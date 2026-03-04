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

//-----------------------------------------------------------------------------
//
//	The classify filter encapsulates the functionality of
//	the external classification engine DLL (classify.dll)
//
//	This version uses the C ABI to communicate with the classification
//	engine, which is loaded as a separate DLL at runtime.
//
//-----------------------------------------------------------------------------
#pragma once

#include "./classifyDllLoader.hpp"

namespace engine::store::filter::classify {

class IFilterGlobal;
class IFilterInstance;

//-------------------------------------------------------------------------
// Filter type and log level
//-------------------------------------------------------------------------
_const auto Type = "classify"_itv;
_const auto Level = Lvl::ServiceClassify;

//-------------------------------------------------------------------------
/// @details
///		Global filter that manages the classification engine instance
//-------------------------------------------------------------------------
class IFilterGlobal : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    friend IFilterInstance;

    _const auto LogLevel = Level;
    _const auto Factory = Factory::makeFactory<IFilterGlobal, Parent>(Type);

    // Public API
    virtual Error beginFilterGlobal() noexcept override;
    virtual Error endFilterGlobal() noexcept override;

    // Accessors
    ClassifyEngineHandle engineHandle() const noexcept { return m_engine; }
    const ClassifyApi* api() const noexcept {
        return classifyLoader::classifyApi();
    }

    bool wantsContext() const noexcept { return m_wantsContext; }
    bool wantsText() const noexcept { return m_wantsText; }
    bool wantsPolicies() const noexcept { return m_wantsPolicies; }

    const std::vector<std::string>& getIncludePolicies() const noexcept {
        return m_includePolicies;
    }
    const std::vector<std::string>& getExcludePolicies() const noexcept {
        return m_excludePolicies;
    }

private:
    ClassifyEngineHandle m_engine = nullptr;

    bool m_wantsContext = false;
    bool m_wantsText = false;
    bool m_wantsPolicies = true;

    std::vector<std::string> m_includePolicies;
    std::vector<std::string> m_excludePolicies;
};

//-------------------------------------------------------------------------
/// @details
///		Instance filter that handles per-document classification
//-------------------------------------------------------------------------
class IFilterInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;

    _const auto LogLevel = Level;
    _const auto Factory = Factory::makeFactory<IFilterInstance, Parent>(Type);

    // Constructor/destructor
    IFilterInstance(const FactoryArgs& args) noexcept;
    virtual ~IFilterInstance();

    // Public API
    virtual Error beginFilterInstance() noexcept override;
    virtual Error open(Entry& object) noexcept override;
    virtual Error writeText(const Utf16View& text) noexcept override;
    virtual Error writeTable(const Utf16View& text) noexcept override;
    virtual Error closing() noexcept override;
    virtual Error endFilterInstance() noexcept override;

private:
    Error resetSession() noexcept;
    Text getSessionError() const noexcept;

private:
    IFilterGlobal& m_global;
    ClassifySessionHandle m_session = nullptr;

    // ICU normalizer for NFKC
    Opt<string::icu::Normalizer> m_normalizer;

    // Buffers for text conversion
    Text m_utf8Buffer;
    Utf16 m_normalizedBuffer;

    // Results buffer (reused across evaluations)
    Text m_resultBuffer;
};

}  // namespace engine::store::filter::classify
