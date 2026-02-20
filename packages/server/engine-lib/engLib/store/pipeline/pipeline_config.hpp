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

namespace engine::store::pipeline {

/**
 * @brief PipelineConfig class for managing pipeline configurations.
 */
class PipelineConfig {
public:
    explicit PipelineConfig(json::Value root = {}) noexcept;

    json::Value &root() noexcept { return m_root; }
    void setRoot(json::Value root) noexcept;
    json::Value &components() noexcept {
        return m_root["pipeline"]["components"];
    }
    bool hasSource() const noexcept;
    json::Value &source() noexcept { return components()[m_sourcePos]; }
    json::Value &sourceConfig() noexcept { return source()["config"]; }
    json::Value &targetConfig() noexcept;

    Error validate(bool sourceRequired = true) noexcept;
    static Error validateComponent(const json::Value &component) noexcept;
    static Error validateSecureParameters(const json::Value &section) noexcept;
    static Error upgradeComponent(json::Value &component, int version) noexcept;

    Error decrypt(bool overwrite = false) noexcept;
    static Error decryptComponent(json::Value &component,
                                  bool overwrite = false) noexcept;
    static Error decryptSection(json::Value &section,
                                bool overwrite = false) noexcept;

    Error encrypt() noexcept;
    static Error encryptComponent(json::Value &component) noexcept;
    static Error encryptSection(IServices::ServiceDefinitionPtr def,
                                json::Value &section) noexcept;

    static void addError(json::Value &root, const Error &ccode,
                         TextView id = {}) noexcept;
    void addError(const Error &ccode, TextView id = {}) noexcept;

private:
    json::Value m_root;
    json::Value::ArrayIndex m_sourcePos = 0;
    json::Value m_targetConfig;
};

}  // namespace engine::store::pipeline
