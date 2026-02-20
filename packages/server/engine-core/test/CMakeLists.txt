cmake_minimum_required(VERSION 3.10 FATAL_ERROR)

# Add the apLib.test executable
rocketride_add_executable(aptest LIST_ONLY "*.ipp" *.cpp *.hpp *.h)

# Link to apLib (we can't use unity due to the backblaze mock trick)
target_link_libraries(aptest PRIVATE apLib)

# Header only unit testing framework
find_package(Catch2 CONFIG REQUIRED)
target_link_libraries(aptest PRIVATE Catch2::Catch2)

target_include_directories(aptest PUBLIC .)

# Register it with cmake unit
enable_testing()

# Process its precompiled headers
rocketride_pch(aptest 
	UNITY_EXCLUDES main.cpp
	PCH ../apLib/headers.h
)

# Note: Test datasets and cacert.pem are copied by scripts/tasks.js (test:server)
