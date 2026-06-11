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

# vcpkg triplet for the rocketride Windows build (MSVC, x64).
# NOTE: Keep this file limited to the VCPKG_* variables

set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_BUILD_TYPE release)

if ("${PORT}" STREQUAL "python3")
	set(VCPKG_LIBRARY_LINKAGE dynamic)
	set(VCPKG_CRT_LINKAGE dynamic)
endif()

# Catch2: Java raises exceptions to probe the system config, but Catch intercepts
# them and crashes due to a bug in its internal state tracking. Disable SEH so a
# dependency built with Catch does not bring the test runner down.
set(VCPKG_CXX_FLAGS "-DCATCH_CONFIG_NO_WINDOWS_SEH")
set(VCPKG_C_FLAGS "-DCATCH_CONFIG_NO_WINDOWS_SEH")
