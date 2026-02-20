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

set(ROCKETRIDE_TRIPLET vs2019)

set(VCPKG_TARGET_ARCHITECTURE x64)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_BUILD_TYPE release)

if ("${PORT}" STREQUAL "python3")
	set(VCPKG_LIBRARY_LINKAGE dynamic)
	set(VCPKG_CRT_LINKAGE dynamic)
endif()

# Basic settings
set(CMAKE_C_COMPILER "cl" CACHE STRING "" FORCE)
set(CMAKE_CXX_COMPILER "cl" CACHE STRING "" FORCE)

# Relocatable code in static lib generation
set(CMAKE_POSITION_INDEPENDENT_CODE YES)

# Release + pdb's
set(ROCKETRIDE_TOOLCHAIN_DEFINITIONS_RELEASE
	"/Od -D_ITERATOR_DEBUG_LEVEL=0 /MD /GS- /Zi /Ob2 /DNDEBUG=1 /std:c++20"
)

# Debug, pdb's, iterator debug level 2
set(ROCKETRIDE_TOOLCHAIN_DEFINITIONS_DEBUG
	"/Od -D_ITERATOR_DEBUG_LEVEL=2 -D_DEBUG /MDd /Zi /DDEBUG=1"
)

# C++ specific options
set(MSVC_TOOLCHAIN_DEFAULT_CXX_DEFINITIONS
	"/await /D_HAS_DEPRECATED_RESULT_OF=1 /Zc:twoPhase- /permissive- -D_SILENCE_ALL_CXX17_DEPRECATION_WARNINGS=1 -D_ENABLE_ATOMIC_ALIGNMENT_FIX=1"
)

# Platform options and settings
set(ROCKETRIDE_TOOLCHAIN_DEFINITIONS
	"-D_SCL_SECURE_NO_WARNINGS=1 -DNOMINMAX=1 -DWINVER=0x0A00 -D_WIN32_WINNT=0x0A00 /bigobj /W4 /WX /wd4251 /wd4996 /wd4250 /wd4065 /wd4100 /wd4456 /EHsc -DWIN32 /Zc:wchar_t /MP"
)

# Enable errors for if (val = 1), force use of new c++ 20 "if statement with initializer" feature instead if (val = 1; val)
set(ROCKETRIDE_TOOLCHAIN_DEFINITIONS "${ROCKETRIDE_TOOLCHAIN_DEFINITIONS} /we4706")

# Enable errors for 'not all control paths return a value', which can cause crashes if the function returns an ErrorOr
set(ROCKETRIDE_TOOLCHAIN_DEFINITIONS "${ROCKETRIDE_TOOLCHAIN_DEFINITIONS} /we4715")

# Release link flags, link time optimization, debug info, stripped pdbs
set(RELEASE_LINKER_FLAGS "/DEBUG /PDBSTRIPPED /INCREMENTAL:NO")

# Debug link flags, full debug info
set(DEBUG_LINKER_FLAGS "/DEBUG:FULL")

# We define rel with deb info just for vcpkg's sake, but we don't use it internally
set(CMAKE_SHARED_LINKER_FLAGS_RELEASE "${CMAKE_STATIC_LINKER_FLAGS_RELEASE} ${RELEASE_LINKER_FLAGS}" CACHE STRING "" FORCE)
set(CMAKE_SHARED_LINKER_FLAGS_RELWITHDEBINFO "${CMAKE_STATIC_LINKER_FLAGS_RELEASE} ${RELEASE_LINKER_FLAGS}" CACHE STRING "" FORCE)
set(CMAKE_EXE_LINKER_FLAGS_RELEASE "${CMAKE_EXE_LINKER_FLAGS_RELEASE} ${RELEASE_LINKER_FLAGS}" CACHE STRING "" FORCE)

set(CMAKE_SHARED_LINKER_FLAGS_DEBUG "${CMAKE_STATIC_LINKER_FLAGS_DEBUG} ${DEBUG_LINKER_FLAGS}" CACHE STRING "" FORCE)
set(CMAKE_EXE_LINKER_FLAGS_DEBUG "${CMAKE_EXE_LINKER_FLAGS_DEBUG} ${DEBUG_LINKER_FLAGS}" CACHE STRING "" FORCE)

set(CMAKE_C_FLAGS_DEBUG " ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS} ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS_DEBUG}" CACHE STRING "" FORCE)
set(CMAKE_C_FLAGS_RELEASE " ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS} ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS_RELEASE}" CACHE STRING "" FORCE)
set(CMAKE_C_FLAGS_RELWITHDEBINFO " ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS} ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS_RELEASE}" CACHE STRING "" FORCE)

set(CMAKE_CXX_FLAGS_DEBUG " ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS} ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS_DEBUG} ${MSVC_TOOLCHAIN_DEFAULT_CXX_DEFINITIONS}" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS_RELEASE " ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS} ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS_RELEASE} ${MSVC_TOOLCHAIN_DEFAULT_CXX_DEFINITIONS}" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS_RELWITHDEBINFO " ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS} ${ROCKETRIDE_TOOLCHAIN_DEFINITIONS_RELEASE} ${MSVC_TOOLCHAIN_DEFAULT_CXX_DEFINITIONS}" CACHE STRING "" FORCE)

set(CMAKE_DEBUG_POSTFIX "" CACHE STRING "" FORCE)

# Add Catch2 flags
#
# Java raises exceptions to probe the system config, but Catch intercepts them, treats
# them as failing the unit test in which Java is initialized, and then promptly crashes
# because of a bug in its internal state tracking. Disable SEH and signals for Catch.  If
# a unit test crashes, engtest will crash.
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DCATCH_CONFIG_NO_WINDOWS_SEH")
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -DCATCH_CONFIG_NO_WINDOWS_SEH")

set(VCPKG_CXX_FLAGS ${CMAKE_CXX_FLAGS})
set(VCPKG_C_FLAGS ${CMAKE_C_FLAGS})
set(VCPKG_TARGET_TRIPLET "x64-windows-vc-rocketride" CACHE STRING "" FORCE)
