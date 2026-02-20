# -*- mode: CMAKE; -*-

cmake_minimum_required(VERSION 3.0)

project( replxx VERSION 0.0.1 LANGUAGES CXX C )

set(CMAKE_BINARY_DIR "${CMAKE_SOURCE_DIR}/build")

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE string "Choose the type of build, options are: None Debug Release RelWithDebInfo MinSizeRel." FORCE)
endif()

message(STATUS "Build mode: ${CMAKE_BUILD_TYPE}")

# INFO
set(REPLXX_DISPLAY_NAME "replxx")
set(REPLXX_URL_INFO_ABOUT "https://github.com/AmokHuginnsson/replxx")
set(REPLXX_CONTACT "amok@codestation.org")
set(REPLXX_FRIENDLY_STRING "replxx - Read Evaluate Print Loop library")

# compiler options
if(CMAKE_COMPILER_IS_GNUCXX)
  message(STATUS "Compiler type GNU: ${CMAKE_CXX_COMPILER}")
  set(BASE_COMPILER_OPTIONS "-std=c++11 -Wall -Wextra -D_GNU_SOURCE")
  set(CMAKE_CXX_FLAGS                "${CMAKE_CXX_FLAGS} ${BASE_COMPILER_OPTIONS}")
  set(CMAKE_CXX_FLAGS_DEBUG          "${CMAKE_CXX_FLAGS_DEBUG} ${BASE_COMPILER_OPTIONS} -O0 -g")
  set(CMAKE_CXX_FLAGS_MINSIZEREL     "${CMAKE_CXX_FLAGS_MINSIZEREL} ${BASE_COMPILER_OPTIONS} -Os")
  set(CMAKE_CXX_FLAGS_RELEASE        "${CMAKE_CXX_FLAGS_RELEASE} ${BASE_COMPILER_OPTIONS} -O3 -fomit-frame-pointer")
  set(CMAKE_CXX_FLAGS_RELWITHDEBINFO "${CMAKE_CXX_FLAGS_RELWITHDEBINFO} ${BASE_COMPILER_OPTIONS} -O3 -g")

elseif(CMAKE_COMPILER_IS_CLANGCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  # using regular Clang or AppleClang
  message(STATUS "Compiler type CLANG: ${CMAKE_CXX_COMPILER}")
  set(BASE_COMPILER_OPTIONS "-std=c++11 -Wall -Wextra -D_GNU_SOURCE")
  set(CMAKE_CXX_FLAGS                "${CMAKE_CXX_FLAGS} ${BASE_COMPILER_OPTIONS}")
  set(CMAKE_CXX_FLAGS_DEBUG          "${CMAKE_CXX_FLAGS_DEBUG} ${BASE_COMPILER_OPTIONS} -O0 -g")
  set(CMAKE_CXX_FLAGS_MINSIZEREL     "${CMAKE_CXX_FLAGS_MINSIZEREL} ${BASE_COMPILER_OPTIONS} -Os")
  set(CMAKE_CXX_FLAGS_RELEASE        "${CMAKE_CXX_FLAGS_RELEASE} ${BASE_COMPILER_OPTIONS} -O3 -fomit-frame-pointer")
  set(CMAKE_CXX_FLAGS_RELWITHDEBINFO "${CMAKE_CXX_FLAGS_RELWITHDEBINFO} ${BASE_COMPILER_OPTIONS} -O3 -g")

elseif(MSVC)
  message(STATUS "Compiler type MSVC: ${CMAKE_CXX_COMPILER}")
  add_definitions("-D_CRT_SECURE_NO_WARNINGS=1")

  set(CMAKE_EXE_LINKER_FLAGS_DEBUG "${CMAKE_EXE_LINKER_FLAGS_DEBUG} /INCREMENTAL:NO /SUBSYSTEM:CONSOLE /LTCG /ignore:4099")
  set(CMAKE_EXE_LINKER_FLAGS_MINSIZEREL "${CMAKE_EXE_LINKER_FLAGS_MINSIZEREL} /SUBSYSTEM:CONSOLE /ignore:4099")
  set(CMAKE_EXE_LINKER_FLAGS_RELEASE "${CMAKE_EXE_LINKER_FLAGS_RELEASE} /SUBSYSTEM:CONSOLE /ignore:4099")
  set(CMAKE_EXE_LINKER_FLAGS_RELWITHDEBINFO "${CMAKE_EXE_LINKER_FLAGS_RELWITHDEBINFO} /SUBSYSTEM:CONSOLE /ignore:4099")
else()
  # unknown compiler
  message(STATUS "Compiler type UNKNOWN: ${CMAKE_CXX_COMPILER}")
  set(BASE_COMPILER_OPTIONS "-std=c++11 -Wall -Wextra")
  set(CMAKE_CXX_FLAGS                "${CMAKE_CXX_FLAGS} ${BASE_COMPILER_OPTIONS}")
  set(CMAKE_CXX_FLAGS_DEBUG          "${CMAKE_CXX_FLAGS_DEBUG} ${BASE_COMPILER_OPTIONS} -O0 -g")
  set(CMAKE_CXX_FLAGS_MINSIZEREL     "${CMAKE_CXX_FLAGS_MINSIZEREL} ${BASE_COMPILER_OPTIONS} -Os")
  set(CMAKE_CXX_FLAGS_RELEASE        "${CMAKE_CXX_FLAGS_RELEASE} ${BASE_COMPILER_OPTIONS} -O3 -fomit-frame-pointer")
  set(CMAKE_CXX_FLAGS_RELWITHDEBINFO "${CMAKE_CXX_FLAGS_RELWITHDEBINFO} ${BASE_COMPILER_OPTIONS} -O3 -g")

endif()

# build libreplxx
add_library(
  replxx
  STATIC
  src/conversion.cxx
  src/ConvertUTF.cpp
  src/escape.cxx
  src/history.cxx
  src/inputbuffer.cxx
  src/io.cxx
  src/prompt.cxx
  src/replxx.cxx
  src/util.cxx
  src/wcwidth.cpp
  src/windows.cxx
)

set(CMAKE_THREAD_PREFER_PTHREAD TRUE)
set(THREADS_PREFER_PTHREAD_FLAG TRUE)
set(CMAKE_FIND_LIBRARY_SUFFIXES ".a")
find_package(Threads REQUIRED)  

add_library(Replxx::Replxx ALIAS replxx)

target_link_libraries(replxx Threads::Threads)

target_include_directories(replxx
   PUBLIC ${PROJECT_SOURCE_DIR}/include
   PRIVATE ${PROJECT_SOURCE_DIR}/src)

# install
install(TARGETS replxx DESTINATION lib)

# headers
install(FILES include/replxx.hxx include/replxx.h DESTINATION include)

# packaging
include(CPack)

if (MSVC)
	set_target_properties( replxx PROPERTIES RELEASE_OUTPUT_NAME replxx DEBUG_OUTPUT_NAME replxx-d )
else ()
  set(CPACK_SET_DESTDIR ON)
endif ()

set(CPACK_PACKAGE_VENDOR  "codestation.org")
set(CPACK_PACKAGE_CONTACT "amok@codestation.org")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")

set(CPACK_RESOURCE_FILE_LICENSE "${PROJECT_SOURCE_DIR}/LICENSE")

set(CPACK_STRIP_FILES "ON")

set(CPACK_PACKAGE_NAME "replxx")
set(CPACK_DEBIAN_PACKAGE_SECTION "utilities")
