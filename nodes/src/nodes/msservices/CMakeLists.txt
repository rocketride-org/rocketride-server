cmake_minimum_required(VERSION 3.20 FATAL_ERROR)

# Everything a C++ node needs to build - see rocketride_add_node for what the
# target gets wired up with
include(${ROCKETRIDE_PACKAGES_DIR}/server/cmake/rocketride-node.cmake)

# The target name is the library base name, and must match the "path" field of
# every services.json of this node - that is how the engine finds this library.
# The extra globs pick up the endpoint and connector subdirectories, which the
# default set (src/*) does not reach
rocketride_add_node(msservices
    ${CMAKE_CURRENT_SOURCE_DIR}/src/*/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/*/*.hpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/*/*/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/*/*/*.hpp)

# The sources include the umbrella header by bare name
target_include_directories(msservices PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

find_package(cpprestsdk CONFIG REQUIRED)
target_link_libraries(msservices PRIVATE cpprestsdk::cpprest)
# Disable platform strings, this prevents cpprest from defining the U macro
target_compile_definitions(msservices PRIVATE -D_TURN_OFF_PLATFORM_STRING=1)
