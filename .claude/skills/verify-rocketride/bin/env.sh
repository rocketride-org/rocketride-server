# shellcheck shell=bash
# Source at the start of every shell command line:
#   . .claude/skills/verify-rocketride/bin/env.sh <run-id> && rr-verify ...
# Puts rr-verify on PATH, sets F to the fixtures directory, sets RR_VERIFY_ID so every
# rr-verify command uses that run, and loads ROCKETRIDE_URI and ROCKETRIDE_APIKEY once
# the run has been launched.
_rr_bin=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
export PATH="$_rr_bin:$PATH"
F=$(cd "$_rr_bin/../fixtures" && pwd)
export F
if [ -n "${1:-}" ]; then
	export RR_VERIFY_ID="$1"
fi
_rr_env="$(git -C "$_rr_bin" rev-parse --show-toplevel)/.verify/${RR_VERIFY_ID:-}/engine.env"
if [ -n "${RR_VERIFY_ID:-}" ] && [ -f "$_rr_env" ]; then
	set -a
	# shellcheck disable=SC1090
	. "$_rr_env"
	set +a
fi
unset _rr_bin _rr_env
