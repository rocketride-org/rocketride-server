#!/bin/bash

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=("$@")
if [[ -n "${CI:-}" ]]; then
    HAS_TEST=0
    HAS_SEQUENTIAL=0
    for ARG in "${ARGS[@]}"; do
        [[ "$ARG" == "test" ]] && HAS_TEST=1
        [[ "$ARG" == "--sequential" || "$ARG" == "-s" ]] && HAS_SEQUENTIAL=1
    done
    if [[ "$HAS_TEST" == "1" && "$HAS_SEQUENTIAL" == "0" ]]; then
        ARGS+=("--sequential")
    fi
fi

exec node "$DIR/scripts/build.js" "${ARGS[@]}"
