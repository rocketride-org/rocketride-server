# The engine: the shared module that carries it, and the executable that
# launches it
add_subdirectory(src/shared)
add_subdirectory(src/app)

# And the test binary, which hosts the shared module the way the engine does
if(NOT DEFINED ENV{CMAKE_DEVMODE})
    add_subdirectory(tests)
endif()
