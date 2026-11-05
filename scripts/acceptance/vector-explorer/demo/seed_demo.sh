#!/usr/bin/env bash
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
# Seed the fictional demo corpus into the Vector Explorer fixtures on the
# disposable local containers (see seed_demo.py): every file of
# demo/gen_corpus.py is uploaded through the fixtures' ingest sources as
# C:/demo/<folder>/<file>; --pager also fills the 1,500-document Qdrant
# fixture. Uploading a name again replaces that document. Point it only at
# disposable containers.
#
# Environment: ENGINE_URL (the engine under test), SERVER_DIR (default:
# dist/server of this checkout), UV_CACHE_DIR and the VX_* settings of
# ../README.md. Arguments go to seed_demo.py (--only, --pager, --if-empty).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
cd "${SERVER_DIR:-$REPO/dist/server}"
exec ./engine "$HERE/seed_demo.py" "$@"
