cmake_minimum_required(VERSION 3.10 FATAL_ERROR)

if (NOT TARGET apLib.lib)
	# Add the apLib library
	rocketride_add_library(apLib LIST_ONLY "json;ipp" *.c *.cpp *.hpp *.h *.json *.ipp *.y)
else()
	# Do not compile any *.c *cpp if the target has a prebuilt apLib.lib
	rocketride_add_library(apLib LIST_ONLY "json;ipp" *.hpp *.h *.json *.ipp *.y)
	set_target_properties(apLib PROPERTIES LINKER_LANGUAGE CXX)
endif()

# Link to the vcpkg dependencies
rocketride_dependency_link(apLib Boost COMPONENTS system thread container)
rocketride_dependency_link(apLib ssl)
rocketride_dependency_link(apLib crypto)
rocketride_dependency_link(apLib icui18n ALIAS icuin)
rocketride_dependency_link(apLib icuio)
rocketride_dependency_link(apLib icutu)
rocketride_dependency_link(apLib icuuc)
rocketride_dependency_link(apLib icudata ALIAS icudt)
rocketride_dependency_link(apLib replxx ALIAS replxx-d)
rocketride_dependency_link(apLib zlib ALIAS z)
rocketride_dependency_link(apLib lz4)
rocketride_dependency_link(apLib lzma)
rocketride_dependency_link(apLib bz2)
rocketride_dependency_link(apLib tinyxml2)
rocketride_dependency_link(apLib FastPFor)

if (ROCKETRIDE_FACTORY_DEBUG)
	target_compile_definitions(apLib PUBLIC -DROCKETRIDE_FACTORY_DEBUG=1)
endif()

if (ROCKETRIDE_PLAT_WIN)
	target_compile_definitions(apLib PUBLIC -DBOOST_STACKTRACE_LINK)
	rocketride_dependency_link(apLib Boost COMPONENTS stacktrace_windbg)
endif()

if (ROCKETRIDE_PLAT_UNX)
	rocketride_dependency_link(apLib date CONFIG TARGETS date::date-tz)	
endif()

if (ROCKETRIDE_PLAT_LIN)
	# Build libbacktrace from source (the libbacktrace vcpkg doesn't work on Linux)
	include(../cmake/AddLibBacktrace.cmake)
	target_link_libraries(apLib PUBLIC LibBacktraceTarget)

	rocketride_dependency_link(apLib breakpad)
	rocketride_dependency_link(apLib breakpad_client)
	target_include_directories(apLib PRIVATE
		${VCPKG_INSTALLED_TRIPLET_PATH}/include/breakpad
	)
endif()

if (ROCKETRIDE_PLAT_MAC)
	target_compile_definitions(apLib PUBLIC	-D_GNU_SOURCE)
endif()

# add target dependency for general vcpkg dependencies
target_include_directories(apLib PUBLIC
	${VCPKG_INSTALLED_TRIPLET_PATH}/include
)

# have to do this for fastpfor, someone needs to go to c school...
target_include_directories(apLib PUBLIC
	${VCPKG_INSTALLED_TRIPLET_PATH}/include/FastPFor/headers
)

# Link to platform libs
if (ROCKETRIDE_PLAT_WIN)
	target_link_libraries(apLib PUBLIC netapi32.lib VssApi.lib Rpcrt4.lib XmlLite.lib Crypt32.lib ws2_32.lib Dbghelp.lib Mpr.lib)
else()
	rocketride_dependency_link(apLib uuid)
	target_link_libraries(apLib PUBLIC dl c m)
endif()

# Register our own public include paths for dependencies linking to apLib with
# un-ambiguous include paths e.g. <apLib/ap.h>
target_include_directories(apLib PUBLIC
	${CMAKE_CURRENT_LIST_DIR}/../
)

if (NOT TARGET apLib.lib)
	# Process its precompiled headers (only if engLib is not prebuilt)
	rocketride_pch(apLib
		UNITY_EXCLUDES ${CMAKE_CURRENT_LIST_DIR}/compress/FastPFor.cpp
		PCH ${CMAKE_CURRENT_LIST_DIR}/headers.h)
endif()
