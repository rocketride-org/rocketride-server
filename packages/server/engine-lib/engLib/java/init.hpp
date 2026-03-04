// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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
class Jni;

extern application::Opt ExecJava;
extern application::Opt ExecTika;

//-------------------------------------------------------------------------
/// @details
///		Returns the root path of the jave subdirectory
///------------------------------------------------------------------------
inline file::Path rootDir() noexcept { return application::execDir() / "java"; }

//-------------------------------------------------------------------------
/// @details
///		Get the directory where all the java files are
///------------------------------------------------------------------------
inline auto jreDirectory() noexcept { return rootDir() / "jre/bin/server"; }

//-------------------------------------------------------------------------
// Definition of function to be passed for Java deinit queue
//------------------------------------------------------------------------
typedef std::function<void(Jni &)> DeinitCallback;

//-------------------------------------------------------------------------
// Everyone here uses Jvm
//------------------------------------------------------------------------
typedef JavaVM Jvm;

//-------------------------------------------------------------------------
/// @details
///		Utility function to convert a numeric java error code to a string
///	@param[in] error
///		The error code to convert
///------------------------------------------------------------------------
inline Text renderJniError(jint error) noexcept {
    switch (error) {
        case JNI_OK:
            return "Success";
        case JNI_ERR:
            return "Unspecified error";
        case JNI_EDETACHED:
            return "Thread detached from the VM";
        case JNI_EVERSION:
            return "JNI version error";
        case JNI_ENOMEM:
            return "Not enough memory";
        case JNI_EEXIST:
            return "VM already created";
        case JNI_EINVAL:
            return "Invalid arguments";
        default:
            return _fmt("Unknown JNI error: {}", error);
    };
}

//-------------------------------------------------------------------------
/// @details
///		Log diagnostic data on JVM crash
///	@param[in] reason
///		The reason why we are doing this
///------------------------------------------------------------------------
inline void onJvmCrash(TextView reason) noexcept {
    // Log the reason so that subsequently logged diagnostics make some sense
    LOG(Always, reason);

    // Dump the process (only on Windows)
    dev::dumpProcess();

    // Log JVM heap usage (if available)
    if (log::options().additionalMemoryUsed)
        LOG(Always, "Current JVM heap usage: {,s}",
            log::options().additionalMemoryUsed);
}

//-------------------------------------------------------------------------
// Declare our externals define in the cpp
//------------------------------------------------------------------------
void registerNativeCallback(jclass clazz,
                            const JNINativeMethod &method) noexcept(false);
void registerNativeCallback(const char *className,
                            const JNINativeMethod &method) noexcept(false);
void registerNativeCallbacks(const char *className,
                             const JNINativeMethod *functionTable,
                             size_t functionCount) noexcept(false);
ErrorOr<Jvm *> getJvm() noexcept;
ErrorOr<Jni *> getJni(bool detachable = false) noexcept;
ErrorOr<JNIEnv *> getEnv(bool detachable = false) noexcept;
bool isJava() noexcept;
Error execJava() noexcept;

Error init() noexcept;
bool initialized() noexcept;
void deinit() noexcept;
}  // namespace engine::java

//-----------------------------------------------------------------------------
// Declare macros to easily get a reference to our Java JVM
//-----------------------------------------------------------------------------
#define GET_JAVA_JVM(jvm)                   \
    auto jvm##ref = java::getJvm();         \
    if (!jvm##ref) return jvm##ref.ccode(); \
    auto &jvm = **jvm##ref
#define GET_JAVA_JVM_THROW(jvm)            \
    auto jvm##ref = java::getJvm();        \
    if (!jvm##ref) throw jvm##ref.ccode(); \
    auto &jvm = **jvm##ref

//-----------------------------------------------------------------------------
// Declare macros to easily get a reference to our Java JNI class for the
// calling thead
//-----------------------------------------------------------------------------
#define GET_JAVA_JNI(jni)                   \
    auto jni##ref = java::getJni();         \
    if (!jni##ref) return jni##ref.ccode(); \
    auto &jni = **jni##ref
#define GET_JAVA_JNI_THROW(jni)            \
    auto jni##ref = java::getJni();        \
    if (!jni##ref) throw jni##ref.ccode(); \
    auto &jni = **jni##ref

//-----------------------------------------------------------------------------
// Declare macros to easily get a reference to the JNI API
//-----------------------------------------------------------------------------
#define GET_JAVA_ENV(env)                   \
    auto env##ref = java::getEnv();         \
    if (!env##ref) return env##ref.ccode(); \
    auto &env = **env##ref
#define GET_JAVA_ENV_THROW(env)            \
    auto env##ref = java::getEnv();        \
    if (!env##ref) throw env##ref.ccode(); \
    auto &env = **env##ref
