#!/bin/sh
# Gives the model keys the names the engine reads, records which names are
# set, then runs the command. Values stay in the environment only: never in
# argv, files or logs.
[ -z "${ROCKETRIDE_ANTHROPIC_KEY:-}" ] && [ -n "${ANTHROPIC_API_KEY:-}" ] && export ROCKETRIDE_ANTHROPIC_KEY="$ANTHROPIC_API_KEY"
[ -z "${ROCKETRIDE_OPENAI_KEY:-}" ] && [ -n "${OPENAI_API_KEY:-}" ] && export ROCKETRIDE_OPENAI_KEY="$OPENAI_API_KEY"
vars="${RR_VERIFY_STATE:?}/engine-vars.txt"
: >"$vars"
[ -n "${ROCKETRIDE_ANTHROPIC_KEY:-}" ] && echo ROCKETRIDE_ANTHROPIC_KEY >>"$vars"
[ -n "${ROCKETRIDE_OPENAI_KEY:-}" ] && echo ROCKETRIDE_OPENAI_KEY >>"$vars"
exec "$@"
