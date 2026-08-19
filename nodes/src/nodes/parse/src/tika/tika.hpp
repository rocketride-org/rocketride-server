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

namespace engine::store::filter::parse::Tika {
//-------------------------------------------------------------------------
// We eventually need to add container sensitive text formatting to
// determine, for example, on a zip file, which document within the
// the zip file contains which text. Here is a good article:
//
//  https://cwiki.apache.org/confluence/display/tika/RecursiveMetadata
//
//-------------------------------------------------------------------------

//-------------------------------------------------------------------------
/// @details
///		This class is the extraction context handler passed when
///     extracting text to notify of parsing events
//-------------------------------------------------------------------------
class TikaContext {
public:
    //-----------------------------------------------------------------
    // Constructor/destructor
    //-----------------------------------------------------------------
    TikaContext() noexcept {};
    virtual ~TikaContext() noexcept = default;

    //-----------------------------------------------------------------
    // Disable moves/copies
    //-----------------------------------------------------------------
    TikaContext(const TikaContext &) = delete;
    TikaContext(TikaContext &&) = delete;

    //-----------------------------------------------------------------
    // This can be overridden to get a begin parsing notification
    //-----------------------------------------------------------------
    virtual Error onDocumentBegin() noexcept {
        LOG(Parse, "Beginning to parse document");
        return {};
    }

    //-----------------------------------------------------------------
    // This can be overridden to receive the parsed text
    //-----------------------------------------------------------------
    virtual Error onText(const Utf16View text) noexcept {
        LOG(Parse, "Signalling text");
        return {};
    };

    //-----------------------------------------------------------------
    // This can be overridden to receive the parsed table
    //-----------------------------------------------------------------
    virtual Error onTable(const Utf16View text) noexcept {
        LOG(Parse, "Signalling table");
        return {};
    };

    //-----------------------------------------------------------------
    // This can be overridden to recieve the imagedata
    //-----------------------------------------------------------------
    virtual Error onImage(const AVI_ACTION action, Text &mimeType,
                          const std::vector<uint8_t> &binaryData) noexcept {
        LOG(Parse, "Signalling Image Data");
        return {};
    };

    //-----------------------------------------------------------------
    // This can be overridden to recieve the audioData
    //-----------------------------------------------------------------
    virtual Error onAudio(const AVI_ACTION action, Text &mimeType,
                          const std::vector<uint8_t> &binaryData) noexcept {
        LOG(Parse, "Signalling Audio Data");
        return {};
    };

    //-----------------------------------------------------------------
    // This can be overridden to recieve the videoData
    //-----------------------------------------------------------------
    virtual Error onVideo(const AVI_ACTION action, Text &mimeType,
                          const std::vector<uint8_t> &binaryData) noexcept {
        LOG(Parse, "Signalling Video Data");
        return {};
    };

    //-----------------------------------------------------------------
    // This can be overridden to recieve the metadata
    //-----------------------------------------------------------------
    virtual Error onMetadata(const Metadata &metadata) noexcept {
        LOG(ExtractedMetadata, "Extracted metadata from {}:\n", this, metadata);
        return {};
    }

    //-----------------------------------------------------------------
    // This can be overridden to recieve a completion notification
    //-----------------------------------------------------------------
    virtual Error onDocumentComplete() noexcept {
        LOG(Parse, "Completed parsing parse document");
        return {};
    }

    //-----------------------------------------------------------------
    // Override to provide cancel support
    //-----------------------------------------------------------------
    virtual bool cancelled() const noexcept { return false; }
};

//---------------------------------------------------------------------
///	@details
///		This structure is built and returned after querying
//		method interfaces specific to the given jni
//---------------------------------------------------------------------
class TikaApi final {
public:
    TikaApi(const java::Jni &jni) noexcept(false) : m_jni(jni) {
        m_class = jni.getClass("com/rocketride/tika_api/TikaApi");
        m_initMethodId = jni.getStaticMethodId(m_class, "init", "()V");
        m_deinitMethodId = jni.getStaticMethodId(m_class, "deinit", "()V");
        m_extractTextFromPathMethodId = jni.getStaticMethodId(
            m_class, "extractTextFromPath", "(Ljava/lang/String;JJ)Z");
        m_extractTextFromStreamMethodId = jni.getStaticMethodId(
            m_class, "extractTextFromStream",
            "(Ljava/io/InputStream;Ljava/lang/String;JJJ)Z");
        m_rootPathFieldId =
            jni.getStaticFieldId(m_class, "rootPath", "Ljava/lang/String;");
        m_enableMarkupFieldId =
            jni.getStaticFieldId(m_class, "enableMarkup", "Z");
    }

    java::Jni m_jni;
    jclass m_class;
    jmethodID m_initMethodId;
    jmethodID m_deinitMethodId;
    jmethodID m_extractTextFromPathMethodId;
    jmethodID m_extractTextFromStreamMethodId;
    jfieldID m_rootPathFieldId;
    jfieldID m_enableMarkupFieldId;
};

//-------------------------------------------------------------------------
/// @details
///		This class is strictly a static interface to generate methods
///		and call methods specific to a jni
//-------------------------------------------------------------------------
class TikaInstance final {
public:
    //-----------------------------------------------------------------
    ///	@details
    ///		Call the class init to initialize our tika
    //-----------------------------------------------------------------
    Error begin(IServiceConfig &config) noexcept;
    Error extractTextFromBuffer(const file::Path &path, IBuffer &buffer,
                                long flags, TikaContext &ctx) noexcept;
    Error end() noexcept;

    [[deprecated]]
    Error extractTextFromPath(const file::Path &path, long flags,
                              TikaContext &ctx) noexcept;

private:
    //-----------------------------------------------------------------
    ///	@details
    ///		Call the class init to initialize our tika
    //-----------------------------------------------------------------
    TikaApi getMethods() {
        // Get the interface
        GET_JAVA_JNI_THROW(jni);

        // Init tika
        return _mv(TikaApi(jni));
    }
};

//-------------------------------------------------------------------------
/// @details
///		Defines a class to interact with Tika
//-------------------------------------------------------------------------
class TikaGlobal final {
public:
    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::Parse;

    //-----------------------------------------------------------------
    // Public API
    //-----------------------------------------------------------------
    Error begin(IServiceConfig &config) noexcept;
    Error end() noexcept;

private:
    //-----------------------------------------------------------------
    // Statics
    //-----------------------------------------------------------------
    static bool onTextOrTableExtracted(JNIEnv *env, jclass clazz,
                                       jlong userData, jcharArray text,
                                       jint offset, jint length,
                                       jboolean isFinal, jlong memoryUsed,
                                       jboolean isTable) noexcept;
    static bool onTextExtracted(JNIEnv *env, jclass clazz, jlong userData,
                                jcharArray text, jint offset, jint length,
                                jboolean isFinal, jlong memoryUsed) noexcept;
    static bool onTableExtracted(JNIEnv *env, jclass clazz, jlong userData,
                                 jcharArray text, jint offset, jint length,
                                 jboolean isFinal, jlong memoryUsed) noexcept;
    static void onMetadataExtracted(JNIEnv *env, TikaContext *ctx,
                                    jobjectArray propertyNames,
                                    jobjectArray propertyValues) noexcept;
    static void onDocumentParsed(JNIEnv *env, jclass clazz, jlong userData,
                                 jobjectArray metadataPropertyNames,
                                 jobjectArray metadataPropertyValues,
                                 jlong memoryUsed) noexcept;
    static jint onReadFromInputStream(JNIEnv *env, jclass clazz, jlong userData,
                                      jlong offset, jbyteArray buffer,
                                      jint length) noexcept;
    static void registerTikaCallbacks() noexcept(false);
    static jboolean onWriteMediaBuffer(JNIEnv *env, jclass clazz,
                                       jlong nativeHandle, jint action,
                                       jstring jMimeType,
                                       jbyteArray jBuffer) noexcept;
};
}  // namespace engine::store::filter::parse::Tika
