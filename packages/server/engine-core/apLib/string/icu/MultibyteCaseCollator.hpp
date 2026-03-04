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

struct MultibyteCaseCollator {
    using is_transparent = std::true_type;

    MultibyteCaseCollator(const Locale& local = {"en", "US"}) noexcept {
        UErrorCode ec = U_ZERO_ERROR;
        m_collator.reset(Collator::createInstance(local, ec));
        ASSERTD_MSG(!U_FAILURE(ec), "Failed to allocate icu collator", ec);
        m_collator->setStrength(_cast<Collator::ECollationStrength>(
            icu::Collator::PRIMARY | icu::Collator::SECONDARY |
            icu::Collator::TERTIARY));
    }

    bool operator()(const TextView& lhs, const TextView& rhs) const noexcept {
        return compare(lhs, rhs);
    }

    template <typename L, typename R>
    bool compare(const L& lhs, const R& rhs) const noexcept {
        UErrorCode ec = U_ZERO_ERROR;
        auto res =
            m_collator->compareUTF8({lhs.data(), _nc<int32_t>(lhs.size())},
                                    {rhs.data(), _nc<int32_t>(rhs.size())}, ec);
        ASSERTD_MSG(!U_FAILURE(ec), "Failed to collate", lhs, rhs);
        if (res == UCOL_LESS) return true;
        return false;
    }

    SharedPtr<Collator> m_collator;
};

}  // namespace ap::string::icu
