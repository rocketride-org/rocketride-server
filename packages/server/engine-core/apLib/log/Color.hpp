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

namespace ap {
// FG_DEFAULT = 39

// FG_BLACK = 30
// FG_RED = 31
// FG_GREEN = 32
// FG_YELLOW = 33
// FG_BLUE = 34
// FG_MAGENTA = 35
// FG_CYAN = 36
// FG_LIGHT_GRAY = 37

// FG_DARK_GRAY = 90
// FG_LIGHT_RED = 91
// FG_LIGHT_GREEN = 92
// FG_LIGHT_YELLOW = 93
// FG_LIGHT_BLUE = 94
// FG_LIGHT_MAGENTA = 95
// FG_LIGHT_CYAN = 96
// FG_WHITE = 97

// BG_RED = 41
// BG_GREEN = 42
// BG_BLUE = 44
// BG_DEFAULT = 49

inline TextView colorCode(Color color) noexcept {
    // This is a kludgy way to disable colors in output, but it works
    if (log::options().disableAllColors) return {};

    switch (color) {
        case Color::Red:
            return "\x1B[31m";
        case Color::Cyan:
            return "\x1B[36m";
        case Color::Green:
            return "\x1B[32m";
        case Color::Blue:
            return "\x1B[34m";
        case Color::Yellow:
            return "\x1B[33m";
        default:
            return "\x1B[0m";  // reset
    }
}

inline iTextView colorName(Color color) noexcept {
    switch (color) {
        case Color::Red:
            return "Red";
        case Color::Cyan:
            return "Cyan";
        case Color::Green:
            return "Green";
        case Color::Blue:
            return "Blue";
        case Color::Yellow:
            return "Yellow";
        case Color::Reset:
            return "Reset";
        default:
            dev::fatality(_location, "Invalid color enum");
    }
}

inline std::ostream& operator<<(std::ostream& stream, Color color) {
    return stream << colorCode(color);
}

template <typename BufferT>
inline void __toString(Color color, BufferT& buff,
                       FormatOptions opts) noexcept {
    if (!opts.noColors()) buff << colorCode(color);
}

template <typename JsonT>
inline Error __fromJson(Color& color, const JsonT& val) noexcept {
    if (!val.isString())
        return APERR(Ec::InvalidJson, "Color type must be string", val);
    iText name = val.asString();

    for (auto c : Color{}) {
        if (colorName(c) == name) {
            color = c;
            return {};
        }
    }

    return APERR(Ec::InvalidJson, "Invalid color name", name);
}

template <typename JsonT>
inline Error __toJson(const Color& color, JsonT& val) noexcept {
    return _tja(colorName(color), val);
}

}  // namespace ap
