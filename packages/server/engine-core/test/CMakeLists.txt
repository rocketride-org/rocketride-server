cmake_minimum_required(VERSION 3.10 FATAL_ERROR)

# Add the apLib.test executable
rocketride_add_executable(aptest LIST_ONLY "*.ipp" *.cpp *.hpp *.h)

# Link to apLib (we can't use unity due to the backblaze mock trick)
target_link_libraries(aptest PRIVATE apLib)

# Header only unit testing framework
find_package(Catch2 CONFIG REQUIRED)
target_link_libraries(aptest PRIVATE Catch2::Catch2)

target_include_directories(aptest PUBLIC .)

# aptest ships to dist/server and runs from there, so it needs the same
# $ORIGIN/lib rpath the engine and engtest use to find the staged libc++.
# Distros with a system libc++ (apt libc++1 / dnf libcxx) mask the gap; RHEL/EL
# has no distro libc++ package, so without this aptest fails to load libc++.so.1.
if(ROCKETRIDE_PLAT_LIN)
    set_target_properties(aptest PROPERTIES
        INSTALL_RPATH "\$ORIGIN/lib"
        BUILD_WITH_INSTALL_RPATH TRUE)
endif()

# Ship crashpad_handler next to the test binary so the out-of-process crash test
# (plat/unx/minidump.cpp) finds it with no env setup. Runtime resolves it via
# execDir(); mirrors how it sits beside the engine in dist/server.
if(ROCKETRIDE_PLAT_LIN OR ROCKETRIDE_PLAT_MAC)
    set(_rr_handler "${VCPKG_INSTALLED_TRIPLET_DIR}/tools/crashpad_handler")
    if(EXISTS "${_rr_handler}")
        add_custom_command(TARGET aptest POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${_rr_handler}" "$<TARGET_FILE_DIR:aptest>/crashpad_handler"
            COMMENT "Copying crashpad_handler next to aptest"
            VERBATIM)
    endif()
endif()

# Register it with cmake unit
enable_testing()

# Process its precompiled headers
rocketride_pch(aptest 
	UNITY_EXCLUDES main.cpp
	PCH ../apLib/headers.h
)

# Note: Test datasets and cacert.pem are copied by scripts/tasks.js (test:server)
