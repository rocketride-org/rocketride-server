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

include(CheckIPOSupported)
#
# rocketride_msg - Simple function to output messages in easy to see format
#
# Usage:
#	 rocketride_msg("hi!")
#
function(rocketride_msg message)
	message(STATUS "* ROCKETRIDE - ${message}")
	foreach(arg IN LISTS ARGN)
		message(STATUS "    ${arg}")
	endforeach(arg IN LISTS ARGN)
endfunction()

# Turn on ccache if present
find_program(CCACHE ccache)
if(CCACHE)
	rocketride_msg("Found CC cache ${CCACHE}")
	set_property(GLOBAL PROPERTY RULE_LAUNCH_COMPILE "${CCACHE}")
	set(CCACHE_SLOPPINESS pch_defines,time_macros)
endif()

find_program(CLCACHE clcache)
if(CLCACHE)
	rocketride_msg("Found CLC cache ${CLCACHE}")
	set(CMAKE_C_COMPILER ${CLCACHE} CACHE STRING "" FORCE)
	set(CMAKE_CXX_COMPILER ${CLCACHE} CACHE STRING "" FORCE)
else()
	rocketride_msg("NOT Found CLC cache ${CLCACHE}")
endif()

# This sets up the core build config and platform definitions in the cmake global scope
# used everywhere to setup basic setup for all rocketride native projects.
if ("${CMAKE_SYSTEM_NAME}" STREQUAL "Linux")
	rocketride_msg("System is Linux")
	set(ROCKETRIDE_PLAT_LIN 1 CACHE INTERNAL "Platform definition" CACHE STRING "" FORCE)
	set(ROCKETRIDE_PLAT_UNX 1 CACHE INTERNAL "Platform definition" CACHE STRING "" FORCE)
	set(ROCKETRIDE_PLAT_TYPE "lin" CACHE STRING "" FORCE)
	set(ROCKETRIDE_PLAT_TYPE_LONG "linux" CACHE STRING "" FORCE)
	set(ROCKETRIDE_DEFS "-DROCKETRIDE_PLAT_LIN=1 -DROCKETRIDE_PLAT_UNX=1" CACHE STRING "" FORCE)
elseif ("${CMAKE_SYSTEM_NAME}" STREQUAL "Darwin")
	rocketride_msg("System is Mac")
	set(ROCKETRIDE_PLAT_MAC 1 CACHE INTERNAL "Platform definition" CACHE STRING "" FORCE)
	set(ROCKETRIDE_PLAT_UNX 1 CACHE INTERNAL "Platform definition" CACHE STRING "" FORCE)
	set(ROCKETRIDE_PLAT_TYPE "mac" CACHE STRING "" FORCE)
	set(ROCKETRIDE_PLAT_TYPE_LONG "osx" CACHE STRING "" FORCE)
	set(ROCKETRIDE_DEFS "-DROCKETRIDE_PLAT_MAC=1 -DROCKETRIDE_PLAT_UNX=1" CACHE STRING "" FORCE)
elseif (WIN32)
	rocketride_msg("System is Windows")
	set(CMAKE_CONFIGURATION_TYPES "Debug;Release" CACHE STRING "" FORCE)
	set(ROCKETRIDE_PLAT_WIN 1 CACHE INTERNAL "Platform definition" FORCE)
	set(ROCKETRIDE_PLAT_TYPE "win" CACHE STRING "" FORCE)
	set(ROCKETRIDE_PLAT_TYPE_LONG "windows" CACHE STRING "" FORCE)
	set(ROCKETRIDE_DEFS "-DROCKETRIDE_PLAT_WIN=1" CACHE STRING "" FORCE)
	# Something is setting /W3, and adding /W4 causes compilation warnings, so just replace the /W3 setting
	string(REPLACE " /W3" " /W4" CMAKE_C_FLAGS "${CMAKE_C_FLAGS}")
	string(REPLACE " /W3" " /W4" CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")
else()
	message(FATAL_ERROR "Unsupported platform: ${CMAKE_SYSTEM_NAME}")
endif()

# If ROCKETRIDE_PLAT_TYPE is defined but ROCKETRIDE_PLAT_TYPE_LONG isn't, set ROCKETRIDE_PLAT_TYPE_LONG from ROCKETRIDE_PLAT_TYPE 
if (ROCKETRIDE_PLAT_TYPE AND NOT ROCKETRIDE_PLAT_TYPE_LONG)
	set(ROCKETRIDE_PLAT_TYPE_LONG "${ROCKETRIDE_PLAT_TYPE}" CACHE STRING "" FORCE)
endif()

# Set our definition for debug mode in rocketride land
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${ROCKETRIDE_DEFS}" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${ROCKETRIDE_DEFS}" CACHE STRING "" FORCE)

set(CMAKE_C_FLAGS_RELEASE "${CMAKE_C_FLAGS_RELEASE} ${ROCKETRIDE_DEFS}" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} ${ROCKETRIDE_DEFS}" CACHE STRING "" FORCE)

rocketride_msg("Detected platform - ${ROCKETRIDE_PLAT_TYPE}")

# Detect target architecture
if(CMAKE_SYSTEM_PROCESSOR STREQUAL "arm64" OR CMAKE_SYSTEM_PROCESSOR STREQUAL "aarch64")
	set(ROCKETRIDE_PROC_TYPE "ARM64")
elseif(CMAKE_SYSTEM_PROCESSOR STREQUAL "x86_64" OR CMAKE_SYSTEM_PROCESSOR STREQUAL "AMD64")
	set(ROCKETRIDE_PROC_TYPE "x64")
elseif(CMAKE_SYSTEM_PROCESSOR STREQUAL "x86")
	set(ROCKETRIDE_PROC_TYPE "x86")
else()
	message(WARNING "Unknown architecture: ${CMAKE_SYSTEM_PROCESSOR}")
endif()

rocketride_msg("Detected target system architecture - ${ROCKETRIDE_PROC_TYPE}")

rocketride_msg("********")
rocketride_msg("******** Configuration type - ${CMAKE_BUILD_TYPE}")
rocketride_msg("********")

# Set a handy var to locate the current installation path for our dependencies
if (NOT VCPKG_ROOT)
	message(FATAL_ERROR "VCPKG_ROOT not defined")
endif()
if (NOT VCPKG_TARGET_TRIPLET)
	message(FATAL_ERROR "VCPKG_TARGET_TRIPLET not defined")
endif()

set(DEPS_ROOT ${VCPKG_INSTALLED_TRIPLET_PATH} CACHE INTERNAL "" FORCE)
if (NOT EXISTS ${DEPS_ROOT})
	message(FATAL_ERROR "Incorrect dependency path: ${DEPS_ROOT}")
endif()

set(DEPS_ROOT_LIB_DEBUG ${DEPS_ROOT}/debug/lib CACHE INTERNAL "" FORCE)
set(DEPS_ROOT_LIB_RELEASE ${DEPS_ROOT}/lib CACHE INTERNAL "" FORCE)
set(DEPS_ROOT_DEBUG ${DEPS_ROOT}/debug CACHE INTERNAL "" FORCE)
set(DEPS_ROOT_RELEASE ${DEPS_ROOT} CACHE INTERNAL "" FORCE)

rocketride_msg("Dependency root path - ${DEPS_ROOT}")
rocketride_msg("Prefix paths:" ${CMAKE_PREFIX_PATH})
rocketride_msg("Debug path:" ${DEPS_ROOT_LIB_DEBUG})
rocketride_msg("Release path:" ${DEPS_ROOT_LIB_RELEASE})

# rocketride_msg("Debug C++ Flags: ${CMAKE_CXX_FLAGS_DEBUG}")
# rocketride_msg("Release C++ Flags: ${CMAKE_CXX_FLAGS_RELEASE}")

# Our command lines are now too long, force ninja to use repsonse files on windows
if (ROCKETRIDE_PLAT_WIN)
	rocketride_msg("Using ninja response files")
	SET(CMAKE_C_USE_RESPONSE_FILE_FOR_OBJECTS 1)
	SET(CMAKE_CXX_USE_RESPONSE_FILE_FOR_OBJECTS 1)
	SET(CMAKE_C_RESPONSE_FILE_LINK_FLAG "@")
	SET(CMAKE_CXX_RESPONSE_FILE_LINK_FLAG "@")
	SET(CMAKE_NINJA_FORCE_RESPONSE_FILE 1 CACHE INTERNAL "")
endif()
