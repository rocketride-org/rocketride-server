cmake_minimum_required(VERSION 3.20 FATAL_ERROR)

# Everything a C++ node needs to build - see rocketride_add_node for what the
# target gets wired up with
include(${ROCKETRIDE_PACKAGES_DIR}/server/cmake/rocketride-node.cmake)

# The target name is the library base name, and must match the "path" field of
# services.json - that is how the engine finds this library
rocketride_add_node(azure)

find_package(cpprestsdk CONFIG REQUIRED)
target_link_libraries(azure PRIVATE cpprestsdk::cpprest)

find_package(azure-identity-cpp CONFIG REQUIRED)
find_package(azure-storage-blobs-cpp CONFIG REQUIRED)
target_link_libraries(azure PRIVATE Azure::azure-identity Azure::azure-storage-blobs)

# Disable export definitions on the azure sdk otherwise it tries to dll import on us
# Disable platform strings this prevents the U macro from being defined
target_compile_definitions(azure PRIVATE -D_NO_WASTORAGE_API=1 -D_TURN_OFF_PLATFORM_STRING=1)
