cmake_minimum_required(VERSION 3.19)
project(rr_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_compile_options(-Wall -Wextra -Wpedantic -Werror=return-type)

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

find_package(ICU REQUIRED COMPONENTS uc i18n data)
find_package(Threads REQUIRED)

find_package(Python COMPONENTS Interpreter Development REQUIRED)
find_package(nanobind CONFIG REQUIRED)

# ---------------------------------------------------------------------------
# Static libraries
# ---------------------------------------------------------------------------

add_library(rr_chunker STATIC
    src/chunker.cpp
)
target_include_directories(rr_chunker PUBLIC src)
target_link_libraries(rr_chunker PUBLIC ICU::uc ICU::i18n ICU::data)

add_library(rr_indexer STATIC
    src/indexer.cpp
)
target_include_directories(rr_indexer PUBLIC src)
target_link_libraries(rr_indexer PUBLIC ICU::uc ICU::i18n Threads::Threads)

# ---------------------------------------------------------------------------
# Python bindings (nanobind)
# ---------------------------------------------------------------------------

nanobind_add_module(rr_native
    python/bindings.cpp
)
target_link_libraries(rr_native PRIVATE rr_chunker rr_indexer)

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

enable_testing()

add_executable(test_chunker tests/test_chunker.cpp)
target_link_libraries(test_chunker PRIVATE rr_chunker)
add_test(NAME test_chunker COMMAND test_chunker)

add_executable(test_indexer tests/test_indexer.cpp)
target_link_libraries(test_indexer PRIVATE rr_indexer Threads::Threads)
add_test(NAME test_indexer COMMAND test_indexer)
