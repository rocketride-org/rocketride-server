#!/usr/bin/env bash
# Shared settings for the rr-verify-agent helpers. Sourced, not run.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(git -C "$SKILL_DIR" rev-parse --show-toplevel)"

# The published engine image, pinned to a release. Every run records the
# image id it actually used.
ENGINE_IMAGE="${RR_VERIFY_IMAGE:-ghcr.io/rocketride-org/rocketride-engine:3.5.0}"
ENGINE_NAME="${RR_VERIFY_ENGINE_NAME:-rr-verify-agent-engine}"
# Its value is the checkout that started the container.
ENGINE_LABEL="rr-verify-agent"
# Pinned: the shell's dev proxy sends /task, /api and /auth to localhost:5565
# (packages/shell/rsbuild.config.mts), so one engine per machine.
ENGINE_PORT=5565
SHELL_PORT="${RR_VERIFY_SHELL_PORT:-3000}"
UI_PORT="${RR_VERIFY_UI_PORT:-3010}"
# Local-only test key the engine is started with. Not a secret.
APIKEY="${RR_VERIFY_APIKEY:-local-test}"

APP_ID="rocketride.pipeBuilder"
DEV_PREFIX="/apps/${APP_ID}/dev"
SHELL_URL="http://127.0.0.1:${SHELL_PORT}/?appid=${APP_ID}&rrdev=1"

# verify-rocketride's launcher (#2870), for --engine source. It starts
# dist/server of the checkout it sits in, so it must sit in this checkout.
LAUNCHER="${RR_VERIFY_LAUNCHER:-$ROOT/.claude/skills/verify-rocketride/bin/rr-verify}"

# Where tokenstash runs when the model keys are not in the environment. Its
# env file is the one in that folder's project (default: this checkout).
KEYS_DIR="${RR_VERIFY_KEYS_DIR:-$ROOT}"

EVIDENCE_ROOT="${RR_VERIFY_EVIDENCE:-$ROOT/.verify/agent}"
STATE_DIR="${RR_VERIFY_STATE:-$ROOT/.verify/agent-state}"
# Every launch-to-cleanup block on this machine holds this lock, because the
# engine, shell and rocket-ui ports are shared by all checkouts.
LOCK_FILE="${RR_VERIFY_LOCK:-/tmp/rr-verify-5565.lock}"
BUILD_RECORD="$ROOT/dist/server/.rr-verify-agent-build.json"

SHELL_WRAPPER="$ROOT/packages/shell/.rocketride/verify.rsbuild.config.mts"
UI_WRAPPER="$ROOT/apps/rocket-ui/.rocketride/verify.rsbuild.config.mts"

mkdir -p "$STATE_DIR"
export RR_VERIFY_EVIDENCE="$EVIDENCE_ROOT" RR_VERIFY_STATE="$STATE_DIR" RR_VERIFY_APIKEY="$APIKEY"

log() { printf '[rr-verify-agent] %s\n' "$*" >&2; }
die() { printf '[rr-verify-agent] ERROR: %s\n' "$*" >&2; exit 1; }

# Who listens on a TCP port (empty when free).
port_owner() { ss -ltnpH "sport = :$1" 2>/dev/null | head -1; }

# A process's start time in clock ticks since boot (field 22 of
# /proc/<pid>/stat), empty when it is gone. The kernel reuses pids, but a
# reused pid has a later start time.
proc_start() { [[ -r "/proc/$1/stat" ]] && sed -E 's/^.*\) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'; }
# Records a process launch started, as "<pid> <start time>".
record_proc() { echo "$2 $(proc_start "$2")" >"$1"; }
# The pid in a record_proc file, while that same process still runs.
owned_pid() {
	local pid start
	read -r pid start 2>/dev/null <"$1" || return 1
	[[ -n "$pid" && -n "$start" && "$(proc_start "$pid")" == "$start" ]] && echo "$pid"
}

# image or source, as recorded by launch (empty before a launch).
engine_mode() { cat "$STATE_DIR/engine.mode" 2>/dev/null || true; }

# The launcher's record of a source engine: .verify/<run id>/engine.env.
source_env() { echo "$ROOT/.verify/$(cat "$STATE_DIR/engine.run" 2>/dev/null)/engine.env"; }
source_pid() { sed -n 's/^ENGINE_PID=//p' "$(source_env)" 2>/dev/null; }

# Whether the engine on 5565 is the one launch started. The container name is
# the same in every checkout and pids get reused, so it goes by what launch
# recorded: the container's id, or the engine process's pid and start time.
engine_is_ours() {
	case "$(engine_mode)" in
		image)
			local id
			id="$(cat "$STATE_DIR/engine.container" 2>/dev/null)"
			[[ -n "$id" ]] || return 1
			[[ "$(docker inspect -f "{{.Id}} {{.State.Running}} {{index .Config.Labels \"$ENGINE_LABEL\"}}" "$id" 2>/dev/null)" == "$id true $ROOT" ]] || return 1
			docker port "$id" 5565/tcp 2>/dev/null | grep -qx "127.0.0.1:$ENGINE_PORT" || return 1
			# The daemon publishes the port through its forwarder: docker-proxy, or RootlessKit for a
			# rootless daemon. Root's docker-proxy shows no process in ss; any other named one is someone else's.
			local forwarder=docker-proxy
			[[ "$(docker info -f '{{.SecurityOptions}}' 2>/dev/null)" == *name=rootless* ]] && forwarder=rootlesskit
			! ss -ltnpH "sport = :$ENGINE_PORT" 2>/dev/null | grep 'users:' | grep -vq "\"$forwarder\""
			;;
		source)
			local pid
			pid="$(owned_pid "$STATE_DIR/engine.pid")" || return 1
			[[ "$pid" == "$(source_pid)" ]] && port_owner "$ENGINE_PORT" | grep -q "pid=$pid,"
			;;
		*) return 1 ;;
	esac
}

# The process group of a dev server launch started, while its leader still runs.
dev_group() { owned_pid "$STATE_DIR/$1.pgid"; }

http_ok() { curl -sf -o /dev/null --max-time 5 "$1"; }

# Runs "$@" with the model keys in its environment, by name only. Order: the
# caller's environment (ROCKETRIDE_ANTHROPIC_KEY or ANTHROPIC_API_KEY), then
# tokenstash from KEYS_DIR when it is installed, else no keys. Values never
# reach argv, logs or files; keys-exec.sh writes only the names it found.
with_model_keys() {
	: >"$STATE_DIR/engine-vars.txt"
	if [[ -n "${RR_VERIFY_NO_KEYS:-}" ]]; then
		echo none >"$STATE_DIR/key-source.txt"
		env -u ROCKETRIDE_ANTHROPIC_KEY -u ROCKETRIDE_OPENAI_KEY -u ANTHROPIC_API_KEY -u OPENAI_API_KEY "$@"
	elif [[ -n "${ROCKETRIDE_ANTHROPIC_KEY:-}${ANTHROPIC_API_KEY:-}" ]]; then
		echo environment >"$STATE_DIR/key-source.txt"
		"$SKILL_DIR/scripts/keys-exec.sh" "$@"
	elif command -v tokenstash >/dev/null 2>&1; then
		[[ -d "$KEYS_DIR" ]] || die "RR_VERIFY_KEYS_DIR $KEYS_DIR does not exist"
		echo "tokenstash" >"$STATE_DIR/key-source.txt"
		# --retries 0: a restart would start a second engine.
		(cd "$KEYS_DIR" && tokenstash run --retries 0 -- "$SKILL_DIR/scripts/keys-exec.sh" "$@")
	else
		echo none >"$STATE_DIR/key-source.txt"
		log "WARNING: no model key in the environment and no tokenstash. Set ROCKETRIDE_ANTHROPIC_KEY (or ANTHROPIC_API_KEY) to drive the agent."
		"$SKILL_DIR/scripts/keys-exec.sh" "$@"
	fi
}
