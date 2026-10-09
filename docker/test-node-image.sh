#!/bin/sh
# Checks a node image as a task gets it: capabilities dropped, no network for
# the installs. Used by `container:test` and by the release workflow
# before the image is signed.
#
#   docker/test-node-image.sh <image>
set -eu

image=${1:?usage: test-node-image.sh <image>}

run() {
    docker run --rm --cap-drop ALL "$@"
}

# The engine is non-dumpable (it needs the dropped capabilities a task has), and
# depends() accepts the shipped constraints as they are. A hash mismatch means
# every task recompiles them, against whatever PyPI holds that day, and the
# cache stops matching what tasks install.
echo "Probing the engine in $image..."
run "$image" ./engine -c "
import os
from depends import _find_requirement_files, _find_override_files, _compute_hash
assert os.stat('/proc/self/environ').st_uid == 0, 'engine is dumpable'
import tempfile
from ai.constants import CONST_TASK_DATA_PATH
tempfile.NamedTemporaryFile(dir=CONST_TASK_DATA_PATH).close()
stored = open('cache/requirements.hash').read().strip()
now = _compute_hash(_find_requirement_files() + _find_override_files())
assert stored == now, f'shipped constraints are stale in a container: {stored} != {now}'
print('image probe ok')
"

# Every requirement file the cache was warmed from must install with no network:
# a miss would reach for PyPI and fail. In production a miss is only slower, which
# is exactly why nothing else would notice one. The list is what the warm step
# wrote into the image, so new nodes are covered and files that never resolved
# (listed in the build log) are not expected to.
# shellcheck disable=SC2016 # expands inside the container, where the image sets it
warmed=$(run "$image" sh -c 'cat "$UV_CACHE_DIR/warmed.txt"')
if [ -z "$warmed" ]; then
    echo "FATAL: the image lists no warmed requirement files"
    exit 1
fi

total=0
missed=0
failed=''
for req in $warmed; do
    total=$((total + 1))
    if ! run --network none -e UV_OFFLINE=1 "$image" ./engine -c \
            "from depends import depends; depends('$req')" > /dev/null 2>&1; then
        echo "  not from the cache: $req"
        missed=$((missed + 1))
        failed="$failed $req"
    fi
done

if [ -n "$failed" ]; then
    echo "FATAL: $missed of $total requirement files did not install offline:"
    for req in $failed; do echo "  $req"; done
    echo "Rerun one to see why: docker run --rm --network none -e UV_OFFLINE=1 $image ./engine -c \"from depends import depends; depends('<file>')\""
    exit 1
fi

# A task runs as the engine's own uid in the image's group (the launcher's --user
# and --group-add), and that uid is not always 1000: whatever a run writes must
# be the group's to write, and an install must work as that uid.
echo "Probing $image as another uid in the image's group..."
first=$(echo "$warmed" | head -n 1)
run --user 4321:4321 --group-add 1000 --network none -e UV_OFFLINE=1 "$image" ./engine -c "
import os, sysconfig, tempfile
from ai.constants import CONST_TASK_DATA_PATH
for d in (CONST_TASK_DATA_PATH, os.environ['HOME'], os.environ['UV_CACHE_DIR'], 'cache', sysconfig.get_paths()['purelib']):
    tempfile.NamedTemporaryFile(dir=d).close()
from depends import depends
depends('$first')
print('another uid writes what a run writes and installs $first')
"
echo "$image: engine probe passed, $total requirement files installed offline, another uid works"
