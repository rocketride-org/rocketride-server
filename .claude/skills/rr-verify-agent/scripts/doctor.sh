#!/usr/bin/env bash
# Read-only: is this instance worth driving? Exit 0 only when every check passes.
# Usage: rr-verify-agent doctor
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fail=0
check() { if eval "$2" >/dev/null 2>&1; then printf '  ok    %s\n' "$1"; else printf '  FAIL  %s\n' "$1"; fail=1; fi; }

echo "rr-verify-agent doctor ($ROOT)"
[[ -f "$STATE_DIR/run.json" ]] && echo "  run   $(cat "$STATE_DIR/run.json")"
[[ -f "$STATE_DIR/engine.json" ]] && echo "  engine $(node -e 'process.stdout.write(require(process.argv[1]).summary)' "$STATE_DIR/engine.json")"
mode="$(engine_mode)"
case "$mode" in
	image) check "engine container is the one launch started ($(cut -c1-12 "$STATE_DIR/engine.container" 2>/dev/null)), running and publishing $ENGINE_PORT" engine_is_ours ;;
	source) check "engine process is the one launch started (run $(cat "$STATE_DIR/engine.run"), pid $(source_pid)) and owns port $ENGINE_PORT" engine_is_ours ;;
	*) check "an engine was launched by this checkout" false ;;
esac
if engine_is_ours; then
	check "engine /version on $ENGINE_PORT" "http_ok http://127.0.0.1:$ENGINE_PORT/version"
	check "signed-in client can use the engine" "node '$SKILL_DIR/scripts/engine-read.cjs' ping"
	check "model key Variable given to the engine (names only)" "grep -q ROCKETRIDE_ANTHROPIC_KEY '$STATE_DIR/engine-vars.txt'"
	if [[ "$mode" == source && -x "$LAUNCHER" ]]; then
		echo "  verify-rocketride doctor (read-only):"
		"$LAUNCHER" doctor --id "$(cat "$STATE_DIR/engine.run")" 2>&1 | sed 's/^/    /' || true
	fi
else
	printf '  skip  engine checks: port %s is not this checkout'"'"'s engine (owner: %s)\n' "$ENGINE_PORT" "$(port_owner "$ENGINE_PORT" | grep -oE 'users:.*' || echo none)"
fi
check "rocket-ui dev server process alive" "dev_group rocket-ui"
check "shell dev server process alive" "dev_group shell"
check "rocket-ui remoteEntry at $UI_PORT$DEV_PREFIX" "http_ok http://127.0.0.1:$UI_PORT$DEV_PREFIX/remoteEntry.js"
check "shell serves the page on $SHELL_PORT" "http_ok http://127.0.0.1:$SHELL_PORT/"
check "shell proxies the dev app manifest (id $APP_ID)" "curl -sf http://127.0.0.1:$SHELL_PORT$DEV_PREFIX/package.json | grep -q '\"id\": \"$APP_ID\"'"
if [[ -f "$STATE_DIR/run.json" ]]; then
	launched="$(sed -E 's/.*"revision":"([0-9a-f]+)".*/\1/' "$STATE_DIR/run.json")"
	check "checkout still at the launched revision ($launched)" "[[ \$(git -C '$ROOT' rev-parse HEAD) == $launched ]]"
fi
[[ $fail == 0 ]] && echo "doctor: healthy. Drive $SHELL_URL" || echo "doctor: NOT healthy. Read the FAIL lines, then 'rr-verify-agent cleanup' and 'rr-verify-agent launch'."
exit $fail
