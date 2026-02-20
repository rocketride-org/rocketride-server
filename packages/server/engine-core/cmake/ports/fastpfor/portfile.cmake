vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO lemire/FastPFor
    REF v0.3.0
    SHA512 b8cf12c77ca54a07d466bb1051e3a803f5d5d17e3e2586266f55a9b24f04bfbacbf683ef7d1ffd01f4a6be3ceb76caa7641d238731c3734d94cf93db0d1d3667
    HEAD_REF master
)

# Overwrite CMakeLists.txt to build and install a proper static library
file(WRITE "${SOURCE_PATH}/CMakeLists.txt" "
cmake_minimum_required(VERSION 3.10)
project(FastPFor)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if((CMAKE_SYSTEM_PROCESSOR MATCHES \"x86_64\" OR CMAKE_SYSTEM_PROCESSOR MATCHES \"i686\") AND CMAKE_CXX_COMPILER_ID MATCHES \"Clang|GNU\")
    add_compile_options(-msse4.1)
endif()

file(GLOB SOURCES src/*.cpp)
add_library(FastPFor STATIC \${SOURCES})

# Include headers and simde
target_include_directories(FastPFor PUBLIC
    \"${SOURCE_PATH}/headers\"
    \"${CURRENT_INSTALLED_DIR}/include\"
)

# Define SIMDE macro only on ARM
if(CMAKE_SYSTEM_PROCESSOR MATCHES \"arm64|aarch64\")
    message(STATUS \"Defining SIMDE_ENABLE_NATIVE_ALIASES for ARM\")
    target_compile_definitions(FastPFor PUBLIC SIMDE_ENABLE_NATIVE_ALIASES)
endif()

# Install the static library and headers
install(TARGETS FastPFor
        ARCHIVE DESTINATION lib
        LIBRARY DESTINATION lib
        RUNTIME DESTINATION bin)

install(DIRECTORY \${CMAKE_CURRENT_SOURCE_DIR}/headers/
        DESTINATION include/FastPFor
        FILES_MATCHING PATTERN \"*.h\")
")

# Configure and build
vcpkg_configure_cmake(
    SOURCE_PATH ${SOURCE_PATH}
    PREFER_NINJA
)

vcpkg_install_cmake()

# Sanity check: confirm a library was installed (.a/.lib/.dylib/.so)
file(GLOB_RECURSE LIB_FILES
    ${CURRENT_PACKAGES_DIR}/lib/*.a
    ${CURRENT_PACKAGES_DIR}/lib/*.lib
    ${CURRENT_PACKAGES_DIR}/lib/*.dylib
    ${CURRENT_PACKAGES_DIR}/lib/*.so
)

if(NOT LIB_FILES)
    message(FATAL_ERROR "FastPFor built, but no static/shared library was found in lib/")
endif()

# Clean up unnecessary debug headers
file(REMOVE_RECURSE ${CURRENT_PACKAGES_DIR}/debug/include)

# Install license file
file(INSTALL ${SOURCE_PATH}/LICENSE DESTINATION ${CURRENT_PACKAGES_DIR}/share/fastpfor RENAME copyright)
