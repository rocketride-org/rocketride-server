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

#pragma once

namespace engine::java {
//-------------------------------------------------------------------------
/// @details
///		This callback is called by the jvm when some kind of log message
///		needs to be output
///	@param[in]	env
///		The environment block for the call
///	@param[in]	clazz
///		The class issuing the message
///	@param[in]	string
///		The message
///------------------------------------------------------------------------
inline void logCallback(JNIEnv *env, jclass clazz, jstring string) noexcept {
    // Get a jni interface with the given env
    java::Jni jni(env);

    // Trim any trailing whitespace
    if (auto text = jni.toText(string).trimTrailing()) {
        // Always log FATAL statements from Java
        if (text.startsWith("FATAL "))
            LOG(Always, "JAVA:", text);
        else
            LOG(Java, "JAVA:", text);
    }
}

//-------------------------------------------------------------------------
/// @details
///		Registers native callacks with the jvm
///	@param[in]	jvm
///		The jvm to register with
///------------------------------------------------------------------------
inline void registerNativeCallbacks(java::Jvm &jvm) noexcept(false) {
    // Register native callbacks
    JNINativeMethod nativeMethodTable[] = {
        {_constCast<char *>("logCallback"),
         _constCast<char *>("(Ljava/lang/String;)V"),
         _reCast<void *>(&logCallback)}};
    jvm.registerNativeCallbacks("com/rocketride/Logging", nativeMethodTable,
                                std::size(nativeMethodTable));
}

}  // namespace engine::java
