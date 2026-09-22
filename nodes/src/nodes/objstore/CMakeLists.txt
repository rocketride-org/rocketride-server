cmake_minimum_required(VERSION 3.20 FATAL_ERROR)

# Everything a C++ node needs to build - see rocketride_add_node for what the
# target gets wired up with
include(${ROCKETRIDE_PACKAGES_DIR}/server/cmake/rocketride-node.cmake)

# The target name is the library base name, and must match the "path" field of
# both services.json files - that is how the engine finds this library
rocketride_add_node(objstore)

find_package(aws-cpp-sdk-core CONFIG REQUIRED)
find_package(aws-cpp-sdk-s3 CONFIG REQUIRED)
find_package(aws-cpp-sdk-transfer CONFIG REQUIRED)
target_link_libraries(objstore PRIVATE aws-cpp-sdk-core aws-cpp-sdk-s3 aws-cpp-sdk-transfer)
# AWS_ENABLE_IO_COMPLETION_PORTS is not listed in aws-cpp-sdk-core defines, but
# the AWS headers must see it
target_compile_definitions(objstore PRIVATE AWS_ENABLE_IO_COMPLETION_PORTS)
