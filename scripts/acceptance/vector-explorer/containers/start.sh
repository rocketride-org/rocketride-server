#!/usr/bin/env bash
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
#
# Start the disposable local containers the Vector Explorer suites and lanes use.
#
# Idempotent: a running container is left exactly as it is (never recreated,
# restarted or removed), a stopped one is started in place, and a missing one
# is created from its pinned image, published on 127.0.0.1 only. Every
# credential below is a throwaway local-only test value for these containers.
#
#   gx-pgvector   pgvector/pgvector:0.8.0-pg16   127.0.0.1:55432        (shared with the Graph Explorer lanes)
#   vx-pgbouncer  edoburu/pgbouncer              127.0.0.1:56434        transaction pooler in front of gx-pgvector
#   vx-qdrant     qdrant/qdrant:v1.17.1          127.0.0.1:56333 (REST), 127.0.0.1:56334 (gRPC)
#   vx-chroma     chromadb/chroma:1.5.9          127.0.0.1:58000
#
# Usage:
#   start.sh [--check | --dry-run] [container ...]
#
#   (no option)  make the named containers (default: all four) run, then wait until they answer
#   --check      change nothing; report state, pinned image and health; exit 1 if any is missing,
#                stopped or not answering
#   --dry-run    change nothing; print what would be done
#
# Environment: DOCKER (default: docker), VX_HEALTH_TIMEOUT_S (default: 90),
# VX_SKIP_HEALTH=1 to skip the health wait (tests).
#
# Written for macOS bash 3.2: no associative arrays.
set -euo pipefail

# Pinned images (tag@digest). The digests are what `docker pull` reported for these tags.
PGVECTOR_IMAGE='pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9'
PGBOUNCER_IMAGE='edoburu/pgbouncer@sha256:9c78945868a6a142c7fc40ccd843bbe5a606df163c7ffce4de70e0d628d696a2'
QDRANT_IMAGE='qdrant/qdrant:v1.17.1@sha256:94728574965d17c6485dd361aa3c0818b325b9016dac5ea6afec7b4b2700865f'
CHROMA_IMAGE='chromadb/chroma:1.5.9@sha256:1e0b73a187a28757c572acba508c46f48c9e8b0acaf5c20e6d95cdedce1acdf6'

ALL_CONTAINERS='gx-pgvector vx-pgbouncer vx-qdrant vx-chroma'

DOCKER="${DOCKER:-docker}"
HEALTH_TIMEOUT_S="${VX_HEALTH_TIMEOUT_S:-90}"
MODE='start'
SELECTED=''

usage() {
	sed -n '/^# Usage:/,/^# Written for/p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	--check) MODE='check' ;;
	--dry-run) MODE='dry-run' ;;
	-h | --help)
		usage
		exit 0
		;;
	gx-pgvector | vx-pgbouncer | vx-qdrant | vx-chroma) SELECTED="$SELECTED $1" ;;
	*)
		echo "start.sh: unknown argument '$1'" >&2
		usage >&2
		exit 2
		;;
	esac
	shift
done
[ -n "$SELECTED" ] || SELECTED="$ALL_CONTAINERS"

image_of() {
	case "$1" in
	gx-pgvector) echo "$PGVECTOR_IMAGE" ;;
	vx-pgbouncer) echo "$PGBOUNCER_IMAGE" ;;
	vx-qdrant) echo "$QDRANT_IMAGE" ;;
	vx-chroma) echo "$CHROMA_IMAGE" ;;
	esac
}

# The `docker run` arguments of each container, one per line, image last.
run_args_of() {
	case "$1" in
	gx-pgvector)
		printf '%s\n' -p 127.0.0.1:55432:5432 \
			-e POSTGRES_USER=rruser -e POSTGRES_PASSWORD=rrpass -e POSTGRES_DB=rrtenant \
			"$PGVECTOR_IMAGE"
		;;
	vx-pgbouncer)
		printf '%s\n' --link gx-pgvector:pgv -p 127.0.0.1:56434:5432 \
			-e DB_HOST=pgv -e DB_USER=rruser -e DB_PASSWORD=rrpass -e DB_NAME=rrtenant \
			-e POOL_MODE=transaction -e AUTH_TYPE=scram-sha-256 -e DEFAULT_POOL_SIZE=4 -e MAX_CLIENT_CONN=200 \
			"$PGBOUNCER_IMAGE"
		;;
	vx-qdrant)
		printf '%s\n' -p 127.0.0.1:56333:6333 -p 127.0.0.1:56334:6334 "$QDRANT_IMAGE"
		;;
	vx-chroma)
		printf '%s\n' -p 127.0.0.1:58000:8000 "$CHROMA_IMAGE"
		;;
	esac
}

# running | stopped | absent. Scoped to containers: an image, network or volume of the
# same name would otherwise answer, with no container state.
state_of() {
	local running
	if ! running="$("$DOCKER" inspect --type container -f '{{.State.Running}}' "$1" 2>/dev/null)"; then
		echo absent
	elif [ "$running" = 'true' ]; then
		echo running
	else
		echo stopped
	fi
}

# Whether the container runs the pinned image (by digest); prints a note when it does not.
check_pin() {
	local name="$1" pinned digest image_id repo_digests
	pinned="$(image_of "$name")"
	digest="${pinned##*@}"
	image_id="$("$DOCKER" inspect --type container -f '{{.Image}}' "$name" 2>/dev/null || true)"
	repo_digests="$("$DOCKER" image inspect -f '{{json .RepoDigests}}' "$image_id" 2>/dev/null || true)"
	case "$image_id $repo_digests" in
	*"$digest"*) return 0 ;;
	esac
	echo "  note: $name does not run the pinned image $pinned (left as is; recreate it yourself to pin it)"
	return 1
}

health_of() {
	case "$1" in
	vx-qdrant) curl -fsS -m 3 http://127.0.0.1:56333/ >/dev/null 2>&1 ;;
	vx-chroma) curl -fsS -m 3 http://127.0.0.1:58000/api/v2/heartbeat >/dev/null 2>&1 ;;
	gx-pgvector) (exec 3<>/dev/tcp/127.0.0.1/55432) >/dev/null 2>&1 ;;
	vx-pgbouncer) (exec 3<>/dev/tcp/127.0.0.1/56434) >/dev/null 2>&1 ;;
	esac
}

wait_healthy() {
	local name="$1" waited=0
	[ "${VX_SKIP_HEALTH:-0}" = '1' ] && return 0
	while ! health_of "$name"; do
		if [ "$waited" -ge "$HEALTH_TIMEOUT_S" ]; then
			echo "  $name did not answer within ${HEALTH_TIMEOUT_S}s"
			return 1
		fi
		sleep 2
		waited=$((waited + 2))
	done
	echo "  $name answers"
}

ensure() {
	local name="$1" state args=()
	state="$(state_of "$name")"
	case "$state" in
	running)
		echo "$name: running, left as is"
		check_pin "$name" || true
		;;
	stopped)
		if [ "$MODE" = 'dry-run' ]; then
			echo "$name: stopped, would start it in place"
			return 0
		fi
		echo "$name: stopped, starting it in place"
		"$DOCKER" start "$name" >/dev/null || {
			echo "  could not start $name" >&2
			return 1
		}
		;;
	absent)
		if [ "$MODE" = 'dry-run' ]; then
			echo "$name: missing, would create it from $(image_of "$name")"
			return 0
		fi
		if [ "$name" = 'vx-pgbouncer' ] && [ "$(state_of gx-pgvector)" != 'running' ]; then
			echo "$name: missing, but gx-pgvector (the database it fronts) is not running; start it first" >&2
			return 1
		fi
		echo "$name: missing, creating it from $(image_of "$name")"
		while IFS= read -r arg; do args+=("$arg"); done < <(run_args_of "$name")
		"$DOCKER" run -d --name "$name" "${args[@]}" >/dev/null || {
			echo "  could not create $name" >&2
			return 1
		}
		;;
	esac
	wait_healthy "$name"
}

check() {
	local name="$1" state problems=0
	state="$(state_of "$name")"
	case "$state" in
	running)
		echo "$name: running"
		check_pin "$name" || true
		if [ "${VX_SKIP_HEALTH:-0}" != '1' ] && ! health_of "$name"; then
			echo "  $name is running but does not answer"
			problems=1
		fi
		;;
	*)
		echo "$name: $state"
		problems=1
		;;
	esac
	return "$problems"
}

STATUS=0
# Keep the dependency order whatever order the names were given in.
for name in $ALL_CONTAINERS; do
	case " $SELECTED " in
	*" $name "*) ;;
	*) continue ;;
	esac
	if [ "$MODE" = 'check' ]; then
		check "$name" || STATUS=1
	else
		ensure "$name" || STATUS=1
	fi
done
exit "$STATUS"
