# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# This module provides functions for setting up vcpkg in manifest mode.
# Dependencies are declared in vcpkg.json and installed by the vcpkg CMake
# toolchain when CMake is run (the toolchain must be passed via
# -DCMAKE_TOOLCHAIN_FILE=... when invoking cmake).
# =============================================================================

cmake_minimum_required(VERSION 3.19 FATAL_ERROR)

message(STATUS "Setting up vcpkg (manifest mode)...")

# Determine vcpkg root - prefer env var, then build/vcpkg relative to project root
if(DEFINED ENV{VCPKG_ROOT})
    set(VCPKG_ROOT $ENV{VCPKG_ROOT} CACHE STRING "" FORCE)
    message(STATUS "Using VCPKG_ROOT from environment: ${VCPKG_ROOT}")
else()
    set(VCPKG_ROOT ${ROCKETRIDE_PROJECT_ROOT}/build/vcpkg CACHE STRING "" FORCE)
    message(STATUS "Using VCPKG_ROOT from project root: ${VCPKG_ROOT}")
endif()

# Triplet: use value from cache (set by toolchain or by caller), or detect from platform
if(NOT DEFINED VCPKG_TARGET_TRIPLET OR VCPKG_TARGET_TRIPLET STREQUAL "")
    if(WIN32)
        set(VCPKG_TARGET_TRIPLET "x64-windows-vc-rocketride" CACHE STRING "" FORCE)
    elseif("${CMAKE_SYSTEM_NAME}" STREQUAL "Darwin")
        if(CMAKE_OSX_ARCHITECTURES MATCHES "^(arm64)$")
            set(VCPKG_TARGET_TRIPLET "arm64-osx-appleclang-rocketride" CACHE STRING "" FORCE)
        else()
            set(VCPKG_TARGET_TRIPLET "x64-osx-appleclang-rocketride" CACHE STRING "" FORCE)
        endif()
    else()
        set(VCPKG_TARGET_TRIPLET "x64-linux-clang-rocketride" CACHE STRING "" FORCE)
    endif()
endif()

message(STATUS "Using triplet: ${VCPKG_TARGET_TRIPLET}")

# Installed triplet directory
if(VCPKG_INSTALLED_DIR)
    set(VCPKG_INSTALLED_TRIPLET_DIR "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}" CACHE STRING "" FORCE)
elseif(EXISTS "${ROCKETRIDE_PROJECT_ROOT}/build/vcpkg_installed/${VCPKG_TARGET_TRIPLET}")
    set(VCPKG_INSTALLED_TRIPLET_DIR "${ROCKETRIDE_PROJECT_ROOT}/build/vcpkg_installed/${VCPKG_TARGET_TRIPLET}" CACHE STRING "" FORCE)
else()
    message(FATAL_ERROR "Failed to find vcpkg installed directory")
endif()

# Include triplet for compiler/flags (ROCKETRIDE_* definitions)
set(TRIPLET_PATH engine-core/cmake/triplets/${VCPKG_TARGET_TRIPLET}.cmake)
include(${TRIPLET_PATH} RESULT_VARIABLE RES)
if(RES STREQUAL "NOTFOUND")
    message(FATAL_ERROR "Failed to include triplet: ${TRIPLET_PATH}")
endif()

# Binary cache (for reference; toolchain may use these when installing from manifest)
if(DEFINED ENV{GITHUB_ACTIONS})
    if(DEFINED ENV{VCPKG_NUGET_USER})
        set(VCPKG_BINARY_SOURCE "clear;nuget,https://nuget.pkg.github.com/$ENV{VCPKG_NUGET_USER}/index.json,readwrite" CACHE STRING "" FORCE)
    else()
        message(WARNING "Default vcpkg binary cache: VCPKG_NUGET_USER not defined")
        set(VCPKG_BINARY_SOURCE "clear;default,readwrite" CACHE STRING "" FORCE)
    endif()
elseif(DEFINED VCPKG_BINARY_CACHE_DIR)
    file(MAKE_DIRECTORY ${VCPKG_BINARY_CACHE_DIR})
    set(VCPKG_BINARY_SOURCE "clear;files,${VCPKG_BINARY_CACHE_DIR},readwrite" CACHE STRING "" FORCE)
else()
    set(VCPKG_BINARY_SOURCE "clear;default,readwrite" CACHE STRING "" FORCE)
endif()
message(STATUS "Using vcpkg binary cache: ${VCPKG_BINARY_SOURCE}")
