cmake_minimum_required(VERSION 3.10 FATAL_ERROR)

# Add the engine target
rocketride_add_executable(engine src/*.cpp src/*.hpp src/*.h)

# Cache the path to engine executable
set(ROCKETRIDE_ENGINE_PATH "$<TARGET_FILE:engine>" CACHE INTERNAL "Path to engine executable")

# Link to engLib (inherit all its settings)
target_link_libraries(engine PUBLIC engLib)

# Add BUILD_ENGLIB definition to match engLib's PCH (required for REUSE_FROM)
target_compile_definitions(engine PRIVATE BUILD_ENGLIB)

# Configure platform-specific JVM linkage
rocketride_configure_jvm_linkage(engine)

# Reuse engLib's precompiled headers instead of building our own
# This saves significant compile time since both use the same headers.h
target_precompile_headers(engine REUSE_FROM engLib)

# Enable unity build for engine (without separate PCH since we're reusing)
set_target_properties(engine PROPERTIES UNITY_BUILD TRUE)
if(DEFINED ROCKETRIDE_UNITY_BATCH_SIZE)
    set_target_properties(engine PROPERTIES UNITY_BUILD_BATCH_SIZE ${ROCKETRIDE_UNITY_BATCH_SIZE})
endif()

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
