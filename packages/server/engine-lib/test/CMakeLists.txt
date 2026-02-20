cmake_minimum_required(VERSION 3.10 FATAL_ERROR)

# Add the engLib.test executable
rocketride_add_executable(engtest *.cpp *.hpp *.h EXCLUDE /rest/)

# Link to engLib
target_link_libraries(engtest PRIVATE engLib)

# Header only unit testing framework
find_package(Catch2 CONFIG REQUIRED)
target_link_libraries(engtest PRIVATE Catch2::Catch2)

# CMake raises a not found error if Boost::filesystem is not found directly
# even though Boost::filesystem is found and linked to engLib
find_package(Boost COMPONENTS filesystem CONFIG REQUIRED)


# Register our own public include paths for dependencies linking to engLib with
# un-ambiguous include paths e.g. <engLib/engine.h>
target_include_directories(engtest PUBLIC .)

target_compile_definitions(engtest PUBLIC)

# Register it with cmake unit
enable_testing()

# Configure platform-specific JVM linkage properties
rocketride_configure_jvm_linkage(engtest)

# Process its precompiled headers
rocketride_pch(engtest
	UNITY_EXCLUDES main.cpp
	PCH ../engLib/headers.h
)

# Note: Test datasets and engine dependencies are copied by scripts/tasks.js (test:server)
