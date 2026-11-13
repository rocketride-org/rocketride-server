# The shared engine module: infra behind the engine_run() facade, imported by
# engine.exe and by C++ node DLLs
add_library(engine_abi SHARED
    engine.h
    engine.cpp
    engine.test.cpp
)

set_target_properties(engine_abi PROPERTIES
    OUTPUT_NAME engine
    PDB_NAME engine.dll)

# BUILD_INFRA matches infra's PCH
target_compile_definitions(engine_abi PRIVATE ENGINE_ABI_EXPORT BUILD_INFRA)

target_include_directories(engine_abi PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

# Whole-archive infra to retain its registration objects, which nothing
# references directly. Explicit flags rather than $<LINK_LIBRARY:WHOLE_ARCHIVE,..>
# which needs CMake 3.24+, newer than Ubuntu 22.04 ships.
if(ROCKETRIDE_PLAT_WIN)
    target_link_libraries(engine_abi PRIVATE infra)
    target_link_options(engine_abi PRIVATE "/WHOLEARCHIVE:$<TARGET_FILE:infra>")
elseif(ROCKETRIDE_PLAT_MAC)
    target_link_libraries(engine_abi PRIVATE infra)
    target_link_options(engine_abi PRIVATE "LINKER:-force_load,$<TARGET_FILE:infra>")
else()
    # GNU ld is positional, so these bracket the archive here rather than in
    # target_link_options
    target_link_libraries(engine_abi PRIVATE
        -Wl,--whole-archive infra -Wl,--no-whole-archive)
endif()

rocketride_set_common_target_options(engine_abi)

rocketride_configure_jvm_linkage(engine_abi)

# This module carries the NEEDED entry for libjvm.so, and GNU ld resolves a
# shared library's own dependencies when linking against it, so consumers need a
# link-time search path to the JDK. At runtime the module's own RUNPATH covers it.
if(ROCKETRIDE_PLAT_LIN)
    target_link_options(engine_abi INTERFACE
        "LINKER:-rpath-link,${CMAKE_BINARY_DIR}/java/jdk/lib/server")
endif()

target_precompile_headers(engine_abi REUSE_FROM infra)

# Both copies hang off engine_abi, not engine: editing infra relinks only this
# module, and the launcher does not rebuild, so copies on that target are skipped
add_custom_command(TARGET engine_abi POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:engine_abi> $<TARGET_FILE_DIR:engine>
    COMMENT "Copying $<TARGET_FILE_NAME:engine_abi> next to $<TARGET_FILE_NAME:engine>")

# Mirror the exe -> dist/server copy that rocketride_add_executable performs
if(ROCKETRIDE_CMAKE_KITS)
    # Copy import library on Windows
    set(copyEngineModImport "")
    if(ROCKETRIDE_PLAT_WIN)
        set(copyEngineModImport COMMAND ${CMAKE_COMMAND} -E copy_if_different
            $<TARGET_LINKER_FILE:engine_abi> "${ROCKETRIDE_DIST_DIR}/")
    endif()

    add_custom_command(TARGET engine_abi POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory "${ROCKETRIDE_DIST_DIR}"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:engine_abi> "${ROCKETRIDE_DIST_DIR}/"
        ${copyEngineModImport}
        COMMENT "Copying $<TARGET_FILE_NAME:engine_abi> to dist/server")
endif()

