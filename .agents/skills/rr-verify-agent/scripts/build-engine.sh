#!/usr/bin/env bash
# Fills dist/server with an engine for this checkout, for `launch --engine source`.
# Usage: rr-verify-agent build-engine [--release <tag>|nearest]
#
# The engine binary comes from the server release whose packages/server source
# matches this checkout (./builder server:download). When none matches, a
# compile needs root once for system packages (see verify-rocketride's
# SKILL.md), so --release puts a release binary in dist/server instead:
# `nearest` picks the server-v* tag with the smallest packages/server diff.
# Either way the engine's Python (packages/ai, nodes) is synced from this
# checkout, which is where the agent branch's engine changes live. The build
# record (dist/server/.rr-verify-agent-build.json) says which binary it is,
# and every evidence record carries it.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
RELEASE=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--release) RELEASE="${2:?--release needs a tag or nearest}"; shift 2 ;;
		*) die "build-engine: unknown argument $1" ;;
	esac
done
[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || die "build-engine supports linux-x64 only; build with ./builder server:build on other platforms"
cd "$ROOT"
t0=$(date +%s)

# "<changed lines> <tag>" for each server release tag, nearest first.
release_distances() {
	for t in $(git tag -l 'server-v[0-9]*' | grep -E '^server-v[0-9.]+(-prerelease)?$'); do
		echo "$(git diff --numstat HEAD "$t" -- packages/server | awk '{n += $1 + $2} END {print n + 0}') $t"
	done | sort -n
}
[[ -d node_modules ]] || { log "installing workspace dependencies"; CI=true pnpm install --frozen-lockfile >"$STATE_DIR/install.log" 2>&1 || die "pnpm install failed, see $STATE_DIR/install.log"; }

# step: a release whose server source matches this checkout
log "looking for a server release that matches packages/server"
CI=true ./builder server:download >"$STATE_DIR/server-download.log" 2>&1 || die "server:download failed, see $STATE_DIR/server-download.log"
origin=""
tag=""
if grep -qE 'Downloaded server from|Server already downloaded' "$STATE_DIR/server-download.log"; then
	origin="matched-release"
	tag="$(sed -nE 's/.*Downloaded server from ([^ ]+).*/\1/p' "$STATE_DIR/server-download.log" | tail -1)"
elif grep -q 'Source differs from all releases' "$STATE_DIR/server-download.log"; then
	if [[ -z "$RELEASE" ]]; then
		log "no server release matches this checkout's packages/server. Nearest tags (lines of packages/server diff):"
		release_distances | head -5 | sed 's/^/  /' >&2
		die "compile with ./builder server:build --autoinstall (needs root once, then 10 minutes to hours), or rerun with --release nearest"
	fi
	if [[ "$RELEASE" == nearest ]]; then
		RELEASE="$(release_distances | head -1 | cut -d' ' -f2)"
		[[ -n "$RELEASE" ]] || die "no server-v* tags in this clone; run git fetch --tags"
	fi
	origin="release"
	tag="$RELEASE"
	repo="$(node -e 'const p = require("./package.json"); process.stdout.write(p.repository.url.match(/github\.com[/:](.+?)(?:\.git)?$/)[1])')"
	file="rocketride-${tag}-linux-x64.tar.gz"
	mkdir -p "$STATE_DIR/download"
	log "downloading $file from $repo"
	curl -fsSL -o "$STATE_DIR/download/$file" "https://github.com/$repo/releases/download/$tag/$file" || die "could not download $file from release $tag"
	curl -fsSL -o "$STATE_DIR/download/$file.manifest.json" "https://github.com/$repo/releases/download/$tag/rocketride-${tag}-linux-x64.manifest.json" || true
	rm -rf dist/server
	mkdir -p dist/server
	tar -xzf "$STATE_DIR/download/$file" -C dist/server || die "could not extract $file"
	rm -f "$STATE_DIR/download/$file"
	# A fresh dist/server has no pip yet; make server:setup-pip bootstrap it again.
	node -e 'const fs = require("fs"); const f = "build/state.json"; const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}; s.server = { ...s.server, pipInstalledV11: false }; fs.mkdirSync("build", { recursive: true }); fs.writeFileSync(f, JSON.stringify(s, null, 2));'
else
	die "server:download said neither match nor mismatch; see $STATE_DIR/server-download.log"
fi
[[ -x dist/server/engine ]] || die "dist/server/engine is missing after the download"

# step: this checkout's engine Python and nodes, as server:build does after a download
log "syncing this checkout's engine Python and nodes into dist/server"
CI=true ./builder --sequential server:setup-pip nodes:sync ai:sync server:setup-test-deps client-typescript:build >"$STATE_DIR/server-sync.log" 2>&1 || die "sync failed, see $STATE_DIR/server-sync.log"
# The sync copies files but deletes none, so a file the release ships and this
# checkout deleted would stay in dist/server. Remove those copies.
if [[ -n "$tag" ]] && git rev-parse -q --verify "$tag^{commit}" >/dev/null; then
	git diff --name-only --diff-filter=D "$tag" HEAD -- packages/ai/src/ai nodes/src/nodes | while read -r f; do
		case "$f" in
			packages/ai/src/ai/*) rm -f "dist/server/ai/${f#packages/ai/src/ai/}" ;;
			nodes/src/nodes/*) rm -f "dist/server/nodes/${f#nodes/src/nodes/}" ;;
		esac
	done
fi

build_hash=""
[[ -f "$STATE_DIR/download/rocketride-${tag}-linux-x64.tar.gz.manifest.json" ]] && build_hash="$(node -e 'process.stdout.write(String(require(process.argv[1]).server?.buildHash ?? ""))' "$STATE_DIR/download/rocketride-${tag}-linux-x64.tar.gz.manifest.json")"
[[ -z "$build_hash" && "$origin" == matched-release ]] && build_hash="$(node -e 'process.stdout.write(String(require("./build/state.json").server?.buildHash ?? ""))')"
cxx_diff=""
[[ -n "$tag" ]] && git rev-parse -q --verify "$tag^{commit}" >/dev/null && cxx_diff="$(git diff --shortstat HEAD "$tag" -- packages/server | sed 's/^ *//')"
cat >"$BUILD_RECORD" <<JSON
{"builtAt":"$(date -Is)","binary":{"origin":"$origin","tag":"$tag","buildHash":"$build_hash","cxxDiffFromCheckout":"$cxx_diff"},"python":{"from":"checkout","commit":"$(git rev-parse HEAD)","dirtyFiles":$(git status --porcelain -- packages/ai nodes | wc -l)},"seconds":$(( $(date +%s) - t0 ))}
JSON
log "engine ready in dist/server ($origin ${tag:-}) in $(( $(date +%s) - t0 ))s. Record: $BUILD_RECORD"
cat "$BUILD_RECORD"
