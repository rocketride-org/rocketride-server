# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
#
# This module provides functions for setting up and managing vcpkg dependencies.
# It handles downloading, caching, and installing packages from the vcpkg
# package manager.
# =============================================================================

cmake_minimum_required(VERSION 3.19 FATAL_ERROR)
include(JSONParser)

# -----------------------------------------------------------------------------
# rocketride_setup_download_cache
# Sets up and creates a cache path for downloaded assets.
#
# Parameters:
#   OUTPUT_VCPKG_CACHE_PATH - Output variable for the cache path
# -----------------------------------------------------------------------------
function(rocketride_setup_download_cache OUTPUT_VCPKG_CACHE_PATH)
    # Check for environment variable first
    if(DEFINED ENV{VCPKG_ASSET_CACHE_PATH})
        set(VCPKG_ASSET_CACHE_PATH "$ENV{VCPKG_ASSET_CACHE_PATH}")
    else()
        # Try various platform-specific locations
        if(DEFINED ENV{HOME})
            set(VCPKG_ASSET_CACHE_PATH "$ENV{HOME}/.vcpkg-cache")
        elseif(DEFINED ENV{LOCALAPPDATA})
            set(VCPKG_ASSET_CACHE_PATH "$ENV{LOCALAPPDATA}/.vcpkg-cache")
        elseif(DEFINED ENV{TMPDIR})
            set(VCPKG_ASSET_CACHE_PATH "$ENV{TMPDIR}/vcpkg-cache")
        elseif(DEFINED ENV{TMP})
            set(VCPKG_ASSET_CACHE_PATH "$ENV{TMP}/vcpkg-cache")
        elseif(DEFINED ENV{TEMP})
            set(VCPKG_ASSET_CACHE_PATH "$ENV{TEMP}/.vcpkg-cache")
        else()
            message(FATAL_ERROR 
                "Cannot determine vcpkg cache path. Please set one of: "
                "HOME, LOCALAPPDATA, TMPDIR, TMP, TEMP, or VCPKG_ASSET_CACHE_PATH")
        endif()
    endif()

    message(STATUS "vcpkg cache path: ${VCPKG_ASSET_CACHE_PATH}")
    file(MAKE_DIRECTORY ${VCPKG_ASSET_CACHE_PATH})
    set(${OUTPUT_VCPKG_CACHE_PATH} "${VCPKG_ASSET_CACHE_PATH}" PARENT_SCOPE)
endfunction()

# -----------------------------------------------------------------------------
# rocketride_download_dependency
# Downloads and extracts tar archives for the dependency bootstrap system.
#
# Parameters:
#   URL          - URL to download from
#   EXPECTED_HASH - SHA512 hash of the expected file
#   TARGET_PATH  - Target directory path within vcpkg
#   STRIP_LEVELS - Number of directory levels to strip when extracting
# -----------------------------------------------------------------------------
function(rocketride_download_dependency URL EXPECTED_HASH TARGET_PATH STRIP_LEVELS)
    # Skip buildtrees unless explicitly requested (they are large)
    if(${TARGET_PATH} STREQUAL "buildtrees" AND NOT ROCKETRIDE_INSTALL_BUILDTREES)
        message(STATUS "Skipping buildtree package (set ROCKETRIDE_INSTALL_BUILDTREES=ON to include)")
        return()
    endif()

    # Create download path
    get_filename_component(NAME ${URL} NAME)
    set(DOWNLOAD_FILE_PATH ${VCPKG_DOWNLOADS_PATH}/${NAME})

    # Check if download is needed
    set(DOWNLOAD_REQUIRED true)
    if(EXISTS ${DOWNLOAD_FILE_PATH}_downloaded.hash)
        file(READ ${DOWNLOAD_FILE_PATH}_downloaded.hash DOWNLOADED_HASH)
        if(${EXPECTED_HASH} STREQUAL ${DOWNLOADED_HASH})
            set(DOWNLOAD_REQUIRED false)
        endif()
    endif()

    if(${DOWNLOAD_REQUIRED})
        # Check cache first
        set(DOWNLOAD_FROM_CACHED false)
        rocketride_setup_download_cache(VCPKG_ASSET_CACHE_PATH)
        if(EXISTS ${VCPKG_ASSET_CACHE_PATH}/${EXPECTED_HASH}/${NAME})
            set(DOWNLOAD_FROM_CACHED true)
        endif()

        # Retry up to 5 times
        foreach(ATTEMPT RANGE 1 5)
            if(NOT "${EXPECTED_HASH}" STREQUAL "${EXTRACT_HASH}")
                message(STATUS "Downloading [${ATTEMPT}/5] ${NAME}")
                if(${DOWNLOAD_FROM_CACHED})
                    message(STATUS "  Using cached copy")
                    file(COPY ${VCPKG_ASSET_CACHE_PATH}/${EXPECTED_HASH}/${NAME} 
                         DESTINATION ${VCPKG_DOWNLOADS_PATH})
                else()
                    file(DOWNLOAD ${URL} ${DOWNLOAD_FILE_PATH} SHOW_PROGRESS)
                endif()
                file(SHA512 ${DOWNLOAD_FILE_PATH} EXTRACT_HASH)
                if(NOT "${EXPECTED_HASH}" STREQUAL "${EXTRACT_HASH}")
                    message(WARNING "Hash mismatch, retrying...")
                    set(DOWNLOAD_FROM_CACHED false)
                endif()
            endif()
        endforeach()

        if(NOT "${EXPECTED_HASH}" STREQUAL "${EXTRACT_HASH}")
            message(FATAL_ERROR "Failed to download ${URL}: hash mismatch after 5 attempts")
        endif()

        # Cache the downloaded file
        if(NOT ${DOWNLOAD_FROM_CACHED})
            message(STATUS "Caching download...")
            file(MAKE_DIRECTORY ${VCPKG_ASSET_CACHE_PATH}/${EXPECTED_HASH})
            file(COPY ${DOWNLOAD_FILE_PATH} DESTINATION ${VCPKG_ASSET_CACHE_PATH}/${EXPECTED_HASH})
        endif()

        # Mark for extraction
        set(EXTRACT_REQUIRED true)
        file(WRITE ${DOWNLOAD_FILE_PATH}_downloaded.hash ${EXPECTED_HASH})
    endif()

    # Check if extraction is needed
    if(NOT EXTRACT_REQUIRED)
        if(EXISTS ${VCPKG_INSTALLED_PATH}/${NAME}_extracted.hash)
            file(READ ${VCPKG_INSTALLED_PATH}/${NAME}_extracted.hash EXTRACT_HASH)
            if(${EXPECTED_HASH} STREQUAL ${EXTRACT_HASH})
                set(EXTRACT_REQUIRED false)
            else()
                set(EXTRACT_REQUIRED true)
            endif()
        else()
            set(EXTRACT_REQUIRED true)
        endif()
    endif()

    if(${EXTRACT_REQUIRED})
        file(MAKE_DIRECTORY ${VCPKG_INSTALLED_PATH}/${TARGET_PATH})
        message(STATUS "Extracting ${NAME}...")
        
        if(STRIP_LEVELS GREATER 0)
            execute_process(
                COMMAND tar xzf ${DOWNLOAD_FILE_PATH} --strip-components=${STRIP_LEVELS}
                WORKING_DIRECTORY "${VCPKG_INSTALLED_PATH}/${TARGET_PATH}"
                COMMAND_ERROR_IS_FATAL ANY
            )
        else()
            execute_process(
                COMMAND ${CMAKE_COMMAND} -E tar xzf ${DOWNLOAD_FILE_PATH}
                WORKING_DIRECTORY "${VCPKG_INSTALLED_PATH}/${TARGET_PATH}"
                COMMAND_ERROR_IS_FATAL ANY
            )
        endif()

        # Verify extraction
        if(NOT EXISTS ${VCPKG_INSTALLED_PATH}/${TARGET_PATH})
            message(FATAL_ERROR "Extraction failed for ${NAME}")
        endif()

        # Ensure write permissions on Unix
        if(NOT WIN32)
            execute_process(COMMAND chmod -R +rw ${VCPKG_INSTALLED_PATH}/${TARGET_PATH})
        endif()

        file(WRITE ${VCPKG_INSTALLED_PATH}/${NAME}_extracted.hash ${EXPECTED_HASH})
    endif()
endfunction()

# -----------------------------------------------------------------------------
# rocketride_install_dependency
# Installs a package using vcpkg.
#
# Parameters:
#   NAME     - Package name
#   TRIPLET  - Target triplet
#   DEPS_PLAT - Platform identifier
# -----------------------------------------------------------------------------
function(rocketride_install_dependency NAME TRIPLET DEPS_PLAT)
    if(NOT DEFINED VCPKG_EXEC)
        message(FATAL_ERROR "VCPKG_EXEC not defined")
    endif()

    message(STATUS "Installing ${NAME}:${TRIPLET}...")
    execute_process(
        COMMAND ${VCPKG_EXEC} install ${NAME}
            "--recurse"
            "--triplet=${TRIPLET}"
            "--host-triplet=${TRIPLET}"
            "--overlay-ports=${ROCKETRIDE_OVERLAY_PORTS}"
            "--binarysource=${VCPKG_BINARY_SOURCE}"
        WORKING_DIRECTORY ${VCPKG_ROOT}
        COMMAND_ERROR_IS_FATAL ANY
        COMMAND_ECHO STDOUT
    )
endfunction()

# -----------------------------------------------------------------------------
# rocketride_copy_file
# Copies a file if contents differ or target doesn't exist.
#
# Parameters:
#   SOURCE     - Source file path
#   TARGET_DIR - Target directory
# -----------------------------------------------------------------------------
function(rocketride_copy_file SOURCE TARGET_DIR)
    if(NOT EXISTS ${SOURCE})
        message(FATAL_ERROR "Source file not found: ${SOURCE}")
    endif()

    get_filename_component(NAME ${SOURCE} NAME)
    set(TARGET ${TARGET_DIR}/${NAME})

    if(NOT EXISTS ${TARGET})
        file(COPY ${SOURCE} DESTINATION ${TARGET_DIR})
    else()
        file(SHA512 ${SOURCE} SOURCE_HASH)
        file(SHA512 ${TARGET} TARGET_HASH)
        if(NOT ${SOURCE_HASH} STREQUAL ${TARGET_HASH})
            file(COPY ${SOURCE} DESTINATION ${TARGET_DIR})
        endif()
    endif()
endfunction()

# -----------------------------------------------------------------------------
# rocketride_download_plat
# Downloads platform-specific packages from the dependency file.
#
# Parameters:
#   PLAT - Platform identifier
# -----------------------------------------------------------------------------
macro(rocketride_download_plat PLAT)
    set(DEPS_LIST ${DEPS.${PLAT}_download})
    foreach(DEP ${DEPS_LIST})
        set(DEP_URL "${DEPS.${PLAT}_download_${DEP}.url}")
        set(DEP_SHA512 "${DEPS.${PLAT}_download_${DEP}.sha512}")
        set(DEP_PATH "${DEPS.${PLAT}_download_${DEP}.path}")
        set(DEP_STRIP_LEVELS "${DEPS.${PLAT}_download_${DEP}.stripLevels}")
        if(NOT DEP_STRIP_LEVELS)
            set(DEP_STRIP_LEVELS 0)
        endif()
        rocketride_download_dependency(${DEP_URL} ${DEP_SHA512} ${DEP_PATH} ${DEP_STRIP_LEVELS})
    endforeach()
endmacro()

# -----------------------------------------------------------------------------
# rocketride_download_common
# Downloads common (platform-independent) packages.
# -----------------------------------------------------------------------------
macro(rocketride_download_common)
    set(DEPS_LIST ${DEPS.download})
    foreach(DEP ${DEPS_LIST})
        set(DEP_URL "${DEPS.download_${DEP}.url}")
        set(DEP_SHA512 "${DEPS.download_${DEP}.sha512}")
        set(DEP_PATH "${DEPS.download_${DEP}.path}")
        set(DEP_STRIP_LEVELS "${DEPS.download_${DEP}.stripLevels}")
        if(NOT DEP_STRIP_LEVELS)
            set(DEP_STRIP_LEVELS 0)
        endif()
        rocketride_download_dependency(${DEP_URL} ${DEP_SHA512} ${DEP_PATH} ${DEP_STRIP_LEVELS})
    endforeach()
endmacro()

# -----------------------------------------------------------------------------
# rocketride_install_plat
# Installs platform-specific packages.
#
# Parameters:
#   DEPS_PLAT - Platform identifier
# -----------------------------------------------------------------------------
macro(rocketride_install_plat DEPS_PLAT)
    set(DEPS_LIST ${DEPS.${DEPS_PLAT}_install})
    foreach(DEP ${DEPS_LIST})
        set(DEP_NAME "${DEPS.${DEPS_PLAT}_install_${DEP}}")
        rocketride_install_dependency(${DEP_NAME} ${VCPKG_TARGET_TRIPLET} ${DEPS_PLAT})
    endforeach()
endmacro()

# -----------------------------------------------------------------------------
# rocketride_install_common
# Installs common packages.
# -----------------------------------------------------------------------------
macro(rocketride_install_common)
    set(DEPS_LIST ${DEPS.install})
    foreach(DEP ${DEPS_LIST})
        set(DEP_NAME "${DEPS.install_${DEP}}")
        rocketride_install_dependency(${DEP_NAME} ${VCPKG_TARGET_TRIPLET} "")
    endforeach()
endmacro()

# -----------------------------------------------------------------------------
# rocketride_install_file
# Installs dependencies listed in a JSON file.
#
# Parameters:
#   DEPS_PATH - Path to the dependencies JSON file
#   DEPS_PLAT - Platform identifier
#   DEPS_TYPE - Dependency type
# -----------------------------------------------------------------------------
function(rocketride_install_file DEPS_PATH DEPS_PLAT DEPS_TYPE)
    file(SHA512 ${DEPS_PATH} DEPS_HASH)
    if(NOT DEPS_HASH)
        message(FATAL_ERROR "Could not hash ${DEPS_PATH}")
    endif()

    get_filename_component(DEPS_NAME ${DEPS_PATH} NAME)
    set(HASH_PATH ${VCPKG_DOWNLOADS_PATH}/${DEPS_NAME}.hash)

    set(INSTALL_REQUIRED true)
    if(EXISTS ${HASH_PATH})
        file(READ ${HASH_PATH} INSTALLED_DEPS_HASH)
        if(${INSTALLED_DEPS_HASH} STREQUAL ${DEPS_HASH})
            set(INSTALL_REQUIRED false)
        endif()
    endif()

    # Load and parse the dependencies file
    file(READ ${DEPS_PATH} DEPS_JSON)
    sbeParseJson(DEPS ${DEPS_JSON})

    rocketride_download_plat(${DEPS_PLAT} ${DEPS_TYPE})
    rocketride_download_common()

    if(INSTALL_REQUIRED)
        rocketride_install_plat(${DEPS_PLAT})
        rocketride_install_common()
    endif()

    file(WRITE ${HASH_PATH} ${DEPS_HASH})
    sbeClearJson(DEPS)
endfunction()

# -----------------------------------------------------------------------------
# rocketride_setup_vcpkg
# Main entry point for setting up vcpkg and all dependencies.
#
# Parameters:
#   PATH - Path to the project root
# -----------------------------------------------------------------------------
function(rocketride_setup_vcpkg PATH)
    message(STATUS "Setting up vcpkg...")
    
    # Determine vcpkg root - prefer build/vcpkg, fall back to env var
    if(DEFINED ENV{VCPKG_ROOT})
        set(VCPKG_ROOT $ENV{VCPKG_ROOT} CACHE STRING "" FORCE)
        message(STATUS "Using VCPKG_ROOT from environment: ${VCPKG_ROOT}")
    else()
        set(VCPKG_ROOT ${PATH}/build/vcpkg CACHE STRING "" FORCE)
    endif()

    # Set platform-specific executable path
    if(WIN32)
        set(VCPKG_EXEC ${VCPKG_ROOT}/vcpkg.exe)
    else()
        set(VCPKG_EXEC ${VCPKG_ROOT}/vcpkg)
    endif()

    # Initialize vcpkg if needed using our setup script
    if(NOT EXISTS ${VCPKG_EXEC})
        message(STATUS "vcpkg not found, running: node scripts/vcpkg.js")
        execute_process(
            COMMAND node scripts/vcpkg.js
            WORKING_DIRECTORY ${PATH}
            RESULT_VARIABLE VCPKG_SETUP_RESULT
        )
        if(NOT VCPKG_SETUP_RESULT EQUAL 0)
            message(FATAL_ERROR "Failed to setup vcpkg. Run 'node scripts/vcpkg.js' manually.")
        endif()
    endif()

    # Verify vcpkg is ready
    if(NOT EXISTS ${VCPKG_EXEC})
        message(FATAL_ERROR "vcpkg executable not found: ${VCPKG_EXEC}\nRun: node scripts/vcpkg.js")
    endif()

    if(NOT EXISTS ${VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake)
        message(FATAL_ERROR "Missing vcpkg toolchain at: ${VCPKG_ROOT}")
    endif()

    # Set toolchain file
    set(CMAKE_TOOLCHAIN_FILE ${VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake CACHE STRING "" FORCE)

    # Determine platform
    if(WIN32)
        set(DEPS_PLAT "windows")
        set(DEPS_TYPE "win32")
    elseif("${CMAKE_SYSTEM_NAME}" STREQUAL "Darwin")
        if(CMAKE_OSX_ARCHITECTURES MATCHES "^(x86_64|AMD64)$")
            set(DEPS_PLAT "osx")
            set(DEPS_TYPE "unx")
        elseif(CMAKE_OSX_ARCHITECTURES MATCHES "^(arm64)$")
            set(DEPS_PLAT "osx_arm64")
            set(DEPS_TYPE "unx_arm64")
        else()
            message(FATAL_ERROR "Unknown macOS architecture")
        endif()
    else()
        set(DEPS_PLAT "linux")
        set(DEPS_TYPE "unx")
    endif()

    message(STATUS "Platform: ${DEPS_PLAT} (${DEPS_TYPE})")

    # Auto-detect triplet based on platform
    if(WIN32)
        set(VCPKG_TARGET_TRIPLET "x64-windows-vc-rocketride" CACHE STRING "" FORCE)
    elseif("${CMAKE_SYSTEM_NAME}" STREQUAL "Darwin")
        if(CMAKE_OSX_ARCHITECTURES MATCHES "^(arm64)$")
            set(VCPKG_TARGET_TRIPLET "arm64-osx-appleclang-rocketride" CACHE STRING "" FORCE)
        else()
            set(VCPKG_TARGET_TRIPLET "x64-osx-appleclang-rocketride" CACHE STRING "" FORCE)
        endif()
    else()
        if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
            set(VCPKG_TARGET_TRIPLET "arm64-linux-clang-rocketride" CACHE STRING "" FORCE)
        else()
            set(VCPKG_TARGET_TRIPLET "x64-linux-clang-rocketride" CACHE STRING "" FORCE)
        endif()
    endif()
    
    message(STATUS "Using triplet: ${VCPKG_TARGET_TRIPLET}")

    # Set up paths - triplet files are in packages/server/engine-core/cmake/triplets
    set(TRIPLET_SOURCE_PATH ${PATH}/packages/server/engine-core/cmake/triplets/${VCPKG_TARGET_TRIPLET}.cmake)
    
    if(NOT EXISTS ${TRIPLET_SOURCE_PATH})
        message(FATAL_ERROR "Triplet file not found: ${TRIPLET_SOURCE_PATH}")
    endif()
    set(TRIPLETS_TARGET_PATH ${VCPKG_ROOT}/triplets)
    set(VCPKG_DOWNLOADS_PATH ${VCPKG_ROOT}/downloads CACHE STRING "" FORCE)
    set(VCPKG_INSTALLED_PATH ${VCPKG_ROOT}/installed CACHE STRING "" FORCE)
    set(VCPKG_INSTALLED_TRIPLET_PATH ${VCPKG_INSTALLED_PATH}/${VCPKG_TARGET_TRIPLET} CACHE STRING "" FORCE)

    # Update prefix paths
    STRING(FIND "${CMAKE_PREFIX_PATH}" "${}/debug" POS)
    if(${POS} EQUAL -1)
        list(APPEND CMAKE_PREFIX_PATH ${VCPKG_INSTALLED_TRIPLET_PATH}/debug)
        list(APPEND CMAKE_PREFIX_PATH ${VCPKG_INSTALLED_TRIPLET_PATH})
        set(CMAKE_PREFIX_PATH ${CMAKE_PREFIX_PATH} CACHE STRING "" FORCE)
    endif()

    # Copy triplets
    rocketride_copy_file(${TRIPLET_SOURCE_PATH} ${TRIPLETS_TARGET_PATH})
    file(MAKE_DIRECTORY ${VCPKG_INSTALLED_TRIPLET_PATH})

    # Include triplet settings
    include(${TRIPLET_SOURCE_PATH} RESULT_VARIABLE RES)
    if(${RES} STREQUAL "NOTFOUND")
        message(FATAL_ERROR "Failed to include triplet: ${TRIPLET_SOURCE_PATH}")
    endif()

    # Determine binary source based on environment
    if(DEFINED ENV{GITHUB_ACTIONS})
        if(DEFINED ENV{VCPKG_NUGET_USER})
            # Use GitHub Packages NuGet for shared cache
            set(VCPKG_BINARY_SOURCE "clear;nuget,https://nuget.pkg.github.com/$ENV{VCPKG_NUGET_USER}/index.json,readwrite" CACHE STRING "" FORCE)
        else()
            message(WARNING "Default vcpkg binary cache: VCPKG_NUGET_USER not defined")
            set(VCPKG_BINARY_SOURCE "clear;default,readwrite" CACHE STRING "" FORCE)
        endif()
    elseif(DEFINED VCPKG_BINARY_CACHE_DIR)
        # Use local file cache
        file(MAKE_DIRECTORY ${VCPKG_BINARY_CACHE_DIR})
        set(VCPKG_BINARY_SOURCE "clear;files,${VCPKG_BINARY_CACHE_DIR},readwrite" CACHE STRING "" FORCE)
    else()
        # No caching
        set(VCPKG_BINARY_SOURCE "clear;default,readwrite" CACHE STRING "" FORCE)
    endif()
    message(STATUS "vcpkg binary cache: ${VCPKG_BINARY_SOURCE}")

    # Make overlay-ports path available to rocketride_install_dependency
    set(ROCKETRIDE_OVERLAY_PORTS "${PATH}/packages/server/engine-core/cmake/ports" CACHE STRING "" FORCE)

    # Install dependencies
    rocketride_install_file(${PATH}/packages/server/engine-core/apDeps.json ${DEPS_PLAT} ${DEPS_TYPE})
    rocketride_install_file(${PATH}/packages/server/engine-lib/engDeps.json ${DEPS_PLAT} ${DEPS_TYPE})
endfunction()

