# Source this to point CC/CXX/PATH at the RocketRide clang toolchain for manual
# builds, matching what the builder uses:
#
#     . scripts/setenvs.sh
#
# If ~/toolchains/llvm-18 exists (the self-contained toolchain the setup fetched),
# it's used; otherwise the system clang is assumed. Also puts ~/toolchains/bin
# (dump_syms) on PATH. Safe to source repeatedly.

_rr_home="$HOME"
if [ -n "${SUDO_USER:-}" ]; then
    _rr_home=$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)
    _rr_home="${_rr_home:-$HOME}"
fi

# dump_syms and other build tools.
[ -d "$_rr_home/toolchains/bin" ] && export PATH="$_rr_home/toolchains/bin:$PATH"

LLVM18="$_rr_home/toolchains/llvm-18"
if [ -x "$LLVM18/bin/clang++" ]; then
    _rr_arch=$(uname -m); [ "$_rr_arch" = "arm64" ] && _rr_arch=aarch64
    export LLVM18
    export PATH="$LLVM18/bin:$PATH"
    export CC="$LLVM18/bin/clang"
    export CXX="$LLVM18/bin/clang++"
    export LD_LIBRARY_PATH="$LLVM18/lib-compat:$LLVM18/lib/${_rr_arch}-unknown-linux-gnu:${LD_LIBRARY_PATH:-}"
    echo "RocketRide: using local LLVM toolchain at $LLVM18"
    unset _rr_arch
else
    export CC=clang
    export CXX=clang++
    echo "RocketRide: using system clang ($(command -v clang 2>/dev/null || echo 'not found'))"
fi

unset _rr_home
