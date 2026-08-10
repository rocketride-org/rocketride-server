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

    # engLib's header usage requirements, inherited because engineMod links it
    # PRIVATE - interface only, the archive itself is never linked
    target_include_directories(${targetName} PRIVATE
        $<TARGET_PROPERTY:engLib,INTERFACE_INCLUDE_DIRECTORIES>
        $<TARGET_PROPERTY:apLib,INTERFACE_INCLUDE_DIRECTORIES>
        ${ROCKETRIDE_PACKAGES_DIR}/server/engine-core
        ${VCPKG_INSTALLED_TRIPLET_DIR}/include)

    # engLib's interface definitions only - apLib's would flip this target back
    # into export mode
    target_compile_definitions(${targetName} PRIVATE
        $<TARGET_PROPERTY:engLib,INTERFACE_COMPILE_DEFINITIONS>)

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

    add_dependencies(engine ${targetName})

    # The loader resolves a node library relative to the engine executable, so
    # it has to land in dist/server/nodes/<node-dir>
    get_filename_component(nodeDir ${CMAKE_CURRENT_SOURCE_DIR} NAME)
    set(distDir "${ROCKETRIDE_PROJECT_ROOT}/dist/server/nodes/${nodeDir}")

    if(ROCKETRIDE_CMAKE_KIST)
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
