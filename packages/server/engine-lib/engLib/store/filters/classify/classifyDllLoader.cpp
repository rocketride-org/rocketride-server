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

#include "./classifyDllLoader.hpp"

#include <filesystem>

#include <apLib/plat/api.hpp>

namespace engine::store::filter::classifyLoader {

// =============================================================================
// Logging Callback
// =============================================================================

/**
 * @brief Logging callback that routes DLL log messages to apLib logging
 *
 * This function is called by the classification DLL to log messages.
 * The DLL passes ap::Lvl values (cast to int), so we just cast back and log.
 */
static void CLASSIFY_CALL logCallback(int level, const char* message,
                                      const char* file, int line,
                                      const char* func, void* /*user_data*/
) {
    auto lvl = static_cast<Lvl>(level);
    auto loc = Location{file ? file : "", line, func ? func : ""};
    LOGL(lvl, loc, "[classify-dll]", message);
}

// =============================================================================
// ClassifyDllLoader Implementation
// =============================================================================

Error ClassifyDllLoader::init() noexcept {
    if (m_api) return {};  // Already loaded

    LOGT("Loading classification DLL");

    // Determine DLL path
    auto execDir = application::execDir();
#if ROCKETRIDE_PLAT_WIN
    file::Path dllPath = execDir / "classify.dll";
#elif ROCKETRIDE_PLAT_MAC
    file::Path dllPath = execDir / "libclassify.dylib";
#else
    file::Path dllPath = execDir / "libclassify.so";
#endif

    m_dllPath = dllPath.str();
    LOGT("Classification DLL path:", m_dllPath);

    try {
        // Use dynamicBind to load the library and get the entry point
        // dynamicBind<FnType> returns ErrorOr<FnType*> (pointer to function)
        // We need the function type (not pointer type), so use the underlying
        // signature
        using ClassifyGetApiFunc = const ClassifyApi* CLASSIFY_CALL(void);

        // Save and restore CWD around dynamicBind - the changeDir=true
        // parameter changes CWD but doesn't restore it, which can break Java
        // class loading
        auto savedCwd = std::filesystem::current_path();
        util::Guard cwdGuard{
            [savedCwd] { std::filesystem::current_path(savedCwd); }};

        auto getApiResult = plat::dynamicBind<ClassifyGetApiFunc>(
            dllPath, CLASSIFY_API_EXPORT_NAME, true);
        if (!getApiResult) {
            // Preserve the actual error from dynamicBind (contains Windows
            // error code)
            auto bindError = getApiResult.ccode();
            LOG(Always,
                "CRITICAL: Failed to bind classification DLL entry point",
                CLASSIFY_API_EXPORT_NAME, "Error:", bindError);
            return bindError;
        }

        // Dereference to get the function pointer, then call it
        auto getApiPtr = *getApiResult;
        m_api = getApiPtr();
        if (!m_api) {
            return APERRL(Always, Ec::InvalidState,
                          "CRITICAL: Classification DLL returned null API. "
                          "Execution cannot continue.");
        }

        // Validate API version
        if (m_api->version != CLASSIFY_API_VERSION) {
            return APERRL(
                Always, Ec::InvalidModule,
                "CRITICAL: Classification DLL API version mismatch. Expected:",
                CLASSIFY_API_VERSION, "Got:", m_api->version);
        }

        // Validate struct size
        if (m_api->struct_size != sizeof(ClassifyApi)) {
            return APERRL(Always, Ec::InvalidModule,
                          "CRITICAL: Classification DLL API struct size "
                          "mismatch. Expected:",
                          sizeof(ClassifyApi), "Got:", m_api->struct_size);
        }

        // Validate all required function pointers
        if (!m_api->engine_create || !m_api->engine_destroy ||
            !m_api->session_create || !m_api->session_destroy ||
            !m_api->session_begin || !m_api->session_push_data ||
            !m_api->session_evaluate || !m_api->session_end ||
            !m_api->get_last_error || !m_api->session_get_last_error ||
            !m_api->set_logger) {
            return APERRL(Always, Ec::InvalidState,
                          "CRITICAL: Classification DLL has null function "
                          "pointers. API table is invalid.");
        }

        // Set up logging callback to route DLL logs to apLib
        m_api->set_logger(logCallback, nullptr);
        LOGT("Classification DLL logging callback installed");

        LOG(Classify,
            "Classification DLL loaded successfully. Version:", m_api->version);
        return {};

    } catch (const Error& e) {
        // dynamicBind throws on failure - convert to error return
        LOG(Always, "CRITICAL: Failed to load classification DLL:", m_dllPath,
            e);
        return e;
    }
}

Text ClassifyDllLoader::getLastError() const noexcept {
    if (!m_api || !m_api->get_last_error) return "DLL not loaded";

    const char* error = m_api->get_last_error();
    return error ? Text{error} : Text{};
}

}  // namespace engine::store::filter::classifyLoader
