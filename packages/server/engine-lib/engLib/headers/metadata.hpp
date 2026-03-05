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
//-------------------------------------------------------------------------
// Forward declare
//-------------------------------------------------------------------------
namespace engine::store::filter::indexer {
class IFilterInstance;
}

namespace engine {
//-------------------------------------------------------------------------
/// @details
///     Well-known metadata property names
//-------------------------------------------------------------------------
namespace metadata::intrinsics {
_const auto XRocketRideIsEncrypted = "X-RocketRide:IsEncrypted"_tv;
}  // namespace metadata::intrinsics

//-------------------------------------------------------------------------
/// @details
///		Define the metadata controller for handling metadata to/from
///     the parser, the word db, etc
//-------------------------------------------------------------------------
class Metadata {
public:
    //-----------------------------------------------------------------
    // This is used for save/load
    //-----------------------------------------------------------------
    using IFilterIndex = engine::store::filter::indexer::IFilterInstance;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::Index;

    //-----------------------------------------------------------------
    // Public functions
    //-----------------------------------------------------------------
    Error save(IFilterIndex &instance) noexcept;
    Error load(IFilterIndex &instance, index::DocId docId) noexcept;

    void clear() noexcept;
    bool isEncrypted() const noexcept;
    void set(Text name, Text value) noexcept;
    TextView get(TextView name) const noexcept;
    TextView operator[](TextView name) const noexcept;
    void remove(TextView name) noexcept;
    Text extract(TextView name) noexcept;
    bool empty() const noexcept;
    explicit operator bool() const noexcept;
    size_t size() const noexcept;
    auto begin() const noexcept;
    auto end() const noexcept;
    bool operator==(const Metadata &cmp) const noexcept;
    bool operator!=(const Metadata &cmp) const noexcept;
    static Text renderProperty(TextView name, TextView value) noexcept;
    TextView getClosestKeyByIndex(size_t id) noexcept;

    template <typename Buffer>
    void __toString(Buffer &buff) const noexcept {
        for (auto &[name, value] : m_properties) {
            buff << renderProperty(name, value) << "\n";
        }
    }

    void __toJson(json::Value &json) const noexcept {
        for (auto &[key, value] : m_properties) {
            json[key] = value;
        }
    }

protected:
    //-----------------------------------------------------------------
    /// @details
    ///     Contains our map of keys/values
    //-----------------------------------------------------------------
    std::map<Text, Text> m_properties;

    //-----------------------------------------------------------------
    /// @details
    ///     Contains the mapping for our word ids
    //-----------------------------------------------------------------
    std::map<size_t, Text> m_wordIdWithKeys;
};

}  // namespace engine