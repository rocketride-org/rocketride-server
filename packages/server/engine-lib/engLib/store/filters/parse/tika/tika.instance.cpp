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

#include <engLib/eng.h>

namespace engine::store::filter::parse::Tika {
//-----------------------------------------------------------------
/// @details
///		Initialize the jni
///	@returns
///		Error
//-----------------------------------------------------------------
Error TikaInstance::begin(IServiceConfig &config) noexcept { return {}; }

//-----------------------------------------------------------------
/// @details
///		Render the text from a file. Typically this will be a
///		temp file
///	@param[in]	jni
///		Handle to the jni
///	@param[in] path
///		The path to render
/// @param[in] flags
///		Flags to pass to tika api
///			Bit 0 - 0x01 = Enable OCR
///			Bit 1 - 0x02 = Enable Magick Image enhancement
///	@param[in] ctx
///		The context
///	@returns
///		Error
//-----------------------------------------------------------------
[[deprecated]]
Error TikaInstance::extractTextFromPath(const file::Path &path, long flags,
                                        TikaContext &ctx) noexcept {
    // Get the API methods
    auto methods = getMethods();

    // Define this so we catch exceptions and can set breakpoints
    const auto _extract = localfcn()->Error {
        // Setup
        auto userData = _reCast<jlong>(&ctx);
        auto javaPath = methods.m_jni.createString(path.plat(false));

        // Call it
        if (!methods.m_jni.invokeStaticMethod<jboolean>(
                methods.m_class, methods.m_extractTextFromPathMethodId,
                javaPath, flags, userData))
            return APERR(Ec::Failed, "Failed to parse");
        return {};
    };

    // Create a local reference frame here so that any objects
    // subsequently created in the JVM are cleaned up at scope exit
    auto localFrameGuard = *methods.m_jni.pushLocalFrame();

    // Prevent exceptions here
    return _callChk(_extract);
}

//-----------------------------------------------------------------
/// @details
///		Render the text from a buffer. This is used when the entire
///		input stream can fit in a segment size buffer
///	@param[in]	jni
///		Handle to the jni
///	@param[in] path
///		The path to render
///	@param[in] pBuffer
///		Ptr to the buffer
///	@param[in] size
///		Size of data in the buffer
/// @param[in] flags
///		Flags to pass to tika api
///			Bit 0 - 0x01 = Enable OCR
///			Bit 1 - 0x02 = Enable Magick Image enhancement
///	@param[in] ctx
///		The context
///	@returns
///		Error
//-----------------------------------------------------------------
Error TikaInstance::extractTextFromBuffer(const file::Path &path,
                                          IBuffer &buffer, long flags,
                                          TikaContext &ctx) noexcept {
    // Get the API methods
    auto methods = getMethods();

    // Define this so we catch exceptions and can set breakpoints
    const auto _extract = localfcn()->Error {
        // Get the size of the data
        auto size = buffer.size();

        // Create a java stream object out of that
        auto javaStream = TikaStream(buffer, methods.m_jni);

        // Setup
        auto userData = _reCast<jlong>(&ctx);
        auto javaPath = methods.m_jni.createString(path.plat(false));

        // And invoke it
        LOG(Parse, "extractTextFromStream", path.fileName(), size, "...");
        if (!methods.m_jni.invokeStaticMethod<jboolean>(
                methods.m_class, methods.m_extractTextFromStreamMethodId,
                javaStream.stream(), javaPath, (long)size, flags, userData))
            return APERR(Ec::Failed, "Failed to parse");
        LOG(Parse, "extractTextFromStream", path.fileName(), size, "done");
        return {};
    };

    // Create a local reference frame here so that any objects subsequently
    // created in the JVM are cleaned up at scope exit
    Error ccode;
    auto localFrameGuard = *methods.m_jni.pushLocalFrame();

    // Append to the parsing context
    if (ccode = ctx.onDocumentBegin()) return ccode;

    // Prevent exceptions here
    ccode = _callChk(_extract);

    // If we had an error, then don't signal doc complete
    // if (!ccode)
    //  ccode = ctx.onDocumentComplete();

    // ^^^ gushinets
    // See https://rocketride.atlassian.net/browse/APPLAT-2911
    // because of this logics we don`t release locked mutex in
    // indexer.instance.cpp and leave shared lock there for a long time trying
    // to release it in IFilterInstance::endFilterInstance() but at that time
    // the handle under the mutex is invalid already so we get exception
    // 0xc0000264 - The application attempted to release a resource it did not
    // own (excetion reproducible in release build only) This issue is fully
    // about the correct order of objects destruction but we don`t have engough
    // time to get fix this properly before 2.0 GA so changing the logics here
    // to signal document complete even if there were any errors from
    // Tika/Tesseract
    ccode = ctx.onDocumentComplete() || ccode;

    return ccode;
};

//-----------------------------------------------------------------
/// @details
///		Deinitialize the jni
//-----------------------------------------------------------------
Error TikaInstance::end() noexcept { return {}; }
}  // namespace engine::store::filter::parse::Tika
