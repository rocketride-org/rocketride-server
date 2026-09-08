#!/bin/bash
# =============================================================================
# RocketRide Engine - Build Environment Setup (Unix)
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# This script checks build prerequisites for compiling the server from source.
# Called automatically by server.js on first compile.
#
# Usage: ./scripts/compiler-unix.sh [--arch x86_64|arm64] [--autoinstall]
# =============================================================================

set -e

# Navigate to project root
cd "$(dirname "$0")/.."

# Detect whether we're running as root (Docker container, automation,
# minimal install) so the auto-install path doesn't unconditionally
# invoke `sudo`. Containers typically don't ship `sudo`, so prefixing
# `apt-get` with `sudo` crashes the install before any package lands.
# `apt-get` itself works fine when called as root.
if [ "$EUID" -eq 0 ]; then
    SUDO=""
else
    SUDO="sudo"
fi

# ~/toolchains installs must belong to the invoking user, not root, even under
# sudo. Resolve the real user/home from SUDO_* and chown back afterward.
REAL_USER="${SUDO_USER:-$(id -un)}"
if [ -n "${SUDO_USER:-}" ]; then
    REAL_HOME=$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)
fi
REAL_HOME="${REAL_HOME:-$HOME}"

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# True if privileged commands can run non-interactively (already root, or
# passwordless/pre-authenticated sudo). The builder captures stdio, so a sudo that
# would prompt for a password counts as "no root".
have_root() {
    [ "$EUID" -eq 0 ] && return 0
    command_exists sudo && sudo -n true 2>/dev/null
}

# Run a command as the invoking user, dropping root when the script runs under sudo
# — so ~/toolchains installs are never owned by root.
as_user() {
    if [ "$EUID" -eq 0 ] && [ -n "$REAL_USER" ] && [ "$REAL_USER" != "root" ]; then
        sudo -u "$REAL_USER" -- "$@"
    else
        "$@"
    fi
}

# Setup the global required packages
REQUIRES=()              # macOS (brew) package list
COMMANDS=()              # macOS: install commands to print/run
SYSTEM_COMPILER=""          # --system-compiler: install a compatible clang system-wide via apt/dnf
LLVM_TARBALL_VERSION=""     # set when no usable system clang → fetch LLVM from llvm.org into ~/toolchains
CLANG_PKGS=()               # apt/dnf clang packages to install (--system-compiler)
CLANG_ALT_VERSION=""        # versioned clang to force via update-alternatives (apt --system-compiler)
LLVM_APT_VERSION=""         # apt.llvm.org clang major to add when the distro archive lacks it (--system-compiler)
LLVM_TARBALL_PREFIX="$REAL_HOME/toolchains/llvm"  # user-local install root (no root needed to unpack)
LLVM_TARBALL_FALLBACK="18.1.8"  # used only if the latest 18.x can't be discovered online
DUMP_SYMS_DIR="$REAL_HOME/toolchains/bin"  # user-local bin for build tools (dump_syms); on the build PATH via tasks.js
DUMP_SYMS_VERSION="v2.3.7"  # pinned: the releases/latest API is unauthenticated and rate-limited on CI

# Supported clang range on Linux: 16 (Crashpad needs C++20 <ranges>) .. 18
# (engine doesn't build with clang >= 19). Install target is clang-18.
MIN_CLANG=16
MAX_CLANG=18

# Single source of truth for the shared Linux build deps: one row per logical
# dependency as "apt|dnf". An empty field means the dep is not needed on that
# distro. Both check paths project their own column, so adding a build dep is a
# one-line edit that reaches Debian and Fedora together — no drift between two
# hand-kept lists. Compiler/clang packages stay out of this table (resolved
# per-distro by the select_* funcs).
LINUX_DEPS=(
    # Row shorthand:  "name" = same package on both;  "apt|dnf" = differing names;
    #                 "apt|" = apt-only;  "|dnf" = dnf-only.
    "sudo"
    "curl"
    "wget"
    "dos2unix"
    "ca-certificates"
    "tzdata"                                # /usr/share/zoneinfo — libc++ std::chrono tz lookups abort without it (minimal Ubuntu 22.04/24.04 omit it)
    "gnupg|gnupg2"
    "lsb-release|"                          # apt-only: Fedora build path doesn't use lsb_release
    "python3"
    "python3-pip"
    "python3-venv|"                         # apt-only: Fedora uses python3-devel/build/wheel instead
    "|python3-devel"                        # fedora: cffi/cryptography/Cython sdist builds
    "make"
    "ninja-build"
    "cmake"                                 # version gated (>= 3.19) by check_linux_cmake
    "git"
    "gcc"                                   # C compiler + crt objects the llvm.org clang links on every distro; also sdist C extensions
    "g++|gcc-c++"                           # provides libstdc++.so — clang's DEFAULT (non-libc++) link and CMake's compiler check need it; also sdist C++ extensions
    "|perl-core"                            # fedora: vcpkg openssl Configure needs core Perl (IPC::Cmd, FindBin); Fedora modularizes it
    "autoconf"
    "autoconf-archive"
    "automake"
    "libtool"
    "zip"
    "unzip"
    "xz-utils|xz"                           # `xz` CLI: tar -xJf unpacks the .tar.xz LLVM/dump_syms tarballs (minimal Ubuntu 24.04+ omits it)
    "uuid-dev|libuuid-devel"
    "pkg-config|pkgconf-pkg-config"
    "libffi-dev|libffi-devel"
    "libssl-dev|openssl-devel"
    "|kernel-headers"                       # fedora: vcpkg openssl needs <linux/*>/<asm/*> (apt: linux-libc-dev)
    "libsqlite3-dev|sqlite-devel"
    "libbz2-dev|bzip2-devel"
    "libreadline-dev|readline-devel"
    "libexpat1-dev|expat-devel"
    "libncurses-dev|ncurses-devel"          # apt also accepts libncurses5-dev on older systems
    "libgdbm-dev|gdbm-devel"
    "libdb-dev|libdb-devel"
    "liblzma-dev|xz-devel"
    "libxmlsec1-dev|xmlsec1-devel"
    "|xmlsec1-openssl-devel"                # fedora: split out (bundled in libxmlsec1-dev on apt)
    "zlib1g-dev|zlib-devel"
    "python3-build"                         # PEP 517 build frontend (apt: universe)
    "python3-wheel"                         # wheel backend (apt: universe)
    # Runtime .so libs the prebuilt/compiled engine links against.
    "libc++1|libcxx"                        # libc++.so.1
    "libc++abi1|libcxxabi"                  # libc++abi.so.1
    "|llvm-libunwind"                       # fedora: clang/libc++ unwinder (apt pulls it via libc++ dev; packaged by tasks.js)
    "libatomic1|libatomic"                  # libatomic.so.1 — vcpkg build tools (icupkg/ICU) link it; absent on minimal EL, and gcc doesn't pull it on dnf
    "libgomp1|libgomp"                      # OMP runtime for bundled transitive deps
    "libgles2|mesa-libGLES"                 # libGLESv2.so.2 — MediaPipe GPU-delegate dlopen
    "libegl1|libglvnd-egl"                  # libEGL.so.1
)

# Emit one column of LINUX_DEPS: "apt" -> field 1, "dnf" -> field 2. Rows whose
# selected field is empty are skipped (dep not needed on that distro).
emit_distro_deps() {
    local entry name
    for entry in "${LINUX_DEPS[@]}"; do
        if [ "$1" = "apt" ]; then name="${entry%%|*}"; else name="${entry##*|}"; fi
        [ -n "$name" ] && echo "$name"
    done
}

# =============================================================================
# Linux Distribution Detection
# =============================================================================

detect_linux_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO=$ID
        VERSION_ID=$VERSION_ID
    else
        echo "=========================================="
        echo "ERROR: Cannot detect Linux distribution"
        echo "=========================================="
        exit 1
    fi
}

# True on the RHEL / Enterprise-Linux family (AlmaLinux, Rocky, RHEL, CentOS,
# Oracle) — NOT Fedora. Both use dnf, but EL ships a far smaller default package
# set, so the dnf column needs EL-specific handling (extra repos + a few drops).
is_el_family() {
    [ -r /etc/os-release ] || return 1
    ( . /etc/os-release
      case " $ID $ID_LIKE " in
          *" rhel "*|*" centos "*|*" almalinux "*|*" rocky "*|*" ol "*) exit 0 ;;
      esac
      exit 1 )
}

# EL BaseOS/AppStream are minimal; enable CRB (CodeReady Builder) and EPEL so the
# dnf column resolves. On AlmaLinux 10 these carry ncurses-compat-libs
# (libtinfo.so.5), python3-build/wheel and libdb-devel — all absent from the base
# repos. Best-effort: a leg without these repos still surfaces via the strict
# post-install re-check.
enable_el_repos() {
    # config-manager ships in dnf-plugins-core (dnf4) or dnf5-plugins (dnf5).
    $SUDO dnf install -y dnf-plugins-core >/dev/null 2>&1 \
        || $SUDO dnf install -y dnf5-plugins >/dev/null 2>&1 || true
    # Enable CRB (EL9/10) / PowerTools (EL8); --set-enabled is dnf4, setopt is dnf5.
    $SUDO dnf config-manager --set-enabled crb >/dev/null 2>&1 \
        || $SUDO dnf config-manager setopt crb.enabled=1 >/dev/null 2>&1 \
        || $SUDO dnf config-manager --set-enabled powertools >/dev/null 2>&1 || true
    $SUDO dnf install -y epel-release >/dev/null 2>&1 || true
}

# =============================================================================
# Triplet Selection
# =============================================================================

# Bare clang major version if it's within [MIN_CLANG, MAX_CLANG], else empty. Only
# the bare `clang` counts: the triplet invokes bare `clang++`, and we don't touch
# system alternatives, so a versioned-only clang-N wouldn't be reachable.
detect_installed_clang() {
    command_exists clang || return 1
    local v
    v=$(clang --version | head -n1 | grep -o '[0-9]\+' | head -1)
    [ -n "$v" ] && [ "$v" -ge "$MIN_CLANG" ] 2>/dev/null && [ "$v" -le "$MAX_CLANG" ] 2>/dev/null || return 1
    echo "$v"
}

# True if bare clang++ can compile+link a trivial -stdlib=libc++ program (matching
# libc++ headers + runtime present).
clang_libcxx_works() {
    local t; t=$(mktemp -d)
    printf '#include <vector>\nint main(){std::vector<int> v; return (int)v.size();}\n' > "$t/t.cpp"
    local ok=0
    clang++ -stdlib=libc++ "$t/t.cpp" -o "$t/t" >/dev/null 2>&1 && ok=1
    rm -rf "$t"
    [ "$ok" = 1 ]
}

# Major version the unversioned `clang` package would install (i.e. what bare clang
# would become), or empty. Lets us decide whether apt/dnf can cleanly provide a
# compatible compiler on a box that has no clang at all.
pkg_default_clang_version() {
    case "$1" in
        apt)
            [ "$AUTOINSTALL" = "1" ] && $SUDO apt-get update -qq 2>/dev/null || true
            apt-cache policy clang 2>/dev/null \
                | sed -nE 's/^[[:space:]]*Candidate:[[:space:]]*([0-9]+:)?([0-9]+).*/\2/p' | head -1
            ;;
        dnf)
            dnf -q info clang 2>/dev/null \
                | sed -nE 's/^Version[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' | head -1
            ;;
    esac
}

in_clang_range() { [ -n "$1" ] && [ "$1" -ge "$MIN_CLANG" ] 2>/dev/null && [ "$1" -le "$MAX_CLANG" ] 2>/dev/null; }

# Does the distro's own apt archive carry an install candidate for clang-$1?
apt_archive_has_clang() {
    apt-cache policy "clang-$1" 2>/dev/null | grep -qE 'Candidate: [0-9]'
}

# Add apt.llvm.org for clang-$1 when the distro archive lacks it (e.g. Ubuntu 22.04
# tops out at clang-15). Idempotent by the sources file; rolls back a broken repo.
ensure_llvm_repo() {
    local ver="$1" codename list="/etc/apt/sources.list.d/llvm-toolchain-$1.list"
    [ -f "$list" ] && return 0
    command_exists wget || { echo "ERROR: wget is required to add apt.llvm.org (install it or re-run with --autoinstall)"; return 1; }
    command_exists gpg  || { echo "ERROR: gpg is required to add apt.llvm.org (install it or re-run with --autoinstall)"; return 1; }
    codename=$(. /etc/os-release 2>/dev/null; printf '%s' "${VERSION_CODENAME:-}")
    [ -z "$codename" ] && { echo "ERROR: cannot determine apt codename for apt.llvm.org (clang-$ver)"; return 1; }
    echo "→ adding apt.llvm.org ($codename) for clang-$ver"
    $SUDO install -d -m 0755 /etc/apt/keyrings || return 1
    # Stage via temp files: a plain wget|gpg|tee pipe reports tee's exit (not
    # wget's), so a failed key download would silently write an empty keyring.
    # (Can't capture the dearmored key in a var — it's binary, and bash strips NULs.)
    local tmpkey; tmpkey=$(mktemp)
    wget -qO "$tmpkey" https://apt.llvm.org/llvm-snapshot.gpg.key \
        || { rm -f "$tmpkey"; echo "ERROR: failed to download the apt.llvm.org GPG key"; return 1; }
    gpg --dearmor < "$tmpkey" > "$tmpkey.gpg" \
        || { rm -f "$tmpkey" "$tmpkey.gpg"; echo "ERROR: failed to dearmor the apt.llvm.org GPG key"; return 1; }
    $SUDO install -m 0644 "$tmpkey.gpg" /etc/apt/keyrings/apt.llvm.org.gpg \
        || { rm -f "$tmpkey" "$tmpkey.gpg"; return 1; }
    rm -f "$tmpkey" "$tmpkey.gpg"
    echo "deb [signed-by=/etc/apt/keyrings/apt.llvm.org.gpg] http://apt.llvm.org/${codename}/ llvm-toolchain-${codename}-${ver} main" \
        | $SUDO tee "$list" >/dev/null || return 1
    $SUDO apt-get update || { $SUDO rm -f "$list"; return 1; }
}

# Force bare clang/clang++/cc/c++ at clang-$1 via /usr/local/bin (ahead of /usr/bin)
# — a versioned apt install leaves /usr/bin/clang pointing at the old default.
force_system_clang() {
    local v="$1" cc cxx
    cc=$(command -v "clang-$v" 2>/dev/null); cxx=$(command -v "clang++-$v" 2>/dev/null)
    { [ -z "$cc" ] || [ -z "$cxx" ]; } && { echo "ERROR: clang-$v not on PATH after install"; exit 1; }
    $SUDO ln -sf "$cc" /usr/local/bin/clang
    $SUDO ln -sf "$cxx" /usr/local/bin/clang++
    $SUDO ln -sf "$cc" /usr/local/bin/cc
    $SUDO ln -sf "$cxx" /usr/local/bin/c++
    echo "✓ clang/clang++/cc/c++ -> clang-$v (/usr/local/bin)"
}

# --system-compiler: pick a system-wide clang install. Sets CLANG_PKGS /
# CLANG_ALT_VERSION / LLVM_APT_VERSION. Returns 0 if the package manager can provide
# clang 16-18 (erroring out if root is unavailable), 1 if it can't (→ tarball). $1=apt|dnf.
select_system_clang() {
    local mgr="$1" cand
    cand=$(pkg_default_clang_version "$mgr")
    if [ "$mgr" = "dnf" ]; then
        # Fedora's default clang (22) is out of range and its compat clangNN lacks a
        # matching libc++ — dnf can't assemble a 16-18 toolchain. Only the (rare)
        # in-range default is usable; otherwise fall back to the tarball.
        in_clang_range "$cand" || return 1
        CLANG_PKGS=(clang libcxx-devel libcxxabi-devel lld); CLANG_VERSION="$cand"
    elif in_clang_range "$cand"; then
        # Default clang package is already 16-18 (e.g. Ubuntu 24.04) — bare clang++
        # becomes it, no alternatives needed.
        CLANG_PKGS=(clang libc++-dev libc++abi-dev lld); CLANG_VERSION="$cand"
    else
        # Install versioned clang-18, from the archive or apt.llvm.org, then repoint.
        # Its versioned libc++1-N replaces the distro's unversioned libc++1 (dropped
        # below) to avoid the apt "held broken packages" ping-pong.
        local v="$MAX_CLANG"
        apt_archive_has_clang "$v" || LLVM_APT_VERSION="$v"
        CLANG_PKGS=(clang-"$v" libc++-"$v"-dev libc++abi-"$v"-dev libc++1-"$v" libc++abi1-"$v" lld-"$v")
        CLANG_ALT_VERSION="$v"; CLANG_VERSION="$v"
    fi

    if ! have_root; then
        echo "=========================================="
        echo "ERROR: --system-compiler needs root to install clang-$CLANG_VERSION via $mgr."
        echo "Re-run with sudo (or pre-authenticate: sudo -v), or drop --system-compiler"
        echo "to use the local ~/toolchains toolchain instead."
        echo "=========================================="
        exit 1
    fi
    echo "→ --system-compiler: installing clang-$CLANG_VERSION system-wide via $mgr${LLVM_APT_VERSION:+ (apt.llvm.org)}"
    return 0
}

# Compiler policy (uniform Fedora/Ubuntu):
#   1. bare clang is 16-18 with a complete toolchain (libc++ works + ld.lld, since
#      Crashpad forces -fuse-ld=lld) → use it as-is.
#   2. --system-compiler → install a compatible clang system-wide via apt/dnf
#      (apt: archive or apt.llvm.org, + repoint clang++). Needs root.
#   3. otherwise → self-contained LLVM toolchain into ~/toolchains (root-free); the
#      JS build env points the build at it.
# $1 = apt|dnf.
select_linux_triplet() {
    local mgr="$1"
    detect_linux_distro
    TRIPLET_NAME="x64-linux-clang-rocketride.cmake"
    TRIPLET_FILE="packages/server/cmake/triplets/$TRIPLET_NAME"
    export CC=clang
    export CXX=clang++

    INSTALLED_CLANG=$(detect_installed_clang || true)
    if [ -n "$INSTALLED_CLANG" ] && command_exists ld.lld && clang_libcxx_works; then
        CLANG_VERSION="$INSTALLED_CLANG"
        echo "✓ Compiler: system clang-$CLANG_VERSION (in range; libc++ + lld OK)"
        return 0
    fi

    if [ -n "$SYSTEM_COMPILER" ] && select_system_clang "$mgr"; then
        return 0
    fi

    LLVM_TARBALL_VERSION="$MAX_CLANG"
    CLANG_VERSION="$MAX_CLANG"
    if [ -n "$SYSTEM_COMPILER" ]; then
        echo "→ $mgr has no clang $MIN_CLANG-$MAX_CLANG; using ~/toolchains/llvm-$MAX_CLANG"
    elif command_exists clang; then
        echo "→ system clang incompatible (need $MIN_CLANG-$MAX_CLANG); using ~/toolchains/llvm-$MAX_CLANG"
    else
        echo "→ using ~/toolchains/llvm-$MAX_CLANG"
    fi
    return 0
}

select_macos_triplet() {
    if [[ -z "$TARGET_ARCH" ]]; then
        ARCH=$(arch)
    else
        ARCH="$TARGET_ARCH"
    fi
    
    echo "Target Architecture: ${ARCH}"
    
    if [[ "$ARCH" == "arm64" ]]; then
        TRIPLET_NAME="arm64-osx-appleclang-rocketride.cmake"
    elif [[ "$ARCH" == "x86_64" ]] || [[ "$ARCH" == "i386" ]]; then
        TRIPLET_NAME="x64-osx-appleclang-rocketride.cmake"
    else
        echo "=========================================="
        echo "ERROR: Unknown architecture: $ARCH"
        echo "=========================================="
        exit 1
    fi
    
    export CC=clang
    export CXX=clang++
    
    TRIPLET_FILE="packages/server/cmake/triplets/$TRIPLET_NAME"
}

# =============================================================================
# Dependency Checks - Linux
# =============================================================================

check_linux_python() {
    # Version gate only: a python3 already on the system that is older than 3.10
    # can't be fixed by the package manager, so fail fast. If python3 is absent
    # it's installed via the dependency list below — don't exit here (Fedora and
    # minimal images ship without it).
    command_exists python3 || return 0

    PYTHON_VERSION=$(python3 --version 2>&1 | grep -o '[0-9]\+\.[0-9]\+' | head -1)
    PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
    PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)
    if [ "$PYTHON_MAJOR" -lt 3 ] || [ "$PYTHON_MAJOR" -eq 3 -a "$PYTHON_MINOR" -lt 10 ]; then
        echo ""
        echo "=========================================="
        echo "ERROR: Python version $PYTHON_VERSION is too old!"
        echo "Minimum required version: Python 3.10"
        echo ""
        echo "Please use one of the following:"
        echo "  - Ubuntu 22.04 or newer (has Python 3.10+)"
        echo "  - Debian 12 or newer (has Python 3.11+)"
        echo "=========================================="
        echo ""
        exit 1
    fi
}

check_linux_cmake() {
    # Version gate only (mirrors check_linux_python): a cmake already on the
    # system that is older than 3.19 can't be upgraded by the package manager on
    # older distros (Ubuntu 20.04 ships 3.16), so fail fast with a clear message
    # instead of a confusing configure-time error. If cmake is absent it's
    # installed via the dependency list.
    command_exists cmake || return 0

    local CMAKE_VERSION CMAKE_MAJOR CMAKE_MINOR
    CMAKE_VERSION=$(cmake --version | head -n1 | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
    CMAKE_MAJOR=$(echo "$CMAKE_VERSION" | cut -d. -f1)
    CMAKE_MINOR=$(echo "$CMAKE_VERSION" | cut -d. -f2)
    if [ "$CMAKE_MAJOR" -lt 3 ] || [ "$CMAKE_MAJOR" -eq 3 -a "$CMAKE_MINOR" -lt 19 ]; then
        echo ""
        echo "=========================================="
        echo "ERROR: CMake version $CMAKE_VERSION is too old!"
        echo "Minimum required version: CMake 3.19"
        echo "=========================================="
        echo ""
        exit 1
    fi
}

# apt and dnf share ALL the dependency machinery below. The ONLY per-distro
# inputs are the package LIST (apt|dnf columns of LINUX_DEPS) and three tiny
# primitives: test-installed, install-set, point-cc-at-clang. The loop,
# missing-detection and autoinstall-vs-print-and-exit flow live once in
# check_dependencies().

# Is package $2 installed? ($1 = apt|dnf). dpkg works without root, so it also
# avoids the ca-certificates root-only-PATH false negative (#370). dnf's
# --whatprovides resolves virtual provides (wget2-wget, zlib-ng-compat-devel,
# libglvnd-gles) that a plain `rpm -q <name>` would miss.
dep_installed() {
    case "$1" in
        apt)
            # Ubuntu 24.04+ ships libncurses-dev; older releases use libncurses5-dev.
            if [ "$2" = "libncurses-dev" ]; then
                dpkg -l libncurses-dev 2>/dev/null | grep -q "^ii" || \
                dpkg -l libncurses5-dev 2>/dev/null | grep -q "^ii"
            else
                dpkg -l "$2" 2>/dev/null | grep -q "^ii"
            fi
            ;;
        dnf)
            rpm -q --whatprovides "$2" >/dev/null 2>&1
            ;;
    esac
}

# Install the missing packages ($1 = apt|dnf, $2.. = packages). apt installs one
# at a time: on Ubuntu 22.04 a single transaction mixing libc++1 (v14) and
# libc++-15-dev (wants libc++1-15) dead-locks apt ("held broken packages");
# sequential installs resolve cleanly. dnf resolves the whole set in one shot.
dep_install() {
    local mgr="$1"; shift
    case "$mgr" in
        apt)
            $SUDO apt-get update || return 1
            local p
            for p in "$@"; do $SUDO apt-get install -y "$p" || return 1; done
            ;;
        dnf) $SUDO dnf install -y "$@" || return 1 ;;
    esac
}

# Put a genuine libtinfo.so.5 into $1 (a dir on the build LD_LIBRARY_PATH) WITHOUT
# root. The llvm.org clang is built against ncurses 5: it needs libtinfo.so.5 with
# the NCURSES_TINFO_5 versioned symbols, which libtinfo.so.6 does NOT export — so a
# .so.6 -> .so.5 symlink fails to load. Sources it root-free into lib-compat: an
# apt-get download, then (Ubuntu 24.04+, where the package is gone) a pinned jammy
# .deb by URL, verified by sha256; dnf uses ncurses-compat-libs (also pulled
# system-wide under --autoinstall on dnf, see check_dependencies).
# $1 = target dir, $2 = apt|dnf.
provide_libtinfo5() {
    local compat="$1" mgr="$2" existing real tmp deb rpm larch ldeb lurl lsha

    # A genuine libtinfo.so.5 already on the system (e.g. installed above) → link it.
    existing=$(ldconfig -p 2>/dev/null | grep -oE '/[^ ]*/libtinfo\.so\.5(\.[0-9]+)*' | head -1)
    [ -n "$existing" ] && { as_user ln -sf "$existing" "$compat/libtinfo.so.5"; return 0; }

    # Otherwise fetch the distro's compat package and extract just the .so (no root).
    tmp=$(as_user mktemp -d)
    case "$mgr" in
        apt)
            as_user sh -c "cd '$tmp' && apt-get download libtinfo5" >/dev/null 2>&1 || true
            deb=$(ls "$tmp"/*.deb 2>/dev/null | head -1)
            # Ubuntu 24.04+ dropped libtinfo5, so apt-get download finds nothing.
            # Fall back to a pinned jammy .deb — it still ships a genuine
            # libtinfo.so.5 that the tarball clang loads.
            if [ -z "$deb" ]; then
                # This path bypasses apt's signed index, and the .so it yields is
                # loaded by clang on every build via lib-compat on LD_LIBRARY_PATH.
                # The digest is the only thing vouching for the file, so a mismatch
                # must discard it rather than fall through.
                case "$(uname -m)" in
                    x86_64)        larch=amd64
                                   lurl="https://archive.ubuntu.com/ubuntu/pool/universe/n/ncurses"
                                   lsha=b9bb64e716a7d9de05b1b33992763142ca81bcae3a7f8ce7e29fa3c6fd32f1e8 ;;
                    aarch64|arm64) larch=arm64
                                   lurl="https://ports.ubuntu.com/ubuntu-ports/pool/universe/n/ncurses"
                                   lsha=79498b68a0253005d483021563414f8595bd3d81a3d32af08fc5ba04ff4b9631 ;;
                esac
                if [ -n "$larch" ]; then
                    ldeb="libtinfo5_6.3-2ubuntu0.2_${larch}.deb"
                    if ! as_user curl -fsSL --retry 3 -o "$tmp/$ldeb" "$lurl/$ldeb" >/dev/null 2>&1; then
                        echo "⚠ could not download $ldeb — the pin may have been superseded in the pool"
                    elif ! (cd "$tmp" && echo "$lsha  $ldeb" | sha256sum -c -) >/dev/null 2>&1; then
                        echo "⚠ $ldeb failed its sha256 check — discarding it"
                        as_user rm -f "$tmp/$ldeb"
                    fi
                    deb=$(ls "$tmp"/*.deb 2>/dev/null | head -1)
                fi
            fi
            [ -n "$deb" ] && as_user dpkg-deb -x "$deb" "$tmp/x" >/dev/null 2>&1 || true
            ;;
        dnf)
            as_user sh -c "cd '$tmp' && dnf download ncurses-compat-libs" >/dev/null 2>&1 || true
            rpm=$(ls "$tmp"/*.rpm 2>/dev/null | head -1)
            [ -n "$rpm" ] && { as_user mkdir -p "$tmp/x"; as_user sh -c "cd '$tmp/x' && rpm2cpio '$rpm' | cpio -idm" >/dev/null 2>&1 || true; }
            ;;
    esac
    real=$(find "$tmp/x" -name 'libtinfo.so.5*' -type f 2>/dev/null | head -1)
    [ -n "$real" ] && as_user cp -f "$real" "$compat/libtinfo.so.5"
    as_user rm -rf "$tmp"
    [ -e "$compat/libtinfo.so.5" ]
}

# Linux fallback: unpack the latest ver.x clang+llvm release (bundles libc++)
# into ~/toolchains, root-free — used when no in-range system clang is available
# (all of Fedora; Ubuntu without --system-compiler).
# $1 = major version, $2 = run|print, $3 = apt|dnf.
install_llvm_tarball() {
    local ver="$1" mode="$2" mgr="${3:-apt}"
    local prefix="$LLVM_TARBALL_PREFIX-$ver"

    if [ "$mode" = "print" ]; then
        echo "No supported clang $MIN_CLANG-$MAX_CLANG with a matching libc++ is installed."
        echo "A self-contained LLVM $ver toolchain (bundles its own libc++) will be"
        echo "unpacked into $prefix (user-local, no root needed)."
        return 0
    fi

    if [ -x "$prefix/bin/clang++" ] && [ -f "$prefix/include/c++/v1/__config" ]; then
        echo "✓ LLVM $ver toolchain present at $prefix"
    else
        # curl not here yet: defer to the --autoinstall retry (which installs curl).
        command_exists curl || { echo "⚠ curl not available yet; will fetch the LLVM toolchain after deps install"; return 0; }
        local arch asset_re
        arch=$(uname -m)
        # The '+' in clang+llvm is %2B-encoded in the asset URL.
        case "$arch" in
            x86_64)        asset_re='clang(\+|%2[Bb])llvm-[0-9.]+-x86_64-linux-gnu[^"]*\.tar\.xz' ;;
            aarch64|arm64) asset_re='clang(\+|%2[Bb])llvm-[0-9.]+-aarch64-linux-gnu[^"]*\.tar\.xz' ;;
            *) echo "ERROR: no prebuilt LLVM tarball for arch $arch; install one manually from https://github.com/llvm/llvm-project/releases"; exit 1 ;;
        esac

        # Latest ver.x point release (no rc); fall back to a known-good pin offline.
        local pin
        pin=$(git ls-remote --tags --refs https://github.com/llvm/llvm-project.git "llvmorg-$ver.*" 2>/dev/null \
              | grep -oE "llvmorg-$ver\.[0-9]+\.[0-9]+$" | sed 's/llvmorg-//' | sort -V | tail -1)
        [ -z "$pin" ] && pin="$LLVM_TARBALL_FALLBACK"

        local url
        url=$(curl -fsSL "https://api.github.com/repos/llvm/llvm-project/releases/tags/llvmorg-$pin" 2>/dev/null \
              | grep -oE '"browser_download_url": *"[^"]+"' | cut -d'"' -f4 \
              | grep -E "$asset_re" | head -1)
        if [ -z "$url" ]; then
            echo "=========================================="
            echo "ERROR: no self-contained clang+llvm $pin tarball ($arch) in the llvm.org"
            echo "release assets. Install an LLVM $MIN_CLANG-$MAX_CLANG toolchain manually from"
            echo "https://github.com/llvm/llvm-project/releases, then re-run."
            echo "=========================================="
            exit 1
        fi

        echo "→ downloading LLVM $pin toolchain ($arch, a few hundred MB)..."
        echo "  $url"
        local tmp; tmp=$(as_user mktemp -d)
        if ! as_user curl -fSL --retry 3 -o "$tmp/llvm.tar.xz" "$url"; then
            as_user rm -rf "$tmp"; echo "ERROR: failed to download the LLVM toolchain"; exit 1
        fi
        echo "→ unpacking into $prefix ..."
        as_user mkdir -p "$prefix"
        if ! as_user tar -xJf "$tmp/llvm.tar.xz" -C "$prefix" --strip-components=1; then
            as_user rm -rf "$tmp" "$prefix"; echo "ERROR: failed to unpack the LLVM toolchain"; exit 1
        fi
        as_user rm -rf "$tmp"
        if [ ! -f "$prefix/include/c++/v1/__config" ]; then
            echo "ERROR: the downloaded LLVM tarball did not include libc++ headers ($prefix)"; exit 1
        fi
        echo "✓ LLVM $pin toolchain installed at $prefix"
    fi

    # The llvm.org clang needs a real libtinfo.so.5 (a libtinfo.so.6 symlink fails:
    # the NCURSES_TINFO_5 versioned symbols are absent). On dnf --autoinstall it's
    # already installed system-wide; otherwise (all apt distros) fetch it root-free
    # into lib-compat, which tasks.js puts on the build LD_LIBRARY_PATH.
    local compat="$prefix/lib-compat"
    as_user mkdir -p "$compat"
    if ! LD_LIBRARY_PATH="$compat" "$prefix/bin/clang" --version >/dev/null 2>&1; then
        provide_libtinfo5 "$compat" "$mgr" || true
        LD_LIBRARY_PATH="$compat" "$prefix/bin/clang" --version >/dev/null 2>&1 \
            || echo "⚠ $prefix/bin/clang still can't load its libs (check: ldd $prefix/bin/clang)"
    fi

    echo "✓ LLVM $ver toolchain ready at $prefix (build tools use it via env)"
}

# Install Mozilla dump_syms (prebuilt) into ~/toolchains/bin, root-free. Best-effort:
# symbol generation is non-fatal. $1 = run|print.
install_dump_syms() {
    local mode="$1" bin="$DUMP_SYMS_DIR/dump_syms"

    if [ "$mode" = "print" ]; then
        echo "dump_syms (crash-symbol generator) is missing — shipped builds need it."
        echo "--autoinstall fetches the prebuilt binary into $bin."
        return 0
    fi

    if command_exists dump_syms; then echo "✓ dump_syms ($(command -v dump_syms))"; return 0; fi
    if [ -x "$bin" ] && "$bin" --version >/dev/null 2>&1; then echo "✓ dump_syms ($bin)"; return 0; fi

    command_exists curl || { echo "⚠ curl not available yet; skipping dump_syms (re-run after deps install)"; return 0; }
    local os arch asset
    os=$(uname -s); arch=$(uname -m)
    case "$os/$arch" in
        Linux/x86_64)  asset='dump_syms-x86_64-unknown-linux-gnu.tar.xz' ;;
        Darwin/arm64)  asset='dump_syms-aarch64-apple-darwin.tar.xz' ;;
        Darwin/x86_64) asset='dump_syms-x86_64-apple-darwin.tar.xz' ;;
        *) echo "⚠ no prebuilt dump_syms for $os/$arch — install it manually (cargo install dump_syms) for crash symbols"; return 0 ;;
    esac

    # Build the release URL from the pinned tag: querying releases/latest needs no auth
    # but is IP-rate-limited, and a throttled reply silently skipped the install.
    local url="https://github.com/mozilla/dump_syms/releases/download/$DUMP_SYMS_VERSION/$asset"

    echo "→ downloading dump_syms ($arch)..."
    local tmp; tmp=$(as_user mktemp -d)
    if ! as_user curl -fSL --retry 3 -o "$tmp/ds.tar.xz" "$url"; then
        as_user rm -rf "$tmp"; echo "⚠ failed to download dump_syms — skipping (symbols won't be generated)"; return 0
    fi
    as_user mkdir -p "$DUMP_SYMS_DIR"
    as_user tar -xJf "$tmp/ds.tar.xz" -C "$tmp"
    local extracted; extracted=$(find "$tmp" -name dump_syms -type f | head -1)
    [ -z "$extracted" ] && { as_user rm -rf "$tmp"; echo "⚠ dump_syms binary not in the archive — skipping"; return 0; }
    as_user cp -f "$extracted" "$bin"; as_user chmod +x "$bin"; as_user rm -rf "$tmp"
    "$bin" --version >/dev/null 2>&1 || { echo "⚠ installed dump_syms can't run ($bin) — skipping"; return 0; }
    echo "✓ dump_syms installed ($bin)"
}

# The install command shown to the user in non-autoinstall mode ($1 = apt|dnf).
dep_install_hint() {
    case "$1" in
        apt) echo "$SUDO apt-get install -y" ;;
        dnf) echo "$SUDO dnf install -y" ;;
    esac
}

# The one general check: same flow for every distro; only the list + primitives differ.
check_dependencies() {
    local mgr="$1"
    check_linux_python  # hard version gate (python >= 3.10), distro-agnostic
    check_linux_cmake   # hard version gate (cmake >= 3.19), distro-agnostic

    local el_family=0
    is_el_family && el_family=1

    # Package set = shared LINUX_DEPS column + any clang packages select_system_clang
    # chose. For a versioned apt clang install, drop the distro's unversioned
    # libc++1/libc++abi1 — the versioned libc++1-N in CLANG_PKGS supersedes them.
    local pkgs=() p
    while IFS= read -r p; do
        if [ -n "$CLANG_ALT_VERSION" ] && { [ "$p" = "libc++1" ] || [ "$p" = "libc++abi1" ]; }; then continue; fi
        # libcxx/libcxxabi/llvm-libunwind are Fedora-only and bundled inside the
        # LLVM tarball the EL leg downloads — RHEL/EL packages none of them.
        if [ "$el_family" = 1 ] && { [ "$p" = "libcxx" ] || [ "$p" = "libcxxabi" ] || [ "$p" = "llvm-libunwind" ]; }; then continue; fi
        pkgs+=("$p")
    done < <(emit_distro_deps "$mgr")
    pkgs+=("${CLANG_PKGS[@]}")

    # The llvm.org tarball clang needs a real libtinfo.so.5 (ncurses 5). On dnf we
    # pull ncurses-compat-libs system-wide. On apt we deliberately do NOT add
    # libtinfo5 here: it was dropped from Ubuntu 24.04+ repos, so a strict install
    # would abort the whole apt batch. The root-free provide_libtinfo5 (with its
    # pinned-.deb fallback) supplies libtinfo.so.5 into lib-compat instead.
    if [ -n "$LLVM_TARBALL_VERSION" ] && [ "$AUTOINSTALL" = "1" ]; then
        case "$mgr" in
            dnf) pkgs+=(ncurses-compat-libs) ;;
        esac
    fi

    local missing=()
    for p in "${pkgs[@]}"; do
        if dep_installed "$mgr" "$p"; then
            echo "✓ $p"
        else
            echo "✗ $p"
            missing+=("$p")
        fi
    done

    # dump_syms isn't a distro package — OK if on PATH or in ~/toolchains/bin.
    local dump_syms_ok=""
    if command_exists dump_syms || { [ -x "$DUMP_SYMS_DIR/dump_syms" ] && "$DUMP_SYMS_DIR/dump_syms" --version >/dev/null 2>&1; }; then
        dump_syms_ok="1"; echo "✓ dump_syms"
    else
        echo "✗ dump_syms"
    fi

    # Policy: distro packages (root) need --autoinstall; root-free ~/toolchains
    # downloads (LLVM toolchain, dump_syms) install regardless.

    # Distro packages (root) — only under --autoinstall.
    if [ "$AUTOINSTALL" == "1" ] && [ ${#missing[@]} -ne 0 ]; then
        echo "Auto-installing missing dependencies with $mgr..."
        # EL base repos are minimal — turn on CRB + EPEL so ncurses-compat-libs,
        # python3-build/wheel and libdb-devel are resolvable before the install.
        if [ "$mgr" = "dnf" ] && [ "$el_family" = 1 ]; then
            enable_el_repos
        fi
        # --system-compiler on a distro whose archive lacks clang-18 (e.g. Ubuntu
        # 22.04): add apt.llvm.org first.
        if [ -n "$LLVM_APT_VERSION" ] && ! ensure_llvm_repo "$LLVM_APT_VERSION"; then
            echo "=========================================="
            echo "ERROR: could not set up apt.llvm.org for clang-$LLVM_APT_VERSION"
            echo "=========================================="
            exit 1
        fi
        # A failed install must stop the build. Without this the script would
        # continue and report success, and the missing runtime libs only
        # surface much later as "libc++.so.1: cannot open shared object file".
        if ! dep_install "$mgr" "${missing[@]}"; then
            echo ""
            echo "=========================================="
            echo "ERROR: $mgr failed to install dependencies."
            echo "Read the package manager errors above, fix them, then re-run:"
            echo "  ./scripts/compiler-unix.sh --autoinstall"
            echo "=========================================="
            exit 1
        fi
        # Re-check every package. A package manager can exit 0 without installing
        # everything (unknown package name, held package). Verify before claiming
        # success so a partial install is not silently accepted.
        local still_missing=() m
        for m in "${missing[@]}"; do
            dep_installed "$mgr" "$m" || still_missing+=("$m")
        done
        if [ ${#still_missing[@]} -ne 0 ]; then
            echo ""
            echo "=========================================="
            echo "ERROR: these packages are still missing after install:"
            echo "    ${still_missing[*]}"
            echo "Check the package names for this distro, then re-run:"
            echo "  ./scripts/compiler-unix.sh --autoinstall"
            echo "=========================================="
            exit 1
        fi
        missing=()
        echo ""
        echo "Dependencies installed successfully."
        echo ""
    fi

    # --system-compiler versioned install: repoint bare clang++/cc/c++ at clang-N.
    [ "$AUTOINSTALL" == "1" ] && [ -n "$CLANG_ALT_VERSION" ] && force_system_clang "$CLANG_ALT_VERSION"

    # Root-free tools: always (after package install so curl/tar are present).
    [ -n "$LLVM_TARBALL_VERSION" ] && install_llvm_tarball "$LLVM_TARBALL_VERSION" run "$mgr"
    [ -z "$dump_syms_ok" ] && install_dump_syms run

    # Missing distro packages without --autoinstall? Report + stop.
    if [ "$AUTOINSTALL" != "1" ] && [ ${#missing[@]} -ne 0 ]; then
        echo "=========================================="
        echo "ERROR: missing packages need root — re-run with --autoinstall."
        echo ""
        echo "Missing: ${missing[*]}"
        echo ""
        echo "Re-run the build with one of:"
        echo "    ./builder server:build --autoinstall"
        echo "        install deps; use a LOCAL clang toolchain in ~/toolchains (no system change)"
        echo "    ./builder server:build --autoinstall --system-compiler"
        echo "        install deps; install clang SYSTEM-WIDE via $mgr (updates the default clang++)"
        echo "=========================================="
        exit 1
    fi
}

# =============================================================================
# Dependency Checks - macOS
# =============================================================================

check_xcode_tools() {
    if ! xcode-select -p &>/dev/null; then
        echo "Xcode Command Line Tools not installed"
        COMMANDS+=("    # Install Xcode Command Line Tools")
        COMMANDS+=("    xcode-select --install")
        COMMANDS+=("    # Note: A dialog will appear - click Install and wait for completion")
    else
        echo "[OK] Xcode Command Line Tools: $(xcode-select -p)"
    fi
}

check_mac_cmake() {
    if command_exists cmake; then
        CMAKE_VERSION=$(cmake --version | head -n1 | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
        CMAKE_MAJOR=$(echo "$CMAKE_VERSION" | cut -d. -f1)
        CMAKE_MINOR=$(echo "$CMAKE_VERSION" | cut -d. -f2)

        if [ "$CMAKE_MAJOR" -lt 3 ] || [ "$CMAKE_MAJOR" -eq 3 -a "$CMAKE_MINOR" -lt 19 ]; then
            echo "CMake version $CMAKE_VERSION is too old (minimum required: 3.19)"
            COMMANDS+=("    # Upgrading CMake")
            COMMANDS+=("    brew upgrade cmake")
        fi
    else
        echo "CMake is not installed."
        COMMANDS+=("    # Installing CMake")
        COMMANDS+=("    brew install cmake")
    fi
}

check_mac_dependencies() {
    if ! command_exists brew; then
        echo "=========================================="
        echo "ERROR: Homebrew is not installed. Please install it first:"
        echo "  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        echo "=========================================="
        exit 1
    fi

    check_xcode_tools
    check_mac_cmake

    REQUIRES+=(
        "curl"
        "wget"
        "dos2unix"
        "python3"
        "gnupg"
        "ninja"
        "git"
        "autoconf"
        "autoconf-archive"
        "automake"
        "libtool"
        "pkg-config"
    )

    for package in "${REQUIRES[@]}"; do
        case "$package" in
            autoconf-archive)
                if ! brew list autoconf-archive &>/dev/null; then
                    COMMANDS+=("    # Install package autoconf-archive")
                    COMMANDS+=("    brew install autoconf-archive")
                fi
                ;;
            libtool)
                if ! command_exists "glibtoolize"; then
                    COMMANDS+=("    # Install package libtool")
                    COMMANDS+=("    brew install libtool")
                fi
                ;;
            gnupg)
                if ! command_exists "gpg"; then
                    COMMANDS+=("    # Install package gnupg")
                    COMMANDS+=("    brew install gnupg")
                fi
                ;;
            *)
                if ! command_exists "$package"; then
                    COMMANDS+=("    # Install package $package")
                    COMMANDS+=("    brew install $package")
                fi
                ;;
        esac
    done

    if command_exists brew && brew list libtool &>/dev/null; then
        if ! command_exists glibtoolize; then
            echo "glibtoolize not accessible - Homebrew libtool needs relinking"
            COMMANDS+=("    # Fix libtool symlinks")
            COMMANDS+=("    brew unlink libtool && brew link libtool")
        fi
    fi

    # dump_syms: root-free download, always installed (best-effort).
    if command_exists dump_syms || { [ -x "$DUMP_SYMS_DIR/dump_syms" ] && "$DUMP_SYMS_DIR/dump_syms" --version >/dev/null 2>&1; }; then
        echo "[OK] dump_syms"
    else
        install_dump_syms run
    fi

    if [ ${#COMMANDS[@]} -ne 0 ]; then
        if [ "$AUTOINSTALL" == "1" ]; then
            echo "Auto-installing missing dependencies..."
            echo ""
            echo "Updating Homebrew..."
            brew update
            for cmd in "${COMMANDS[@]}"; do
                if [[ "$cmd" == *"# "* ]]; then
                    echo "$cmd"
                    continue
                fi
                clean_cmd=$(echo "$cmd" | sed 's/^[[:space:]]*//')
                echo "Executing: $clean_cmd"
                eval "$clean_cmd"
            done
            echo ""
            echo "Dependencies installed successfully."
            echo ""
        else
            echo "=========================================="
            echo "ERROR: Missing required dependencies - please execute the following commands:"
            echo ""
            echo "    brew update"
            for cmd in "${COMMANDS[@]}"; do
                echo "$cmd"
            done
            echo ""
            echo "Or run with --autoinstall to install them automatically:"
            echo "  ./scripts/compiler-unix.sh --autoinstall"
            echo ""
            echo "=========================================="
            exit 1
        fi
    fi
}

# =============================================================================
# Parse Arguments
# =============================================================================

TARGET_ARCH=""
AUTOINSTALL="0"

while [[ $# -gt 0 ]]; do
    case $1 in
        --arch)
            TARGET_ARCH="$2"
            if [[ "$TARGET_ARCH" != "x86_64" ]] && [[ "$TARGET_ARCH" != "arm64" ]]; then
                echo "=========================================="
                echo "ERROR: Invalid architecture '$TARGET_ARCH'. Must be 'x86_64' or 'arm64'"
                echo "=========================================="
                exit 1
            fi
            shift
            shift
            ;;
        --autoinstall)
            AUTOINSTALL="1"
            shift
            ;;
        --system-compiler)
            SYSTEM_COMPILER="1"
            shift
            ;;
        --help)
            echo "Usage: ./scripts/compiler-unix.sh [options]"
            echo ""
            echo "Options:"
            echo "  --arch x86_64|arm64          Target architecture (default: auto-detect)"
            echo "  --autoinstall                Auto-install missing dependencies"
            echo "  --system-compiler            Install a compatible clang system-wide via apt/dnf"
            echo "                               (needs root); default keeps it local in ~/toolchains"
            echo "  --help                       Show this help"
            exit 0
            ;;
        *)
            echo "=========================================="
            echo "ERROR: unknown parameter \"$1\""
            echo "Usage: ./scripts/compiler-unix.sh [--arch x86_64|arm64] [--autoinstall] [--system-compiler]"
            echo "=========================================="
            exit 1
            ;;
    esac
done

# --system-compiler installs packages, which only happens under --autoinstall.
if [ -n "$SYSTEM_COMPILER" ] && [ "$AUTOINSTALL" != "1" ]; then
    echo "=========================================="
    echo "ERROR: --system-compiler requires --autoinstall (it installs packages)."
    echo "Use: ./scripts/compiler-unix.sh --autoinstall --system-compiler"
    echo "=========================================="
    exit 1
fi

# =============================================================================
# Platform-specific setup
# =============================================================================

echo "Checking build prerequisites..."
echo ""

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Branch by package manager. Fedora / RHEL-family use dnf+rpm; everything
    # else stays on the apt+dpkg path. Both share check_dependencies(); only the
    # package manager (list column + install/query primitives) differs.
    detect_linux_distro
    case "$DISTRO" in
        fedora|rhel|centos|rocky|almalinux)
            select_linux_triplet dnf
            check_dependencies dnf
            ;;
        *)
            select_linux_triplet apt
            check_dependencies apt
            ;;
    esac
elif [[ "$OSTYPE" == "darwin"* ]]; then
    select_macos_triplet
    check_mac_dependencies
else
    echo "=========================================="
    echo "ERROR: Unrecognized OS type $OSTYPE"
    echo "=========================================="
    exit 1
fi

echo "[OK] All build prerequisites satisfied"
echo ""

# =============================================================================
# Install Python build tools
# =============================================================================

echo "Checking Python build tools..."

# Check if build/wheel are available (via pip or apt)
check_python_tool() {
    local pkg_name="$1"
    python3 -c "import $pkg_name" 2>/dev/null && return 0
    python3 -m pip show "$pkg_name" >/dev/null 2>&1 && return 0
    dpkg -l "python3-$pkg_name" 2>/dev/null | grep -q "^ii" && return 0
    return 1
}

MISSING_TOOLS=()
check_python_tool "build" || MISSING_TOOLS+=("python3-build")
check_python_tool "wheel" || MISSING_TOOLS+=("python3-wheel")

if [ ${#MISSING_TOOLS[@]} -ne 0 ]; then
    echo ""
    echo "=========================================="
    echo "Missing Python build tools. Please install:"
    echo "  $SUDO apt install -y ${MISSING_TOOLS[*]}"
    echo ""
    echo "Or with pip (Ubuntu 24.04+ requires --break-system-packages):"
    echo "  pip install build wheel --break-system-packages"
    echo "=========================================="
    echo ""
    exit 1
fi

echo "[OK] Python build tools"
echo ""

# =============================================================================
# Done
# =============================================================================

