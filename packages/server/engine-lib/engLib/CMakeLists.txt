cmake_minimum_required(VERSION 3.20 FATAL_ERROR)

if(NOT TARGET engLib.lib)
    # Add the engLib library
    rocketride_add_library(engLib LIST_ONLY "*.json;*.ipp" *.cpp *.hpp *.h *.json *.ipp *.y)
else()
    # Do not compile any *.c *cpp if the target has a prebuilt engLib.lib
    rocketride_add_library(engLib LIST_ONLY "*.json;*.ipp" *.hpp *.h *.json *.ipp *.y)
    set_target_properties(engLib PROPERTIES LINKER_LANGUAGE CXX)
endif()

find_package(minizip-ng CONFIG REQUIRED)
target_link_libraries(engLib PRIVATE MINIZIP::minizip-ng)

find_package(zstd CONFIG REQUIRED)
target_link_libraries(engLib PRIVATE zstd::libzstd)

find_package(cpprestsdk CONFIG REQUIRED)
target_link_libraries(engLib PRIVATE cpprestsdk::cpprest)
rocketride_reexport_library_defines(engLib cpprestsdk::cpprest)

find_package(aws-cpp-sdk-core CONFIG REQUIRED)
find_package(aws-cpp-sdk-s3 CONFIG REQUIRED)
find_package(aws-cpp-sdk-transfer CONFIG REQUIRED)
target_link_libraries(engLib PRIVATE aws-cpp-sdk-core aws-cpp-sdk-s3 aws-cpp-sdk-transfer)
rocketride_reexport_library_defines(engLib aws-cpp-sdk-core aws-cpp-sdk-s3 aws-cpp-sdk-transfer)
# AWS_ENABLE_IO_COMPLETION_PORTS is not listed in aws-cpp-sdk-core defines,
# but it's required to link the engLib PCH to the engine, so we define it manually.
target_compile_definitions(engLib PUBLIC AWS_ENABLE_IO_COMPLETION_PORTS)

# Find package has issues when attempting to find our interpreter
# so we set it up ourselves
if(ROCKETRIDE_PLAT_WIN)
    set(Python3_EXECUTABLE "${VCPKG_INSTALLED_TRIPLET_DIR}/tools/python3/python.exe")
else()
    set(Python3_EXECUTABLE "${VCPKG_INSTALLED_TRIPLET_DIR}/tools/python3/python3")
endif()
set(Python3_ROOT_DIR "${VCPKG_INSTALLED_TRIPLET_DIR}/tools/python3")
set(Python3_Interpreter_FOUND TRUE)

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
if(ROCKETRIDE_PLAT_UNX)
    # The libxml2 package is supposed to take care of this, but it's failing on OSX
    if(ROCKETRIDE_PLAT_MAC)
        target_link_libraries(engLib PUBLIC iconv)
    endif()
endif()
# Libxml2 2.15.0 creates <installed>/include/libxml2/libxml/*.h
# and manual include is needed. Check, if it's still needed if Libxml2 is upgraded.
find_package(LibXml2 REQUIRED)
target_link_libraries(engLib PUBLIC LibXml2::LibXml2)

# classify_api.h lives in engine-lib/include/ (public header for the classify DLL ABI)
target_include_directories(engLib PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/../include)

# Link to platform libs
if(ROCKETRIDE_PLAT_LIN)
    # target_link_libraries(engLib PUBLIC /usr/lib/x86_64-linux-gnu/libfuse.a dl)
elseif(ROCKETRIDE_PLAT_WIN)
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

if(NOT EXISTS "${ROCKETRIDE_JDK_DIR}/include")
    message(FATAL_ERROR "JDK include directory not found: ${ROCKETRIDE_JDK_DIR}/include\nRun: builder setup:java")
endif()

target_include_directories(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/include")

if(ROCKETRIDE_PLAT_WIN)
    target_include_directories(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/include/win32")
    target_link_libraries(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/lib/jvm.lib")
elseif(ROCKETRIDE_PLAT_LIN)
    target_include_directories(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/include/linux")
    target_link_libraries(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/lib/server/libjvm.so")
elseif(ROCKETRIDE_PLAT_MAC)
    target_include_directories(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/include/darwin")
    # On OSX, we link to libjli.dylib instead of the JDK dylib
    target_link_libraries(engLib PUBLIC "${ROCKETRIDE_JDK_DIR}/lib/libjli.dylib")
endif()

if(NOT TARGET engLib.lib)
    # Process its precompiled headers (only if engLib is not prebuilt)
    rocketride_pch(engLib PCH ${CMAKE_CURRENT_LIST_DIR}/headers.h)
endif()
