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

#include <classify_api.h>

namespace engine::store::filter::classifyLoader {

using namespace ap;

/**
 * @brief Singleton that loads and manages the classification DLL
 *
 * Thread Safety:
 *   - init() should be called once from main thread before any other calls
 *   - After initialization, api() is safe to call from any thread
 */
class ClassifyDllLoader : public Singleton<ClassifyDllLoader> {
public:
    _const auto LogLevel = Lvl::Classify;

    /**
     * @brief Load the classification DLL and bind to its API
     * @return Error if loading or binding fails
     *
     * @note This must be called successfully before using any API functions.
     * @note If this fails, execution should be halted - classification cannot
     * proceed.
     */
    Error init() noexcept;

    /**
     * @brief Check if the DLL is loaded
     */
    bool isLoaded() const noexcept { return m_api != nullptr; }

    /**
     * @brief Get the classification API
     * @return Pointer to API table, or nullptr if not loaded
     */
    const ClassifyApi* api() const noexcept { return m_api; }

    /**
     * @brief Get the DLL library path
     */
    TextView dllPath() const noexcept { return m_dllPath; }

    /**
     * @brief Get the last error message from the DLL (thread-local)
     * @note Use this for engine-level errors (before session exists)
     */
    Text getLastError() const noexcept;

private:
    const ClassifyApi* m_api = nullptr;
    Text m_dllPath;
};

/**
 * @brief Convenience accessor for the DLL loader
 */
inline ClassifyDllLoader& classifyDll() noexcept {
    return ClassifyDllLoader::get();
}

/**
 * @brief Convenience accessor for the classification API
 */
inline const ClassifyApi* classifyApi() noexcept {
    return ClassifyDllLoader::get().api();
}

}  // namespace engine::store::filter::classifyLoader
