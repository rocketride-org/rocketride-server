cmake_minimum_required(VERSION 3.20 FATAL_ERROR)

# The shared engine module: engLib behind the engine_run() facade, imported by
# engine.exe and by C++ node DLLs
add_library(engineMod SHARED
    include/engine.h
    src/engine.cpp
)

set_target_properties(engineMod PROPERTIES
    OUTPUT_NAME engine
    PDB_NAME engine.dll)

# BUILD_ENGLIB matches engLib's PCH
target_compile_definitions(engineMod PRIVATE ENGINE_MOD_EXPORT BUILD_ENGLIB)

target_include_directories(engineMod PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

# Whole-archive engLib to retain its registration objects, which nothing
# references directly. Explicit flags rather than $<LINK_LIBRARY:WHOLE_ARCHIVE,..>
# which needs CMake 3.24+, newer than Ubuntu 22.04 ships.
if(ROCKETRIDE_PLAT_WIN)
    target_link_libraries(engineMod PRIVATE engLib)
    target_link_options(engineMod PRIVATE "/WHOLEARCHIVE:$<TARGET_FILE_NAME:engLib>")
elseif(ROCKETRIDE_PLAT_MAC)
    target_link_libraries(engineMod PRIVATE engLib)
    target_link_options(engineMod PRIVATE "LINKER:-force_load,$<TARGET_FILE:engLib>")
else()
    # GNU ld is positional, so these bracket the archive here rather than in
    # target_link_options
    target_link_libraries(engineMod PRIVATE
        -Wl,--whole-archive engLib -Wl,--no-whole-archive)
endif()

rocketride_set_common_target_options(engineMod)

# The module places itself in dist/server. This belongs here rather than on the
# engine executable's POST_BUILD: changing only engineMod's implementation
# leaves its import library untouched, so engine.exe does not relink and a copy
# hanging off that target never runs - leaving a stale module in dist.
if(ROCKETRIDE_CMAKE_KIST)
    add_custom_command(TARGET engineMod POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "${ROCKETRIDE_PROJECT_ROOT}/dist/server"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:engineMod> "${ROCKETRIDE_PROJECT_ROOT}/dist/server/"
        COMMENT "Copying $<TARGET_FILE_NAME:engineMod> to dist/server")
endif()

rocketride_configure_jvm_linkage(engineMod)

# This module carries the NEEDED entry for libjvm.so, and GNU ld resolves a
# shared library's own dependencies when linking against it, so consumers need a
# link-time search path to the JDK. At runtime the module's own RUNPATH covers it.
if(ROCKETRIDE_PLAT_LIN)
    target_link_options(engineMod INTERFACE
        "LINKER:-rpath-link,${CMAKE_BINARY_DIR}/java/jdk/lib/server")
endif()

target_precompile_headers(engineMod REUSE_FROM engLib)
