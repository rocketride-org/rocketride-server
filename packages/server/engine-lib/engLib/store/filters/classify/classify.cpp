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

#include "./classify.hpp"

namespace engine::store::filter::classify {

// =============================================================================
// IFilterGlobal Implementation
// =============================================================================

Error IFilterGlobal::beginFilterGlobal() noexcept {
    LOGT("beginFilterGlobal: Initializing classification engine via DLL");

    // Load the DLL if not already loaded
    if (auto err = classifyLoader::classifyDll().init()) {
        LOG(Always, "CRITICAL: Classification DLL load failed", err);
        return err;
    }

    auto *api = classifyLoader::classifyApi();
    if (!api) {
        return APERRT(Ec::InvalidState, "Classification API not available");
    }

    // Read configuration flags from task config
    const json::Value &taskConfig = endpoint->config.taskConfig;
    if (taskConfig.isMember("classify")) {
        const json::Value &classifyConfig = taskConfig["classify"];
        if (classifyConfig.isMember("wantsContext"))
            m_wantsContext = classifyConfig["wantsContext"].asBool();
        if (classifyConfig.isMember("wantsText"))
            m_wantsText = classifyConfig["wantsText"].asBool();
        if (classifyConfig.isMember("wantsPolicies"))
            m_wantsPolicies = classifyConfig["wantsPolicies"].asBool();
    }

    // Build flags
    uint32_t flags = CLASSIFY_FLAG_NONE;
    if (m_wantsContext) flags |= CLASSIFY_FLAG_WANT_CONTEXT;
    if (m_wantsText) flags |= CLASSIFY_FLAG_WANT_TEXT;
    if (m_wantsPolicies) flags |= CLASSIFY_FLAG_WANT_POLICIES;
    if (m_openMode == OPEN_MODE::PIPELINE) flags |= CLASSIFY_FLAG_PIPELINE_MODE;

    // Convert configuration to JSON string
    Text configJson = taskConfig.stringify();

    // Create the engine (pass execDir and cachePath separately - DLL can't
    // access host's config/application)
    auto result = api->engine_create(
        configJson.c_str(), flags, Text{application::execDir()}.data(),
        Text{config::paths().cache}.data(), &m_engine);
    if (result != CLASSIFY_OK) {
        Text errorMsg = classifyLoader::classifyDll().getLastError();
        return APERRT(Ec::Classify, "Failed to create classification engine",
                      result, errorMsg);
    }

    LOGT("Classification engine created successfully");
    return {};
}

Error IFilterGlobal::endFilterGlobal() noexcept {
    LOGT("endFilterGlobal: Destroying classification engine");

    if (m_engine && classifyLoader::classifyApi()) {
        auto result = classifyLoader::classifyApi()->engine_destroy(m_engine);
        if (result != CLASSIFY_OK) {
            LOG(Always, "Warning: Failed to destroy classification engine",
                result);
        }
        m_engine = nullptr;
    }

    return {};
}

// =============================================================================
// IFilterInstance Implementation
// =============================================================================

IFilterInstance::IFilterInstance(const FactoryArgs &args) noexcept
    : Parent(args), m_global(static_cast<IFilterGlobal &>(*args.global)) {}

IFilterInstance::~IFilterInstance() { resetSession(); }

Error IFilterInstance::resetSession() noexcept {
    if (m_session && m_global.api()) {
        m_global.api()->session_destroy(m_session);
        m_session = nullptr;
    }
    m_utf8Buffer.clear();
    m_normalizedBuffer.clear();
    m_resultBuffer.clear();
    return {};
}

Text IFilterInstance::getSessionError() const noexcept {
    auto *api = m_global.api();
    if (!api || !m_session) return "Session or API not available";

    const char *error = api->session_get_last_error(m_session);
    return error ? Text{error} : Text{};
}

Error IFilterInstance::beginFilterInstance() noexcept {
    LOGT("beginFilterInstance");

    auto *api = m_global.api();
    if (!api) {
        return APERRT(Ec::InvalidState, "Classification API not available");
    }

    // Create session
    auto result = api->session_create(m_global.engineHandle(), &m_session);
    if (result != CLASSIFY_OK) {
        Text errorMsg = classifyLoader::classifyDll().getLastError();
        return APERRT(Ec::Classify, "Failed to create classification session",
                      result, errorMsg);
    }

    // Create normalizer - NFKC mode
    auto normalizerResult =
        string::icu::getNormalizer(string::icu::NormalizationForm::NFKC);
    if (!normalizerResult) {
        return APERRT(Ec::Icu, "Failed to create NFKC normalizer");
    }
    m_normalizer = *normalizerResult;

    // Pre-allocate result buffer
    m_resultBuffer.resize(64_kb);

    return {};
}

Error IFilterInstance::open(Entry &object) noexcept {
    LOGT("open:", object.path());

    // Call parent to set currentEntry
    if (auto err = Parent::open(object)) return err;

    auto *api = m_global.api();
    if (!api || !m_session) {
        return APERRT(Ec::InvalidState, "Session not initialized");
    }

    // Begin document - metadata can be added here if needed
    json::Value metadata(json::objectValue);
    metadata["path"] = object.path();
    Text metadataJson = metadata.stringify();

    auto result = api->session_begin(m_session, metadataJson.c_str());
    if (result != CLASSIFY_OK) {
        return APERRT(Ec::Classify, "Failed to begin document classification",
                      result, getSessionError());
    }

    return {};
}

Error IFilterInstance::writeText(const Utf16View &text) noexcept {
    auto *api = m_global.api();
    if (!api || !m_session) {
        return APERRT(Ec::InvalidState, "Session not initialized");
    }

    if (text.empty()) return {};

    // Normalize to NFKC
    if (!m_normalizer) {
        return APERRT(Ec::InvalidState, "Normalizer not initialized");
    }

    // Check if already normalized - most text will be
    if (m_normalizer->isNormalized(text)) {
        // Convert to UTF-8 directly
        m_utf8Buffer.clear();
        __transform(text, m_utf8Buffer);
    } else {
        // Normalize first
        auto normalizeResult = m_normalizer->normalize(text);
        if (!normalizeResult) {
            // On failure, use the text as-is
            m_utf8Buffer.clear();
            __transform(text, m_utf8Buffer);
        } else {
            // Convert normalized text to UTF-8
            m_utf8Buffer.clear();
            __transform(Utf16View{*normalizeResult}, m_utf8Buffer);
        }
    }

    // Push data to the engine
    auto result = api->session_push_data(m_session, m_utf8Buffer.c_str(),
                                         m_utf8Buffer.size());
    if (result != CLASSIFY_OK) {
        auto errorMsg = getSessionError();
        LOGT("Push data warning:", result, errorMsg);
        // Set completion code on entry (like original implementation did)
        if (currentEntry)
            currentEntry->completionCode(
                APERRT(Ec::Classify, "Classification push data failed", result,
                       errorMsg));
        // Continue processing despite the error
    }

    return {};
}

Error IFilterInstance::writeTable(const Utf16View &text) noexcept {
    // Tables are treated like regular text
    return writeText(text);
}

Error IFilterInstance::closing() noexcept {
    LOGT("closing");

    auto *api = m_global.api();
    if (!api || !m_session) {
        return APERRT(Ec::InvalidState, "Session not initialized");
    }

    // Evaluate and get results
    size_t resultLen = m_resultBuffer.size();
    auto result =
        api->session_evaluate(m_session, m_resultBuffer.data(), &resultLen);

    // Handle buffer too small - retry with larger buffer
    while (result == CLASSIFY_ERR_BUFFER_TOO_SMALL) {
        LOGT("Resizing result buffer to", resultLen + 10_kb);
        m_resultBuffer.resize(resultLen + 10_kb);
        resultLen = m_resultBuffer.size();
        result =
            api->session_evaluate(m_session, m_resultBuffer.data(), &resultLen);
    }

    if (result != CLASSIFY_OK) {
        return APERRT(Ec::Classify, "Failed to evaluate classification", result,
                      getSessionError());
    }

    // Parse results JSON - construct TextView from raw buffer data and length
    TextView jsonView(m_resultBuffer.data(), resultLen);
    auto resultsOr = json::parse(jsonView);
    if (!resultsOr) {
        return APERRT(Ec::InvalidJson,
                      "Failed to parse classification results");
    }

    // Store results in the current entry's classifications
    if (currentEntry) {
        currentEntry->classifications(*resultsOr);
    }

    // End the document
    result = api->session_end(m_session);
    if (result != CLASSIFY_OK) {
        LOGT("Warning: Failed to end document classification", result,
             getSessionError());
    }

    return {};
}

Error IFilterInstance::endFilterInstance() noexcept {
    LOGT("endFilterInstance");
    return resetSession();
}

}  // namespace engine::store::filter::classify
