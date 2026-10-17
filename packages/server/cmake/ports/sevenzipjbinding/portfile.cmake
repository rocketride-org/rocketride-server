# 7-Zip-JBinding's native library, built here instead of taken from the jar.
#
# The Maven artifact sevenzipjbinding-all-platforms ships a prebuilt
# lib7-Zip-JBinding.so with a statically linked GCC 7 libstdc++ and 2800+ exported
# std:: symbols, 106 of them STB_GNU_UNIQUE under the same names libstdc++.so.6
# defines (all 40 locale facet ids among them). glibc binds a GNU-unique name
# process-wide to the first copy loaded, so the binding numbers the system
# libstdc++'s locale facet table with its own counter and the first GCC-built
# stream that formats a number (torch, on import) calls the wrong facet and dies
# at address 0x20. Built with STATIC_BUILD=OFF under
# the engine's triplet the library links the engine's libc++ instead, exports its
# 27 JNI entry points and nothing of a C++ runtime, and shares no symbol with
# libstdc++ at all.
#
# Java is needed at build time (javac, jar, jni.h): the engine build keeps a JDK at
# <build>/java/jdk, beside vcpkg's own root. The project's CMake asks for javah,
# which JDK 10+ no longer has; javah.in is a shim over javac -h that writes the
# same headers.

vcpkg_check_linkage(ONLY_DYNAMIC_LIBRARY)
set(VCPKG_POLICY_EMPTY_INCLUDE_FOLDER enabled)
# The library is shipped as <engine>/nodes/parse/lib7-Zip-JBinding.so and must find
# the engine's libc++ like every node library does (rocketride-node.cmake):
# $ORIGIN/../.. and $ORIGIN/../../lib. vcpkg's post-build fixup would rewrite that
# relative to its own tree ($ORIGIN:$ORIGIN/..), and the image's ldd check then
# fails on libc++.so.1. The RPATH is set with patchelf below instead.
set(VCPKG_FIXUP_ELF_RPATH OFF)

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO borisbrodski/sevenzipjbinding
    REF f900290347beb06d4c1f5f6274e31a457b1ac643
    SHA512 283d6e04e8aab9c2c5f04b2c3e7ca9371f3d4878602b8a5445a5ab7ec33cc3999b54e38c785b993a885565c2d65b353cc451f93617b6c3105a8f39ccfecf372b
    HEAD_REF master
    PATCHES
        cmake4.patch
)

# The JDK the builder installed for the engine (java:setup-jdk), or JAVA_HOME.
set(JDK "${VCPKG_ROOT_DIR}/../java/jdk")
if(NOT EXISTS "${JDK}/include/jni.h" AND DEFINED ENV{JAVA_HOME})
    set(JDK "$ENV{JAVA_HOME}")
endif()
if(NOT EXISTS "${JDK}/include/jni.h" OR NOT EXISTS "${JDK}/bin/javac")
    message(FATAL_ERROR
        "sevenzipjbinding: no JDK with JNI headers at ${JDK}. "
        "The builder's java:setup-jdk puts one at <build>/java/jdk; run it first.")
endif()
get_filename_component(JDK "${JDK}" ABSOLUTE)

set(JAVAC "${JDK}/bin/javac")
set(SZJ_JAVA_SRC "${SOURCE_PATH}/jbinding-java/src")
set(JAVAH "${CURRENT_BUILDTREES_DIR}/javah")
configure_file("${CMAKE_CURRENT_LIST_DIR}/javah.in" "${JAVAH}" @ONLY)
file(CHMOD "${JAVAH}" PERMISSIONS
    OWNER_READ OWNER_WRITE OWNER_EXECUTE
    GROUP_READ GROUP_EXECUTE
    WORLD_READ WORLD_EXECUTE)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5
        -DSTATIC_BUILD=OFF
        -DBUILD_TESTING=OFF
        "-DJAVA_JDK=${JDK}"
        "-DJAVA_HOME=${JDK}"
        "-DJAVA_HEADER_COMPILE=${JAVAH}"
)

vcpkg_cmake_build(TARGET 7-Zip-JBinding)

set(LIB_NAME "${CMAKE_SHARED_LIBRARY_PREFIX}7-Zip-JBinding${CMAKE_SHARED_LIBRARY_SUFFIX}")
set(BUILT_LIB "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/jbinding-cpp/${LIB_NAME}")

# Loaded from <engine>/nodes/parse: the engine runtime is two levels up, in <engine>
# and <engine>/lib, the RPATH rocketride_add_node gives every node library. Set with
# patchelf after the build: passed through -DCMAKE_INSTALL_RPATH the $ORIGIN did not
# survive the project's link step (the file came out with "/../..").
vcpkg_find_acquire_program(PATCHELF)
vcpkg_execute_required_process(
    COMMAND "${PATCHELF}" --set-rpath "\$ORIGIN/../..:\$ORIGIN/../../lib" "${BUILT_LIB}"
    WORKING_DIRECTORY "${CURRENT_BUILDTREES_DIR}"
    LOGNAME "patchelf-${TARGET_TRIPLET}")

file(INSTALL "${BUILT_LIB}" DESTINATION "${CURRENT_PACKAGES_DIR}/lib/sevenzipjbinding")

vcpkg_install_copyright(FILE_LIST
    "${SOURCE_PATH}/COPYING"
    "${SOURCE_PATH}/LGPL"
    "${SOURCE_PATH}/License.txt")
