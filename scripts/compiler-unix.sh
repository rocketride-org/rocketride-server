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

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Setup the global required packages
REQUIRES=()              # macOS (brew) package list
COMMANDS=()              # macOS: install commands to print/run
EXTRA_PKGS=()            # Linux: compiler/clang packages chosen by select_*_triplet
NEED_CC_ALTERNATIVES=""  # apt: set when cc/c++ must be pointed at clang

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
    "|gcc"                                  # fedora: sdist C extensions
    "|gcc-c++"                              # fedora: sdist C++ extensions
    "|perl-core"                            # fedora: vcpkg openssl Configure needs core Perl (IPC::Cmd, FindBin); Fedora modularizes it
    "autoconf"
    "autoconf-archive"
    "automake"
    "libtool"
    "zip"
    "unzip"
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
    "|python3-build"                        # fedora-only
    "|python3-wheel"                        # fedora-only
    # Runtime .so libs the prebuilt/compiled engine links against.
    "libc++1|libcxx"                        # libc++.so.1
    "libc++abi1|libcxxabi"                  # libc++abi.so.1
    "|llvm-libunwind"                       # fedora: clang/libc++ unwinder (apt pulls it via libc++ dev; packaged by tasks.js)
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

# =============================================================================
# Triplet Selection
# =============================================================================

# Detect installed clang version (12 or later)
detect_installed_clang() {
    # Prefer the distro-DEFAULT unversioned `clang` when it's >=12. The image
    # provisions the matching libc++ stack — including the UNVERSIONED
    # libc++-dev / libc++abi-dev that own the multiarch symlink
    # /usr/lib/x86_64-linux-gnu/libc++.so, which is what the linker resolves
    # `-lc++` against. Picking a DIFFERENT (higher) versioned clang here makes
    # the libc++ check below force-install libc++-<higher>-dev, and apt resolves
    # the conflict by REMOVING the unversioned libc++-dev — deleting that
    # symlink and breaking every `-stdlib=libc++` link with
    # `/usr/bin/ld: cannot find -lc++`. Seen on GHA ubuntu-22.04 image
    # 20260525: default clang is 14 but clang-15 is also present, so taking the
    # highest version silently broke the build. Aligning to the default keeps
    # compiler and its fully-installed libc++ in lockstep, no apt mutation.
    if command_exists "clang"; then
        CLANG_VER=$(clang --version | head -n1 | grep -o '[0-9]\+\.[0-9]\+' | head -1 | cut -d. -f1)
        if [ "$CLANG_VER" -ge 12 ] 2>/dev/null; then
            echo "$CLANG_VER"
            return 0
        fi
    fi

    # Fallback: highest installed versioned clang (no usable default `clang`).
    for ver in 18 17 16 15 14 13 12; do
        if command_exists "clang-$ver"; then
            echo "$ver"
            return 0
        fi
    done

    return 1
}

select_linux_triplet() {   # $1 = apt | dnf
    local mgr="$1"
    detect_linux_distro
    
    # First, try to detect if a suitable clang is already installed
    INSTALLED_CLANG=$(detect_installed_clang) || true
    
    TRIPLET_NAME="x64-linux-clang-rocketride.cmake"

    # Fedora/RHEL differ ONLY in the clang packages: an UNVERSIONED clang plus a
    # libcxx-devel stack (Debian uses versioned clang-15 / libc++-15-dev). Same
    # triplet, same downstream flow. cc/c++ is pointed at clang later by
    # setup_cc_alternatives (dnf symlink), so no update-alternatives probing here.
    if [ "$mgr" = "dnf" ]; then
        export CC=clang
        export CXX=clang++
        if [ -n "$INSTALLED_CLANG" ] && [ "$INSTALLED_CLANG" -ge 12 ]; then
            CLANG_VERSION="$INSTALLED_CLANG"
            echo "✓ Compiler: Using clang-$CLANG_VERSION (found and supported)"
            dep_installed dnf libcxx-devel    || EXTRA_PKGS+=("libcxx-devel")
            dep_installed dnf libcxxabi-devel || EXTRA_PKGS+=("libcxxabi-devel")
            dep_installed dnf lld             || EXTRA_PKGS+=("lld")
        else
            echo "✗ Compiler: clang not found or too old (requires clang 12+)"
            echo "→ Will install clang (Fedora unversioned)"
            EXTRA_PKGS+=("clang" "lld" "libcxx-devel" "libcxxabi-devel")
        fi
        TRIPLET_FILE="packages/server/cmake/triplets/$TRIPLET_NAME"
        return 0
    fi

    # Debian/Ubuntu (apt): versioned clang packages.
    # Determine default/recommended version based on distro
    case "$DISTRO" in
        ubuntu)
            case "$VERSION_ID" in
                24.*)
                    DEFAULT_CLANG="18"
                    ;;
                22.*)
                    DEFAULT_CLANG="15"
                    ;;
                20.*)
                    DEFAULT_CLANG="10"
                    ;;
                *)
                    echo "=========================================="
                    echo "ERROR: Unrecognized Ubuntu version $VERSION_ID"
                    echo "=========================================="
                    exit 1
                    ;;
            esac
            ;;
        debian)
            case "$VERSION_ID" in
                12|11)
                    DEFAULT_CLANG="16"
                    ;;
                *)
                    echo "=========================================="
                    echo "ERROR: Unrecognized Debian version $VERSION_ID"
                    echo "=========================================="
                    exit 1
                    ;;
            esac
            ;;
        *)
            echo "=========================================="
            echo "ERROR: Unrecognized Linux distribution $DISTRO"
            echo "=========================================="
            exit 1
            ;;
    esac
    
    # Check if we have a suitable clang
    if [ -n "$INSTALLED_CLANG" ] && [ "$INSTALLED_CLANG" -ge 12 ]; then
        # Use installed clang
        CLANG_VERSION="$INSTALLED_CLANG"
        echo "✓ Compiler: Using clang-$CLANG_VERSION (found and supported)"
        
        # Use generic triplet and set CC/CXX to point to the installed version
        TRIPLET_NAME="x64-linux-clang-rocketride.cmake"

        # CLANG_VERSION is the DEFAULT clang's version (see
        # detect_installed_clang), so its libc++ stack — including the
        # unversioned multiarch libc++.so the linker needs for `-lc++` — is
        # already installed and consistent. Prefer the versioned frontend, but
        # fall back to the bare `clang`/`clang++` when no versioned symlink
        # exists (clang via update-alternatives or a source build) — otherwise
        # we'd set an invalid CC/CXX that only fails later at compile time.
        if command_exists "clang-${CLANG_VERSION}" && command_exists "clang++-${CLANG_VERSION}"; then
            export CC=clang-${CLANG_VERSION}
            export CXX=clang++-${CLANG_VERSION}
        else
            export CC=clang
            export CXX=clang++
        fi
        
        # Check if required libc++ libraries are installed for this version
        if ! dpkg -l "libc++-${CLANG_VERSION}-dev" 2>/dev/null | grep -q "^ii"; then
            echo "  → libc++-${CLANG_VERSION}-dev not found, will install"
            EXTRA_PKGS+=("libc++-${CLANG_VERSION}-dev" "libc++abi-${CLANG_VERSION}-dev" "lld-${CLANG_VERSION}")
        fi
        
    elif [ -n "$INSTALLED_CLANG" ]; then
        # Clang found but too old - install recommended version
        echo "✗ Compiler: clang-$INSTALLED_CLANG found but unsupported (requires clang 12+)"
        echo "→ Will install clang-$DEFAULT_CLANG (recommended for $DISTRO $VERSION_ID)"
        
        CLANG_VERSION="$DEFAULT_CLANG"
        EXTRA_PKGS+=("clang-$CLANG_VERSION" "libc++-${CLANG_VERSION}-dev" "libc++abi-${CLANG_VERSION}-dev" "lld-${CLANG_VERSION}")
        TRIPLET_NAME="x64-linux-clang-rocketride.cmake"
        export CC=clang-${CLANG_VERSION}
        export CXX=clang++-${CLANG_VERSION}
        
    else
        # No clang found - install recommended version
        echo "✗ Compiler: clang not found (requires clang 12+)"
        echo "→ Will install clang-$DEFAULT_CLANG (recommended for $DISTRO $VERSION_ID)"
        
        CLANG_VERSION="$DEFAULT_CLANG"
        EXTRA_PKGS+=("clang-$CLANG_VERSION" "libc++-${CLANG_VERSION}-dev" "libc++abi-${CLANG_VERSION}-dev" "lld-${CLANG_VERSION}")
        TRIPLET_NAME="x64-linux-clang-rocketride.cmake"
        export CC=clang-${CLANG_VERSION}
        export CXX=clang++-${CLANG_VERSION}
    fi
    
    # cc/c++ must resolve to clang for vcpkg's compiler detection. Flag it here;
    # the generic setup_cc_alternatives (run by check_dependencies) applies it
    # via update-alternatives — Fedora does the equivalent with a symlink.
    CC_PATH=$(command -v "$CC" 2>/dev/null)
    CXX_PATH=$(command -v "$CXX" 2>/dev/null)
    CC_LINK=$(readlink -f "$(command -v cc 2>/dev/null)" 2>/dev/null || true)
    CXX_LINK=$(readlink -f "$(command -v c++ 2>/dev/null)" 2>/dev/null || true)
    CC_RESOLVED=""
    CXX_RESOLVED=""
    [ -n "$CC_PATH" ] && CC_RESOLVED=$(readlink -f "$CC_PATH" 2>/dev/null)
    [ -n "$CXX_PATH" ] && CXX_RESOLVED=$(readlink -f "$CXX_PATH" 2>/dev/null)
    if [ -n "$CC_RESOLVED" ] && [ -n "$CXX_RESOLVED" ]; then
        if [ "$CC_RESOLVED" != "$CC_LINK" ] || [ "$CXX_RESOLVED" != "$CXX_LINK" ]; then
            NEED_CC_ALTERNATIVES="1"
        fi
    fi

    TRIPLET_FILE="packages/server/cmake/triplets/$TRIPLET_NAME"
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
            $SUDO apt-get update
            local p
            for p in "$@"; do $SUDO apt-get install -y "$p"; done
            ;;
        dnf) $SUDO dnf install -y "$@" ;;
    esac
}

# The install command shown to the user in non-autoinstall mode ($1 = apt|dnf).
dep_install_hint() {
    case "$1" in
        apt) echo "$SUDO apt-get install -y" ;;
        dnf) echo "$SUDO dnf install -y" ;;
    esac
}

# Point the default cc/c++ at clang so vcpkg's compiler detection doesn't pick
# gcc (which rejects the triplet's -stdlib=libc++). $1 = apt|dnf, $2 = run|print.
# apt uses update-alternatives; Fedora symlinks into /usr/local/bin (ahead of
# /usr/bin in PATH).
setup_cc_alternatives() {
    case "$1" in
        apt)
            [ "$NEED_CC_ALTERNATIVES" = "1" ] || return 0
            if [ "$2" = "run" ]; then
                $SUDO update-alternatives --install /usr/bin/cc cc "$CC_PATH" 100
                $SUDO update-alternatives --install /usr/bin/c++ c++ "$CXX_PATH" 100
                echo "✓ cc/c++ -> $CC/$CXX"
            else
                echo "    # Set default cc/c++ to $CC and $CXX"
                echo "    $SUDO update-alternatives --install /usr/bin/cc cc $CC_PATH 100"
                echo "    $SUDO update-alternatives --install /usr/bin/c++ c++ $CXX_PATH 100"
            fi
            ;;
        dnf)
            if [ "$2" = "run" ] && command_exists clang && command_exists clang++; then
                $SUDO ln -sf "$(command -v clang)" /usr/local/bin/cc
                $SUDO ln -sf "$(command -v clang++)" /usr/local/bin/c++
                echo "✓ cc/c++ -> clang (/usr/local/bin)"
            elif [ "$2" = "print" ]; then
                # Fedora's cc defaults to gcc; point it at clang (ahead of /usr/bin
                # in PATH) so vcpkg's compiler detection doesn't choke on -stdlib=libc++.
                echo "    # Point default cc/c++ at clang"
                echo "    $SUDO ln -sf \"\$(command -v clang)\" /usr/local/bin/cc"
                echo "    $SUDO ln -sf \"\$(command -v clang++)\" /usr/local/bin/c++"
            fi
            ;;
    esac
}

# The one general check: same flow for every distro; only the list + primitives differ.
check_dependencies() {
    local mgr="$1"
    check_linux_python  # hard version gate (python >= 3.10), distro-agnostic
    check_linux_cmake   # hard version gate (cmake >= 3.19), distro-agnostic

    # Package set = shared LINUX_DEPS column + the compiler packages the
    # select_*_triplet chose. This list is the ONLY per-distro input.
    local pkgs=() p
    while IFS= read -r p; do pkgs+=("$p"); done < <(emit_distro_deps "$mgr")
    pkgs+=("${EXTRA_PKGS[@]}")

    local missing=()
    for p in "${pkgs[@]}"; do
        if dep_installed "$mgr" "$p"; then
            echo "✓ $p"
        else
            echo "✗ $p"
            missing+=("$p")
        fi
    done

    if [ "$AUTOINSTALL" == "1" ]; then
        if [ ${#missing[@]} -ne 0 ]; then
            echo "Auto-installing missing dependencies with $mgr..."
            dep_install "$mgr" "${missing[@]}"
            echo ""
            echo "Dependencies installed successfully."
            echo ""
        fi
        setup_cc_alternatives "$mgr" run
    elif [ ${#missing[@]} -ne 0 ] || { [ "$mgr" = "apt" ] && [ "$NEED_CC_ALTERNATIVES" = "1" ]; }; then
        echo "=========================================="
        echo "ERROR: Missing required dependencies - install with:"
        echo ""
        if [ ${#missing[@]} -ne 0 ]; then
            echo "    $(dep_install_hint "$mgr") ${missing[*]}"
        fi
        setup_cc_alternatives "$mgr" print
        echo ""
        echo "Or run with --autoinstall to install them automatically:"
        echo "  ./scripts/compiler-unix.sh --autoinstall"
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
        --help)
            echo "Usage: ./scripts/compiler-unix.sh [options]"
            echo ""
            echo "Options:"
            echo "  --arch x86_64|arm64          Target architecture (default: auto-detect)"
            echo "  --autoinstall                Auto-install missing dependencies"
            echo "  --help                       Show this help"
            exit 0
            ;;
        *)
            echo "=========================================="
            echo "ERROR: unknown parameter \"$1\""
            echo "Usage: ./scripts/compiler-unix.sh [--arch x86_64|arm64] [--autoinstall]"
            echo "=========================================="
            exit 1
            ;;
    esac
done

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

