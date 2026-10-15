cmake_minimum_required(VERSION 3.20 FATAL_ERROR)

# Everything a C++ node needs to build - see rocketride_add_node for what the
# target gets wired up with
include(${ROCKETRIDE_PACKAGES_DIR}/server/cmake/rocketride-node.cmake)

# The target name is the library base name, and must match the "path" field of
# services.json - that is how the engine finds this library
rocketride_add_node(hash)

# ap::crypto::Sha512 is header-inline over OpenSSL, so this node emits its own
# SHA512_* references rather than resolving them through engineMod
find_package(OpenSSL REQUIRED)
target_link_libraries(hash PRIVATE OpenSSL::Crypto)
