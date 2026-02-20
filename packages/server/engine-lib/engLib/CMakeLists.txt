cmake_minimum_required(VERSION 3.20 FATAL_ERROR)

if (NOT TARGET engLib.lib)
	# Add the engLib library
	rocketride_add_library(engLib LIST_ONLY "*.json;*.ipp" *.cpp *.hpp *.h *.json *.ipp *.y)
else()
	# Do not compile any *.c *cpp if the target has a prebuilt engLib.lib
	rocketride_add_library(engLib LIST_ONLY "*.json;*.ipp" *.hpp *.h *.json *.ipp *.y)
	set_target_properties(engLib PROPERTIES LINKER_LANGUAGE CXX)
endif()

rocketride_dependency_link(engLib minizip-ng)
find_package(zstd CONFIG REQUIRED)

# rocketride_dependency_link(engLib expat)
if (ROCKETRIDE_PLAT_WIN)
	rocketride_dependency_link(engLib zstd)
else()
	rocketride_dependency_link(engLib zstd)
	rocketride_dependency_link(engLib uuid)
endif()

# Link to the vcpkg dependencies
if (ROCKETRIDE_PLAT_MAC)
rocketride_dependency_link(engLib intl)
endif()

rocketride_dependency_link(engLib zlib)
rocketride_dependency_link(engLib azure-storage-common)
rocketride_dependency_link(engLib azure-core-cpp ALIAS azure-core)
rocketride_dependency_link(engLib azure-identity-cpp ALIAS azure-identity)
rocketride_dependency_link(engLib azure-storage-blobs-cpp ALIAS azure-storage-blobs)
rocketride_dependency_link(engLib azure-storage-files-shares-cpp ALIAS azure-storage-files-shares)
rocketride_dependency_link(engLib azure-storage-files-datalake-cpp ALIAS azure-storage-files-datalake)
rocketride_dependency_link(engLib cpprestsdk CONFIG TARGETS cpprestsdk::cpprest INTERFACES cpprestsdk::cpprestsdk_zlib_internal)
rocketride_dependency_link(engLib aws-cpp-sdk-core CONFIG TARGETS aws-cpp-sdk-core)
rocketride_dependency_link(engLib aws-cpp-sdk-s3 CONFIG TARGETS aws-cpp-sdk-s3)
# @TODO: Please refer to https://bitbucket.org/rocketride/engine/pull-requests/573 when old AWS node will be removed
rocketride_dependency_link(engLib aws-cpp-sdk-transfer CONFIG TARGETS aws-cpp-sdk-transfer)
rocketride_dependency_link(engLib Boost COMPONENTS log)

# Find package has issues when attempting to find our interpreter
# so we set it up ourselves
if (ROCKETRIDE_PLAT_WIN)
	set(Python3_EXECUTABLE			"${DEPS_ROOT}/tools/python3/python.exe")
else()
	set(Python3_EXECUTABLE			"${DEPS_ROOT}/tools/python3/python3.10")
endif()
set(Python3_ROOT_DIR   				"${DEPS_ROOT}/tools/python3")
set(Python3_Interpreter_FOUND		TRUE)

# Since we already setup the interpreter, it finds what it needs
# for the development end
find_package(Python3 COMPONENTS Interpreter Development REQUIRED)
target_link_libraries(engLib PUBLIC Python3::Python)

find_package(azure-identity-cpp CONFIG REQUIRED)
find_package(azure-storage-blobs-cpp CONFIG REQUIRED)
target_link_libraries(engLib PUBLIC Azure::azure-identity Azure::azure-storage-blobs)

# Find pybind11 module with CMake
find_package(pybind11 REQUIRED)
target_link_libraries(engLib PUBLIC pybind11::embed)

# Required on *nix for the Azure Storage SDK
if (ROCKETRIDE_PLAT_UNX)
	# The libxml2 package is supposed to take care of this, but it's failing on OSX
	if (ROCKETRIDE_PLAT_MAC)
		target_link_libraries(engLib PUBLIC iconv)
	endif()
	rocketride_dependency_link(engLib xml2)
endif()
# Libxml2 2.15.0 creates <installed>/include/libxml2/libxml/*.h
# and manual include is needed. Check, if it's still needed if Libxml2 is upgraded.
find_package(LibXml2 REQUIRED)
target_include_directories(engLib PUBLIC ${LIBXML2_INCLUDE_DIR})

# classify_api.h lives in engine-lib/include/ (public header for the classify DLL ABI)
target_include_directories(engLib PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/../include)

# Link to platform libs
if (ROCKETRIDE_PLAT_LIN)
#	target_link_libraries(engLib PUBLIC /usr/lib/x86_64-linux-gnu/libfuse.a dl)
elseif (ROCKETRIDE_PLAT_WIN)
	target_link_libraries(engLib PUBLIC Activeds.lib ADSIid.lib WinHTTP.lib httpapi.lib)
	target_link_libraries(engLib PUBLIC ws2_32.lib iphlpapi.lib rpcrt4.lib WebServices.lib)
endif()

target_link_libraries(engLib PUBLIC apLib)

if(ROCKETRIDE_PLAT_MAC)
    target_link_libraries(engLib PUBLIC compression)
endif()

# Disable export definitions on the azure sdk otherwise it tries to dll import on us
# Disable platform strings this prevents the U macro from being defined
target_compile_definitions(engLib PUBLIC -D_NO_WASTORAGE_API=1 -D_TURN_OFF_PLATFORM_STRING=1)

# Register our own public include paths for dependencies linking to engLib with
# un-ambiguous include paths e.g. <engLib/eng.h>
target_include_directories(engLib PUBLIC
	${CMAKE_CURRENT_LIST_DIR}/../
)

# Add JDK include path from build/java/jdk (installed by builder setup:java)
# Note: ROCKETRIDE_PROJECT_ROOT is set in the main CMakeLists.txt (packages/server/)
set(ROCKETRIDE_JDK_DIR "${ROCKETRIDE_PROJECT_ROOT}/build/java/jdk")

if (NOT EXISTS "${ROCKETRIDE_JDK_DIR}/include")
	message(FATAL_ERROR "JDK include directory not found: ${ROCKETRIDE_JDK_DIR}/include\nRun: builder setup:java")
endif()

target_include_directories(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/include")

if (ROCKETRIDE_PLAT_WIN)
	target_include_directories(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/include/win32")
	target_link_libraries(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/lib/jvm.lib")
elseif (ROCKETRIDE_PLAT_LIN)
	target_include_directories(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/include/linux")
	target_link_libraries(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/lib/server/libjvm.so")
elseif (ROCKETRIDE_PLAT_MAC)
	target_include_directories(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/include/darwin")
	# On OSX, we link to libjli.dylib instead of the JDK dylib
	target_link_libraries(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/lib/libjli.dylib")
endif()

if (NOT TARGET engLib.lib)
	# Process its precompiled headers (only if engLib is not prebuilt)
	rocketride_pch(engLib PCH ${CMAKE_CURRENT_LIST_DIR}/headers.h)
endif()
