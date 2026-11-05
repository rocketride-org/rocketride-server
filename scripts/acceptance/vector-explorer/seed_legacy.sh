#!/usr/bin/env bash
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
# Seed (or, when they exist, verify) the legacy-shaped Vector Explorer
# collections vx_legacy_docs on the disposable local containers: pgvector,
# Qdrant and Chroma. See seed_legacy.py for the recipes. Run it once, with an
# engine whose store drivers are still the old ones, before any driver change
# is merged; the collections are kept for the driver and tool-path suites.
# On pgvector it also soft-deletes one row (the health fields' live case); a
# table seeded before that row existed gets it in place on a run without
# --verify-only, which needs no engine.
#
# Environment: ENGINE_URL (an engine whose store drivers are the old ones,
# started with ROCKETRIDE_DB_BROKER_URL/ROCKETRIDE_DB_BROKER_TOKEN pointing at fake_broker.py;
# the seed refuses, before dropping anything, when that engine's chunker or
# drivers would not write the legacy shape), SERVER_DIR (default: dist/server of
# this checkout), UV_CACHE_DIR, and the VX_* settings of README.md. Arguments go
# to seed_legacy.py (--only, --recreate, --verify-only).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
cd "${SERVER_DIR:-$REPO/dist/server}"
exec ./engine "$HERE/seed_legacy.py" "$@"
