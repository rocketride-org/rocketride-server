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

#include <engLib/eng.h>

namespace engine::store::filter::parse::Tika {
//---------------------------------------------------------------------
/// @details
///		This function is called by tika when something has been
///     parsed
///	@param[in]	env
///     The java source environment
///	@param[in]	userData
///		Actually, a pointer to the TikaContext
///	@param[in]	text
///		The text buffer being signalled
///	@param[in]	offset
///		Offset within the text buffer to signal
///	@param[in]	length
///		The length of text to signal
///	@param[in]	isFinal
///		Is it done?
///	@param[in]	memoryUsed
///		The amount of memory used during parsing
/// @param[in]  isTable
///     true if we are processing a table, false if normal tex
///	@returns	bool
///		true = continue/false = stop
//---------------------------------------------------------------------
bool TikaGlobal::onTextOrTableExtracted(JNIEnv *env, jclass clazz,
                                        jlong userData, jcharArray text,
                                        jint offset, jint length,
                                        jboolean isFinal, jlong memoryUsed,
                                        jboolean isTable) noexcept {
    // Validate parameters
    ASSERT_MSG(env && userData && offset >= 0 && length >= 0,
               "onTextExtracted callback invoked with invalid parameters",
               offset, length);
    [[maybe_unused]] const auto textLength = env->GetArrayLength(text);
    ASSERT_MSG(offset + length <= textLength,
               "onTextExtracted callback invoked with invalid text dimensions",
               offset, length, textLength);

    // Check for empty text
    if (!length) return true;

    // Convert the user data to our parse context
    auto ctx = _reCast<TikaContext *>(userData);

    // Access Java character array
    jchar *javaChars = env->GetCharArrayElements(text, nullptr);
    ASSERT_MSG(javaChars, "Failed to extract Java character array");

    // Clean up the Java character array without copying any changes back
    auto javaCharsCleanup = util::Guard(
        [&] { env->ReleaseCharArrayElements(text, javaChars, JNI_ABORT); });

    // Convert Java character array to our UTF-16 view and log it
    const Utf16View utf16(javaChars + offset, _cast<size_t>(length));

    // Dump it out if needed
    if (::ap::log::isLevelEnabled<false>(Lvl::ExtractedText)) {
        Text line;

        // Output it
        for (auto row = 0; row < utf16.length(); row += 16) {
            line = "";
            string::formatBuffer(line, "{,X`,6}: ", row);

            Text buff;
            for (auto col = 0; col < 16; col++) {
                if (row + col >= utf16.length())
                    string::formatBuffer(buff, "     ");
                else
                    string::formatBuffer(buff, "{,X`,4} ", utf16[row + col]);
                line += buff;
            }

            line += "  ";

            for (auto col = 0; col < 16; col++) {
                if (row + col >= utf16.length()) {
                    line += ' ';
                } else {
                    auto utf16chr = utf16[row + col];
                    if (utf16chr < 32 || utf16chr > 127) {
                        line += '.';
                    } else {
                        TextChr textChr = (TextChr)utf16chr;
                        line += textChr;
                    }
                }
            }

            LOG(ExtractedText, "{}", line);
        }
    }

    // Append to the parsing context
    if (isTable)
        ctx->onTable(utf16);
    else
        ctx->onText(utf16);

    // Update the JVM heap usage
    log::options().additionalMemoryUsed = memoryUsed;

    // Returning false aborts the parse
    return !ctx->cancelled();
}
//---------------------------------------------------------------------
/// @details
///		This function is called by tika to deliver text
///     parsed
///	@param[in]	env
///     The java source environment
///	@param[in]	userData
///		Actually, a pointer to the TikaContext
///	@param[in]	text
///		The text buffer being signalled
///	@param[in]	offset
///		Offset within the text buffer to signal
///	@param[in]	length
///		The length of text to signal
///	@param[in]	isFinal
///		Is it done?
///	@param[in]	memoryUsed
///		The amount of memory used during parsing
///	@returns	bool
///		true = continue/false = stop
//---------------------------------------------------------------------
bool TikaGlobal::onTextExtracted(JNIEnv *env, jclass clazz, jlong userData,
                                 jcharArray text, jint offset, jint length,
                                 jboolean isFinal, jlong memoryUsed) noexcept {
    return onTextOrTableExtracted(env, clazz, userData, text, offset, length,
                                  isFinal, memoryUsed, false);
}

//---------------------------------------------------------------------
/// @details
///		This function is called by tika to deliver a table
///	@param[in]	env
///     The java source environment
///	@param[in]	userData
///		Actually, a pointer to the TikaContext
///	@param[in]	text
///		The text buffer being signalled
///	@param[in]	offset
///		Offset within the text buffer to signal
///	@param[in]	length
///		The length of text to signal
///	@param[in]	isFinal
///		Is it done?
///	@param[in]	memoryUsed
///		The amount of memory used during parsing
///	@returns	bool
///		true = continue/false = stop
//---------------------------------------------------------------------
bool TikaGlobal::onTableExtracted(JNIEnv *env, jclass clazz, jlong userData,
                                  jcharArray text, jint offset, jint length,
                                  jboolean isFinal, jlong memoryUsed) noexcept {
    return onTextOrTableExtracted(env, clazz, userData, text, offset, length,
                                  isFinal, memoryUsed, true);
}

//---------------------------------------------------------------------
/// @details
///		This function is called at the end of the document to
///		signal the metadata - this is called by end of document
///	@param[in]	env
///     The java source environment
///	@param[in]	ctx
///		Pointer to the TikaContext
///	@param[in]	propertyNames
///		Array of property names of the metadata
///	@param[in]	propertyValues
///		Array of values for the property
///	@returns	bool
///		true = continue/false = stop
//---------------------------------------------------------------------
void TikaGlobal::onMetadataExtracted(JNIEnv *env, TikaContext *ctx,
                                     jobjectArray propertyNames,
                                     jobjectArray propertyValues) noexcept {
    java::Jni jni(env);

    try {
        // Maps are not JNI types, so we get the metadata as an array of
        // property names and an array of property values
        const auto nameCount = jni.getArrayLength(propertyNames);
        [[maybe_unused]] const auto valueCount =
            jni.getArrayLength(propertyValues);
        ASSERT_MSG(nameCount == valueCount,
                   "onDocumentParsed callback invoked with differing numbers "
                   "of property names and values",
                   nameCount, valueCount);

        // Add the names and values to the document metadata
        Metadata metadata;
        for (size_t i = 0; i < nameCount; i++) {
            Text name = jni.getObjectArrayElement<Text>(propertyNames, i);
            Text value = jni.getObjectArrayElement<Text>(propertyValues, i);
            if (!name || !value) {
                LOG(Java, "Extracted metadata contained invalid property", name,
                    value);
                continue;
            }

            // Log Tika parsing exceptions stored in the metadata and remove
            // them so they're not indexed
            if (name.equals("X-TIKA:EXCEPTION:embedded_exception")) {
                LOG(Parse,
                    "Tika encountered an exception while parsing this embedded "
                    "document:\n",
                    value);
                continue;
            }
            if (name.equals("X-TIKA:EXCEPTION:embedded_resource_limit_reached"))
                LOG(Parse,
                    "Tika stopped parsing text from this document because the "
                    "maximum number of embedded resources was reached");
            if (name.equals("X-TIKA:EXCEPTION:embedded_stream_exception"))
                LOG(Parse,
                    "Tika encountered a exception while reading from an "
                    "embedded stream:\n",
                    value);
            if (name.equals("X-TIKA:EXCEPTION:runtime"))
                LOG(Parse,
                    "Tika encountered an exception while parsing this "
                    "container:\n",
                    value);
            if (name.equals("X-TIKA:EXCEPTION:warn"))
                LOG(Parse,
                    "Tika encountered a non-fatal exception while parsing this "
                    "document:\n",
                    value);
            if (name.equals("X-TIKA:EXCEPTION:write_limit_reached"))
                LOG(Parse,
                    "Tika stopped parsing text from this document because the "
                    "maximum amount of text was reached");
            metadata.set(_mv(name), _mv(value));
        }
        // Set the metadata, even if it's empty
        ctx->onMetadata(metadata);
    } catch (const std::exception &e) {
        LOG(Java, "Failure processing extracted metadata", e);
    }
}

//---------------------------------------------------------------------
/// @details
///		This function is called by Tika at the end of the
///		document to signal it is done
///	@param[in]	env
///     The java source environment
///	@param[in]	clazz
///		The source class - not really used
///	@param[in]	userData
///		Actually, a pointer to the TikaContext
///	@param[in]	propertyNames
///		Array of property names of the metadata
///	@param[in]	propertyValues
///		Array of values for the property
///	@param[in]	memoryUsed
///		The amount of memory used during parsing
//---------------------------------------------------------------------
void TikaGlobal::onDocumentParsed(JNIEnv *env, jclass clazz, jlong userData,
                                  jobjectArray metadataPropertyNames,
                                  jobjectArray metadataPropertyValues,
                                  jlong memoryUsed) noexcept {
    // Validate parameters
    ASSERT_MSG(env && userData,
               "onDocumentParsed callback invoked with invalid parameters");
    java::Jni jni(env);

    // Convert the user data to our parse context
    auto ctx = _reCast<TikaContext *>(userData);

    // Save the extracted metadata
    if (metadataPropertyNames && metadataPropertyValues)
        onMetadataExtracted(env, ctx, metadataPropertyNames,
                            metadataPropertyValues);

    // Update the JVM heap usage
    log::options().additionalMemoryUsed = memoryUsed;
}

//---------------------------------------------------------------------
/// @details
///		This function is called by Tika when it needs more data from
///		the memory stream
///	@param[in]	env
///     The java source environment
///	@param[in]	clazz
///		The source class - not really used
///	@param[in]	userData
///		Actually, a pointer to the TikaMemoryStream
///	@param[in]	offset
///		Offset of the stream to read
///	@param[in]	buffer
///		Where to read the data into
///	@param[in]	length
///		Length to read
/// @returns
///		The number of bytes read
//---------------------------------------------------------------------
jint TikaGlobal::onReadFromInputStream(JNIEnv *env, jclass clazz,
                                       jlong userData, jlong offset,
                                       jbyteArray buffer,
                                       jint length) noexcept {
    // Validate parameters
    ASSERT_MSG(
        env && userData,
        "onReadFromInputStream callback invoked with invalid parameters");

    // Check for empty read
    if (!length) return 0;

    // Convert the user data to our parse context
    auto pStream = _reCast<TikaStream *>(userData);

    // Since overflow file was removed for TIKA (APPLAT-3930), reading and
    // processing data with TIKA began to work concurrently, there became many
    // more system calls between
    // GetPrimitiveArrayCritical/ReleasePrimitiveArrayCritical, and it started
    // taking much longer, espacially in case of the remote sources, and a
    // global lock started to happen (APPLAT-4309). So, the solution is using
    // GetByteArrayElements/ReleaseByteArrayElements instead, which could be
    // less productive, but which are safe.
    //
    // // Access Java array directly (may cause a global lock within Java-- work
    // fast) void *javaBytes = env->GetPrimitiveArrayCritical(buffer, nullptr);

    // Get the native copy of Java array
    auto javaBytes = env->GetByteArrayElements(buffer, nullptr);
    ASSERTD_MSG(javaBytes, "GetByteArrayElements failed");

    // Setup a data view of the java stream buffer
    auto dataView = OutputData(_cast<void *>(javaBytes), length);

    // Read the data into it
    auto res = pStream->read(offset, dataView);

    // Determine if error, or get the size read
    size_t sizeRead = 0;
    if (res.hasCcode()) {
        LOG(Parse, "Error reading tika stream", res.ccode());
        sizeRead = 0;
    } else {
        sizeRead = *res;
    }

    // Commit the native data to the Java array and release the native buffer
    env->ReleaseByteArrayElements(buffer, javaBytes, 0);
    return _nc<jint>(sizeRead);
}

//---------------------------------------------------------------------
/// @details
///		Register the above native callbacks
///	@param[in]	jvm
///     The jvm to register with
//---------------------------------------------------------------------
void TikaGlobal::registerTikaCallbacks() noexcept(false) {
    // Register native callbacks
    JNINativeMethod nativeMethodTable[] = {
        {_constCast<char *>("onTextExtractedCallback"),
         _constCast<char *>("(J[CIIZJ)Z"), _reCast<void *>(&onTextExtracted)},
        {_constCast<char *>("onTableExtractedCallback"),
         _constCast<char *>("(J[CIIZJ)Z"), _reCast<void *>(&onTableExtracted)},
        {_constCast<char *>("onDocumentParsedCallback"),
         _constCast<char *>("(J[Ljava/lang/Object;[Ljava/lang/Object;J)V"),
         _reCast<void *>(&onDocumentParsed)},
        {_constCast<char *>("onReadFromInputStream"),
         _constCast<char *>("(JJ[BI)I"),
         _reCast<void *>(&onReadFromInputStream)},
        {_constCast<char *>("onWriteMediaBufferCallback"),
         _constCast<char *>("(JILjava/lang/String;[B)Z"),
         _reCast<void *>(&onWriteMediaBuffer)}};

    engine::java::registerNativeCallbacks("com/rocketride/tika_api/TikaApi",
                                          nativeMethodTable,
                                          std::size(nativeMethodTable));
}

//=========================================================================
// JNI Callback for Streaming Media Buffers (Image, Audio, Video)
//=========================================================================
/**
 * Called from the Java layer during media stream processing via InputStream.
 * This JNI callback handles the transfer of media data chunks from Java
 * to the native C++ layer for different media types (image, audio, video).
 *
 * The stream is sent in three phases, represented by AVI_ACTION values:
 *   AVI_ACTION = 0 → Begin of media stream (initial signal).
 *   AVI_ACTION = 1 → Streaming chunk (typically 1MB blocks of binary data).
 *   AVI_ACTION = 2 → End of media stream (final signal).
 *
 * Parameters:
 * - env:           JNI environment pointer.
 * - clazz:         Calling Java class.
 * - nativeHandle:  Pointer to the native TikaContext object.
 * - action:        The streaming action (BEGIN, WRITE, END).
 * - jMimeType:     MIME type of the media (e.g., image/png, audio/mpeg).
 * - jBuffer:       Raw binary data for the current chunk (may be empty for
 * BEGIN/END).
 *
 * This function will dispatch the media buffer to the appropriate
 * native pipeline (onImage / onAudio / onVideo) depending on the MIME type.
 */

jboolean TikaGlobal::onWriteMediaBuffer(JNIEnv *env, jclass clazz,
                                        jlong nativeHandle, jint action,
                                        jstring jMimeType,
                                        jbyteArray jBuffer) noexcept {
    // Convert the user data to our parse context
    auto ctx = _reCast<TikaContext *>(nativeHandle);

    if (!ctx) {
        LOG(Java, "TikaContext pointer is NULL");
        return JNI_FALSE;
    }

    const char *mimeChars = env->GetStringUTFChars(jMimeType, nullptr);
    if (!mimeChars) {
        return JNI_FALSE;
    }
    Text mimeType(mimeChars);
    env->ReleaseStringUTFChars(jMimeType, mimeChars);

    jsize bufferLength = env->GetArrayLength(jBuffer);
    std::vector<uint8_t> binaryData;

    // If bufferLength is zero, binaryData remains empty (as expected for
    // BEGIN/END signals).
    if (bufferLength > 0) {
        // Get a pointer to the byte array elements.
        jbyte *bufferData = env->GetByteArrayElements(jBuffer, nullptr);
        ASSERTD_MSG(bufferData, "GetByteArrayElements failed");
        if (!bufferData) return JNI_FALSE;

        binaryData.assign(_reCast<uint8_t *>(bufferData),
                          _reCast<uint8_t *>(bufferData) + bufferLength);

        // Release the array; using JNI_ABORT means we don't copy any modified
        // data back.
        env->ReleaseByteArrayElements(jBuffer, bufferData, JNI_ABORT);
    }

    // Convert the action to AVI_ACTION.
    AVI_ACTION aviAction = _cast<AVI_ACTION>(action);

    // Determine which onXXX() method to call based on the MIME type.
    Error ccode;
    if (mimeType.starts_with("image/")) {
        ccode = ctx->onImage(aviAction, mimeType, binaryData);
    } else if (mimeType.starts_with("audio/")) {
        ccode = ctx->onAudio(aviAction, mimeType, binaryData);
    } else if (mimeType.starts_with("video/")) {
        ccode = ctx->onVideo(aviAction, mimeType, binaryData);
    } else {
        LOG(Java, "Unsupported MIME type: %s", mimeType.c_str());
        return JNI_FALSE;
    }

    return JNI_TRUE;
}

}  // namespace engine::store::filter::parse::Tika
