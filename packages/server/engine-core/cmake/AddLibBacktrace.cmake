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

include(ExternalProject)

set(LIBBACKTRACE_SRC_DIR "${CMAKE_BINARY_DIR}/apLib/apLib/LibBacktrace/src/LibBacktrace" CACHE STRING "" FORCE)
set(LIBBACKTRACE_INSTALL_DIR "${CMAKE_BINARY_DIR}/apLib/apLib/LibBacktrace/install/LibBacktrace" CACHE STRING "" FORCE)

ExternalProject_Add(
    LibBacktrace
    GIT_REPOSITORY https://github.com/ianlancetaylor/libbacktrace
	CONFIGURE_COMMAND ${LIBBACKTRACE_INSTALL_DIR}/src/LibBacktrace/configure --enable-host-shared --prefix=${LIBBACKTRACE_INSTALL_DIR} --enable-shared=no --enable-static=yes
    BUILD_COMMAND make -j
    UPDATE_DISCONNECTED # do not re-download on every make
    UPDATE_COMMAND ""   # do not re-configure on every make
	PREFIX ${LIBBACKTRACE_INSTALL_DIR}
	BUILD_BYPRODUCTS ${LIBBACKTRACE_INSTALL_DIR}/lib/libbacktrace.a
    INSTALL_COMMAND make install
)

add_library(LibBacktraceTarget STATIC IMPORTED GLOBAL)
set_target_properties(LibBacktraceTarget PROPERTIES IMPORTED_LOCATION "${LIBBACKTRACE_INSTALL_DIR}/lib/libbacktrace.a")
include_directories(${LIBBACKTRACE_INSTALL_DIR}/include)
add_dependencies(LibBacktraceTarget LibBacktrace)

