#!/bin/sh
# Load the local Gemini key before starting the engine, so task subprocesses inherit it.
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
key_file="$repo_root/.env.gemini.local"
if [ ! -f "$key_file" ]; then
    cp "$repo_root/nodes/test/tool_redis/gemini.env.example" "$key_file"
    chmod 600 "$key_file"
fi
set -a
. "$key_file"
set +a
if [ -z "${ROCKETRIDE_GEMINI_KEY:-}" ]; then
    printf 'Paste your Gemini key after ROCKETRIDE_GEMINI_KEY= in %s, then run this command again.\n' "$key_file" >&2
    exit 1
fi
engine=${ROCKETRIDE_ENGINE:-"$repo_root/dist/server/engine"}
if [ ! -x "$engine" ]; then
    printf 'Engine not found at %s. Set ROCKETRIDE_ENGINE to its absolute path in %s.\n' "$engine" "$key_file" >&2
    exit 1
fi
cd -- "$(dirname -- "$engine")"
exec "./$(basename -- "$engine")" ./ai/eaas.py --host=127.0.0.1 "$@"
