include(${CMAKE_CURRENT_SOURCE_DIR}/../cmake/jvm.cmake)

# Add the infra library
add_subdirectory(src)

# And its unit test
if(NOT DEFINED ENV{CMAKE_DEVMODE}) 
	add_subdirectory(tests)
endif()
