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

# Require 3.16 for the built-in unity support
cmake_minimum_required(VERSION 3.16 FATAL_ERROR)

# Upstream BoostConfig.cmake package config
if(POLICY CMP0167)
    cmake_policy(SET CMP0167 NEW)
endif()

include(CMakeParseArguments)
include(CheckFunctionExists)
include(CheckLibraryExists)
include(CheckIncludeFile)
include(TestBigEndian)

#
# rocketride_set_common_target_options - Sets common options across all rocketride targets
#
# Usage:
#   rocketride_set_common_target_options(target)
#
function(rocketride_set_common_target_options target)
    if(NOT TARGET ${target})
        message(FATAL_ERROR "Invalid taget ${target}")
    endif()

    if(ROCKETRIDE_PLAT_UNX)
        set(TARGET_FILE $<TARGET_FILE:${target}>)
        set(TARGET_FILE_DIR $<TARGET_FILE_DIR:${target}>)
        set(TARGET_NAME $<TARGET_FILE_NAME:${target}>)
        set(TARGET_DEBUG_FILE ${TARGET_FILE_DIR}/${TARGET_NAME}.debug)
        set(TARGET_DEBUG_SYMS_FILE ${TARGET_FILE_DIR}/${TARGET_NAME}.symbols)
        get_target_property(target_type ${target} TYPE)

        if(target_type STREQUAL "EXECUTABLE")
            # On *nix break out the debug info so we can store it separate from the release binary
            if("${CMAKE_BUILD_TYPE}" MATCHES "Release" OR "${CMAKE_BUILD_TYPE}" MATCHES "Sanitize")
                if(ROCKETRIDE_PLAT_LIN)
                    add_custom_command(TARGET ${target} POST_BUILD
                        COMMAND objcopy --only-keep-debug ${TARGET_FILE} ${TARGET_DEBUG_FILE}
                        #COMMAND objcopy --strip-debug ${TARGET_FILE}
                        COMMAND objcopy --add-gnu-debuglink=${TARGET_DEBUG_FILE} ${TARGET_FILE}
                        COMMENT "Separating debug information from ${TARGET_NAME}(${TARGET_DEBUG_FILE})"
                        VERBATIM
                    )
                elseif(ROCKETRIDE_PLAT_MAC)
                    add_custom_command(TARGET ${target} POST_BUILD
                        COMMAND dsymutil ${TARGET_FILE} -o ${TARGET_DEBUG_FILE}
                        COMMENT "Separating debug information from ${TARGET_NAME}(${TARGET_DEBUG_FILE})"
                        VERBATIM
                    )
                endif()
            endif()

            # On Linux release builds, retain the Breakpad symbols
            if(ROCKETRIDE_PLAT_LIN AND "${CMAKE_BUILD_TYPE}" MATCHES "Release")
                set(breakpad_bin_dump_syms "${VCPKG_INSTALLED_TRIPLET_DIR}/bin/dump_syms")
                if(NOT EXISTS ${breakpad_bin_dump_syms})
                    message(FATAL_ERROR "Breakpad's dump_syms tool not found at expected path: ${breakpad_bin_dump_syms}")
                endif()

                rocketride_msg("Breakpad's dump_syms tool found at ${breakpad_bin_dump_syms}")
                add_custom_command(TARGET ${target} POST_BUILD
                    COMMAND ${CMAKE_COMMAND} -E env bash -c "${breakpad_bin_dump_syms} ${TARGET_DEBUG_FILE} > ${TARGET_DEBUG_SYMS_FILE}"
                    COMMENT "Dumping Breakpad symbols from ${TARGET_NAME}(${TARGET_DEBUG_SYMS_FILE})"
                    VERBATIM
                )
            endif()
        endif()
    endif()

    # Turn off d postfix
    set_target_properties(${target} PROPERTIES DEBUG_POSTFIX "")

    # Declare the module specific definition
    string(TOUPPER ${target} PRIVATE_DEF)
    # If the target name includes a "-" character, replace it with "_" so that the C macro will be validly named
    string(REPLACE "-" "_" PRIVATE_DEF "${PRIVATE_DEF}")

    if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
        target_compile_definitions(${target} PRIVATE SIMDE_ENABLE_NATIVE_ALIASES)
    endif()

    target_compile_definitions(${target} PRIVATE -DBUILD_${PRIVATE_DEF})

    set_target_properties(${target} PROPERTIES CXX_STANDARD 20)

endfunction()

#
# rocketride_add_library - Creates a static library target
#
# Usage:
#   rocketride_add_library(targetName *.cpp *.hpp *.h)
#
function(rocketride_add_library targetName)

    rocketride_load_sources(targetDeps ${ARGN})

    add_library(${targetName} STATIC ${targetDeps})

    rocketride_set_common_target_options(${targetName})

endfunction()

#
# rocketride_add_executable - Creates an executable target
#
# Usage:
#   rocketride_add_executable(targetName *.cpp *.hpp *.h)
#
function(rocketride_add_executable targetName)
    rocketride_load_sources(targetDeps ${ARGN})

    add_executable(${targetName} ${targetDeps})

    rocketride_set_common_target_options(${targetName})

endfunction()

#
# rocketride_load_sources - Uses the glob approach to building source files
# allows for platform specific folders to be automatically excluded/included
# depending on the current platform.
# For example, in the following project layout:
#
#   MyProj\*.cpp
#   windows\*.cpp
#   linux\*.cpp
#   mac\*.cpp
#
# Only the win, and MyProject paths will be scanned, excluding lin/mac folders
# automatically.
#
# Usage:
#    rocketride_load_sources(VarName
#        NO_RECURSE
#        EXCLUDE "SomeValue"
#        LIST_ONLY_EXTS "json;pem"
#        *.hpp
#        *.cpp
#        *.c
#        *.json
#        *.pem
#        ...
#    )
#
# Options:
#   NO_RECURSE - If specified will prevent scanning recursively in paths.
#
# Arguments:
#   EXCLUDE - Defines a string to exclude, will be matched on with regex.
#   LIST_ONLY_EXTS - Defines one or more file extensions (separated by semicolon) which should not be compiled.
#                    This is useful for displaying configuration files or resources in the project envs.
#   ARGN - One or more paths with wildcards, e.g. ${CMAKE_CURRENT_SOURCE_DIR}/*.cpp
#
function(rocketride_load_sources output_var)
    set(options NO_RECURSE)
    set(oneValueArgs EXCLUDE LIST_ONLY_EXTS)

    cmake_parse_arguments(rocketride_load_sources "${options}" "${oneValueArgs}" "${multiArgs}" ${ARGN})

    foreach(pattern ${ARGN})
        if(NOT IS_ABSOLUTE ${pattern})
            set(pattern ${CMAKE_CURRENT_SOURCE_DIR}/${pattern})
        endif()
        file(GLOB_RECURSE _source_files LIST_DIRECTORIES false ${pattern})
        set(source_files ${source_files} ${_source_files})
    endforeach()

    if(NOT source_files)
        message(FATAL_ERROR "No sources loaded for filter: ${ARGN}")
    endif()

    # Exclude platform folders that do not match our own
    if(ROCKETRIDE_PLAT_WIN)
        list(FILTER source_files EXCLUDE REGEX "unx/[^;]+;?")
        list(FILTER source_files EXCLUDE REGEX "mac/[^;]+;?")
        list(FILTER source_files EXCLUDE REGEX "lin/[^;]+;?")
    elseif(ROCKETRIDE_PLAT_LIN)
        list(FILTER source_files EXCLUDE REGEX "win/[^;]+;?")
        list(FILTER source_files EXCLUDE REGEX "mac/[^;]+;?")
    elseif(ROCKETRIDE_PLAT_MAC)
        list(FILTER source_files EXCLUDE REGEX "win/[^;]+;?")
        list(FILTER source_files EXCLUDE REGEX "lin/[^;]+;?")
    else()
        message(FATAL_ERROR "Unknown platform")
    endif()

    # Exclude, excludes
    if(rocketride_load_sources_EXCLUDE)
        list(FILTER source_files EXCLUDE REGEX "${rocketride_load_sources_EXCLUDE}")
    endif()

    # Now strip out any list only extensions so we can group them differently from the rest
    if(rocketride_load_sources_LIST_ONLY_EXTS)
        # Convert it to a list
        separate_arguments(list_only_exts UNIX_COMMAND ${rocketride_load_sources_LIST_ONLY_EXTS})
        foreach(source_file ${source_files})
            get_filename_component(source_file_ext ${source_file} EXT)

            if(source_file_ext)
                foreach(list_only_ext ${list_only_exts})
                    if(".${list_only_ext}" STREQUAL ${source_file_ext})
                        set_source_files_properties(${source_file} PROPERTIES HEADER_FILE_ONLY TRUE)
                        list(REMOVE_ITEM source_files ${source_file})
                        set(list_only_files ${list_only_files} ${source_file})
                    endif()
                endforeach()
            endif()
        endforeach()
    endif()

    # Now set this in the callers scope and combine both list only and source files
    set(${output_var} ${source_files} ${list_only_files} PARENT_SCOPE)

endfunction()

#
# rocketride_pch - Sets up the precompiled header and unity build
#
macro(rocketride_pch target)
    set(options NO_UNITY)
    set(multiArgs UNITY_EXCLUDES)
    set(oneValueArgs PCH)

    cmake_parse_arguments(rocketride_pch "${options}" "${oneValueArgs}" "${multiArgs}" ${ARGN})

    if(rocketride_pch_NO_UNITY)
        rocketride_msg("NOT enabling unity mode for target - ${target}")
        set_target_properties(${target} PROPERTIES UNITY_BUILD FALSE)
    else()
        rocketride_msg("Enabling unity for target - ${target}")
        set_target_properties(${target} PROPERTIES UNITY_BUILD TRUE)
        # We could set UNITY_BUILD_BATCH_SIZE here, which defaults to 8
        # See https://cmake.org/cmake/help/v3.16/prop_tgt/UNITY_BUILD_BATCH_SIxZE.html#prop_tgt:UNITY_BUILD_BATCH_SIZE

        # Set the batch size to 128 - it seems to be the best balance
        # between full builds, changing an .HPP, .H and a single .CPP
        set_target_properties(${target} PROPERTIES UNITY_BUILD_BATCH_SIZE 128)

    endif()

    if(rocketride_pch_UNITY_EXCLUDES)
        foreach(EXCLUDE ${rocketride_pch_UNITY_EXCLUDES})
            rocketride_msg("Unity exclude ${EXCLUDE} for target ${target}")
            set_source_files_properties(${EXCLUDE} PROPERTIES SKIP_UNITY_BUILD_INCLUSION TRUE)
        endforeach()
    endif()

    # Exclude files listed in .unity-excludes files from unity build
    file(GLOB_RECURSE unity_exclude_files RELATIVE ${CMAKE_CURRENT_LIST_DIR} ".unity-excludes")
    foreach(unity_exclude_file ${unity_exclude_files})
        file(READ "${CMAKE_CURRENT_LIST_DIR}/${unity_exclude_file}" unity_exclude_content)
        string(REPLACE "\n" ";" unity_exclude_list "${unity_exclude_content}")
        foreach(unity_exclude ${unity_exclude_list})
            if(unity_exclude STREQUAL "" OR unity_exclude MATCHES "^\\s*#")
                continue()
            endif()

            get_filename_component(unity_exclude_dir "${CMAKE_CURRENT_LIST_DIR}/${unity_exclude_file}" DIRECTORY)
            set(unity_exclude "${unity_exclude_dir}/${unity_exclude}")
            rocketride_msg("Unity exclude ${unity_exclude} for target ${target}")
            set_source_files_properties("${unity_exclude}" PROPERTIES SKIP_UNITY_BUILD_INCLUSION TRUE)
        endforeach()
    endforeach()

    rocketride_msg("Building PCH from ${rocketride_pch_PCH}")
    target_precompile_headers(${target} PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:${rocketride_pch_PCH}>")

    rocketride_set_common_target_options(${target})

endmacro()

#
# rocketride_reexport_library_defines - Re-export compile definitions from PRIVATE deps so targets
# that REUSE_FROM a target (e.g. engine) get the same defines and avoid MSVC C4651.
#
# Usage:
#   rocketride_reexport_library_defines(target dep_target [dep_target ...])
#
function(rocketride_reexport_library_defines target)
    foreach(dep_target IN LISTS ARGN)
        if(TARGET ${dep_target})
            get_target_property(defs ${dep_target} INTERFACE_COMPILE_DEFINITIONS)
            if(defs)
                target_compile_definitions(${target} PUBLIC ${defs})
            endif()
        endif()
    endforeach()
endfunction()
