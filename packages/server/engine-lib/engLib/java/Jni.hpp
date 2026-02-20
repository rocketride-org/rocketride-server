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

using NativeHandle = int64_t;

_const auto ExceptionClassName = "java/lang/Exception";
_const auto NativeErrorClassName = "com/rocketride/NativeError";

//-------------------------------------------------------------------------
/// @details
///		Define the interface into the jvm that a thread can use to
///		call the jvm
///------------------------------------------------------------------------
class Jni {
public:
    //-----------------------------------------------------------------
    ///	Define out logging information
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::Java;

    //-----------------------------------------------------------------
    //	Contstuctor/desctructor
    //-----------------------------------------------------------------
    Jni(JNIEnv* jni) noexcept : m_env(jni) { assert(m_env); }

    ~Jni() noexcept = default;
    Jni() noexcept {};
    Jni(const Jni&) noexcept = default;
    Jni(Jni&&) noexcept = default;

    //-----------------------------------------------------------------
    ///	@details
    ///		Set a new env after the fact
    //-----------------------------------------------------------------
    void setEnv(JNIEnv* jni) noexcept {
        ASSERT_MSG(!m_env, "Invalid JNIEnv");
        m_env = jni;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Set a new env after the fact
    //-----------------------------------------------------------------
    JNIEnv* getEnv() noexcept { return m_env; }

    //-----------------------------------------------------------------
    ///	@details
    ///		Setup a local frame such that when the function call is
    ///		completed, all objects created within the frame will be
    ///		detroyed
    //-----------------------------------------------------------------
    ErrorOr<util::Scope> pushLocalFrame(int capacity = 512) const noexcept {
        // Default to a capacity of 512. This used to be at 0, which
        //  was the default of 32, which is simply not enough. If we
        //  have a memory leek, this will continually  increase over
        //  time so we well get more than 512
        if (auto res = m_env->PushLocalFrame(capacity))
            return APERRT(Ec::Java, "PushLocalFrame failed with capacity",
                          capacity, res);

        return util::Scope(
            [this]() noexcept { m_env->PopLocalFrame(nullptr); });
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Return a text string from a java string
    ///	@param[in] string
    ///		The java string
    //-----------------------------------------------------------------
    Text toText(const jstring& string) const noexcept {
        if (!string) return {};

        auto length = m_env->GetStringUTFLength(string);
        if (!length) return {};

        // Get the UTF-8 buffer
        auto buffer = m_env->GetStringUTFChars(string, nullptr);
        if (!buffer) {
            LOGT(
                "JNI failed to convert Java string to UTF-8; JVM is probably "
                "out of memory");
            return {};
        }

        // Make a copy of the buffer
        Text text(buffer, length);

        // Release the buffer
        m_env->ReleaseStringUTFChars(string, buffer);

        return text;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Stringify a java object
    ///	@param[in] object
    ///		The java object
    //-----------------------------------------------------------------
    Text toText(const jobject& object) const noexcept {
        // Doesn't appear to be a safer way of doing this
        return toText(_reCast<const jstring&>(object));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Return a Utf16 text string from a java string
    ///	@param[in] string
    ///		The java string
    //-----------------------------------------------------------------
    Utf16 toUtf16(const jstring& string) const noexcept {
        if (!string) return {};

        auto length = m_env->GetStringLength(string);
        if (!length) return {};

        // Get the UTF-16 buffer
        auto buffer = m_env->GetStringChars(string, nullptr);
        if (!buffer) {
            LOGT(
                "JNI failed to convert Java string to UTF-8; JVM is probably "
                "out of memory");
            return {};
        }

        // Make a copy of the buffer
        Utf16 utf16(buffer, length);

        // Release the buffer
        m_env->ReleaseStringChars(string, buffer);
        return utf16;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Return a Utf16 text string from a java object
    ///	@param[in] string
    ///		The java string
    //-----------------------------------------------------------------
    Utf16 toUtf16(const jobject& object) const noexcept {
        // Doesn't appear to be a safer way of doing this
        return toUtf16(_reCast<const jstring&>(object));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get a class
    ///	@param[in] name
    ///		Name of the class
    //-----------------------------------------------------------------
    jclass getClass(const char* name) const noexcept(false) {
        // Always return a global reference to a class so that the reference
        // persists even if the class is unloaded. The class reference will be
        // of static duration and will outlive the JVM itself, so don't worry
        // about freeing it.
        if (auto localClass = m_env->FindClass(name))
            return _reCast<jclass>(m_env->NewGlobalRef(localClass));

        APERRT_THROW(Ec::Java, "Failed to find Java class", name);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the unique method id of a method within a class
    ///	@param[in] clazz
    ///		The java class
    ///	@param[in] name
    ///		The name of the method
    ///	@param[in] signature
    ///		The calling/return signature of the method
    //-----------------------------------------------------------------
    jmethodID getMethodId(jclass clazz, const char* name,
                          const char* signature) const noexcept(false) {
        if (auto methodId = m_env->GetMethodID(clazz, name, signature))
            return methodId;

        APERRT_THROW(Ec::Java, "Failed to find Java method",
                     getClassName(clazz), name, signature);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the unique field id of a field within a class
    ///	@param[in] clazz
    ///		The java class
    ///	@param[in] name
    ///		The name of the field
    ///	@param[in] signature
    ///		The type signature of the field
    //-----------------------------------------------------------------
    jfieldID getFieldId(jclass clazz, const char* name,
                        const char* signature) const noexcept(false) {
        if (auto fieldId = m_env->GetFieldID(clazz, name, signature))
            return fieldId;

        APERRT_THROW(Ec::Java, "Failed to find Java field", getClassName(clazz),
                     name, signature);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the constructor method of class
    ///	@param[in] clazz
    ///		The java class
    ///	@param[in] signature
    ///		The type signature of the constructor
    //-----------------------------------------------------------------
    jmethodID getConstructorMethodId(jclass clazz,
                                     const char* signature = "()V") const
        noexcept(false) {
        return getMethodId(clazz, "<init>", signature);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the stringifier method for the class
    ///	@param[in] clazz
    ///		The java class
    //-----------------------------------------------------------------
    jmethodID getToStringMethodId(jclass clazz) const noexcept(false) {
        return getMethodId(clazz, "toString", "()Ljava/lang/String;");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the localized stringifier method for the class
    ///	@param[in] clazz
    ///		The java class
    //-----------------------------------------------------------------
    jmethodID getLocalizedMessageId(jclass clazz) const noexcept(false) {
        return getMethodId(clazz, "getLocalizedMessage",
                           "()Ljava/lang/String;");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get a static method for the class
    ///	@param[in] clazz
    ///		The java class
    ///	@param[in] name
    ///		The name of the method
    ///	@param[in] signature
    ///		The calling/return signature of the method
    //-----------------------------------------------------------------
    jmethodID getStaticMethodId(jclass clazz, const char* name,
                                const char* signature) const noexcept(false) {
        if (auto methodId = m_env->GetStaticMethodID(clazz, name, signature))
            return methodId;

        APERRT_THROW(Ec::Java, "Failed to find Java static method",
                     getClassName(clazz), name, signature);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get a static field for the class
    ///	@param[in] clazz
    ///		The java class
    ///	@param[in] name
    ///		The name of the field
    ///	@param[in] signature
    ///		The signature of the field
    //-----------------------------------------------------------------
    jfieldID getStaticFieldId(jclass clazz, const char* name,
                              const char* signature) const noexcept(false) {
        if (auto fieldId = m_env->GetStaticFieldID(clazz, name, signature))
            return fieldId;

        APERRT_THROW(Ec::Java, "Failed to find Java static field",
                     getClassName(clazz), name, signature);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the text associated with an exception
    ///	@param[in] exception
    ///		The java exception
    //-----------------------------------------------------------------
    ErrorOr<Text> renderException(jthrowable exception) const noexcept {
        // Use the raw API rather than invokeObjectMethod because we may enter
        // an infinite loop
        const auto toLocalizedMessageId =
            getLocalizedMessageId(getClass(ExceptionClassName));
        return toText(m_env->CallObjectMethod(exception, toLocalizedMessageId));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get the last exception that was raised within the context
    ///		of this jni
    //-----------------------------------------------------------------
    Error getLastError() const noexcept {
        // Check whether an exception occurred
        auto exception = m_env->ExceptionOccurred();
        if (!exception) return {};

        // Convert to an error
        auto error = APERRT(Ec::Java, renderException(exception));

        // Print to stderr if dev logging is enabled or if this is a debug build
        if (log::isLevelEnabled(Lvl::Java)) {
            LOG(Java, error);
            m_env->ExceptionDescribe();
        }

        // Clear the exception
        m_env->ExceptionClear();
        return error;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Check if an exception was raised
    //-----------------------------------------------------------------
    void checkError() const noexcept(false) { *getLastError(); }

    //-----------------------------------------------------------------
    ///	@details
    ///		Raise a java exception within the jni context
    ///	@param[in]	exceptionClass
    ///		The class of the exception being raised
    ///	@param[in]	message
    ///		The message assocated with the exception (cause/why)
    //-----------------------------------------------------------------
    void raiseError(const char* exceptionClass, const char* message) const
        noexcept(false) {
        // Check for a Java exception first
        checkError();

        // Throw a new Java exception of the specified class
        LOGT("Throwing Java exception of class '{}': {}", exceptionClass,
             message);
        m_env->ThrowNew(getClass(exceptionClass), message);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Raise a generic java exception within the jni context
    ///	@param[in]	message
    ///		The message assocated with the exception (cause/why)
    //-----------------------------------------------------------------
    void raiseError(const char* message) const noexcept(false) {
        raiseError(ExceptionClassName, message);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Raise a native java exception within the jni context
    ///	@param[in]	message
    ///		The message assocated with the exception (cause/why)
    //-----------------------------------------------------------------
    void raiseNativeError(const char* message) const noexcept(false) {
        raiseError(NativeErrorClassName, message);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Raise a native java exception within the jni context
    ///	@param[in]	message
    ///		The error code
    //-----------------------------------------------------------------
    void raiseNativeError(const Error& ccode) const noexcept(false) {
        raiseNativeError(_fmt("Native callback failed: {}", ccode));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Generic cast
    ///	@param[in]	object
    ///		The object to cast
    //-----------------------------------------------------------------
    template <typename T>
    T jCast(jobject object) const noexcept {
        if constexpr (traits::IsSameTypeV<T, Text>)
            return toText(object);
        else if constexpr (traits::IsSameTypeV<T, Utf16>)
            return toUtf16(object);
        else if constexpr (traits::IsSameTypeV<T, jobject>)
            return object;
        else if constexpr (traits::IsSameTypeV<T, void>)
            return;
        else
            static_assert(sizeof(T) == 0, "Unsupported return type");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Call a static method on a class
    ///	@param[in]	clazz
    ///		The class info
    ///	@param[in]	methodId
    ///		The method id to call
    ///	@param[in]	vargs
    ///		The arguments
    //-----------------------------------------------------------------
    template <typename T>
    T invokeStaticMethodV(jclass clazz, jmethodID methodId,
                          va_list vargs) const noexcept {
        if constexpr (traits::IsSameTypeV<T, jboolean>)
            return m_env->CallStaticBooleanMethodV(clazz, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jbyte>)
            return m_env->CallStaticByteMethodV(clazz, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jchar>)
            return m_env->CallStaticCharMethodV(clazz, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jshort>)
            return m_env->CallStaticShortMethodV(clazz, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jint>)
            return m_env->CallStaticIntMethodV(clazz, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jlong>)
            return m_env->CallStaticLongMethodV(clazz, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jfloat>)
            return m_env->CallStaticFloatMethodV(clazz, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jdouble>)
            return m_env->CallStaticDoubleMethodV(clazz, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, void>)
            return m_env->CallStaticVoidMethodV(clazz, methodId, vargs);
        else
            return jCast<T>(
                m_env->CallStaticObjectMethodV(clazz, methodId, vargs));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Call a static method on a class
    ///	@param[in]	clazz
    ///		The class info
    ///	@param[in]	methodId
    ///		The method id to call
    ///	@param[in]	...
    ///		The arguments
    //-----------------------------------------------------------------
    template <typename T>
    T invokeStaticMethod(jclass clazz, jmethodID methodId, ...) const
        noexcept(false) {
        va_list vargs;
        va_start(vargs, methodId);
        auto res = invokeStaticMethodV<T>(clazz, methodId, vargs);
        va_end(vargs);

        checkError();
        return res;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Call a static method on a class returning void
    ///		return a void
    ///	@param[in]	clazz
    ///		The class info
    ///	@param[in]	methodId
    ///		The method id to call
    ///	@param[in]	...
    ///		The arguments
    //-----------------------------------------------------------------
    void invokeStaticMethod(jclass clazz, jmethodID methodId, ...) const
        noexcept(false) {
        va_list vargs;
        va_start(vargs, methodId);
        invokeStaticMethodV<void>(clazz, methodId, vargs);
        va_end(vargs);

        checkError();
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Call a method on a object
    ///	@param[in]	object
    ///		The object info
    ///	@param[in]	methodId
    ///		The method id to call
    ///	@param[in]	vargs
    ///		The arguments
    //-----------------------------------------------------------------
    template <typename T>
    T invokeObjectMethodV(jobject object, jmethodID methodId,
                          va_list vargs) const noexcept {
        if constexpr (traits::IsSameTypeV<T, jboolean>)
            return m_env->CallBooleanMethodV(object, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jbyte>)
            return m_env->CallByteMethodV(object, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jchar>)
            return m_env->CallCharMethodV(object, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jshort>)
            return m_env->CallShortMethodV(object, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jint>)
            return m_env->CallIntMethodV(object, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jlong>)
            return m_env->CallLongMethodV(object, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jfloat>)
            return m_env->CallFloatMethodV(object, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, jdouble>)
            return m_env->CallDoubleMethodV(object, methodId, vargs);
        else if constexpr (traits::IsSameTypeV<T, void>)
            return m_env->CallVoidMethodV(object, methodId, vargs);
        else
            return jCast<T>(m_env->CallObjectMethodV(object, methodId, vargs));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Call a method on a object
    ///	@param[in]	object
    ///		The object info
    ///	@param[in]	methodId
    ///		The method id to call
    ///	@param[in]	vargs
    ///		The arguments
    //-----------------------------------------------------------------
    template <typename T>
    T invokeObjectMethod(jobject object, jmethodID methodId, ...) const
        noexcept(false) {
        va_list vargs;
        va_start(vargs, methodId);
        auto res = invokeObjectMethodV<T>(object, methodId, vargs);
        va_end(vargs);

        checkError();
        return res;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Call a method on an object returning void
    ///	@param[in]	object
    ///		The object info
    ///	@param[in]	methodId
    ///		The method id to call
    ///	@param[in]	vargs
    ///		The arguments
    //-----------------------------------------------------------------
    void invokeObjectMethod(jobject object, jmethodID methodId, ...) const
        noexcept(false) {
        va_list vargs;
        va_start(vargs, methodId);
        invokeObjectMethodV<void>(object, methodId, vargs);
        va_end(vargs);

        checkError();
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get a static field from a class
    ///	@param[in]	clazz
    ///		The class info
    ///	@param[in]	fieldId
    ///		The field id to retrieve
    //-----------------------------------------------------------------
    template <typename T>
    T getStaticField(jclass clazz, jfieldID fieldId) const noexcept {
        if constexpr (traits::IsSameTypeV<T, jboolean>)
            return m_env->GetStaticBooleanField(clazz, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jbyte>)
            return m_env->GetStaticByteField(clazz, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jchar>)
            return m_env->GetStaticCharField(clazz, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jshort>)
            return m_env->GetStaticShortField(clazz, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jint>)
            return m_env->GetStaticIntField(clazz, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jlong>)
            return m_env->GetStaticLongField(clazz, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jfloat>)
            return m_env->GetStaticFloatField(clazz, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jdouble>)
            return m_env->GetStaticDoubleField(clazz, fieldId);
        else
            return jCast<T>(m_env->GetStaticObjectField(clazz, fieldId));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Set a static field in a class
    ///	@param[in]	clazz
    ///		The class info
    ///	@param[in]	fieldId
    ///		The field id to set
    ///	@param[in]	value
    ///		Value to set
    //-----------------------------------------------------------------
    template <typename T>
    void setStaticField(jclass clazz, jfieldID fieldId,
                        const T& value) const noexcept {
        if constexpr (traits::IsSameTypeV<T, jboolean>)
            m_env->SetStaticBooleanField(clazz, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jbyte>)
            m_env->SetStaticByteField(clazz, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jchar>)
            m_env->SetStaticCharField(clazz, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jshort>)
            m_env->SetStaticShortField(clazz, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jint>)
            m_env->SetStaticIntField(clazz, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jlong>)
            m_env->SetStaticLongField(clazz, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jfloat>)
            m_env->SetStaticFloatField(clazz, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jdouble>)
            m_env->SetStaticDoubleField(clazz, fieldId, value);
        else if constexpr (std::is_convertible_v<T, jobject>)
            m_env->SetStaticObjectField(clazz, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, Text>)
            m_env->SetStaticObjectField(clazz, fieldId, createString(value));
        else
            static_assert(sizeof(T) == 0, "Unsupported object type");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Get a field in an object
    ///	@param[in]	object
    ///		The class info
    ///	@param[in]	fieldId
    ///		The field id to retrieve
    //-----------------------------------------------------------------
    template <typename T>
    T getObjectField(jobject object, jfieldID fieldId) const noexcept {
        if constexpr (traits::IsSameTypeV<T, jboolean>)
            return m_env->GetBooleanField(object, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jbyte>)
            return m_env->GetByteField(object, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jchar>)
            return m_env->GetCharField(object, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jshort>)
            return m_env->GetShortField(object, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jint>)
            return m_env->GetIntField(object, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jlong>)
            return m_env->GetLongField(object, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jfloat>)
            return m_env->GetFloatField(object, fieldId);
        else if constexpr (traits::IsSameTypeV<T, jdouble>)
            return m_env->GetDoubleField(object, fieldId);
        else
            return jCast<T>(m_env->GetObjectField(object, fieldId));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Retrieve an array of strings from a field in an object
    ///	@param[in]	object
    ///		The object info
    ///	@param[in]	fieldId
    ///		The field id to set
    //-----------------------------------------------------------------
    std::vector<Text> getObjectStringArray(jobject object,
                                           jfieldID fieldId) const noexcept {
        auto jArray =
            _reCast<jobjectArray>(m_env->GetObjectField(object, fieldId));
        const auto jArrayLength = getArrayLength(jArray);
        std::vector<Text> res;
        for (size_t i = 0; i < jArrayLength; ++i) {
            res.emplace_back(getObjectArrayElement<Text>(jArray, i));
        }
        return res;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Set a field in an object
    ///	@param[in]	object
    ///		The object info
    ///	@param[in]	fieldId
    ///		The field id to set
    ///	@param[in]	value
    ///		Value to set
    //-----------------------------------------------------------------
    template <typename T>
    void setObjectField(jobject object, jfieldID fieldId,
                        const T& value) const noexcept {
        if constexpr (traits::IsSameTypeV<T, jboolean>)
            m_env->SetBooleanField(object, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jbyte>)
            m_env->SetByteField(object, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jchar>)
            m_env->SetCharField(object, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jshort>)
            m_env->SetShortField(object, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jint>)
            m_env->SetIntField(object, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jlong>)
            m_env->SetLongField(object, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jfloat>)
            m_env->SetFloatField(object, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, jdouble>)
            m_env->SetDoubleField(object, fieldId, value);
        else if constexpr (std::is_convertible_v<T, jobject>)
            m_env->SetObjectField(object, fieldId, value);
        else if constexpr (traits::IsSameTypeV<T, Text>)
            m_env->SetObjectField(object, fieldId, createString(value));
        else
            static_assert(sizeof(T) == 0, "Unsupported field type");
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Create an object instance of a class
    ///	@param[in]	clazz
    ///		The class of the object
    ///	@param[in]	constructorMethodId
    ///		The method id of the constructor to call with the args
    ///	@param[in]	...
    ///		Arguments to the constructor
    //-----------------------------------------------------------------
    jobject createObject(jclass clazz, jmethodID constructorMethodId, ...) const
        noexcept(false) {
        va_list vargs;
        va_start(vargs, constructorMethodId);
        auto result = m_env->NewObjectV(clazz, constructorMethodId, vargs);
        va_end(vargs);

        checkError();
        return result;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Create a string from a text
    ///	@param[in]	text
    ///		Text of the string
    //-----------------------------------------------------------------
    jstring createString(const Text& text) const noexcept(false) {
        auto result = m_env->NewStringUTF(text);

        checkError();  // Will only throw on out of memory
        return result;
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Retrieve an array of strings from a field in an object
    ///	@param[in]	object
    ///		The object info
    ///	@param[in]	fieldId
    ///		The field id to set
    //-----------------------------------------------------------------
    jobjectArray createStringArray(TextVector& strings) const noexcept {
        // Create a string array
        auto jArray = m_env->NewObjectArray(
            (jsize)strings.size(), m_env->FindClass("java/lang/String"),
            m_env->NewStringUTF(""));

        // Set all the members
        for (auto index = 0; index < strings.size(); index++) {
            m_env->SetObjectArrayElement(jArray, index,
                                         m_env->NewStringUTF(strings[index]));
        }

        // and return it
        return _mv(jArray);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Given an object, gets its class
    ///	@param[in]	object
    ///		The object to get the class from
    //-----------------------------------------------------------------
    jclass getObjectClass(jobject object) const noexcept {
        return m_env->GetObjectClass(object);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Given a class, gets its class name
    ///	@param[in]	clazz
    ///		The class
    //-----------------------------------------------------------------
    Text getClassName(jclass clazz) const noexcept {
        // Since this function is used in error handling, exceptions are
        // anticipated; ignore them
        try {
            if (auto classObj = getObjectClass(clazz))
                return invokeObjectMethod<Text>(
                    clazz,
                    getMethodId(classObj, "getName", "()Ljava/lang/String;"));
        } catch (...) {
        }

        return "Unable to identify Java class";
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Gets the length of a java array
    ///	@param[in]	array
    ///		The array to get the length from
    //-----------------------------------------------------------------
    size_t getArrayLength(jarray array) const noexcept {
        return m_env->GetArrayLength(array);
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		Gets an elment within an array
    ///	@param[in]	array
    ///		The array to get the length from
    ///	@param[in]	index
    ///		The index to retrieve
    //-----------------------------------------------------------------
    template <typename T = jobject>
    T getObjectArrayElement(jobjectArray array, size_t index) const noexcept {
        return jCast<T>(
            m_env->GetObjectArrayElement(array, _cast<jsize>(index)));
    }

    //-----------------------------------------------------------------
    ///	@details
    ///		This is typcially called by the tests to supress exception
    ///		error output to the log
    ///	@param[in]	supress
    ///		Supress log output of exceptions or not
    //-----------------------------------------------------------------
    void supressExceptionDisplay(bool supress) {
        m_supressExceptionDisplay = supress;
    }

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		Are exceptions being supressed or not
    //-----------------------------------------------------------------
    bool m_supressExceptionDisplay = false;

    //-----------------------------------------------------------------
    ///	@details
    ///		The bound env context this jni is connected to
    //-----------------------------------------------------------------
    JNIEnv* m_env = nullptr;
};
}  // namespace engine::java
