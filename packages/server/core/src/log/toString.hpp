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

//
// Log level conversion api
//
#pragma once

namespace ap::log {

// Specialize a from string hook to a single string to a single
// level
template <typename Buffer>
inline Error __fromString(Lvl &lvl, const Buffer &buff) noexcept {
    // Its either a numeric value or a level name...
    iText str = buff.toString();
    if (util::allOf(str, [](const auto &chr) noexcept {
            return chr >= '0' && chr <= '9';
        })) {
        // Numeric, look it up by its id
        auto id = _fs<uint32_t>(str);
        if (id >= EnumIndex(Lvl::_begin) && id < EnumIndex(Lvl::_end)) {
            lvl = EnumFrom<Lvl>(id);
            return {};
        }
    } else {
        // Non numeric, look it up by its name
        auto iter = util::findIf(LvlNames, [&](const auto &levelName) noexcept {
            return levelName == str;
        });
        if (iter != LvlNames.end()) {
            lvl = EnumFrom<Lvl>(std::distance(LvlNames.begin(), iter));
            return {};
        }
    }

    // Could not look it up
    return APERR(Ec::StringParse, "Failed to parse level from string:", str);
}

template <typename Buffer>
inline void __toString(const Lvl &lvl, Buffer &buff) noexcept {
    buff << LvlNames[EnumIndex(lvl)];
}

}  // namespace ap::log
