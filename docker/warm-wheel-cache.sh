#!/bin/sh
# Warms $UV_CACHE_DIR with the wheels a task run installs. Run inside the node
# image build, from /opt/rocketride.
#
# The resolution is the engine's own: depends() compiles every requirement file
# into cache/constraints.txt and installs each file against it, with the
# overrides and excludes it computes. This script installs each file the same
# way, into a throwaway --target instead of site-packages, so the cache holds
# exactly what a run asks for. The image ships cache/constraints.txt, so a run
# reuses that resolution instead of recompiling against a newer PyPI.
#
# - The engine is the interpreter: cp312 / manylinux wheels for this glibc.
# - No torch: the run never installs it (the model server does inference), and
#   its CUDA build alone is gigabytes. Excluded transitively too.
# - Best effort: a file that does not resolve here does not install at run time
#   either. Each one is listed at the end.
# - Each file is also resolved with torch allowed. A file that needs torch goes
#   to $UV_CACHE_DIR/needs-torch.txt and is only allowed where it is installed
#   without a model server (torch_allowed below); anywhere else it would put a
#   CUDA torch into every run, and the build fails. The rest go to
#   $UV_CACHE_DIR/warmed.txt: what the cache promises, and what
#   test-node-image.sh installs offline.
set -eu

# Files that may need torch: installed only without a model server, where the
# run does its own inference (rocketride-server#2443).
torch_allowed() {
    case "$1" in
        ai/common/models/*) return 0 ;;                # model loaders: local path only
        nodes/audio_tts/requirements.txt) return 0 ;;  # depends() only without a model server
        nodes/anonymize/requirements.txt) return 0 ;;  # never installed by the node: GLiNER comes through ai.common.models
    esac
    return 1
}

# The engine resolves: cache/constraints.txt and cache/overrides-combined.txt,
# from every requirement file. In the node image engine-base already did it
# while installing the baseline, so this finds the hash unchanged and returns.
./engine -c "from depends import ensure_constraints; ensure_constraints()"

# The excludes file depends() passes to every install (uv; onnxruntime on Linux).
engine_excludes=$(./engine -c "from depends import _write_excludes_file; print(_write_excludes_file())" | tail -n 1)

constraints=cache/constraints.txt
overrides=cache/overrides-combined.txt
if [ ! -s "$constraints" ]; then
    echo "FATAL: the engine produced no $constraints."
    exit 1
fi
set -- -c "$constraints"
if [ -s "$overrides" ]; then
    set -- "$@" --override "$overrides"
fi

excludes=$(mktemp)
cat "$engine_excludes" > "$excludes"
printf 'torch\ntorchvision\ntorchaudio\n' >> "$excludes"

total=0
failed=''
warmed=''
needs_torch=''
forbidden=''
for req in $(find nodes ai -name 'requirement*.txt' | sort); do
    case "$req" in
        ai/common/torch/*) continue ;;
    esac
    total=$((total + 1))
    target=$(mktemp -d)
    if ! ./bin/uv pip install --quiet \
            -r "$req" \
            "$@" \
            --python ./engine \
            --target "$target" \
            --index-strategy unsafe-best-match \
            --no-build-isolation \
            --excludes "$excludes"; then
        failed="$failed $req"
    elif ./bin/uv pip install --dry-run \
            -r "$req" \
            "$@" \
            --python ./engine \
            --target "$target" \
            --index-strategy unsafe-best-match \
            --no-build-isolation \
            --excludes "$engine_excludes" 2>&1 | grep -qE '^ \+ torch=='; then
        needs_torch="$needs_torch $req"
        torch_allowed "$req" || forbidden="$forbidden $req"
    else
        warmed="$warmed $req"
    fi
    rm -rf "$target"
done
rm -f "$excludes"

for req in $warmed; do echo "$req"; done > "$UV_CACHE_DIR/warmed.txt"
for req in $needs_torch; do echo "$req"; done > "$UV_CACHE_DIR/needs-torch.txt"

echo "Warmed from $total requirement files."
if [ -n "$failed" ]; then
    echo "Did not resolve (fails at run time too):"
    for req in $failed; do echo "  $req"; done
fi
if [ -n "$needs_torch" ]; then
    echo "Need torch, not warmed (installed only without a model server):"
    for req in $needs_torch; do echo "  $req"; done
fi
if [ -n "$forbidden" ]; then
    echo "FATAL: these requirement files pull torch, and a run installs them even with a model server:"
    for req in $forbidden; do echo "  $req"; done
    echo "Drop the dependency that pulls torch, or, if the file is installed only without a model server, add it to torch_allowed with the reason."
    exit 1
fi

# Fail closed on torch: a declaration change must not bring gigabytes back
# unnoticed. Top level of each unpacked wheel only: other packages carry
# subpackages named torch (google-cloud-aiplatform does).
torch=$(find "$UV_CACHE_DIR/archive-v0" -mindepth 2 -maxdepth 2 -type d \( -name torch -o -name nvidia -o -name triton \) -print)
if [ -n "$torch" ]; then
    echo "FATAL: torch reached the wheel cache:"
    echo "$torch" | head -20
    exit 1
fi

du -sh "$UV_CACHE_DIR"
