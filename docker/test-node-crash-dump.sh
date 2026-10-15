#!/bin/sh
# Checks that a crash in a task container leaves a minidump the engine can
# fetch: the engine is crashed on purpose in a container run as the launcher
# runs a task, and the dump is copied out of the stopped container, as the
# launcher does before it removes one. Used by `container:test` and by the
# release workflow before the image is signed.
#
#   docker/test-node-crash-dump.sh <image>
set -eu

image=${1:?usage: test-node-crash-dump.sh <image>}

# Container paths reach docker as they are, from Git Bash too
export MSYS_NO_PATHCONV=1

out=$(mktemp -d)
id=''
cleanup() {
    [ -z "$id" ] || docker rm -f "$id" > /dev/null 2>&1 || true
    rm -rf "$out"
}
trap cleanup EXIT

fail() {
    echo "FATAL: $1"
    [ ! -f "$out/log" ] || tail -n 30 "$out/log" | sed 's/^/  | /'
    # What decides whether Crashpad may read the crashed process. The image's
    # engine is execute-only, so the kernel starts it with fs.suid_dumpable as
    # its dumpable flag, and Crashpad can take a dump from 0 but not from 2:
    # the engine clears the flag itself as it starts
    docker run --rm --cap-drop ALL --security-opt no-new-privileges "$image" sh -c '
        echo "  kernel $(uname -r), ptrace_scope $(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo n/a), suid_dumpable $(cat /proc/sys/fs/suid_dumpable 2>/dev/null || echo n/a)"
        grep -E "^(CapEff|Seccomp):" /proc/self/status | sed "s/^/  /"' || true
    exit 1
}

# crash <what> [docker create options...]
crash() {
    what=$1
    shift
    echo "Crashing the engine in $image, $what..."
    # A task's flags, and no --rm: the dump would go with the container.
    # A C string read at address 0, which no process has mapped: SIGSEGV
    id=$(docker create --cap-drop ALL --security-opt no-new-privileges --memory 2g --cpus 1 \
        -e ROCKETRIDE_CRASHDB_DIR=/opt/data/crashdb "$@" "$image" \
        ./engine -c 'import ctypes; ctypes.string_at(0)' --monitor=app)
    docker start -a "$id" > "$out/log" 2>&1 || true
    rc=$(docker wait "$id")
    # The engine aborts after the fault: 128 + SIGABRT
    [ "$rc" = 134 ] || fail "$what: the engine exited $rc, not 134"
    dump=$(sed -n 's/^>DUMP\*//p' "$out/log" | tr -d '\r' | head -n 1)
    [ -n "$dump" ] || fail "$what: the engine announced no dump (>DUMP)"
    # Outside a task the engine's dumps go to its temp directory. A tar stream,
    # as the launcher takes it
    docker cp "$id:/tmp/$dump" - > "$out/dump.tar" || fail "$what: $dump is not in the container"
    [ "$(tar -xOf "$out/dump.tar" | head -c 4)" = MDMP ] || fail "$what: $dump is not a minidump"
    echo "  $dump: $(tar -xOf "$out/dump.tar" | wc -c) bytes"
    docker rm -f "$id" > /dev/null
    id=''
}

crash 'as the image user'
# A task runs as the engine's own uid in the image's group (the launcher's --user and --group-add)
crash 'as another uid' --user 4321:4321 --group-add 1000
echo "$image: a crash leaves a minidump that can be copied out of the stopped container"
