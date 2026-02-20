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
namespace {
//-----------------------------------------------------------------
/// @details
///		Flag to indicate we have already initialized the tika
///		side of the engine
//-----------------------------------------------------------------
bool bInitialized = false;
}  // namespace

//-----------------------------------------------------------------
/// @details
///		This function will initialize the global java environment
///		for use with Tika
//-----------------------------------------------------------------
Error TikaGlobal::begin(IServiceConfig &config) noexcept {
    // Define the guarded function
    const auto _begin = localfcn()->Error {
        // If we have already initialized, then done
        if (bInitialized) return {};

        // Initialize the java engine
        if (auto ccode = java::init()) return ccode;

        // Setup a reference to our jni interface
        GET_JAVA_JNI(jni);

        // Get the bound methods
        auto methods = TikaApi(jni);

        // Get the path to tika-config.xml
        auto rootPath = java::rootDir();

        // Register native callbacks and initialize the API
        LOGT("Initializing indexing engine...");

        // Register the callbacks with the jvm
        registerTikaCallbacks();

        // Set the config path
        methods.m_jni.setStaticField(methods.m_class, methods.m_rootPathFieldId,
                                     _ts(rootPath.plat(false)));

        // And init it
        methods.m_jni.invokeStaticMethod(methods.m_class,
                                         methods.m_initMethodId);

        // De-initialize Tika API on JVM destruction
        java::addDeinitCallback([](java::Jni &jni) noexcept(false) {
            // If this is not called, the JVM will hang on deinit due to
            // scheduled tasks on the Java side
            LOG(Parse, "De-initializing parsing engine");

            // Get the bound methods
            auto methods = TikaApi(jni);

            // And deinit it
            jni.invokeStaticMethod(methods.m_class, methods.m_deinitMethodId);
        });

        // Say we have initialized
        bInitialized = true;
        return {};
    };

    // Call it
    if (auto ccode = _callChk(_begin)) {
        // Say we did it
        LOGT("Failed to initialize the parsing engine");
        return ccode;
    } else {
        // Say we did it
        LOGT("Successfully initialized the parsing engine");
        return {};
    }
}

//-----------------------------------------------------------------
/// @details
///		This function will deinit and unload the java engine
///	@returns
///		Error
//-----------------------------------------------------------------
Error TikaGlobal::end() noexcept {
    // We wil let the main deinit process handle scrapping the jvm
    return {};
}

}  // namespace engine::store::filter::parse::Tika
