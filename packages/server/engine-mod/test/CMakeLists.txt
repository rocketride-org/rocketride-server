cmake_minimum_required(VERSION 3.10 FATAL_ERROR)

# The node test binary. Unlike engtest, which links engLib statically and so
# has to keep node modules switched off, this one hosts the shared engine
# module exactly as engine does - that is what lets a test drive a filter that
# has moved out into a node library.
rocketride_add_executable(nodetest *.cpp *.hpp *.h tests/*.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../../engine-lib/test/test/words.cpp)

# Group it with the other test binaries in the IDE target tree
set_property(TARGET nodetest PROPERTY FOLDER "tests")

# Import mode; see ROCKETRIDE_CORE_API in apLib/ap.h
target_compile_definitions(nodetest PRIVATE
    ROCKETRIDE_CORE_IMPORT
    JSON_DLL)

target_link_libraries(nodetest PRIVATE engineMod)

# engLib's interface definitions only - apLib's would flip this target back
# into export mode
target_compile_definitions(nodetest PRIVATE
    $<TARGET_PROPERTY:engLib,INTERFACE_COMPILE_DEFINITIONS>)

# engLib's header usage requirements, inherited because engineMod links it
# PRIVATE - interface only, the archive itself is never linked
target_include_directories(nodetest PRIVATE
    $<TARGET_PROPERTY:engLib,INTERFACE_INCLUDE_DIRECTORIES>
    $<TARGET_PROPERTY:apLib,INTERFACE_INCLUDE_DIRECTORIES>
    ${ROCKETRIDE_PACKAGES_DIR}/server/engine-core
    ${ROCKETRIDE_PACKAGES_DIR}/server/engine-mod/include
    ${VCPKG_INSTALLED_TRIPLET_DIR}/include)

# Header only unit testing framework
find_package(Catch2 CONFIG REQUIRED)
target_link_libraries(nodetest PRIVATE Catch2::Catch2)

# Windows needs an import library for what the module does not export, the same
# set rocketride_add_node gives a node. Python/pybind11 come in even with no
# python code here, since filter.hpp puts pybind11 types on its virtual
# interface. On ELF/Mach-O the module's own copies serve, and a second copy of
# python in the executable is actively harmful - the engine re-invokes this
# binary as its interpreter and the executable's symbols interpose
if(ROCKETRIDE_PLAT_WIN)
    find_package(Python3 COMPONENTS Development REQUIRED)
    find_package(pybind11 REQUIRED)
    target_link_libraries(nodetest PRIVATE Python3::Python pybind11::embed)

    find_package(ICU REQUIRED COMPONENTS i18n)
    target_link_libraries(nodetest PRIVATE ICU::i18n)

    find_package(Boost CONFIG REQUIRED COMPONENTS stacktrace_windbg)
    target_link_libraries(nodetest PRIVATE Boost::stacktrace_windbg)
endif()

# CMake raises a not found error if Boost::filesystem is not found directly
# even though Boost::filesystem is found and linked to engLib
find_package(Boost COMPONENTS filesystem CONFIG REQUIRED)

# The tests include their headers by bare name; engtest's tree comes along for
# the support files shared with it (testMain.ipp, the word list, util.hpp)
target_include_directories(nodetest PRIVATE
    .
    ${CMAKE_CURRENT_SOURCE_DIR}/../../engine-lib/test)

# Register it with cmake unit
enable_testing()

# Configure platform-specific JVM linkage properties
rocketride_configure_jvm_linkage(nodetest)

# Process its precompiled headers
rocketride_pch(nodetest
    UNITY_EXCLUDES main.cpp
    PCH ../../engine-lib/engLib/headers.h
)

# The loader resolves node libraries relative to the executable, so this binary
# has to sit beside engine and the module in dist/server. Its own rpath finds
# the module next to it on *nix
if(ROCKETRIDE_PLAT_LIN)
    set_target_properties(nodetest PROPERTIES
        INSTALL_RPATH "\$ORIGIN:\$ORIGIN/lib"
        BUILD_WITH_INSTALL_RPATH TRUE)
elseif(ROCKETRIDE_PLAT_MAC)
    set_target_properties(nodetest PROPERTIES
        INSTALL_RPATH "@loader_path;@loader_path/lib"
        BUILD_WITH_INSTALL_RPATH TRUE)
endif()
