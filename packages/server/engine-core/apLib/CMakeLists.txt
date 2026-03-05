cmake_minimum_required(VERSION 3.10 FATAL_ERROR)

if(NOT TARGET apLib.lib)
    # Add the apLib library
    rocketride_add_library(apLib LIST_ONLY "json;ipp" *.c *.cpp *.hpp *.h *.json *.ipp *.y)
else()
    # Do not compile any *.c *cpp if the target has a prebuilt apLib.lib
    rocketride_add_library(apLib LIST_ONLY "json;ipp" *.hpp *.h *.json *.ipp *.y)
    set_target_properties(apLib PROPERTIES LINKER_LANGUAGE CXX)
endif()

# Link to the vcpkg dependencies

find_package(OpenSSL CONFIG REQUIRED)
target_link_libraries(apLib PRIVATE OpenSSL::SSL OpenSSL::Crypto)

find_package(ICU REQUIRED COMPONENTS i18n)
target_link_libraries(apLib PRIVATE ICU::i18n)

find_package(lz4 CONFIG REQUIRED)
target_link_libraries(apLib PRIVATE lz4::lz4)

find_package(tinyxml2 CONFIG REQUIRED)
target_link_libraries(apLib PRIVATE tinyxml2::tinyxml2)

# find_package/target_link_libraries is not working for FastPFor, so we link it manually
if(ROCKETRIDE_PLAT_WIN)
    target_link_libraries(apLib PRIVATE "${VCPKG_INSTALLED_TRIPLET_DIR}/lib/FastPFor.lib")
else() # ROCKETRIDE_PLAT_UNX
    target_link_libraries(apLib PRIVATE "${VCPKG_INSTALLED_TRIPLET_DIR}/lib/libFastPFor.a")
endif()
target_include_directories(apLib PUBLIC "${VCPKG_INSTALLED_TRIPLET_DIR}/include/FastPFor/headers")

if(ROCKETRIDE_FACTORY_DEBUG)
    target_compile_definitions(apLib PUBLIC -DROCKETRIDE_FACTORY_DEBUG=1)
endif()

if(ROCKETRIDE_PLAT_WIN)
    target_compile_definitions(apLib PUBLIC -DBOOST_STACKTRACE_LINK)
    find_package(Boost CONFIG REQUIRED COMPONENTS stacktrace_windbg)
    target_link_libraries(apLib PRIVATE Boost::stacktrace_windbg)
endif()

find_package(date CONFIG REQUIRED)
if(ROCKETRIDE_PLAT_UNX)
    target_link_libraries(apLib PRIVATE date::date-tz)
endif()
target_link_libraries(apLib PRIVATE date::date)

if(ROCKETRIDE_PLAT_LIN)
    # Build libbacktrace from source (the libbacktrace vcpkg doesn't work on Linux)
    include(../cmake/AddLibBacktrace.cmake)
    target_link_libraries(apLib PUBLIC LibBacktraceTarget)

    find_package(unofficial-breakpad CONFIG REQUIRED)
    target_link_libraries(apLib PRIVATE
        unofficial::breakpad::libbreakpad
        unofficial::breakpad::libbreakpad_client)
endif()

if(ROCKETRIDE_PLAT_MAC)
    target_compile_definitions(apLib PUBLIC -D_GNU_SOURCE)
endif()

# Link to platform libs
if(ROCKETRIDE_PLAT_WIN)
    target_link_libraries(apLib PUBLIC netapi32.lib VssApi.lib Rpcrt4.lib XmlLite.lib Crypt32.lib ws2_32.lib Dbghelp.lib Mpr.lib)
else()
    target_link_libraries(apLib PUBLIC dl c m)
endif()

# Register our own public include paths for dependencies linking to apLib with
# un-ambiguous include paths e.g. <apLib/ap.h>
target_include_directories(apLib PUBLIC "${CMAKE_CURRENT_LIST_DIR}/../")

if(NOT TARGET apLib.lib)
    # Process its precompiled headers (only if engLib is not prebuilt)
    rocketride_pch(apLib
        UNITY_EXCLUDES "${CMAKE_CURRENT_LIST_DIR}/compress/FastPFor.cpp"
        PCH "${CMAKE_CURRENT_LIST_DIR}/headers.h")
endif()
