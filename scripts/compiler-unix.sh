#!/bin/bash
# =============================================================================
# RocketRide Engine - Build Environment Setup (Unix)
# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
#
# This script checks build prerequisites for compiling the server from source.
# Called automatically by server.js on first compile.
#
# Usage: ./scripts/compiler-unix.sh [--arch x86_64|arm64] [--autoinstall]
# =============================================================================

set -e

# Navigate to project root
cd "$(dirname "$0")/.."

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Setup the global required packages
REQUIRES=()
COMMANDS=()

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
    # Try to find any clang version 12 or later that's already installed
    for ver in 18 17 16 15 14 13 12; do
        if command_exists "clang-$ver"; then
            echo "$ver"
            return 0
        fi
    done
    
    # Check if generic 'clang' command exists and get its version
    if command_exists "clang"; then
        CLANG_VER=$(clang --version | head -n1 | grep -o '[0-9]\+\.[0-9]\+' | head -1 | cut -d. -f1)
        if [ "$CLANG_VER" -ge 12 ] 2>/dev/null; then
            echo "$CLANG_VER"
            return 0
        fi
    fi
    
    return 1
}

select_linux_triplet() {
    detect_linux_distro
    
    # First, try to detect if a suitable clang is already installed
    INSTALLED_CLANG=$(detect_installed_clang) || true
    
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
        
        # Check if generic clang/clang++ exist, otherwise use versioned ones
        if command_exists "clang" && command_exists "clang++"; then
            export CC=clang
            export CXX=clang++
        else
            export CC=clang-${CLANG_VERSION}
            export CXX=clang++-${CLANG_VERSION}
        fi
        
        # Check if required libc++ libraries are installed for this version
        if ! dpkg -l "libc++-${CLANG_VERSION}-dev" 2>/dev/null | grep -q "^ii"; then
            echo "  → libc++-${CLANG_VERSION}-dev not found, will install"
            REQUIRES+=("libc++-${CLANG_VERSION}-dev" "libc++abi-${CLANG_VERSION}-dev" "lld-${CLANG_VERSION}")
        fi
        
    elif [ -n "$INSTALLED_CLANG" ]; then
        # Clang found but too old - install recommended version
        echo "✗ Compiler: clang-$INSTALLED_CLANG found but unsupported (requires clang 12+)"
        echo "→ Will install clang-$DEFAULT_CLANG (recommended for $DISTRO $VERSION_ID)"
        
        CLANG_VERSION="$DEFAULT_CLANG"
        REQUIRES+=("clang-$CLANG_VERSION" "libc++-${CLANG_VERSION}-dev" "libc++abi-${CLANG_VERSION}-dev" "lld-${CLANG_VERSION}")
        TRIPLET_NAME="x64-linux-clang-rocketride.cmake"
        export CC=clang-${CLANG_VERSION}
        export CXX=clang++-${CLANG_VERSION}
        
    else
        # No clang found - install recommended version
        echo "✗ Compiler: clang not found (requires clang 12+)"
        echo "→ Will install clang-$DEFAULT_CLANG (recommended for $DISTRO $VERSION_ID)"
        
        CLANG_VERSION="$DEFAULT_CLANG"
        REQUIRES+=("clang-$CLANG_VERSION" "libc++-${CLANG_VERSION}-dev" "libc++abi-${CLANG_VERSION}-dev" "lld-${CLANG_VERSION}")
        TRIPLET_NAME="x64-linux-clang-rocketride.cmake"
        export CC=clang-${CLANG_VERSION}
        export CXX=clang++-${CLANG_VERSION}
    fi
    
    TRIPLET_FILE="packages/server/engine-core/cmake/triplets/$TRIPLET_NAME"
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
    
    TRIPLET_FILE="packages/server/engine-core/cmake/triplets/$TRIPLET_NAME"
}

# =============================================================================
# Dependency Checks - Linux
# =============================================================================

check_linux_sudo() {
    if ! command_exists "sudo"; then
        COMMANDS+=("    # Installing sudo")
        COMMANDS+=("    apt update")
        COMMANDS+=("    apt install -y sudo")
    fi
}

check_linux_cmake() {
    if ! command_exists "wget"; then
        COMMANDS+=("    # Installing wget")
        COMMANDS+=("    sudo apt install -y wget")
    fi

    if command_exists cmake; then
        CMAKE_VERSION=$(cmake --version | head -n1 | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
        CMAKE_MAJOR=$(echo "$CMAKE_VERSION" | cut -d. -f1)
        CMAKE_MINOR=$(echo "$CMAKE_VERSION" | cut -d. -f2)
        
        if [ "$CMAKE_MAJOR" -lt 3 ] || [ "$CMAKE_MAJOR" -eq 3 -a "$CMAKE_MINOR" -lt 19 ]; then
            echo "CMake version $CMAKE_VERSION is too old (minimum required: 3.19)"
            COMMANDS+=("    # Updating CMake")
            COMMANDS+=("    sudo rm -f /usr/local/bin/cmake* && sudo rm -rf /opt/cmake*")
            COMMANDS+=("    (cd /tmp && wget https://github.com/Kitware/CMake/releases/download/v3.30.1/cmake-3.30.1-linux-x86_64.tar.gz)")
            COMMANDS+=("    (cd /tmp && tar -xzf cmake-3.30.1-linux-x86_64.tar.gz && sudo mv cmake-3.30.1-linux-x86_64 /opt/cmake)")
            COMMANDS+=("    sudo ln -sf /opt/cmake/bin/* /usr/local/bin/")
        fi
        if [ "$CMAKE_MAJOR" -gt 3 ]; then
            echo "CMake version $CMAKE_VERSION is too new (must be < version 4)"
            COMMANDS+=("    # Downgrading CMake")
            COMMANDS+=("    sudo rm -f /usr/local/bin/cmake* && sudo rm -rf /opt/cmake*")
            COMMANDS+=("    (cd /tmp && wget https://github.com/Kitware/CMake/releases/download/v3.30.1/cmake-3.30.1-linux-x86_64.tar.gz)")
            COMMANDS+=("    (cd /tmp && tar -xzf cmake-3.30.1-linux-x86_64.tar.gz && sudo mv cmake-3.30.1-linux-x86_64 /opt/cmake)")
            COMMANDS+=("    sudo ln -sf /opt/cmake/bin/* /usr/local/bin/")
        fi
    else
        COMMANDS+=("    # Installing CMake")
        COMMANDS+=("    sudo rm -f /usr/local/bin/cmake* && sudo rm -rf /opt/cmake*")
        COMMANDS+=("    (cd /tmp && wget https://github.com/Kitware/CMake/releases/download/v3.30.1/cmake-3.30.1-linux-x86_64.tar.gz)")
        COMMANDS+=("    (cd /tmp && tar -xzf cmake-3.30.1-linux-x86_64.tar.gz && sudo mv cmake-3.30.1-linux-x86_64 /opt/cmake)")
        COMMANDS+=("    sudo ln -sf /opt/cmake/bin/* /usr/local/bin/")
    fi
}

check_linux_python() {
    if command_exists python3; then
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
    else
        echo ""
        echo "=========================================="
        echo "ERROR: Python 3 is not installed!"
        echo "Minimum required version: Python 3.10"
        echo "=========================================="
        echo ""
        exit 1
    fi
}

check_linux_dependencies() {
    check_linux_sudo
    check_linux_cmake
    check_linux_python

    REQUIRES+=(
        "sudo"
        "curl"
        "wget"
        "dos2unix"
        "ca-certificates"
        "gnupg"
        "lsb-release"
        "python3"
        "python3-pip"
        "python3-venv"
        "make"
        "ninja-build"
        "git"
        "autoconf"
        "autoconf-archive"
        "automake"
        "libtool"
        "zip"
        "unzip"
        "uuid-dev"
        "pkg-config"
        "libffi-dev"
        "libssl-dev"
        "libsqlite3-dev"
        "libbz2-dev"
        "libreadline-dev"
        "libexpat1-dev"
        "libncurses-dev"  # Also accepts libncurses5-dev on older systems
        "libgdbm-dev"
        "libdb-dev"
        "liblzma-dev"
        "libxmlsec1-dev"
        "zlib1g-dev"
    )

    for package in "${REQUIRES[@]}"; do
        case "$package" in
            sudo)
                if ! command_exists "sudo"; then
                    echo "✗ sudo"
                    COMMANDS+=("    # Install sudo")
                    COMMANDS+=("    apt install -y sudo")
                else
                    echo "✓ sudo"
                fi
                ;;
            gnupg)
                if ! command_exists "gpg"; then
                    echo "✗ gnupg: gpg not available"
                    COMMANDS+=("    # Install package gnupg")
                    COMMANDS+=("    sudo apt install gnupg")
                else
                    echo "✓ gnupg: gpg available"
                fi
                ;;
            libncurses-dev)
                # Ubuntu 24.04+ uses libncurses-dev, older systems use libncurses5-dev/libncursesw5-dev
                if ! dpkg -l "libncurses-dev" 2>/dev/null | grep -q "^ii" && \
                   ! dpkg -l "libncurses5-dev" 2>/dev/null | grep -q "^ii"; then
                    echo "✗ libncurses-dev"
                    COMMANDS+=("    # Install development library (ncurses)")
                    COMMANDS+=("    sudo apt install -y libncurses-dev")
                else
                    echo "✓ ncurses"
                fi
                ;;
            *-dev)
                if ! dpkg -l "$package" 2>/dev/null | grep -q "^ii"; then
                    echo "✗ $package"
                    COMMANDS+=("    # Install development library $package")
                    COMMANDS+=("    sudo apt install -y $package")
                else
                    echo "✓ $package"
                fi
                ;;
            *)
                local cmd_name="$package"
                case "$package" in
                    ninja-build) cmd_name="ninja" ;;
                    libtool) cmd_name="libtoolize" ;;
                    dos2unix) cmd_name="dos2unix" ;;
                    ca-certificates) cmd_name="update-ca-certificates" ;;
                    python3-pip) cmd_name="pip3" ;;
                    python3-venv) cmd_name="python3" ;;
                    autoconf-archive | lsb-release)
                        if ! dpkg -l "$package" 2>/dev/null | grep -q "^ii"; then
                            echo "✗ $package"
                            COMMANDS+=("    # Install package $package")
                            COMMANDS+=("    sudo apt install -y $package")
                        else
                            echo "✓ $package"
                        fi
                        continue
                        ;;
                esac
                
                if ! command_exists "$cmd_name"; then
                    if [ "$package" == "$cmd_name" ]; then
                        echo "✗ $package"
                    else
                        echo "✗ $package: $cmd_name not available"
                    fi
                    COMMANDS+=("    # Install package $package")
                    COMMANDS+=("    sudo apt install -y $package")
                else
                    if [ "$package" == "$cmd_name" ]; then
                        echo "✓ $package"
                    else
                        echo "✓ $package: $cmd_name available"
                    fi
                fi
                ;;
        esac
    done
    
    if [ ${#COMMANDS[@]} -ne 0 ]; then
        if [ "$AUTOINSTALL" == "1" ]; then
            echo "Auto-installing missing dependencies..."
            echo ""
            echo "Updating apt..."
            sudo apt update
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
            COMMANDS+=("    # Upgrading CMake to 3.30.1")
            COMMANDS+=("    (cd /tmp && curl -LO https://cmake.org/files/v3.30/cmake-3.30.1-macos-universal.tar.gz)")
            COMMANDS+=("    (cd /tmp && tar -xzf cmake-3.30.1-macos-universal.tar.gz)")
            COMMANDS+=("    sudo mv /tmp/cmake-3.30.1-macos-universal /Applications/CMake-3.30.1")
            COMMANDS+=("    sudo rm -f /usr/local/bin/cmake /usr/local/bin/ctest /usr/local/bin/cpack")
            COMMANDS+=("    sudo ln -sf /Applications/CMake-3.30.1/CMake.app/Contents/bin/cmake /usr/local/bin/cmake")
            COMMANDS+=("    sudo ln -sf /Applications/CMake-3.30.1/CMake.app/Contents/bin/ctest /usr/local/bin/ctest")
            COMMANDS+=("    sudo ln -sf /Applications/CMake-3.30.1/CMake.app/Contents/bin/cpack /usr/local/bin/cpack")
            COMMANDS+=("    rm -f /tmp/cmake-3.30.1-macos-universal.tar.gz")
        fi
        if [ "$CMAKE_MAJOR" -gt 3 ]; then
            echo "CMake version $CMAKE_VERSION is too new (must be < version 4)"
            COMMANDS+=("    # Downgrading CMake to 3.30.1")
            COMMANDS+=("    brew uninstall cmake --ignore-dependencies || true")
            COMMANDS+=("    (cd /tmp && curl -LO https://cmake.org/files/v3.30/cmake-3.30.1-macos-universal.tar.gz)")
            COMMANDS+=("    (cd /tmp && tar -xzf cmake-3.30.1-macos-universal.tar.gz)")
            COMMANDS+=("    sudo mv /tmp/cmake-3.30.1-macos-universal /Applications/CMake-3.30.1")
            COMMANDS+=("    sudo rm -f /usr/local/bin/cmake /usr/local/bin/ctest /usr/local/bin/cpack")
            COMMANDS+=("    sudo ln -sf /Applications/CMake-3.30.1/CMake.app/Contents/bin/cmake /usr/local/bin/cmake")
            COMMANDS+=("    sudo ln -sf /Applications/CMake-3.30.1/CMake.app/Contents/bin/ctest /usr/local/bin/ctest")
            COMMANDS+=("    sudo ln -sf /Applications/CMake-3.30.1/CMake.app/Contents/bin/cpack /usr/local/bin/cpack")
            COMMANDS+=("    rm -f /tmp/cmake-3.30.1-macos-universal.tar.gz")
        fi
    else
        echo "CMake is not installed. Installing CMake 3.30.1..."
        COMMANDS+=("    # Installing CMake 3.30.1")
        COMMANDS+=("    (cd /tmp && curl -LO https://cmake.org/files/v3.30/cmake-3.30.1-macos-universal.tar.gz)")
        COMMANDS+=("    (cd /tmp && tar -xzf cmake-3.30.1-macos-universal.tar.gz)")
        COMMANDS+=("    sudo mv /tmp/cmake-3.30.1-macos-universal /Applications/CMake-3.30.1")
        COMMANDS+=("    sudo ln -sf /Applications/CMake-3.30.1/CMake.app/Contents/bin/cmake /usr/local/bin/cmake")
        COMMANDS+=("    sudo ln -sf /Applications/CMake-3.30.1/CMake.app/Contents/bin/ctest /usr/local/bin/ctest")
        COMMANDS+=("    sudo ln -sf /Applications/CMake-3.30.1/CMake.app/Contents/bin/cpack /usr/local/bin/cpack")
        COMMANDS+=("    rm -f /tmp/cmake-3.30.1-macos-universal.tar.gz")
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

if [[ "$OSTYPE" == "linux-gnu" ]]; then
    select_linux_triplet
    check_linux_dependencies
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
    echo "  sudo apt install -y ${MISSING_TOOLS[*]}"
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

