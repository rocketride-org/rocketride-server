#
# Do not want on new boost version library. The port does not know about
# the latest version, but it should be okay
#
set(Boost_NO_WARN_NEW_VERSIONS 1)

# Add the core library
add_subdirectory(src)

# And its unit test
if(NOT DEFINED ENV{CMAKE_DEVMODE})
    add_subdirectory(tests)
endif()

set(CMAKE_VERBOSE_MAKEFILE ON)

# Generate version.h from version.h.in, which contains the metadata for the build (version, git commit hash, etc.)
configure_file(
    ${CMAKE_CURRENT_SOURCE_DIR}/../cmake/version.h.in
    ${CMAKE_CURRENT_SOURCE_DIR}/src/application/version.h
    @ONLY)
rocketride_msg("Configured version.h")

