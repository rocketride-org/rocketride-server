# Add the infra test executable
rocketride_add_executable(infra_tests *.cpp *.hpp *.h EXCLUDE /rest/)

# Group it with the other test binaries in the IDE target tree
set_property(TARGET infra_tests PROPERTY FOLDER "tests")

# Link to infra
target_link_libraries(infra_tests PRIVATE infra)

# Header only unit testing framework
find_package(Catch2 CONFIG REQUIRED)
target_link_libraries(infra_tests PRIVATE Catch2::Catch2)

# CMake raises a not found error if Boost::filesystem is not found directly
# even though Boost::filesystem is found and linked to infra
find_package(Boost COMPONENTS filesystem CONFIG REQUIRED)


# Register our own public include paths for dependencies linking to infra
target_include_directories(infra_tests PUBLIC .)

target_compile_definitions(infra_tests PUBLIC)

# Register it with cmake unit
enable_testing()

# Configure platform-specific JVM linkage properties
rocketride_configure_jvm_linkage(infra_tests)

# Process its precompiled headers
rocketride_pch(infra_tests
	UNITY_EXCLUDES main.cpp
	PCH ../src/headers.h
)

# Note: Test datasets and engine dependencies are copied by scripts/tasks.js (test:server)
