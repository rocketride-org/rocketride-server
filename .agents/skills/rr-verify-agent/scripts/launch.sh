#!/usr/bin/env bash
# Starts an engine on 5565, the rocket-ui dev remote and the shell dev server
# for verifying the browser agent. Refuses to touch anything it did not start.
# Usage: rr-verify-agent launch [--engine source|image] [--dev-only]
#   --engine source  (default) dist/server of this checkout, started by
#                    verify-rocketride's launcher. Falls back to the image, and
#                    says why, when the launcher or dist/server is missing.
#   --engine image   the published engine image ($ENGINE_IMAGE)
#   --dev-only       build and serve rocket-ui and the shell only, no engine (a
#                    compile check; drive refuses to run, never open the page)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
REQUESTED="${RR_VERIFY_ENGINE:-source}"
DEV_ONLY=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--engine) REQUESTED="${2:?--engine needs source or image}"; shift 2 ;;
		--engine=*) REQUESTED="${1#--engine=}"; shift ;;
		--dev-only) DEV_ONLY=1; shift ;;
		*) die "launch: unknown argument $1" ;;
	esac
done
[[ "$REQUESTED" == source || "$REQUESTED" == image ]] || die "--engine must be source or image (got $REQUESTED)"

# step: isolation. 5565 is pinned by the shell's dev proxy, so a second engine
# on this machine is a hard stop, never something to stop or share.
if [[ -z "$DEV_ONLY" && -n "$(port_owner "$ENGINE_PORT")" ]]; then
	if engine_is_ours; then die "an rr-verify-agent engine is already running. Run 'rr-verify-agent doctor' or 'rr-verify-agent cleanup'."; fi
	die "port $ENGINE_PORT is in use by something this checkout's rr-verify-agent did not start ($(port_owner "$ENGINE_PORT" | grep -oE 'users:.*' || true)). Wait for it, or hold $LOCK_FILE as every run should. Never stop it."
fi
for p in "$SHELL_PORT" "$UI_PORT"; do
	[[ -z "$(port_owner "$p")" ]] || die "port $p is in use. Free it or set RR_VERIFY_SHELL_PORT / RR_VERIFY_UI_PORT."
done

# step: dependencies, once per checkout
if [[ ! -d "$ROOT/node_modules" ]]; then log "installing workspace dependencies"; (cd "$ROOT" && CI=true pnpm install --frozen-lockfile >"$STATE_DIR/install.log" 2>&1) || die "pnpm install failed, see $STATE_DIR/install.log"; fi
if [[ ! -f "$ROOT/packages/client-typescript/dist/cjs/client/index.js" ]]; then log "building the TypeScript client (engine reads)"; (cd "$ROOT" && CI=true ./builder client-typescript:build >"$STATE_DIR/client-build.log" 2>&1) || die "client build failed, see $STATE_DIR/client-build.log"; fi
if [[ ! -d "$SKILL_DIR/scripts/node_modules/playwright" ]]; then log "installing the Playwright helper"; (cd "$SKILL_DIR/scripts" && npm ci --no-audit --no-fund >"$STATE_DIR/helper-install.log" 2>&1) || die "helper install failed, see $STATE_DIR/helper-install.log"; fi
(cd "$SKILL_DIR/scripts" && npx playwright install chromium >"$STATE_DIR/browser-install.log" 2>&1) || die "chromium install failed, see $STATE_DIR/browser-install.log"

if [[ -z "$DEV_ONLY" ]]; then
rm -f "$STATE_DIR/engine.mode" "$STATE_DIR/engine.run" "$STATE_DIR/engine.container" "$STATE_DIR/engine.json"
MODE="$REQUESTED"
FALLBACK=""
if [[ "$MODE" == source ]]; then
	# The launcher starts dist/server of the checkout it lives in, so a copy in
	# another checkout would start the wrong engine.
	if [[ ! -x "$LAUNCHER" ]]; then
		FALLBACK="verify-rocketride's launcher is not in this checkout ($LAUNCHER). Copy the verify-rocketride skill into .claude/skills/verify-rocketride/, or set RR_VERIFY_LAUNCHER."
	elif [[ "$(git -C "$(dirname "$LAUNCHER")" rev-parse --show-toplevel 2>/dev/null)" != "$ROOT" ]]; then
		FALLBACK="the launcher at $LAUNCHER belongs to another checkout, so it would start that checkout's engine."
	elif [[ ! -x "$ROOT/dist/server/engine" || ! -d "$ROOT/dist/server/ai" ]]; then
		FALLBACK="no engine in dist/server. Run 'rr-verify-agent build-engine' first."
	fi
	if [[ -n "$FALLBACK" ]]; then
		MODE=image
		log "CANNOT START THE ENGINE FROM SOURCE: $FALLBACK"
		log "Falling back to the published image $ENGINE_IMAGE. It has no fs_put_json, so session saves fail on it: journeys report reply-recorded, sessions-saved and the stored-session checks as not verifiable on this engine."
	fi
fi

if [[ "$MODE" == source ]]; then
	RUN_ID="agent-$(date -u +%Y%m%dT%H%M%SZ)-$$"
	# A store of its own, emptied at each launch. The engine's default store is
	# ~/.rocketlib, shared with every local engine of this user, and each
	# journey's reset deletes all workspace files and sessions in it.
	rm -rf "$STORE_DIR"
	mkdir -p "$STORE_DIR"
	log "starting the engine from dist/server through verify-rocketride's launcher (run $RUN_ID, store $STORE_DIR)"
	# The engine inherits the model keys and the store from the launcher's environment.
	with_model_keys env RR_STORE_URL="filesystem://$STORE_DIR" RR_VERIFY_APIKEY="$APIKEY" RR_VERIFY_READY_TIMEOUT="${RR_VERIFY_READY_TIMEOUT:-600}" \
		"$LAUNCHER" launch --port "$ENGINE_PORT" --id "$RUN_ID" >"$STATE_DIR/launcher.log" 2>&1 \
		|| { cat "$STATE_DIR/launcher.log" >&2; die "verify-rocketride's launcher could not start the engine; see $STATE_DIR/launcher.log"; }
	echo source >"$STATE_DIR/engine.mode"
	echo "$RUN_ID" >"$STATE_DIR/engine.run"
else
	# Fresh container, empty data. Keys go in by name only (-e NAME).
	docker rm -f "$ENGINE_NAME" >/dev/null 2>&1 || true
	with_model_keys docker run -d --name "$ENGINE_NAME" --label "$ENGINE_LABEL=1" -p "127.0.0.1:$ENGINE_PORT:5565" \
		-e ROCKETRIDE_APIKEY="$APIKEY" -e ROCKETRIDE_ANTHROPIC_KEY -e ROCKETRIDE_OPENAI_KEY "$ENGINE_IMAGE" >/dev/null \
		|| die "engine container did not start"
	echo image >"$STATE_DIR/engine.mode"
	echo "$ENGINE_NAME" >"$STATE_DIR/engine.container"
fi
grep -q ROCKETRIDE_ANTHROPIC_KEY "$STATE_DIR/engine-vars.txt" || log "WARNING: no ROCKETRIDE_ANTHROPIC_KEY. The Agent tab's model call will fail; only no-model checks will work."

log "waiting for the engine"
for _ in $(seq 1 90); do http_ok "http://127.0.0.1:$ENGINE_PORT/version" && break; sleep 2; done
http_ok "http://127.0.0.1:$ENGINE_PORT/version" || die "engine did not answer /version"
# Ready means usable: a signed-in client can list the store, not just /version.
for _ in $(seq 1 30); do node "$SKILL_DIR/scripts/engine-read.cjs" ping >/dev/null 2>&1 && break; sleep 2; done
node "$SKILL_DIR/scripts/engine-read.cjs" ping >/dev/null || die "engine answers /version but a signed-in client cannot use it"

# step: provenance, copied into every evidence record by drive
RR_MODE="$MODE" RR_STORE_DIR="$STORE_DIR" RR_REQUESTED="$REQUESTED" RR_FALLBACK="$FALLBACK" RR_ROOT="$ROOT" RR_LAUNCHER="$LAUNCHER" \
	RR_IMAGE="$ENGINE_IMAGE" RR_CONTAINER="$ENGINE_NAME" RR_BUILD_RECORD="$BUILD_RECORD" \
	node "$SKILL_DIR/scripts/provenance.cjs" >"$STATE_DIR/engine.json" || die "could not record the engine's provenance"
node -e 'const e = require(process.argv[1]); console.error(`[rr-verify-agent] engine: ${e.summary}`); if (!e.capabilities.fsPutJson) console.error(`[rr-verify-agent] this engine has no fs_put_json (${e.capabilities.detail}). Session-save checks report not verifiable.`);' "$STATE_DIR/engine.json"
fi

# step: dev wrappers. .rocketride/ is gitignored; cleanup removes them.
mkdir -p "$(dirname "$UI_WRAPPER")" "$(dirname "$SHELL_WRAPPER")"
cat >"$UI_WRAPPER" <<WRAP
// GENERATED by rr-verify-agent launch. Do not edit or commit.
// Serves the branch's rocket-ui under the URL-convention dev prefix, the same
// shape apps/vscode/src/appdev/proxyConfig.ts gives a local-first dev server.
import { mergeRsbuildConfig } from '@rsbuild/core';
import appConfigExport from '../rsbuild.config.mts';

const appConfig = typeof appConfigExport === 'function'
	? appConfigExport({ env: 'development', command: 'dev', envMode: 'development' })
	: appConfigExport;

export default mergeRsbuildConfig(appConfig, {
	dev: { assetPrefix: '${DEV_PREFIX}/', hmr: false, liveReload: false },
	output: { copy: [{ from: 'package.json', to: '.' }, { from: 'icon.svg', to: '.' }] },
	server: { host: '127.0.0.1', port: ${UI_PORT}, strictPort: true },
});
WRAP
cat >"$SHELL_WRAPPER" <<WRAP
// GENERATED by rr-verify-agent launch. Do not edit or commit.
// The shell's own dev config, plus one proxy rule placed first so the
// rocket-ui dev remote wins over the '/apps/' -> engine rule.
import shellConfigExport from '../rsbuild.config.mts';

const base = typeof shellConfigExport === 'function'
	? shellConfigExport({ env: 'development', command: 'dev', envMode: 'development' })
	: shellConfigExport;

export default {
	...base,
	server: {
		...base.server,
		host: '127.0.0.1',
		port: ${SHELL_PORT},
		strictPort: true,
		proxy: { '${DEV_PREFIX}': { target: 'http://127.0.0.1:${UI_PORT}' }, ...(base.server?.proxy ?? {}) },
	},
};
WRAP

start_dev() { # name dir
	# The server runs in its own session; the session leader writes its pid,
	# which is the process group cleanup kills. Nothing holds our stdout.
	local name="$1" dir="$2" pgfile="$STATE_DIR/$1.pgid"
	rm -f "$pgfile"
	(
		cd "$dir" || exit 1
		setsid sh -c 'echo $$ >"$0"; exec "$@"' "$pgfile" ./node_modules/.bin/rsbuild dev --config .rocketride/verify.rsbuild.config.mts </dev/null >"$STATE_DIR/$name.log" 2>&1 &
	)
	for _ in $(seq 1 50); do [[ -s "$pgfile" ]] && return 0; sleep 0.1; done
	die "$name dev server did not start; see $STATE_DIR/$name.log"
}
log "starting rocket-ui dev remote on $UI_PORT"
start_dev rocket-ui "$ROOT/apps/rocket-ui"
log "starting shell dev server on $SHELL_PORT"
start_dev shell "$ROOT/packages/shell"

for _ in $(seq 1 120); do http_ok "http://127.0.0.1:$UI_PORT$DEV_PREFIX/remoteEntry.js" && break; sleep 2; done
http_ok "http://127.0.0.1:$UI_PORT$DEV_PREFIX/remoteEntry.js" || die "rocket-ui remote never served; see $STATE_DIR/rocket-ui.log"
for _ in $(seq 1 120); do http_ok "http://127.0.0.1:$SHELL_PORT$DEV_PREFIX/package.json" && break; sleep 2; done
http_ok "http://127.0.0.1:$SHELL_PORT$DEV_PREFIX/package.json" || die "shell dev server or its proxy is not up; see $STATE_DIR/shell.log"

cat >"$STATE_DIR/run.json" <<JSON
{"startedAt":"$(date -Is)","checkout":"$ROOT","revision":"$(git -C "$ROOT" rev-parse HEAD)","engineMode":"$(engine_mode)","url":"$SHELL_URL"}
JSON
if [[ -n "$DEV_ONLY" ]]; then log "dev servers up (no engine). Compile check only: do not open the page."; exit 0; fi
log "ready: $SHELL_URL (API key screen: $APIKEY)"
"$SKILL_DIR/scripts/doctor.sh"
