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

namespace ap::dev {

class Backtrace {
public:
    Backtrace() noexcept;
    Backtrace(const Backtrace &) noexcept = default;
    Backtrace(Backtrace &&) noexcept = default;

    Backtrace &operator=(const Backtrace &) noexcept = default;
    Backtrace &operator=(Backtrace &&) noexcept = default;

    const TextView toString() const noexcept;

    template <typename Buff>
    auto __toString(Buff &buff) const noexcept {
        buff << toString();
    }

private:
    std::vector<Text> m_cachedVec;
    mutable Text m_cachedStr;
    Text m_threadName;
    async::Tid m_threadId;
    async::Pid m_processId;
};

}  // namespace ap::dev
