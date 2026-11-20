#!/usr/bin/env bash
# Self-test for start.sh against a fake docker: no real container is touched.
#
# The fake records every docker call and answers `inspect` from a state table,
# so the test can assert that start.sh never recreates or removes a container,
# starts a stopped one, creates a missing one from the pinned image on
# 127.0.0.1 only, creates the pooler after the database it links to, and that
# --check changes nothing.
#
# Usage: bash scripts/acceptance/vector-explorer/containers/selftest.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILURES=0

cat > "$WORK/docker" <<'FAKE'
#!/usr/bin/env bash
# Fake docker: state lines are "<name> <running|stopped|image>" in $FAKE_STATE; calls go to $FAKE_LOG.
# "image" is an image (not a container) of that name: `inspect` without `--type container`
# resolves it and, as some docker versions do for a key the object lacks, prints <no value>.
echo "$*" >> "$FAKE_LOG"
cmd="$1"; shift
case "$cmd" in
  inspect)
    fmt=''; kind=''
    while [ $# -gt 1 ]; do
      case "$1" in
        -f | --format) fmt="$2"; shift 2 ;;
        --type) kind="$2"; shift 2 ;;
        *) break ;;
      esac
    done
    name="$1"
    line="$(grep "^$name " "$FAKE_STATE" | head -1 || true)"
    state="${line#* }"
    if [ -z "$line" ] || { [ "$state" = image ] && [ "$kind" = container ]; }; then
      echo "Error: No such object: $name" >&2; exit 1
    fi
    if [ "$state" = image ]; then
      echo '<no value>'; exit 0
    fi
    case "$fmt" in
      *State.Running*) [ "$state" = running ] && echo true || echo false ;;
      *.Image*) echo "sha256:0000" ;;
      *) echo "{}" ;;
    esac ;;
  image)
    echo '["pinned@sha256:0000"]' ;;
  run)
    name=''
    while [ $# -gt 0 ]; do
      if [ "$1" = "--name" ]; then name="$2"; fi
      shift
    done
    echo "$name running" >> "$FAKE_STATE" ;;
  start)
    sed -i.bak "s/^$1 stopped$/$1 running/" "$FAKE_STATE" ;;
  *) ;;
esac
exit 0
FAKE
chmod +x "$WORK/docker"

run_case() {
  # $1 = case name, $2 = state table, remaining = start.sh arguments
  name="$1"; table="$2"; shift 2
  printf '%s\n' "$table" | sed '/^$/d' > "$WORK/state"
  : > "$WORK/log"
  set +e
  FAKE_STATE="$WORK/state" FAKE_LOG="$WORK/log" DOCKER="$WORK/docker" VX_SKIP_HEALTH=1 \
    bash "$HERE/start.sh" "$@" > "$WORK/out" 2>&1
  STATUS=$?
  set -e
  CASE="$name"
}

fail() { echo "FAIL [$CASE]: $1"; echo "--- docker calls:"; cat "$WORK/log"; echo "--- output:"; cat "$WORK/out"; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok   [$CASE]: $1"; }
calls() { grep -c -E "$1" "$WORK/log" || true; }

ALL_RUNNING='gx-pgvector running
vx-pgbouncer running
vx-qdrant running
vx-chroma running'

# 1. Everything running: nothing is created, started, stopped or removed.
run_case 'all running' "$ALL_RUNNING"
if [ "$STATUS" -eq 0 ] && [ "$(calls '^(run|start|stop|rm|create|kill|restart) ')" -eq 0 ]; then
  pass 'no container touched'
else
  fail 'a running container was touched'
fi

# 2. A missing container is created from the pinned image, published on 127.0.0.1 only.
run_case 'qdrant missing' 'gx-pgvector running
vx-pgbouncer running
vx-chroma running'
run_line="$(grep '^run ' "$WORK/log" || true)"
if [ "$STATUS" -eq 0 ] && [ "$(calls '^run ')" -eq 1 ] \
  && echo "$run_line" | grep -q -- '--name vx-qdrant' \
  && echo "$run_line" | grep -q 'qdrant/qdrant:v1.17.1@sha256:94728574965d17c6485dd361aa3c0818b325b9016dac5ea6afec7b4b2700865f' \
  && echo "$run_line" | grep -q -- '-p 127.0.0.1:56333:6333' \
  && echo "$run_line" | grep -q -- '-p 127.0.0.1:56334:6334' \
  && ! echo "$run_line" | grep -q -- '-p 0.0.0.0' && [ "$(calls '^rm ')" -eq 0 ]; then
  pass 'created from the pinned image on 127.0.0.1'
else
  fail 'vx-qdrant was not created as pinned'
fi

# 3. A stopped container is started, not recreated.
run_case 'chroma stopped' 'gx-pgvector running
vx-pgbouncer running
vx-qdrant running
vx-chroma stopped'
if [ "$STATUS" -eq 0 ] && [ "$(calls '^start vx-chroma$')" -eq 1 ] && [ "$(calls '^(run|rm) ')" -eq 0 ]; then
  pass 'started in place'
else
  fail 'vx-chroma was not started in place'
fi

# 4. The pooler is created after the database it links to, in transaction mode, pinned.
run_case 'database and pooler missing' 'vx-qdrant running
vx-chroma running'
first_run="$(grep -n '^run ' "$WORK/log" | head -1)"
pooler_run="$(grep '^run .*--name vx-pgbouncer' "$WORK/log" || true)"
if [ "$STATUS" -eq 0 ] && echo "$first_run" | grep -q -- '--name gx-pgvector' \
  && echo "$pooler_run" | grep -q -- '--link gx-pgvector:pgv' \
  && echo "$pooler_run" | grep -q 'POOL_MODE=transaction' \
  && echo "$pooler_run" | grep -q 'DEFAULT_POOL_SIZE=4' \
  && echo "$pooler_run" | grep -q -- '-p 127.0.0.1:56434:5432' \
  && echo "$pooler_run" | grep -q 'edoburu/pgbouncer@sha256:9c78945868a6a142c7fc40ccd843bbe5a606df163c7ffce4de70e0d628d696a2'; then
  pass 'database first, then the pinned transaction pooler'
else
  fail 'the pooler was not created after its database as pinned'
fi

# 5. --check reports a missing container with a non-zero exit and changes nothing.
run_case 'check with a missing container' 'gx-pgvector running
vx-pgbouncer running
vx-qdrant running' --check
if [ "$STATUS" -ne 0 ] && [ "$(calls '^(run|start|stop|rm) ')" -eq 0 ] && grep -q 'vx-chroma' "$WORK/out"; then
  pass 'reported and left alone'
else
  fail '--check changed something or did not report the missing container'
fi

# 6. --check with everything running succeeds without changes.
run_case 'check all running' "$ALL_RUNNING" --check
if [ "$STATUS" -eq 0 ] && [ "$(calls '^(run|start|stop|rm) ')" -eq 0 ]; then
  pass 'all present'
else
  fail '--check failed with every container running'
fi

# 7. Naming one container only touches that one.
run_case 'only chroma' 'gx-pgvector running
vx-pgbouncer running' vx-chroma
if [ "$STATUS" -eq 0 ] && [ "$(calls '^run ')" -eq 1 ] && [ "$(calls '^run .*--name vx-chroma')" -eq 1 ]; then
  pass 'only vx-chroma created'
else
  fail 'more than the named container was touched'
fi

# 8. Every container lookup is scoped to containers (an image, network or volume can share the name).
run_case 'inspect scoped to containers' "$ALL_RUNNING" --check
lookups="$(grep '^inspect ' "$WORK/log" || true)"
if [ "$STATUS" -eq 0 ] && [ -n "$lookups" ] && ! echo "$lookups" | grep -v -q -- '--type container'; then
  pass 'every inspect names --type container'
else
  fail 'a lookup could resolve a non-container object'
fi

# 9. An image named like a missing container: the container is created, not "started".
run_case 'image named like the container' 'gx-pgvector running
vx-pgbouncer running
vx-qdrant running
vx-chroma image' vx-chroma
if [ "$STATUS" -eq 0 ] && [ "$(calls '^run .*--name vx-chroma')" -eq 1 ] && [ "$(calls '^start ')" -eq 0 ]; then
  pass 'created, not started'
else
  fail 'the image was taken for a stopped container'
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "selftest: $FAILURES case(s) failed"
  exit 1
fi
echo 'selftest: all cases passed'
