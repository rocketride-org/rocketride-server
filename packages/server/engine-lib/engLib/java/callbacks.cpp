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

namespace engine::java {
//-----------------------------------------------------------------
/// @details
///		Registers a native method within a class
///	@param[in] clazz
///		The java class to register within
///	@param[in]	method
///		The method information to register
///----------------------------------------------------------------
void registerNativeCallback(jclass clazz,
                            const JNINativeMethod& method) noexcept(false) {
    GET_JAVA_JNI_THROW(jni);
    GET_JAVA_ENV_THROW(env);

    if (auto result = env.RegisterNatives(clazz, &method, 1);
        result != JNI_OK) {
        APERR_THROW(Ec::Java, "Failed to register native callback",
                    jni.getClassName(clazz), method.name,
                    renderJniError(result));
    }
}

//-----------------------------------------------------------------
/// @details
///		Registers a global class by name within the jvm
///	@param[in] className
///		The java class name to register within
///	@param[in]	method
///		The method information to register
///----------------------------------------------------------------
void registerNativeCallback(const char* className,
                            const JNINativeMethod& method) noexcept(false) {
    GET_JAVA_ENV_THROW(env);

    auto clazz = env.FindClass(className);
    if (!clazz) APERR_THROW(Ec::Java, "Java class not found", className);
    registerNativeCallback(clazz, method);
}

//-----------------------------------------------------------------
/// @details
///		Registers a series of native callbacks by name
///	@param[in] className
///		The java class name to register within
///	@param[in]	method
///		Ptr to the method information table
///	@param[in]	functionCount
///		The number of methods to register
///----------------------------------------------------------------
void registerNativeCallbacks(const char* className,
                             const JNINativeMethod* functionTable,
                             size_t functionCount) noexcept(false) {
    GET_JAVA_ENV_THROW(env);

    auto clazz = env.FindClass(className);
    if (!clazz) APERR_THROW(Ec::Java, "Java class not found", className);

    // Register individually to make errors more easily identifiable
    for (size_t i = 0; i < functionCount; ++i) {
        registerNativeCallback(clazz, functionTable[i]);
    }
}
}  // namespace engine::java
