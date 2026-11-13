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

namespace ap {

// Given a series of characters (up to 8), shifts each character and packs them
// into a 64 bit signature id, this then will show up in memory dumps in the
// correct order
template <typename Tag>
_const uint64_t makeId(Tag tag) noexcept {
    if constexpr (traits::IsSameTypeV<uint64_t, Tag>)
        return tag;
    else {
        auto fullTag = TextView{tag};
        TextView highTag, lowTag;
        if (fullTag.size() > 4) {
            lowTag = TextView{tag}.substr(0, 4);
            highTag = TextView{tag}.substr(4);
        } else
            lowTag = TextView{tag};

        auto shift32 = [&](TextView tag32) {
            uint64_t shift = 0, id = 0;
            for (auto chr : tag32) {
                id |= chr << shift;
                shift += 8;
            }
            return id;
        };

        uint64_t low = shift32(lowTag);
        uint64_t hi = 0;
        if (highTag) hi = shift32(highTag);

        return hi << 32 | low;
    }
}

inline Text idNameImpl(uint64_t tagId) noexcept {
    std::array name{(char)(uint8_t)(tagId & 0xFF),
                    (char)(uint8_t)((tagId >> 8) & 0xFF),
                    (char)(uint8_t)((tagId >> 16) & 0xFF),
                    (char)(uint8_t)((tagId >> 24) & 0xFF),

                    (char)(uint8_t)((tagId >> 32) & 0xFF),
                    (char)(uint8_t)((tagId >> 40) & 0xFF),
                    (char)(uint8_t)((tagId >> 48) & 0xFF),
                    (char)(uint8_t)((tagId >> 56) & 0xFF)};
    return {&name.front(), name.size()};
}

template <typename TagIdT>
Text idName(TagIdT tagId) noexcept {
    return idNameImpl(_cast<uint64_t>(tagId));
}

}  // namespace ap
