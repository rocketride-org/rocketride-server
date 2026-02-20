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

namespace ap::string::icu {
// Unicode normalization forms
enum class NormalizationForm {
    NFD,
    NFKD,
    NFC,
    NFKC,
};

// Forward declarations
class Normalizer;
ErrorOr<Normalizer> getNormalizer(NormalizationForm form) noexcept;

class Normalizer {
public:
    friend ErrorOr<Normalizer> getNormalizer(NormalizationForm form) noexcept;

    _const auto DefaultForm = NormalizationForm::NFKC;

    template <typename ChrT, typename TraitsT = Case<ChrT>,
              typename AllocT = std::allocator<ChrT>>
    ErrorOr<Str<ChrT, TraitsT, AllocT>> normalize(
        StrView<ChrT, TraitsT> text, const AllocT& alloc = {}) const noexcept {
        UErrorCode ec = U_ZERO_ERROR;
        if constexpr (traits::IsSameTypeV<ChrT, Utf8Chr>) {
            // Normalize using a buffer
            TextSink sink(alloc);
            m_instance->normalizeUTF8(0, _tr<StringPiece>(text), sink, nullptr,
                                      ec);
            if (U_FAILURE(ec))
                return APERRL(Icu, Ec::Icu, "Failed to normalize text", text,
                              u_errorName(ec));
            return _mv(sink.extract());
        } else if constexpr (traits::IsSameTypeV<ChrT, Utf16Chr>) {
            auto normalized =
                m_instance->normalize(_tr<UnicodeString>(text), ec);
            if (U_FAILURE(ec))
                return APERRL(Icu, Ec::Icu, "Failed to normalize text", text,
                              u_errorName(ec));
            return toUtf16(normalized, alloc);
        } else
            static_assert(sizeof(ChrT) == 0, "Unsupported character type");
    }

    template <typename ChrT, typename TraitsT = Case<ChrT>,
              typename AllocT = std::allocator<ChrT>>
    auto normalize(const Str<ChrT, TraitsT>& text,
                   const AllocT& alloc = {}) const noexcept {
        return normalize(_cast<StrView<ChrT, TraitsT>>(text), alloc);
    }

    template <typename ChrT, typename TraitsT = Case<ChrT>>
    bool isNormalized(StrView<ChrT, TraitsT> text) const noexcept {
        UErrorCode ec = U_ZERO_ERROR;
        UBool res = {};
        if constexpr (traits::IsSameTypeV<ChrT, Utf8Chr>)
            res = m_instance->isNormalizedUTF8(_tr<StringPiece>(text), ec);
        else
            res = m_instance->isNormalized(_tr<UnicodeString>(text), ec);

        // If it failed, log and return false
        if (U_FAILURE(ec)) {
            LOG(Icu, Ec::Icu,
                "Failed to determine whether text is normalized text", text,
                u_errorName(ec));
            return false;
        }

        return res;
    }

    template <typename ChrT, typename TraitsT = Case<ChrT>>
    auto isNormalized(const Str<ChrT, TraitsT>& text) const noexcept {
        return isNormalized(_cast<StrView<ChrT, TraitsT>>(text));
    }

protected:
    Normalizer(const ::icu::Normalizer2* instance) noexcept
        : m_instance(instance) {
        ASSERT(m_instance);
    }

protected:
    const ::icu::Normalizer2* m_instance;
};

inline ErrorOr<Normalizer> getNormalizer(
    NormalizationForm form = Normalizer::DefaultForm) noexcept {
    const ::icu::Normalizer2* instance = {};
    UErrorCode ec = U_ZERO_ERROR;
    switch (form) {
        case NormalizationForm::NFD:
            instance = ::icu::Normalizer2::getNFDInstance(ec);
            break;
        case NormalizationForm::NFKD:
            instance = ::icu::Normalizer2::getNFKDInstance(ec);
            break;
        case NormalizationForm::NFC:
            instance = ::icu::Normalizer2::getNFCInstance(ec);
            break;
        case NormalizationForm::NFKC:
            instance = ::icu::Normalizer2::getNFKCInstance(ec);
            break;
        default:
            return APERRL(Icu, Ec::InvalidParam,
                          "Normalization form not recognized", form);
    }
    if (U_FAILURE(ec))
        return APERRL(Icu, Ec::Icu,
                      "Failed to get ICU normalizer instance for form", form,
                      u_errorName(ec));

    ASSERT(instance);
    return Normalizer(instance);
}

template <typename ChrT, typename TraitsT = Case<ChrT>,
          typename AllocT = std::allocator<ChrT>>
ErrorOr<Str<ChrT, TraitsT, AllocT>> normalize(
    StrView<ChrT, TraitsT> text,
    NormalizationForm form = Normalizer::DefaultForm,
    const AllocT& alloc = {}) noexcept {
    auto normalizer = getNormalizer(form);
    if (!normalizer) return normalizer.ccode();
    return normalizer->normalize(text, alloc);
}

template <typename ChrT, typename TraitsT = Case<ChrT>,
          typename AllocT = std::allocator<ChrT>>
auto normalize(const Str<ChrT, TraitsT>& text,
               NormalizationForm form = Normalizer::DefaultForm,
               const AllocT& alloc = {}) noexcept {
    return normalize(_cast<StrView<ChrT, TraitsT>>(text), form, alloc);
}

template <typename ChrT, typename TraitsT = Case<ChrT>>
bool isNormalized(StrView<ChrT, TraitsT> text,
                  NormalizationForm form = Normalizer::DefaultForm) noexcept {
    auto normalizer = getNormalizer(form);
    if (!normalizer) return false;
    return normalizer->isNormalized(text);
}

template <typename ChrT, typename TraitsT = Case<ChrT>>
auto isNormalized(const Str<ChrT, TraitsT>& text,
                  NormalizationForm form = Normalizer::DefaultForm) noexcept {
    return isNormalized(_cast<StrView<ChrT, TraitsT>>(text), form);
}

}  // namespace ap::string::icu