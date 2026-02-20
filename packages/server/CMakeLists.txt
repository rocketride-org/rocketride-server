# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
#
# This is the main CMake configuration file for the RocketRide Engine project.
# It orchestrates the build of all C++ components including the core library,
# engine library, and the main engine executable.
# =============================================================================

# -----------------------------------------------------------------------------
# CMake minimum version requirement
# We require CMake 3.14+ for modern CMake features like FetchContent
# -----------------------------------------------------------------------------
cmake_minimum_required(VERSION 3.14 FATAL_ERROR)

# -----------------------------------------------------------------------------
# Project root directory (two levels up from packages/server)
# -----------------------------------------------------------------------------
get_filename_component(ROCKETRIDE_PROJECT_ROOT "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)

# -----------------------------------------------------------------------------
# Display CMake configuration information
# -----------------------------------------------------------------------------
message(STATUS "========================================")
message(STATUS "RocketRide Engine Build Configuration")
message(STATUS "========================================")
message(STATUS "CMake command   : ${CMAKE_COMMAND}")
message(STATUS "      version   : ${CMAKE_VERSION}")
message(STATUS "      generator : ${CMAKE_GENERATOR}")
message(STATUS "      compiler  : ${CMAKE_CXX_COMPILER}")
message(STATUS "Project root    : ${ROCKETRIDE_PROJECT_ROOT}")

# -----------------------------------------------------------------------------
# Build time measurement (optional)
# Enable with -DSHOW_BUILD_TIME=ON for Makefiles and Ninja generators
# -----------------------------------------------------------------------------
if(SHOW_BUILD_TIME)
    message(STATUS "Build time measurement: ENABLED")
    set_property(GLOBAL PROPERTY RULE_LAUNCH_COMPILE "${CMAKE_COMMAND} -E time")
else()
    message(STATUS "Build time measurement: DISABLED")
endif()

# -----------------------------------------------------------------------------
# Version configuration
# Reads version from package.json if not specified on command line
# -----------------------------------------------------------------------------
if(NOT CMAKE_PROJECT_VERSION)
    # Try to read version from package.json (in project root)
    set(PACKAGE_JSON "${ROCKETRIDE_PROJECT_ROOT}/package.json")
    if(EXISTS "${PACKAGE_JSON}")
        file(READ "${PACKAGE_JSON}" JSON_CONTENT)
        
        # Extract version string from JSON
        string(REGEX MATCH "\"version\"[ \t]*:[ \t]*\"([^\"]+)\"" _ "${JSON_CONTENT}")
        
        if(DEFINED CMAKE_MATCH_1)
            set(CMAKE_PROJECT_VERSION "${CMAKE_MATCH_1}.9999")
            message(STATUS "Version (from package.json): ${CMAKE_PROJECT_VERSION}")
        else()
            message(WARNING "Could not parse version from package.json")
        endif()
    else()
        message(WARNING "package.json not found at: ${PACKAGE_JSON}")
    endif()
    
    # Fall back to default version if not found
    if(NOT CMAKE_PROJECT_VERSION)
        set(CMAKE_PROJECT_VERSION "1.0.0.9999")
        message(STATUS "Version (default): ${CMAKE_PROJECT_VERSION}")
    endif()
else()
    message(STATUS "Version (specified): ${CMAKE_PROJECT_VERSION}")
endif()

# Preserve version for CPack
set(ROCKETRIDE_PROJECT_VERSION "${CMAKE_PROJECT_VERSION}")

# -----------------------------------------------------------------------------
# Installation directory configuration
# By default, install to the build directory
# -----------------------------------------------------------------------------
set(CMAKE_INSTALL_PREFIX "${CMAKE_CURRENT_BINARY_DIR}" 
    CACHE PATH "Installation directory (defaults to build directory)" FORCE)

# -----------------------------------------------------------------------------
# Project declaration
# -----------------------------------------------------------------------------
project(RocketRideEngine 
    VERSION ${CMAKE_PROJECT_VERSION}
    DESCRIPTION "High-performance data processing engine"
    HOMEPAGE_URL "https://github.com/rocketride/rocketride-engine"
    LANGUAGES CXX C
)

# -----------------------------------------------------------------------------
# C++ standard configuration
# We require C++17 for modern language features
# -----------------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# -----------------------------------------------------------------------------
# CMake module path configuration
# Add our custom CMake modules to the search path
# -----------------------------------------------------------------------------
list(APPEND CMAKE_MODULE_PATH 
    ${CMAKE_CURRENT_LIST_DIR}/cmake
    ${CMAKE_CURRENT_LIST_DIR}/engine-core/cmake
)

# -----------------------------------------------------------------------------
# vcpkg integration
# Bootstrap and configure vcpkg for dependency management
# -----------------------------------------------------------------------------
include(vcpkg)
rocketride_setup_vcpkg(${ROCKETRIDE_PROJECT_ROOT})

# -----------------------------------------------------------------------------
# Setup and include rocketride cmake api
# -----------------------------------------------------------------------------
include(cmake/setup.cmake)
include(cmake/rocketride.cmake)

# -----------------------------------------------------------------------------
# Compiler information
# -----------------------------------------------------------------------------
message(STATUS "C compiler  : ${CMAKE_C_COMPILER}")
message(STATUS "C++ compiler: ${CMAKE_CXX_COMPILER}")
message(STATUS "Build type  : ${CMAKE_BUILD_TYPE}")

# -----------------------------------------------------------------------------
# Build options
# -----------------------------------------------------------------------------
option(BUILD_TESTS "Build test suites" ON)
option(BUILD_DOCS "Build documentation" OFF)
option(ENABLE_PYTHON "Enable Python node support" ON)

message(STATUS "Build tests : ${BUILD_TESTS}")
message(STATUS "Build docs  : ${BUILD_DOCS}")
message(STATUS "Python support: ${ENABLE_PYTHON}")
message(STATUS "========================================")

# -----------------------------------------------------------------------------
# Add subdirectories for each component
# Order matters - core must be built before engine-lib, which must be
# built before the engine executable
# -----------------------------------------------------------------------------
# Note: Java/Tika is built separately via: node scripts/build.js build:tika

# Core library (apLib) - fundamental utilities and abstractions
add_subdirectory(engine-core)

# Engine library (engLib) - engine-specific functionality
add_subdirectory(engine-lib)

# Main engine executable (external to packages/server)
add_subdirectory(${ROCKETRIDE_PROJECT_ROOT}/apps/engine ${CMAKE_BINARY_DIR}/apps/engine)

# -----------------------------------------------------------------------------
# Testing configuration
# -----------------------------------------------------------------------------
if(BUILD_TESTS)
    enable_testing()
    # Tests are defined within each package's CMakeLists.txt
endif()

# -----------------------------------------------------------------------------
# Include vcpkg as system headers to suppress warnings
# -----------------------------------------------------------------------------
include_directories(SYSTEM vcpkg)

# -----------------------------------------------------------------------------
# Export compile commands for IDE integration
# -----------------------------------------------------------------------------
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

