cmake_minimum_required(VERSION 3.10 FATAL_ERROR)

# Add the engine target
rocketride_add_executable(engine src/*.cpp src/*.hpp src/*.h)

# Cache the path to engine executable
set(ROCKETRIDE_ENGINE_PATH "$<TARGET_FILE:engine>" CACHE INTERNAL "Path to engine executable")

# Link to the shared engine module, the launcher's only dependency
target_link_libraries(engine PRIVATE engineMod)

set_target_properties(engine PROPERTIES PDB_NAME engine.exe)

set_target_properties(engine PROPERTIES UNITY_BUILD FALSE)

# On *nix an RPATH is needed to load the module from the executable's directory
if(ROCKETRIDE_PLAT_LIN)
    set_target_properties(engine PROPERTIES
        INSTALL_RPATH "\$ORIGIN:\$ORIGIN/lib"
        BUILD_WITH_INSTALL_RPATH TRUE)
elseif(ROCKETRIDE_PLAT_MAC)
    set_target_properties(engine PROPERTIES
        INSTALL_RPATH "@loader_path;@loader_path/lib"
        BUILD_WITH_INSTALL_RPATH TRUE)
endif()

# The module must sit next to the executable for the loader to find it
add_custom_command(TARGET engine POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:engineMod> $<TARGET_FILE_DIR:engine>
    COMMENT "Copying $<TARGET_FILE_NAME:engineMod> next to $<TARGET_FILE_NAME:engine>")

# The module's own dist/server copy lives on the engineMod target, so that it
# still happens when only engineMod changes and this executable does not relink

# Generate version.rc on Windows
if(ROCKETRIDE_PLAT_WIN)
    # Generate version.rc from res/version.rc.in
    configure_file(
        ${ROCKETRIDE_PACKAGES_DIR}/server/engine-core/cmake/version.rc.in
        ${CMAKE_CURRENT_SOURCE_DIR}/src/res/version.rc
        @ONLY)

    # Add version.rc to project
    target_sources(engine PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/res/version.rc)
endif()
