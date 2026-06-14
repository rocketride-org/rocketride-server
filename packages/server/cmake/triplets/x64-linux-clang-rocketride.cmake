# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
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

# vcpkg triplet for the rocketride Linux build (clang, x64).
# NOTE: Keep this file limited to the VCPKG_* variables

set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_CMAKE_SYSTEM_NAME Linux)
set(VCPKG_BUILD_TYPE release)

set(CMAKE_C_COMPILER "clang" CACHE STRING "" FORCE)
set(CMAKE_CXX_COMPILER "clang++" CACHE STRING "" FORCE)

# Fixes curl build
set(THREADS_PTHREAD_ARG "2" CACHE STRING "Fix curl" FORCE)
set(HAVE_POLL_FINE_EXITCODE "ON" CACHE STRING "Fix curl" FORCE)
set(HAVE_POLL_FINE_EXITCODE__TRYRUN_OUTPUT "" CACHE STRING "Fix curl" FORCE)

# Dependency compile/link flags (libc++). Catch2 is built as a static lib, so its
# cmake/vcpkg flags must stay consistent with the engine's (see the flags module).
set(VCPKG_CXX_FLAGS "-stdlib=libc++")
set(VCPKG_C_FLAGS "")
set(VCPKG_LINKER_FLAGS "-stdlib=libc++ -Wl,--no-export-dynamic")
set(VCPKG_CXX_FLAGS "${VCPKG_CXX_FLAGS} -DCATCH_CONFIG_NO_POSIX_SIGNALS")
set(VCPKG_C_FLAGS "${VCPKG_C_FLAGS} -DCATCH_CONFIG_NO_POSIX_SIGNALS")
