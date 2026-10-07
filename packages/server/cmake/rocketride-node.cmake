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

cmake_minimum_required(VERSION 3.20 FATAL_ERROR)

#
# Everything a node needs from the server project, for a node built on its own:
# the CMake project is nodes/src/nodes/<node-dir>, and the engine it imports is
# already built. Include it from a node's CMakeLists.txt right after project().
#
# The builder passes ROCKETRIDE_PACKAGES_DIR and ROCKETRIDE_SERVER_BUILD_DIR -
# the server's build tree, which owns vcpkg's installed packages and the JDK
# headers. The engine module itself comes from the dist, wherever it was
# built or downloaded to
#

if(NOT ROCKETRIDE_PACKAGES_DIR OR NOT ROCKETRIDE_SERVER_BUILD_DIR)
    message(FATAL_ERROR
        "A node project needs -DROCKETRIDE_PACKAGES_DIR and "
        "-DROCKETRIDE_SERVER_BUILD_DIR; build it with `builder nodes:build`")
endif()

get_filename_component(ROCKETRIDE_PACKAGES_DIR "${ROCKETRIDE_PACKAGES_DIR}" ABSOLUTE)
get_filename_component(ROCKETRIDE_SERVER_BUILD_DIR "${ROCKETRIDE_SERVER_BUILD_DIR}" ABSOLUTE)

get_filename_component(ROCKETRIDE_PROJECT_ROOT "${ROCKETRIDE_PACKAGES_DIR}/.." ABSOLUTE)
set(ROCKETRIDE_SERVER_DIR "${ROCKETRIDE_PACKAGES_DIR}/server")

# The dist this node ships into, by the same rule as the server root
if(ROCKETRIDE_OVERLAY_ROOT)
    get_filename_component(ROCKETRIDE_OVERLAY_ROOT "${ROCKETRIDE_OVERLAY_ROOT}" ABSOLUTE)
    set(ROCKETRIDE_DIST_DIR "${ROCKETRIDE_OVERLAY_ROOT}/dist/server")
else()
    set(ROCKETRIDE_DIST_DIR "${ROCKETRIDE_PROJECT_ROOT}/dist/server")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

list(APPEND CMAKE_MODULE_PATH
    ${ROCKETRIDE_SERVER_DIR}/cmake
    ${ROCKETRIDE_SERVER_DIR}/engine-core/cmake)

include(${ROCKETRIDE_SERVER_DIR}/cmake/setup_vcpkg.cmake)
include(${ROCKETRIDE_SERVER_DIR}/cmake/setup.cmake)
include(${ROCKETRIDE_SERVER_DIR}/cmake/rocketride.cmake)

message(STATUS "========================================")
message(STATUS "RocketRide Node Build Configuration")
message(STATUS "========================================")
message(STATUS "Node            : ${PROJECT_NAME}")
message(STATUS "Project root    : ${ROCKETRIDE_PROJECT_ROOT}")
message(STATUS "Overlay root    : ${ROCKETRIDE_OVERLAY_ROOT}")
message(STATUS "Server build    : ${ROCKETRIDE_SERVER_BUILD_DIR}")
message(STATUS "Dist dir        : ${ROCKETRIDE_DIST_DIR}")
message(STATUS "========================================")

# The engine module a node imports its ABI from, as the dist has it
# On Windows the link needs the import library beside the dll
add_library(engineMod SHARED IMPORTED GLOBAL)

if(ROCKETRIDE_PLAT_WIN)
    set_target_properties(engineMod PROPERTIES
        IMPORTED_LOCATION "${ROCKETRIDE_DIST_DIR}/engine.dll"
        IMPORTED_IMPLIB "${ROCKETRIDE_DIST_DIR}/engine.lib")
else()
    set_target_properties(engineMod PROPERTIES
        IMPORTED_LOCATION
            "${ROCKETRIDE_DIST_DIR}/${CMAKE_SHARED_LIBRARY_PREFIX}engine${CMAKE_SHARED_LIBRARY_SUFFIX}")
endif()

get_target_property(engineModFile engineMod IMPORTED_IMPLIB)
if(NOT engineModFile)
    get_target_property(engineModFile engineMod IMPORTED_LOCATION)
endif()

if(NOT EXISTS "${engineModFile}")
    message(FATAL_ERROR
        "The engine module a node links is not there: ${engineModFile}\n"
        "Build the server, or download one - `builder server:build`")
endif()

message(STATUS "Engine module   : ${engineModFile}")

target_include_directories(engineMod INTERFACE "${ROCKETRIDE_SERVER_DIR}/engine-mod/include")

# What engLib and apLib put on their INTERFACE for whatever links them. A node
# reads it from here instead of from those targets, which a build without the
# server does not have. Only engLib's definitions - apLib's would flip the node
# back into export mode
set(ROCKETRIDE_JDK_DIR "${ROCKETRIDE_SERVER_BUILD_DIR}/java/jdk")

if(NOT EXISTS "${ROCKETRIDE_JDK_DIR}/include")
    message(FATAL_ERROR "JDK include directory not found: ${ROCKETRIDE_JDK_DIR}/include\nRun: builder java:setup-jdk")
endif()

if(ROCKETRIDE_PLAT_WIN)
    set(jdkPlatInclude "${ROCKETRIDE_JDK_DIR}/include/win32")
elseif(ROCKETRIDE_PLAT_LIN)
    set(jdkPlatInclude "${ROCKETRIDE_JDK_DIR}/include/linux")
elseif(ROCKETRIDE_PLAT_MAC)
    set(jdkPlatInclude "${ROCKETRIDE_JDK_DIR}/include/darwin")
endif()

set(ROCKETRIDE_ENGINE_INCLUDE_DIRS
    "${ROCKETRIDE_SERVER_DIR}/engine-lib"
    "${ROCKETRIDE_SERVER_DIR}/engine-core"
    "${ROCKETRIDE_SERVER_DIR}/engine-core/include"
    "${VCPKG_INSTALLED_TRIPLET_DIR}/include"
    "${VCPKG_INSTALLED_TRIPLET_DIR}/include/FastPFor/headers"
    "${ROCKETRIDE_JDK_DIR}/include"
    "${jdkPlatInclude}")

set(ROCKETRIDE_ENGINE_DEFINITIONS _TURN_OFF_PLATFORM_STRING=1)

#
# rocketride_add_node - Builds a C++ node as a shared library importing the
# engine ABI from engineMod
#
# Usage, from nodes/src/nodes/<node-dir>/CMakeLists.txt:
#   rocketride_add_node(cppExample)
#
# Arguments:
#   targetName - The CMake target and library base name; must match the "path"
#                field of the node's services.json
#   ARGN       - Additional source globs
#
function(rocketride_add_node targetName)
    set(sourceGlobs
        ${CMAKE_CURRENT_SOURCE_DIR}/services*.json
        ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp
        ${CMAKE_CURRENT_SOURCE_DIR}/src/*.hpp
        ${CMAKE_CURRENT_SOURCE_DIR}/src/*.h
        ${ARGN})

    rocketride_load_sources(targetDeps ${sourceGlobs})

    add_library(${targetName} SHARED ${targetDeps})

    set_target_properties(${targetName} PROPERTIES
        OUTPUT_NAME ${targetName})

    set_property(TARGET ${targetName} PROPERTY FOLDER "nodes")

    # Import mode; see ROCKETRIDE_CORE_API in apLib/ap.h
    target_compile_definitions(${targetName} PRIVATE
        ROCKETRIDE_CORE_IMPORT
        JSON_DLL)

    target_link_libraries(${targetName} PRIVATE engineMod)

    # engLib's and apLib's header usage requirements, which engineMod links
    # PRIVATE - interface only, the archives themselves are never linked
    target_include_directories(${targetName} PRIVATE ${ROCKETRIDE_ENGINE_INCLUDE_DIRS})
    target_compile_definitions(${targetName} PRIVATE ${ROCKETRIDE_ENGINE_DEFINITIONS})

    # Third-party libraries engineMod does not re-export, so the node links its
    # own copy. Python/pybind11 are required even for a node holding no python
    # code - filter.hpp puts pybind11 types on its virtual interface
    find_package(Python3 COMPONENTS Development REQUIRED)
    find_package(pybind11 REQUIRED)
    target_link_libraries(${targetName} PRIVATE Python3::Python pybind11::embed)

    find_package(ICU REQUIRED COMPONENTS i18n)
    target_link_libraries(${targetName} PRIVATE ICU::i18n)

    if(ROCKETRIDE_PLAT_WIN)
        find_package(Boost CONFIG REQUIRED COMPONENTS stacktrace_windbg)
        target_link_libraries(${targetName} PRIVATE Boost::stacktrace_windbg)
    endif()

    # Unity and PCH, as every other target gets them. engLib's headers are
    # force-included ahead of the node's own sources - a fresh PCH, not
    # REUSE_FROM engLib, since that one is in export mode
    rocketride_pch(${targetName}
        PCH ${ROCKETRIDE_PACKAGES_DIR}/server/engine-lib/engLib/headers.h)

    if(ROCKETRIDE_PLAT_WIN)
        # C4275: dll-interface classes deriving from non-dll-interface std bases
        target_compile_options(${targetName} PRIVATE /wd4275)
    endif()

    # The loader resolves a node library relative to the engine executable, so
    # it has to land in dist/server/nodes/<node-dir>
    get_filename_component(nodeDir ${CMAKE_CURRENT_SOURCE_DIR} NAME)
    set(distDir "${ROCKETRIDE_DIST_DIR}/nodes/${nodeDir}")

    if(ROCKETRIDE_CMAKE_KITS)
        add_custom_command(TARGET ${targetName} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E make_directory "${distDir}"
            COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:${targetName}> "${distDir}/"
            COMMENT "Copying $<TARGET_FILE_NAME:${targetName}> to dist/server/nodes/${nodeDir}")
    endif()

    # On *nix the node resolves engineMod out of the engine's own directory,
    # two levels up from nodes/<node-dir>
    if(ROCKETRIDE_PLAT_LIN)
        set_target_properties(${targetName} PROPERTIES
            INSTALL_RPATH "\$ORIGIN/../..:\$ORIGIN/../../lib"
            BUILD_WITH_INSTALL_RPATH TRUE)
    elseif(ROCKETRIDE_PLAT_MAC)
        set_target_properties(${targetName} PROPERTIES
            INSTALL_RPATH "@loader_path/../..;@loader_path/../../lib"
            BUILD_WITH_INSTALL_RPATH TRUE)
    endif()
endfunction()
