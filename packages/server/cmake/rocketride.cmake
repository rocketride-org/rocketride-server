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

# Define the packages directory
# Note: ROCKETRIDE_PROJECT_ROOT is defined in the main CMakeLists.txt (packages/server/)
set(ROCKETRIDE_PACKAGES_DIR "${ROCKETRIDE_PROJECT_ROOT}/packages")

#
# rocketride_building_target_installs_component - Causes installation of a specified
# component when a specific target is built.
#
# Usage:
#	rocketride_building_target_installs_component(target component)
#
macro(rocketride_building_target_installs_component target component)
	set(multiArgs DEPENDS)

	cmake_parse_arguments(rocketride_building_target_installs_component "" "" "${multiArgs}" ${ARGN})

	if (NOT TARGET ${target})
		message(FATAL_ERROR "Invalid taget ${target}")
	endif()

	add_custom_target(${target}.${component}.install.dep
		COMMAND
			${CMAKE_COMMAND}
			-DBUILD_TYPE=${CMAKE_BUILD_TYPE}
			-DCOMPONENT=${component}
			-P ${CMAKE_BINARY_DIR}/cmake_install.cmake
		COMMENT "Building ${target} component ${component} from ${CMAKE_BINARY_DIR}")

	if (rocketride_building_target_installs_component_DEPENDS)
		foreach(DEPENDS ${rocketride_building_target_installs_component_DEPENDS})
			rocketride_msg("Adding dependency on ${target} component ${component} of ${DEPENDS}")
			add_dependencies(${target}.${component}.install.dep ${DEPENDS})
		endforeach()
	endif()

	add_dependencies(${target} ${target}.${component}.install.dep)

endmacro()

#
# rocketride_set_common_target_options - Sets common options across all rocketride targets
#
# Usage:
#	rocketride_set_common_target_options(target)
#
function(rocketride_set_common_target_options target)
	if (NOT TARGET ${target})
		message(FATAL_ERROR "Invalid taget ${target}")
	endif()

	if (ROCKETRIDE_PLAT_UNX)
		set(TARGET_FILE $<TARGET_FILE:${target}>)
		set(TARGET_FILE_DIR $<TARGET_FILE_DIR:${target}>)
		set(TARGET_NAME $<TARGET_FILE_NAME:${target}>)
		set(TARGET_DEBUG_FILE ${TARGET_FILE_DIR}/${TARGET_NAME}.debug)
		set(TARGET_DEBUG_SYMS_FILE ${TARGET_FILE_DIR}/${TARGET_NAME}.symbols)
		get_target_property(target_type ${target} TYPE)

		if (target_type STREQUAL "EXECUTABLE")
			# On *nix break out the debug info so we can store it separate from the release binary
			if ("${CMAKE_BUILD_TYPE}" MATCHES "Release" OR "${CMAKE_BUILD_TYPE}" MATCHES "Sanitize")
				if (ROCKETRIDE_PLAT_LIN)
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
			if (ROCKETRIDE_PLAT_LIN AND "${CMAKE_BUILD_TYPE}" MATCHES "Release")
				set(breakpad_bin_dump_syms "${DEPS_ROOT}/bin/dump_syms")
				if (NOT EXISTS ${breakpad_bin_dump_syms})
					message(FATAL_ERROR "Breakpad's dump_syms tool not found at expected path: ${breakpad_bin_dump_syms}")
				endif()

				rocketride_msg("Breakpad's dump_syms tool found at ${breakpad_bin_dump_syms}")
				add_custom_command(TARGET ${target} POST_BUILD
					COMMAND ${CMAKE_COMMAND} -E env bash -c "${breakpad_bin_dump_syms} ${TARGET_DEBUG_FILE} > ${TARGET_DEBUG_SYMS_FILE}"
					COMMENT "Dumping Breakpad symbols from ${TARGET_NAME}(${TARGET_DEBUG_SYMS_FILE})"
					VERBATIM
				)
			endif ()
		endif ()
	endif()

	# Turn off d postfix
	set_target_properties(${target} PROPERTIES DEBUG_POSTFIX "")

	# Declare the module specific definition
	string(TOUPPER ${target} PRIVATE_DEF)
	# If the target name includes a "-" character, replace it with "_" so that the C macro will be validly named
	string(REPLACE "-" "_" PRIVATE_DEF "${PRIVATE_DEF}")
	
        if (CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
	   target_compile_definitions(${target} PRIVATE SIMDE_ENABLE_NATIVE_ALIASES)
        endif()

        target_compile_definitions(${target} PRIVATE -DBUILD_${PRIVATE_DEF})

	set_target_properties(${target} PROPERTIES CXX_STANDARD 20)

endfunction()

#
# rocketride_add_library - Creates a static library target
#
# Usage:
#	 rocketride_add_library(targetName *.cpp *.hpp *.h)
#
function(rocketride_add_library targetName)

	rocketride_load_sources(targetDeps ${ARGN})

	add_library(${targetName} STATIC ${targetDeps} )

	rocketride_set_common_target_options(${targetName})

endfunction()

#
# rocketride_add_executable - Creates an executable target
#
# Usage:
#	 rocketride_add_executable(targetName *.cpp *.hpp *.h)
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
#	MyProj\*.cpp
#	windows\*.cpp
#	linux\*.cpp
#	mac\*.cpp
#
# Only the win, and MyProject paths will be scanned, excluding lin/mac folders
# automatically.
#
# Usage:
#	rocketride_load_sources(VarName
#		NO_RECURSE
#		EXCLUDE "SomeValue"
#		LIST_ONLY_EXTS "json;pem"
#		*.hpp
#		*.cpp
#		*.c
#		*.json
#		*.pem
#		...
#	)
#
# Options:
#	NO_RECURSE - If specified will prevent scanning recursively in paths.
#
# Arguments:
#	 EXCLUDE	- Defines a string to exclude, will be matched on with regex.
#	 ARGN		- One or more paths with wildcards, e.g. ${CMAKE_CURRENT_SOURCE_DIR}/*.cpp
#	 LIST_ONLY_EXTS - Defines one or more file extensions (separated by semicolon) which should not be compiled.
#			 This is useful for displaying configuration files or
#			 resources in the project envs.
#
function(rocketride_load_sources output_var)
	set(options NO_RECURSE)
	set(oneValueArgs EXCLUDE LIST_ONLY_EXTS)

	cmake_parse_arguments(rocketride_load_sources "${options}" "${oneValueArgs}" "${multiArgs}" ${ARGN})

	foreach(pattern ${ARGN})
		if (NOT IS_ABSOLUTE ${pattern})
			set(pattern ${CMAKE_CURRENT_SOURCE_DIR}/${pattern})
		endif()
		file(GLOB_RECURSE _source_files [LIST_DIRECTORIES false] ${pattern})
		set(source_files ${source_files} ${_source_files})
	endforeach()

	if (NOT source_files)
		message(FATAL_ERROR "No sources loaded for filter: ${ARGN}")
	endif()

	# Exclude platform folders that do not match our own
	if (ROCKETRIDE_PLAT_WIN)
		list(FILTER source_files EXCLUDE REGEX "unx/[^;]+;?")
		list(FILTER source_files EXCLUDE REGEX "mac/[^;]+;?")
		list(FILTER source_files EXCLUDE REGEX "lin/[^;]+;?")
	elseif (ROCKETRIDE_PLAT_LIN)
		list(FILTER source_files EXCLUDE REGEX "win/[^;]+;?")
		list(FILTER source_files EXCLUDE REGEX "mac/[^;]+;?")
	elseif (ROCKETRIDE_PLAT_MAC)
		list(FILTER source_files EXCLUDE REGEX "win/[^;]+;?")
		list(FILTER source_files EXCLUDE REGEX "lin/[^;]+;?")
	else()
		message(FATAL_ERROR "Unknown platform")
	endif()

	# Exclude, excludes
	if (rocketride_load_sources_EXCLUDE)
		list(FILTER source_files EXCLUDE REGEX "${rocketride_load_sources_EXCLUDE}")
	endif()

	# Now strip out any list only extensions so we can group them differently from the rest
	if (rocketride_load_sources_LIST_ONLY_EXTS)
		# Convert it to a list
		separate_arguments(list_only_exts UNIX_COMMAND ${rocketride_load_sources_LIST_ONLY_EXTS})
		foreach(source_file ${source_files})
			get_filename_component(source_file_ext ${source_file} EXT)

			if (source_file_ext)
				foreach(list_only_ext ${list_only_exts})
					if (".${list_only_ext}" STREQUAL ${source_file_ext})
						set_source_files_properties(${source_file} PROPERTIES HEADER_FILE_ONLY TRUE)
						list(REMOVE_ITEM source_files ${source_file})
						set(list_only_files ${list_only_files} ${source_file})
					endif()
				endforeach()
			endif()
		endforeach()
	endif()

	# Sort the dependencies in visual studio
#	if (ROCKETRIDE_PLAT_WIN)
#		source_group(TREE ${CMAKE_CURRENT_LIST_DIR} PREFIX "/" FILES ${source_files})
#		source_group(TREE ${CMAKE_CURRENT_LIST_DIR} PREFIX "/" FILES ${list_only_files})
#	endif()

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

	if (rocketride_pch_NO_UNITY)
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

	if (rocketride_pch_UNITY_EXCLUDES)
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
			if (unity_exclude STREQUAL "" OR unity_exclude MATCHES "^\\s*#")
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
# rocketride_copy - Copy a directory or file to the location of the binary being
# built by the current target.
#
macro(rocketride_copy targetName _path)
	set(options INSTALL WATCH)
	set(oneValueArgs DEST_NAME DEPENDS)
	set(multiArgs EXCLUDE)
	cmake_parse_arguments(rocketride_copy "${options}" "${oneValueArgs}" "${multiArgs}" ${ARGN})

	# If it's not an absolute path,  make it relative to the current directory
	if (NOT IS_ABSOLUTE ${_path})
		set(path ${CMAKE_CURRENT_LIST_DIR}/${_path})
	else()
		set(path ${_path})
	endif()
	
	# Parse the filename from the path; replace with DEST_NAME if specified
	get_filename_component(FILE_NAME ${path} NAME)
	if (rocketride_copy_DEST_NAME)
		set(FILE_NAME ${rocketride_copy_DEST_NAME})
	endif()

	# Require the source to exist unless this is a build-time command (i.e. WATCH was specified)
	if (NOT EXISTS ${path} AND NOT rocketride_copy_WATCH)
		message(FATAL_ERROR "Path to copy does not exist: ${path}")
	elseif (IS_DIRECTORY ${path})
		if (rocketride_copy_WATCH)
			set(outputPath ${CMAKE_CURRENT_BINARY_DIR}/${_path})
			
			# Build a list of relative paths for files in the directory
			file(GLOB_RECURSE relativeInputFiles RELATIVE ${path} "${path}/*")
			
			# Convert to absolute input and output paths
			foreach(inputFile ${relativeInputFiles})
				list(APPEND inputFiles ${path}/${inputFile})
				list(APPEND outputFiles ${outputPath}/${inputFile})
			endforeach()
			
			# Add custom command to copy the source files if any of them change
			add_custom_command(
				COMMAND ${CMAKE_COMMAND} -E copy_directory ${path} ${outputPath}
				COMMENT "Copying contents of ${path}"
				OUTPUT ${outputFiles}
				DEPENDS ${inputFiles}
			)

			# Create a randomly named custom target to wrap the command
			string(RANDOM LENGTH 16 rnd)
			set(customTargetName "zz__tmp${rnd}")

			while (TARGET customTargetName)
				string(RANDOM LENGTH 16 rnd)
				set(customTargetName "zz__tmp${rnd}")
			endwhile()

			add_custom_target(${customTargetName}
				DEPENDS ${outputFiles}
				COMMENT Copying contents of ${path}
			)
			set_target_properties(${customTargetName} PROPERTIES FOLDER "tmp")

			# Make the custom target dependent on the specified dependency
			if (rocketride_copy_DEPENDS)
				add_dependencies(${customTargetName} ${rocketride_copy_DEPENDS})
			endif()
			
			# Make the target dependent on it
			add_dependencies(${targetName} ${customTargetName})
			rocketride_msg("Copying directory ${path} => ${outputPath} at build time when needed")
		else()
			if (rocketride_copy_EXCLUDE)
				# Copy files one by one except excluded ones
				file(GLOB source_files RELATIVE ${path} ${path}/*)
				list(REMOVE_ITEM source_files ${rocketride_copy_EXCLUDE})
				add_custom_command(
					TARGET ${targetName}
					PRE_BUILD
					COMMAND ${CMAKE_COMMAND} -E make_directory $<TARGET_FILE_DIR:${targetName}>/${FILE_NAME})
				rocketride_msg("Making directory $<TARGET_FILE_DIR:${targetName}>/${FILE_NAME}")
				foreach(source_file ${source_files})
					add_custom_command(
						TARGET ${targetName}
						PRE_BUILD
						COMMAND ${CMAKE_COMMAND} -E copy ${path}/${source_file} $<TARGET_FILE_DIR:${targetName}>/${FILE_NAME})
					rocketride_msg("Copying file ${path}/${source_file} => $<TARGET_FILE_DIR:${targetName}>/${FILE_NAME}")
				endforeach()
			else()
				add_custom_command(
					TARGET ${targetName}
					PRE_BUILD
					COMMAND ${CMAKE_COMMAND} -E copy_directory ${path} $<TARGET_FILE_DIR:${targetName}>/${FILE_NAME}
				)
				rocketride_msg("Copying directory ${path} => $<TARGET_FILE_DIR:${targetName}>/${FILE_NAME}")
			endif()
		endif()

		if (rocketride_copy_INSTALL)
			if (rocketride_copy_EXCLUDE)
				# Install source files one by one except excluded ones
				foreach(source_file ${source_files})
					set(install_file ${path}/${source_file})

					if (rocketride_copy_DEST_NAME)
						install(FILES ${install_file} DESTINATION ${rocketride_copy_DEST_NAME})
						rocketride_msg("Installing file ${install_file} as ${rocketride_copy_DEST_NAME}/${source_file}")
					else()
						install(FILES ${install_file} DESTINATION .)
						rocketride_msg("Installing file ${install_file} as ${FILE_NAME}/${source_file}")
					endif()
				endforeach()
			else()
				if (rocketride_copy_DEST_NAME)
					install(DIRECTORY "${path}/" DESTINATION ${rocketride_copy_DEST_NAME})
					rocketride_msg("Installing directory ${path} as ${rocketride_copy_DEST_NAME}")
				else()
					install(DIRECTORY "${path}/" DESTINATION .)
					rocketride_msg("Installing directory ${path} as ${FILE_NAME}")
				endif()
			endif()
		endif()
	else()
		# If WATCH was specified but the path doesn't exist yet, assume it will be a file
		# This could be extended with something like an ISDIR flag to assume it's a directory instead
		if (NOT EXISTS ${path})
			rocketride_msg("Path to copy does not exist yet; assuming it will be a single file, not a directory")
		endif()
		
		get_filename_component(FILE_NAME ${path} NAME)
		if (rocketride_copy_DEST_NAME)
			set(FILE_NAME ${rocketride_copy_DEST_NAME})
		endif()
		
		if (rocketride_copy_WATCH)
			set(outputPath ${CMAKE_CURRENT_BINARY_DIR}/${FILE_NAME})
		
			# Add custom command to copy the source file if it changes
			add_custom_command(
				COMMAND ${CMAKE_COMMAND} -E copy ${path} ${outputPath}
				COMMENT "Copying ${path}"
				OUTPUT ${outputPath}
				DEPENDS ${path}
			)

			# Create a randomly named custom target to wrap the command
			string(RANDOM LENGTH 16 rnd)
			set(customTargetName "zz__tmp${rnd}")

			while (TARGET customTargetName)
				string(RANDOM LENGTH 16 rnd)
				set(customTargetName "zz__tmp${rnd}")
			endwhile()
			
			add_custom_target(${customTargetName}
				DEPENDS ${outputPath}
				COMMENT Copying ${path}
			)
			set_target_properties(${customTargetName} PROPERTIES FOLDER "tmp")
			
			# Make the target dependent on it
			add_dependencies(${targetName} ${customTargetName})
			rocketride_msg("Copying file ${path} => ${outputPath} at build time when needed")
		else()
			add_custom_command(TARGET ${targetName} PRE_BUILD COMMAND ${CMAKE_COMMAND} -E copy ${path} $<TARGET_FILE_DIR:${targetName}>/${FILE_NAME})
			rocketride_msg("Copying file ${path} => $<TARGET_FILE_DIR:${targetName}>/${FILE_NAME}")
		endif()
		
		if (rocketride_copy_INSTALL)
			if (rocketride_copy_DEST_NAME)
				# Get the final character of the DEST_NAME
				string(LENGTH ${rocketride_copy_DEST_NAME} dest_name_length)
				math(EXPR dest_name_length_minus_one "${dest_name_length} - 1")
				string(SUBSTRING ${rocketride_copy_DEST_NAME} ${dest_name_length_minus_one} 1 last_dest_name_char)
				
				# If DEST_NAME ends in '/', just install to the directory DEST_NAME
				if (last_dest_name_char STREQUAL "/")
					install(FILES ${path} DESTINATION ${rocketride_copy_DEST_NAME})
				else()
					# Otherwise, assume we're renaming the source file
					# Split DEST_NAME into directory and file portions
					get_filename_component(dest_directory ${rocketride_copy_DEST_NAME} DIRECTORY)
					get_filename_component(dest_file ${rocketride_copy_DEST_NAME} NAME)

					if (dest_directory)
						# If DEST_NAME is a path, install to the directory portion and rename to the file portion
						install(FILES ${path} DESTINATION ${dest_directory} RENAME ${dest_file})
					else()
						# Otherwise, assume DEST_NAME is a filename and rename
						install(FILES ${path} DESTINATION . RENAME ${dest_file})
					endif()
				endif()

				rocketride_msg("Installing file ${path} as ${rocketride_copy_DEST_NAME}")
			else()
				install(FILES ${path} DESTINATION .)
				rocketride_msg("Installing file ${path} as ${FILE_NAME}")
			endif()
		endif()
	endif()
endmacro()

# rocketride_install - Install helper, sets installation rules for both unity
# and non unity targets
#
# 	usage:
#		rocketride_install(apTest ApTest {file1} {file1} ...)
#
macro(rocketride_install target comp)
	rocketride_msg("Setting up install rules for target ${target} (${comp})")

	# Install the target (if built)
	install(TARGETS ${target} COMPONENT ${comp} EXPORT ${comp}Config DESTINATION . OPTIONAL)

	# Install the dependencies
	foreach(dep ${ARGN})
		rocketride_msg("Installing ${dep} for target ${target}")
		if (IS_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}/${dep})
			install(DIRECTORY ${CMAKE_CURRENT_LIST_DIR}/${dep} DESTINATION .)
		else()
			install(FILES ${CMAKE_CURRENT_LIST_DIR}/${dep} DESTINATION .)
		endif()
	endforeach()

endmacro()

#
# rocketride_dependency_link - Looks for a package, or library, with a CONFIG or
# non config mode, and links to the required target and adds include dirs to
# the target as needed. This will ensure the proper debug/release libs are
# discovered and it works around a few vcpkg quirks to do this.
#
# 	usage:
#		rocketride_dependency_link(apLib Boost COMPONENTS log stack)
#		rocketride_dependency_link(apLib libcurl)
#
macro(rocketride_dependency_link target name)
	set(options CONFIG)
	set(multiArgs COMPONENTS TARGETS INTERFACES)
	set(oneValueArgs ALIAS)
	set(components ${ARGN})

	cmake_parse_arguments(rocketride_dependency_link "${options}" "${oneValueArgs}" "${multiArgs}" ${ARGN})

	if (rocketride_dependency_link_CONFIG)
		rocketride_msg("Looking Config based dependency ${name}")
	else()
		rocketride_msg("Looking dependency ${name}")
	endif()
	if (rocketride_dependency_link_COMPONENTS)
		rocketride_msg("   Components: ${rocketride_dependency_link_COMPONENTS}")
	endif()
	if (rocketride_dependency_link_ALIAS)
		rocketride_msg("   Alias: ${rocketride_dependency_link_ALIAS}")
	endif()

	# Try to find it
	if (rocketride_dependency_link_COMPONENTS)
		rocketride_msg("Locating dependency ${name} with components ${rocketride_dependency_link_COMPONENTS}")
		find_package(${name} QUIET ${rocketride_dependency_link_OPTIONS} COMPONENTS ${rocketride_dependency_link_COMPONENTS})
		if (${name}_FOUND)
			rocketride_msg("Found package: ${name}")
		else()
			message(FATAL_ERROR "Did not find package: ${name} With components: ${rocketride_dependency_link_COMPONENTS}")
		endif()
	elseif(rocketride_dependency_link_CONFIG)
		rocketride_msg("Locating config based dependency ${name} Current prefix paths: ${CMAKE_PREFIX_PATH}")
		find_package(${name} CONFIG REQUIRED)
		if (NOT ${name}_FOUND)
			message(FATAL_ERROR "Failed to locate config based dependency ${name}")
		endif()
	else()
		rocketride_msg("Looking for non config based dependency ${name}")
		rocketride_msg("Debug root search path: ${DEPS_ROOT_LIB_DEBUG}")
		rocketride_msg("Release root search path: ${DEPS_ROOT_LIB_RELEASE}")

		set(DEBUG_NAMES ${name} ${name}d ${name}_d lib${name} lib${name}d)
		set(RELEASE_NAMES ${name} ${name}d lib${name})
		
		if (${name} STREQUAL "pthreads")
			string(SUBSTRING ${name} 0 7 name_temp)
			set(DEBUG_NAMES ${name_temp}VC3 ${name_temp}VC3d ${name_temp}_VC3d lib${name_temp}VC3 lib${name_temp}VC3d)
			set(RELEASE_NAMES ${name_temp}VC3 ${name_temp}VC3d lib${name_temp}VC3)
		endif()

		if (rocketride_dependency_link_ALIAS)
			set(DEBUG_NAMES ${DEBUG_NAMES} ${rocketride_dependency_link_ALIAS} ${rocketride_dependency_link_ALIAS}d lib${rocketride_dependency_link_ALIAS} lib${rocketride_dependency_link_ALIAS}d)
			set(RELEASE_NAMES ${RELEASE_NAMES} ${rocketride_dependency_link_ALIAS} lib${rocketride_dependency_link_ALIAS})
		endif()

		rocketride_msg("Looking for: ${DEBUG_NAMES} ${RELEASE_NAMES}")

		#---- We are now only building release versions
		# find_library(${name}_debug_libs NAMES ${DEBUG_NAMES} PATHS ${DEPS_ROOT_LIB_DEBUG} NO_DEFAULT_PATH)
		# find_library(${name}_release_libs NAMES ${RELEASE_NAMES} PATHS ${DEPS_ROOT_LIB_RELEASE} NO_DEFAULT_PATH)
		# 
		# set(debug_libs ${${name}_debug_libs})
		# set(release_libs ${${name}_release_libs})
		# 
		# if (NOT debug_libs OR NOT release_libs)
		# 	message(FATAL_ERROR "Failed to locate both debug and release library paths for target: ${name} Debug lib: ${debug_libs} Release lib: ${release_libs}")
		# endif()
		# 
		# rocketride_msg("Linking target: ${target} to dependency: ${name}" "debug: ${debug_libs}" "release: ${release_libs}")
		# target_link_libraries(${target} PUBLIC debug ${debug_libs} optimized ${release_libs})

		find_library(${name}_release_libs NAMES ${RELEASE_NAMES} PATHS ${DEPS_ROOT_LIB_RELEASE} NO_DEFAULT_PATH)
		set(release_libs ${${name}_release_libs})
		set(debug_libs ${${name}_release_libs})
		 
		if (NOT debug_libs OR NOT release_libs)
			message(FATAL_ERROR "Failed to locate both debug and release library paths for target: ${name} Debug lib: ${debug_libs} Release lib: ${release_libs}")
		endif()
	
		rocketride_msg("Linking target: ${target} to dependency: ${name}" "debug: ${debug_libs}" "release: ${release_libs}")
		target_link_libraries(${target} PUBLIC debug ${debug_libs} optimized ${release_libs})

	endif()

	# Log the target libs debug and release libs
	foreach(dep ${rocketride_dependency_link_TARGETS})
		#---- We are now only building release versions
		# if (NOT TARGET ${dep})
		# 	message(FATAL_ERROR "Failed to locate target: ${dep} for dependency: ${name}")
		# endif()
		# get_target_property(LIBS_DEBUG ${dep} IMPORTED_LOCATION_DEBUG)
		# get_target_property(LIBS_RELEASE ${dep} IMPORTED_LOCATION_RELEASE)
		# if (NOT LIBS_DEBUG OR NOT LIBS_RELEASE)
		# 	message(FATAL_ERROR "One or more targets have incorrect imports for dependency: ${dep}me Debug lib: ${LIBS_DEBUG} Release lib: ${LIBS_RELEASE}")
		# endif()
		# rocketride_msg("Linking target: ${target} to dependency: ${name}" "debug: ${LIBS_DEBUG}" "release: ${LIBS_RELEASE}")

		if (NOT TARGET ${dep})
		 	message(FATAL_ERROR "Failed to locate target: ${dep} for dependency: ${name}")
		endif()
		get_target_property(LIBS_RELEASE ${dep} IMPORTED_LOCATION_RELEASE)
		set(LIBS_DEBUG ${LIBS_RELEASE})
		if (NOT LIBS_RELEASE)
		 	message(FATAL_ERROR "One or more targets have incorrect imports for dependency: ${dep}me Debug lib: ${LIBS_DEBUG} Release lib: ${LIBS_RELEASE}")
		endif()
		rocketride_msg("Linking target: ${target} to dependency: ${name}" "debug: ${LIBS_DEBUG}" "release: ${LIBS_RELEASE}")

		target_link_libraries(${target} PUBLIC ${dep})
	endforeach()

	foreach(dep ${rocketride_dependency_link_INTERFACES})
		if (NOT TARGET ${dep})
			message(FATAL_ERROR "Failed to locate interface target: ${dep} for dependency: ${name}")
		endif()
		rocketride_msg("Linking target: ${target} to interface dependency: ${dep}")
		target_link_libraries(${target} INTERFACE ${dep})
	endforeach()

	# If includes were defined, add them
	if (${name}_INCLUDE_DIRS)
		rocketride_msg("Including package directory dependency: ${name} To target: ${target} Include dirs: ${${name}_INCLUDE_DIRS}")
		target_include_directories(${target} PUBLIC ${${name}_INCLUDE_DIRS})
	endif()

	# If the dependency is boost we have to include another definition
	if (${name} STREQUAL "Boost" AND ${name}_LIBRARIES)
		rocketride_msg("Linking target: ${target} To boost lib list:" ${${name}_LIBRARIES})
		target_link_libraries(${target} PUBLIC ${${name}_LIBRARIES})
	endif()

	if (${name} STREQUAL "azurestorage" AND ${name}_LIBRARIES)
		rocketride_msg("Linking target: ${target} To azurestorage lib list:" ${${name}_LIBRARIES})
		target_link_libraries(${target} PUBLIC ${${name}_LIBRARIES})
	endif()

endmacro()
