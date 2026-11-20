#!/usr/bin/env bash
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
#
# Checks that each file given was built with ASan and UBSan: a build without
# the sanitizer flags runs clean and writes no reports, so it would pass.
#
# A program links the sanitizer runtime in, so its symbol table holds the
# __asan_ and __ubsan_handle_ symbols. A shared library (*.so) leaves the
# runtime to the program that loads it, so it holds them as undefined dynamic
# references. The ASan runtime carries the UBSan handlers too, so in a program
# __ubsan_handle_ proves only ASan; only a library proves UBSan.
#
# Usage: bash scripts/ci/check-sanitizer-symbols.sh <file>...
#
# Prints one line per file, an ::error:: line for each missing file or file
# without the symbols. Exits 0 when every file passes, 1 when any fails, and
# 2 when no file is given.
# =============================================================================

set -euo pipefail

if [ "$#" -eq 0 ]; then
    echo "::error::usage: $0 <file>..."
    exit 2
fi

# nm writes to a file, not a pipe: grep -q quits at the first match, and the
# SIGPIPE nm then gets would fail the check under pipefail.
syms=$(mktemp)
errs=$(mktemp)
trap 'rm -f "$syms" "$errs"' EXIT

symbols() { # <file>
    case $1 in
    *.so | *.so.*) nm -D --undefined-only "$1" ;;
    *) nm "$1" ;;
    esac
}

failed=0
for file in "$@"; do
    if [ ! -f "$file" ]; then
        echo "::error::$file is missing"
        failed=1
        continue
    fi

    if ! symbols "$file" >"$syms" 2>"$errs"; then
        echo "::error::nm cannot read $file: $(head -n1 "$errs")"
        failed=1
        continue
    fi

    missing=()
    for prefix in __asan_ __ubsan_handle_; do
        grep -q "$prefix" "$syms" || missing+=("$prefix")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        echo "::error::$file has no symbols that start with ${missing[*]}: it was built without the sanitizer flags"
        failed=1
        continue
    fi

    echo "$file: ASan and UBSan symbols found"
done

exit "$failed"
