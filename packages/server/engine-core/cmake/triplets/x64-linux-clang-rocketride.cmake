# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

set(ROCKETRIDE_TRIPLET clang)

set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_CMAKE_SYSTEM_NAME Linux)
set(VCPKG_BUILD_TYPE release)

# General linking order:
# crt1.o crti.o crtbegin.o [-L paths] [user objects] [gcc libs] [C libs] [gcc libs] crtend.o crtn.o


# debug - full symbols, embedded
# release - symbols, optimized
# note - we do not specify DEBUG in our debug flags for linux due to
# issues with some dependencies
set(TOOLCHAIN_FLAGS_DEBUG "-g -fstandalone-debug -O0")
set(TOOLCHAIN_FLAGS_RELEASE "-g -O2 -DNDEBUG")

# Fixes curl build
set(THREADS_PTHREAD_ARG "2" CACHE STRING "Fix curl" FORCE)
set(HAVE_POLL_FINE_EXITCODE "ON" CACHE STRING "Fix curl" FORCE)
set(HAVE_POLL_FINE_EXITCODE__TRYRUN_OUTPUT "" CACHE STRING "Fix curl" FORCE)

# Basic settings
set(CMAKE_C_COMPILER "clang" CACHE STRING "" FORCE)
set(CMAKE_CXX_COMPILER "clang++" CACHE STRING "" FORCE)

# Common definitions across c++/c
set(TOOLCHAIN_FLAGS "-Wno-trigraphs -Wno-unused-value -Wno-switch -Wfatal-errors -Wno-deprecated-declarations")
set(TOOLCHAIN_FLAGS "${TOOLCHAIN_FLAGS} -fPIC -msse3 -mssse3 -msse4 -maes -msha ")

# Enable errors for if (val = 1), force use of new c++ 20 'if statement with initializer' feature instead if (val = 1; val)
set(TOOLCHAIN_FLAGS "${TOOLCHAIN_FLAGS} -Werror=parentheses")

# Enable errors for (while obj = ...)
set(TOOLCHAIN_FLAGS "${TOOLCHAIN_FLAGS} -Werror=idiomatic-parentheses")

# Allow various logical operators
set(TOOLCHAIN_FLAGS "${TOOLCHAIN_FLAGS} -Wno-logical-op-parentheses")

# Default flags
set(CMAKE_CXX_FLAGS "-stdlib=libc++ -Winvalid-pch ${TOOLCHAIN_FLAGS}" CACHE STRING "" FORCE)
set(CMAKE_C_FLAGS "-Winvalid-pch ${TOOLCHAIN_FLAGS}" CACHE STRING "" FORCE)

# Catch2 flags
# NOTE: Catch2 flags also set to vcpkg flags, as Catch2 is built as static lib
# and Catch2 cmake/vcpkg flags must be consistent.
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DCATCH_CONFIG_NO_POSIX_SIGNALS")
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -DCATCH_CONFIG_NO_POSIX_SIGNALS")

# Set release/debug settings
set(CMAKE_C_FLAGS_DEBUG "${CMAKE_C_FLAGS} ${TOOLCHAIN_FLAGS_DEBUG}" CACHE STRING "" FORCE)
set(CMAKE_C_FLAGS_RELEASE "${CMAKE_C_FLAGS} ${TOOLCHAIN_FLAGS_RELEASE}" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS} ${TOOLCHAIN_FLAGS_DEBUG}" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS} ${TOOLCHAIN_FLAGS_RELEASE}" CACHE STRING "" FORCE)

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)

set(CMAKE_DEBUG_POSTFIX "d" CACHE STRING "" FORCE)

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++2a" CACHE STRING "" FORCE)

# ThreadSanitizer
set(CMAKE_C_FLAGS_TSAN
    "${CMAKE_C_FLAGS_RELEASE} -fsanitize=thread -g -O1"
    CACHE STRING "Flags used by the C compiler during ThreadSanitizer builds."
    FORCE)
set(CMAKE_CXX_FLAGS_TSAN
    "${CMAKE_CXX_FLAGS_RELEASE} -fsanitize=thread -g -O1"
    CACHE STRING "Flags used by the C++ compiler during ThreadSanitizer builds."
    FORCE)

# AddressSanitize
set(CMAKE_C_FLAGS_ASAN
    "${CMAKE_C_FLAGS_RELEASE} -fsanitize=address -fno-optimize-sibling-calls -fsanitize-address-use-after-scope -fno-omit-frame-pointer -g -O1"
    CACHE STRING "Flags used by the C compiler during AddressSanitizer builds."
    FORCE)
set(CMAKE_CXX_FLAGS_ASAN
    "${CMAKE_CXX_FLAGS_RELEASE} -fsanitize=address -fno-optimize-sibling-calls -fsanitize-address-use-after-scope -fno-omit-frame-pointer -g -O1"
    CACHE STRING "Flags used by the C++ compiler during AddressSanitizer builds."
    FORCE)

# LeakSanitizer
set(CMAKE_C_FLAGS_LSAN
    "${CMAKE_C_FLAGS_RELEASE} -fsanitize=leak -fno-omit-frame-pointer -g -O1"
    CACHE STRING "Flags used by the C compiler during LeakSanitizer builds."
    FORCE)
set(CMAKE_CXX_FLAGS_LSAN
    "${CMAKE_CXX_FLAGS_RELEASE} -fsanitize=leak -fno-omit-frame-pointer -g -O1"
    CACHE STRING "Flags used by the C++ compiler during LeakSanitizer builds."
    FORCE)

# MemorySanitizer
set(CMAKE_C_FLAGS_MSAN
    "${CMAKE_C_FLAGS_RELEASE} -fsanitize=memory -fno-optimize-sibling-calls -fsanitize-memory-track-origins=2 -fno-omit-frame-pointer -g -O2"
    CACHE STRING "Flags used by the C compiler during MemorySanitizer builds."
    FORCE)
set(CMAKE_CXX_FLAGS_MSAN
    "${CMAKE_CXX_FLAGS_RELEASE} -fsanitize=memory -fno-optimize-sibling-calls -fsanitize-memory-track-origins=2 -fno-omit-frame-pointer -g -O2"
    CACHE STRING "Flags used by the C++ compiler during MemorySanitizer builds."
    FORCE)

# UndefinedBehaviour
set(CMAKE_C_FLAGS_UBSAN
    "${CMAKE_C_FLAGS_RELEASE} -fsanitize=undefined"
    CACHE STRING "Flags used by the C compiler during UndefinedBehaviourSanitizer builds."
    FORCE)
set(CMAKE_CXX_FLAGS_UBSAN
    "${CMAKE_CXX_FLAGS_RELEASE} -fsanitize=undefined"
    CACHE STRING "Flags used by the C++ compiler during UndefinedBehaviourSanitizer builds."
    FORCE)

# We need the linker flags -Xlinker -export-dynamic
# to make the embedded python symbols available (see APPLAT-6500)
set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} \
-Xlinker \
-export-dynamic")

# VCPKG
set(VCPKG_CXX_FLAGS "-stdlib=libc++")
set(VCPKG_C_FLAGS "")
set(VCPKG_LINKER_FLAGS "-stdlib=libc++ -Wl,--no-export-dynamic")

# Add Catch2 vcpkg flags
#
# Java raises exceptions to probe the system config, but Catch intercepts them, treats
# them as failing the unit test in which Java is initialized, and then promptly crashes
# because of a bug in its internal state tracking. Disable SEH and signals for Catch.  If
# a unit test crashes, engtest will crash.
set(VCPKG_CXX_FLAGS "${VCPKG_CXX_FLAGS} -DCATCH_CONFIG_NO_POSIX_SIGNALS")
set(VCPKG_C_FLAGS "${VCPKG_C_FLAGS} -DCATCH_CONFIG_NO_POSIX_SIGNALS")

set(VCPKG_TARGET_TRIPLET "x64-linux-clang-rocketride" CACHE STRING "" FORCE)
