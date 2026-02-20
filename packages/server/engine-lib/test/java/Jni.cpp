// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

#include "test.h"

TEST_CASE("java::jni::raiseNativeError") {
    REQUIRE_NO_ERROR(java::init());

    // Get the interface
    GET_JAVA_JNI_THROW(jni);

    // We rarely throw exceptions back into Java, so verify it works
    auto message = "Oopsie daisy!";

    jni.supressExceptionDisplay(true);
    jni.raiseNativeError(message);
    jni.supressExceptionDisplay(false);

    // Retrieve and validate the thrown Java exception
    auto nativeError = jni.getLastError();
    REQUIRE_THROWS(*nativeError);
    REQUIRE(nativeError == Ec::Java);
    REQUIRE(_ts(nativeError).contains(message));

    // getLastError should have cleared the exception state
    REQUIRE_NOTHROW(*jni.getLastError());
}
