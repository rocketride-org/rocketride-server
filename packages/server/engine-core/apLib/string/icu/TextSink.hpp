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

namespace ap::string::icu {

// Buffer for collecting UTF-8 text
template <typename AllocT = std::allocator<Utf8Chr>>
class TextSink : public ByteSink {
public:
    using StrType = Str<Utf8Chr, Case<Utf8Chr>, AllocT>;

    TextSink() = default;
    TextSink(const AllocT& alloc) noexcept : m_text(alloc), m_buffer(alloc) {}
    TextSink(const TextSink&) = delete;
    TextSink(TextSink&&) = delete;

    virtual void Append(const char* bytes, int32_t length) noexcept override {
        // If this is our buffer, resize and move
        if (bytes == m_buffer.data()) {
            ASSERTD(length <= m_buffer.size());
            m_buffer.resize(length);

            if (m_text) {
                m_text += m_buffer;
                m_buffer.clear();
            } else
                m_text = _mv(m_buffer);
        } else
            m_text += TextView(bytes, length);
    }

    virtual char* GetAppendBuffer(int32_t min_capacity,
                                  int32_t desired_capacity_hint, char* scratch,
                                  int32_t scratch_capacity,
                                  int32_t* result_capacity) noexcept override {
        auto size = std::max(min_capacity, desired_capacity_hint);
        m_buffer.resize(size);
        *result_capacity = size;
        return m_buffer.data();
    }

    StrType extract() noexcept { return _mv(m_text); }

protected:
    StrType m_text;
    StrType m_buffer;
};

}  // namespace ap::string::icu