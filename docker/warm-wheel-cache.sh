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
# - No local inference runtime: torch and onnxruntime. The run never installs
#   them (the model server does inference); torch's CUDA build alone is
#   gigabytes, and onnxruntime-gpu, the one depends() installs on Linux, is
#   430 MB of CUDA kernels for a container without a GPU. Excluded transitively
#   too.
# - Best effort: a file that does not resolve here does not install at run time
#   either. Each one is listed at the end.
# - Each file is also resolved with them allowed. A file that needs one goes to
#   $UV_CACHE_DIR/needs-inference.txt and is only allowed where it is installed
#   without a model server (inference_allowed below); anywhere else every run
#   would download it, and the build fails. The rest go to
#   $UV_CACHE_DIR/warmed.txt: what the cache promises, and what
#   test-node-image.sh installs offline.
set -eu

# Files that may need torch or onnxruntime: installed only without a model
# server, where the run does its own inference (rocketride-server#2443).
inference_allowed() {
    case "$1" in
        ai/common/models/*) return 0 ;;                        # model loaders: local path only
        nodes/audio_tts/requirements.txt) return 0 ;;          # depends() only without a model server
        nodes/anonymize/requirements.txt) return 0 ;;          # never installed by the node: GLiNER comes through ai.common.models
        nodes/audio_transcribe/requirements.txt) return 0 ;;   # never installed by the node: Whisper comes through ai.common.models
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
printf 'torch\ntorchvision\ntorchaudio\nonnxruntime\nonnxruntime-gpu\n' >> "$excludes"

total=0
failed=''
warmed=''
needs_inference=''
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
            --excludes "$engine_excludes" 2>&1 | grep -qE '^ \+ (torch|onnxruntime|onnxruntime-gpu)=='; then
        needs_inference="$needs_inference $req"
        inference_allowed "$req" || forbidden="$forbidden $req"
    else
        warmed="$warmed $req"
    fi
    rm -rf "$target"
done
rm -f "$excludes"

for req in $warmed; do echo "$req"; done > "$UV_CACHE_DIR/warmed.txt"
for req in $needs_inference; do echo "$req"; done > "$UV_CACHE_DIR/needs-inference.txt"

echo "Warmed from $total requirement files."
if [ -n "$failed" ]; then
    echo "Did not resolve (fails at run time too):"
    for req in $failed; do echo "  $req"; done
fi
if [ -n "$needs_inference" ]; then
    echo "Need torch or onnxruntime, not warmed (installed only without a model server):"
    for req in $needs_inference; do echo "  $req"; done
fi
if [ -n "$forbidden" ]; then
    echo "FATAL: these requirement files pull torch or onnxruntime, and a run installs them even with a model server:"
    for req in $forbidden; do echo "  $req"; done
    echo "Drop the dependency that pulls it, or, if the file is installed only without a model server, add it to inference_allowed with the reason."
    exit 1
fi

# Fail closed on both: a declaration change must not bring them back unnoticed.
# Top level of each unpacked wheel only: other packages carry subpackages named
# torch (google-cloud-aiplatform does).
runtimes=$(find "$UV_CACHE_DIR/archive-v0" -mindepth 2 -maxdepth 2 -type d \( -name torch -o -name nvidia -o -name triton -o -name onnxruntime \) -print)
if [ -n "$runtimes" ]; then
    echo "FATAL: a local inference runtime reached the wheel cache:"
    echo "$runtimes" | head -20
    exit 1
fi

du -sh "$UV_CACHE_DIR"
