# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

# Engine compiler/linker flags for the arm64-osx-appleclang-rocketride build (AppleClang).

set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE INTERNAL "" FORCE)

set(CMAKE_C_COMPILER "clang" CACHE STRING "" FORCE)
set(CMAKE_CXX_COMPILER "clang++" CACHE STRING "" FORCE)

# Set default CMAKE_OSX_DEPLOYMENT_TARGET if not set (drives -mmacosx-version-min below)
if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "14.6" CACHE STRING "" FORCE)
endif()

# Common definitions across c++/c
set(TOOLCHAIN_FLAGS "-g3 -Wno-trigraphs -Wno-unused-value -Wno-switch -Wfatal-errors -Wno-deprecated-declarations")
set(TOOLCHAIN_FLAGS "${TOOLCHAIN_FLAGS} -arch arm64 -Wno-switch -fPIC")

# Enable errors for if (val = 1), force use of new c++ 20 'if statement with initializer' feature instead if (val = 1; val)
set(TOOLCHAIN_FLAGS "${TOOLCHAIN_FLAGS} -Werror=parentheses")

# Enable errors for (while obj = ...)
set(TOOLCHAIN_FLAGS "${TOOLCHAIN_FLAGS} -Werror=idiomatic-parentheses")

# Allow various logical operators
set(TOOLCHAIN_FLAGS "${TOOLCHAIN_FLAGS} -Wno-logical-op-parentheses")

# Set the CXX flags using the resolved deployment target
set(CMAKE_CXX_FLAGS "${TOOLCHAIN_FLAGS} -std=c++2a -mmacosx-version-min=${CMAKE_OSX_DEPLOYMENT_TARGET}" CACHE STRING "" FORCE)
set(CMAKE_C_FLAGS "${TOOLCHAIN_FLAGS} -mmacosx-version-min=${CMAKE_OSX_DEPLOYMENT_TARGET}" CACHE STRING "" FORCE)

set(CMAKE_CXX_FLAGS_DEBUG "${TOOLCHAIN_FLAGS} -std=c++2a" CACHE STRING "" FORCE)

# ThreadSanitizer
set(CMAKE_C_FLAGS_TSAN
    "${CMAKE_C_FLAGS_RELEASE} -fsanitize=thread -O1"
    CACHE STRING "Flags used by the C compiler during ThreadSanitizer builds."
    FORCE)
set(CMAKE_CXX_FLAGS_TSAN
    "${CMAKE_CXX_FLAGS_RELEASE} -fsanitize=thread -O1"
    CACHE STRING "Flags used by the C++ compiler during ThreadSanitizer builds."
    FORCE)

# AddressSanitize
set(CMAKE_C_FLAGS_ASAN
    "${CMAKE_C_FLAGS_RELEASE} -fsanitize=address -fno-optimize-sibling-calls -fsanitize-address-use-after-scope -fno-omit-frame-pointer -O1"
    CACHE STRING "Flags used by the C compiler during AddressSanitizer builds."
    FORCE)
set(CMAKE_CXX_FLAGS_ASAN
    "${CMAKE_CXX_FLAGS_RELEASE} -fsanitize=address -fno-optimize-sibling-calls -fsanitize-address-use-after-scope -fno-omit-frame-pointer -O1"
    CACHE STRING "Flags used by the C++ compiler during AddressSanitizer builds."
    FORCE)

# LeakSanitizer
set(CMAKE_C_FLAGS_LSAN
    "${CMAKE_C_FLAGS_RELEASE} -fsanitize=leak -fno-omit-frame-pointer -O1"
    CACHE STRING "Flags used by the C compiler during LeakSanitizer builds."
    FORCE)
set(CMAKE_CXX_FLAGS_LSAN
    "${CMAKE_CXX_FLAGS_RELEASE} -fsanitize=leak -fno-omit-frame-pointer -O1"
    CACHE STRING "Flags used by the C++ compiler during LeakSanitizer builds."
    FORCE)

# UndefinedBehaviour
set(CMAKE_C_FLAGS_UBSAN
    "${CMAKE_C_FLAGS_RELEASE} -fsanitize=undefined"
    CACHE STRING "Flags used by the C compiler during UndefinedBehaviourSanitizer builds."
    FORCE)
set(CMAKE_CXX_FLAGS_UBSAN
    "${CMAKE_CXX_FLAGS_RELEASE} -fsanitize=undefined"
    CACHE STRING "Flags used by the C++ compiler during UndefinedBehaviourSanitizer builds."
    FORCE)
