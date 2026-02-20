cmake_minimum_required(VERSION 3.10 FATAL_ERROR)
include(cmake/englib.cmake)

# Add engLib project
add_subdirectory(engLib)

# And its unit test
if(NOT DEFINED ENV{CMAKE_DEVMODE}) 
	add_subdirectory(test)
endif()
