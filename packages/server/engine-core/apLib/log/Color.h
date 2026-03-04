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

enum class Color {
    _begin,

    Green = _begin,
    Red,
    Blue,
    Cyan,
    Yellow,
    Reset,

    _end
};

// Bless this enum with range for with a range for adapter
APUTIL_DEFINE_ENUM_ITER(Color)

TextView colorCode(Color color) noexcept;
iTextView colorName(Color color) noexcept;

std::ostream& operator<<(std::ostream& stream, Color color);

template <typename BufferT>
void __toString(BufferT& buff, FormatOptions opts) noexcept;

template <typename JsonT>
Error __fromJson(Color& color, const JsonT& val) noexcept;

template <typename JsonT>
Error __toJson(const Color& color, JsonT& val) noexcept;

}  // namespace ap
