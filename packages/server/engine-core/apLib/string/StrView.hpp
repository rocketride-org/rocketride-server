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
//	The rocketride string view class
//
#pragma once

namespace ap::string {

// Forward declare the no position type into our namespace
_const auto npos = std::string::npos;

// Here is rocketride's specialization of std::basic_string_view, we
// allow implicit casting to and form Str's, and our views can
// cast to any encoding as well.
// @notes
// All constexpr methods are declared inline in this header as that is a
// requirement, the rest are broken up into implementation definitions in the
// strview.hpp file.
template <typename Character, typename Traits = std::char_traits<Character>>
class StrView : public std::basic_string_view<Character, Traits> {
public:
    static_assert(std::is_same_v<Character, typename Traits::char_type>,
                  "Bad char_traits for basic_string_view; "
                  "N4659 24.4.2 [string.view.template]/1 \"the type "
                  "traits::char_type shall name the same type as charT.\"");

    using CharacterType = Character;
    using TraitsType = Traits;
    using Parent = std::basic_string_view<CharacterType, TraitsType>;

    using ThisType = StrView<CharacterType, TraitsType>;
    using SizeType = typename Parent::size_type;

    // Api implementation aliases
    using Api = ::ap::string::StrApi<CharacterType, TraitsType,
                                     std::allocator<CharacterType>>;
    using NoCaseApi = ::ap::string::StrApi<CharacterType, TraitsType,
                                           std::allocator<CharacterType>,
                                           NoCase<CharacterType>>;
    using CaseApi = ::ap::string::StrApi<CharacterType, TraitsType,
                                         std::allocator<CharacterType>,
                                         Case<CharacterType>>;

    using typename Parent::const_iterator;
    using typename Parent::const_pointer;
    using typename Parent::const_reference;
    using typename Parent::const_reverse_iterator;
    using typename Parent::difference_type;
    using typename Parent::iterator;
    using typename Parent::pointer;
    using typename Parent::reference;
    using typename Parent::reverse_iterator;
    using typename Parent::size_type;
    using typename Parent::traits_type;
    using typename Parent::value_type;

    using Parent::begin;
    using Parent::cbegin;
    using Parent::cend;
    using Parent::crbegin;
    using Parent::crend;
    using Parent::data;
    using Parent::empty;
    using Parent::end;
    using Parent::length;
    using Parent::max_size;
    using Parent::npos;
    using Parent::rbegin;
    using Parent::rend;
    using Parent::size;
    using Parent::operator[];
    using Parent::at;
    using Parent::back;
    using Parent::compare;
    using Parent::copy;
    using Parent::find;
    using Parent::find_first_not_of;
    using Parent::find_first_of;
    using Parent::find_last_not_of;
    using Parent::find_last_of;
    using Parent::front;
    using Parent::remove_prefix;
    using Parent::remove_suffix;
    using Parent::rfind;
    using Parent::swap;

#if SW_PLAT_WIN
    using Parent::_Copy_s;
    using Parent::_Equal;
    using Parent::_Starts_with;
    using Parent::_Unchecked_begin;
    using Parent::_Unchecked_end;
#endif

    // Default construction
    constexpr StrView() = default;

    // Allow construction from strings/views with different traits and
    // different character definitions provided the character size is a match
    template <typename ChrT, typename TraitsT,
              typename = std::enable_if_t<sizeof(ChrT) == sizeof(Character)>>
    constexpr StrView(std::basic_string_view<ChrT, TraitsT> str) noexcept
        : Parent(str.empty() ? ((const Character *)"")
                             : ((const Character *)(str.data())),
                 str.empty() ? 0 : str.size()) {}

    template <typename ChrT, typename TraitsT,
              typename = std::enable_if_t<sizeof(ChrT) == sizeof(Character)>>
    StrView(const std::basic_string<ChrT, TraitsT> &str) noexcept
        : Parent(str.empty() ? ((const Character *)"")
                             : ((const Character *)(str.data())),
                 str.empty() ? 0 : str.size()) {}

    template <typename ChrT,
              typename = std::enable_if_t<std::is_integral_v<ChrT> &&
                                          sizeof(ChrT) == sizeof(Character)>>
    constexpr StrView(const ChrT *str) noexcept
        : Parent(!str ? ((const Character *)"") : ((const Character *)(str))) {}

    template <typename ChrT,
              typename = std::enable_if_t<std::is_integral_v<ChrT> &&
                                          sizeof(ChrT) == sizeof(Character)>>
    constexpr StrView(const ChrT *str, size_t len) noexcept
        : Parent(str ? ((const Character *)(str)) : ((const Character *)""),
                 str ? len : 0) {}

    template <typename Iter,
              typename = std::enable_if_t<traits::IsIteratorV<Iter>>>
    constexpr StrView(Iter start, Iter end) noexcept
        : Parent(&(*start), std::distance(start, end)) {}

    // Allow implicit casting to boolean based on empty check
    constexpr explicit operator bool() const noexcept { return !empty(); }

    // Equality with any StrView with same character width
    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<sizeof(ChrT) == sizeof(CharacterType)>>
    constexpr bool operator==(StrView<ChrT, TraitsT> str) const noexcept {
        if (size() != str.size()) return false;

        if constexpr (traits::IsSameTypeV<TraitsT, NoCase<ChrT>>)
            return string::NoCase<Character>::compare(data(), str.data(),
                                                      size()) == 0;
        else
            return TraitsType::compare(data(), str.data(), size()) == 0;
    }

    // Inequality with any StrView with same character width
    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<sizeof(ChrT) == sizeof(CharacterType)>>
    constexpr bool operator!=(StrView<ChrT, TraitsT> str) const noexcept {
        return !(operator==(str));
    }

    // Equality with any STL string view with same character width
    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<sizeof(ChrT) == sizeof(CharacterType)>>
    constexpr bool operator==(
        std::basic_string_view<ChrT, TraitsT> str) const noexcept {
        if (size() != str.size()) return false;

        if constexpr (traits::IsSameTypeV<TraitsT, NoCase<ChrT>>)
            return string::NoCase<Character>::compare(data(), str.data(),
                                                      size()) == 0;
        else
            return TraitsType::compare(data(), str.data(), size()) == 0;
    }

    // Inequality with any STL string view with same character width
    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<sizeof(ChrT) == sizeof(CharacterType)>>
    constexpr bool operator!=(
        std::basic_string_view<ChrT, TraitsT> str) const noexcept {
        return !(operator==(str));
    }

    // Equality with any STL string with same character width (needed only until
    // we can replace Clang 9)
    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<sizeof(ChrT) == sizeof(CharacterType)>>
    constexpr bool operator==(
        const std::basic_string<ChrT, TraitsT> &str) const noexcept {
        if (size() != str.size()) return false;

        if constexpr (traits::IsSameTypeV<TraitsT, NoCase<ChrT>>)
            return string::NoCase<Character>::compare(data(), str.data(),
                                                      size()) == 0;
        else
            return TraitsType::compare(data(), str.data(), size()) == 0;
    }

    // Inequality with any STL string with same character width (needed only
    // until we can replace Clang 9)
    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<sizeof(ChrT) == sizeof(CharacterType)>>
    constexpr bool operator!=(
        const std::basic_string<ChrT, TraitsT> &str) const noexcept {
        return !(operator==(str));
    }

    // Returns a sub view from this view
    constexpr StrView substr(size_type pos = 0,
                             size_type count = npos) const noexcept {
        if (count) return {Parent::substr(pos, count)};
        return {};
    }

    // Statically returns the count of instances of a character in this string
    constexpr size_t countOf(CharacterType chr) const noexcept {
        return std::count(begin(), end(), chr);
    }

    // Trims a view from the left portion
    constexpr decltype(auto) trimLeft(CharacterType with) noexcept {
        remove_prefix(std::min(find_first_not_of(with), size()));
        return *this;
    }

    constexpr decltype(auto) trimLeft(StrView with) noexcept {
        remove_prefix(std::min(find_first_not_of(with), size()));
        return *this;
    }

    // Trims this view from the right with any matching characters
    constexpr decltype(auto) trimRight(CharacterType with) noexcept {
        remove_suffix(std::min(size() - find_last_not_of(with) - 1, size()));
        return *this;
    }

    constexpr decltype(auto) trimRight(StrView with) noexcept {
        remove_suffix(std::min(size() - find_last_not_of(with) - 1, size()));
        return *this;
    }

    // Deref to access the first element
    constexpr decltype(auto) operator*() const noexcept { return front(); }

    // Dec the trailing ptr down by one
    constexpr auto operator--(int dummy) noexcept {
        auto res = *this;
        remove_suffix(1);
        return res;
    }

    // Pre dec the trailing ptr down by one
    constexpr decltype(auto) operator--() noexcept {
        remove_suffix(1);
        return *this;
    }

    // Advance the leading ptr up by one
    constexpr auto operator++(int dummy) noexcept {
        auto res = *this;
        remove_prefix(1);
        return res;
    }

    // Pre advance the leading ptr up by one
    constexpr decltype(auto) operator++() noexcept {
        remove_prefix(1);
        return *this;
    }

    // Trims a view from both the left and right portions
    constexpr decltype(auto) trim(CharacterType with) noexcept {
        return trimRight(with).trimLeft(with);
    }

    constexpr auto trim(StrView with) noexcept {
        return trimRight(with).trimLeft(with);
    }

    // Uppercase this string view as a copy
    template <typename StrTypeT>
    auto lowerCase() const noexcept {
        return Api::template toLower<StrTypeT>(*this);
    }

    // Lowercase this string view as a copy
    template <typename StrTypeT>
    auto upperCase() const noexcept {
        return Api::template toUpper<StrTypeT>(*this);
    }

    // Remove one instance of a leading and trailing quote character.
    template <typename StrTypeT>
    auto removeQuotes() const noexcept {
        return Api::template extractEnclosed<StrTypeT>(*this, '"', '"');
    }

    // Enclose this string in a leading and trailing delimiter
    template <typename StrTypeT>
    auto enclose(CharacterType leadingDelim,
                 CharacterType trailingDelim = '\0') noexcept {
        return Api::template enclose<StrTypeT>(*this, leadingDelim,
                                               trailingDelim);
    }

    // Extracts a portion of the string within two delimiters.
    template <typename StrTypeT>
    auto extractEnclosed(CharacterType leadingDelim,
                         CharacterType trailingDelim = '\0',
                         Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::template extractEnclosed<StrTypeT>(
                    *this, leadingDelim, trailingDelim);
            else
                return NoCaseApi::template extractEnclosed<StrTypeT>(
                    *this, leadingDelim, trailingDelim);
        }
        return Api::template extractEnclosed<StrTypeT>(*this, leadingDelim,
                                                       trailingDelim);
    }

    // Trim characters from the leading and trailing portions of this string.
    template <typename StrTypeT>
    StrTypeT trim(std::initializer_list<CharacterType> charSet = {'\t', '\n',
                                                                  '\r', ' ',
                                                                  '\0'},
                  Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::template trim<StrTypeT>(*this, charSet);
            else
                return NoCaseApi::template trim<StrTypeT>(*this, charSet);
        }
        return Api::template trim<StrTypeT>(*this, charSet);
    }

    // Trim characters from the leading portions of this string.
    template <typename StrTypeT>
    auto trimLeading(std::initializer_list<CharacterType> charSet = {'\t', '\n',
                                                                     '\r', ' ',
                                                                     '\0'},
                     Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return NoCaseApi::template trimLeading<StrTypeT>(*this,
                                                                 charSet);
            else
                return CaseApi::template trimLeading<StrTypeT>(*this, charSet);
        }

        return Api::template trimLeading<StrTypeT>(*this, charSet);
    }

    decltype(auto) trimLeading(ThisType leading,
                               Opt<bool> caseAware = {}) noexcept {
        while (startsWith(leading, caseAware)) *this = substr(leading.size());
        return *this;
    }

    // Trim characters from the trailing portions of this string.
    template <typename StrTypeT>
    StrTypeT trimTrailing(std::initializer_list<CharacterType> charSet =
                              {'\t', '\n', '\r', ' ', '\0'},
                          Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::template trimTrailing<StrTypeT>(*this, charSet);
            else
                return NoCaseApi::template trimTrailing<StrTypeT>(*this,
                                                                  charSet);
        }
        return Api::template trimTrailing<StrTypeT>(*this, charSet);
    }

    decltype(auto) trimTrailing(ThisType trailing,
                                Opt<bool> caseAware = {}) noexcept {
        while (endsWith(trailing, caseAware))
            *this = substr(0, size() - trailing.size());
        return *this;
    }

    // Count occurrences of a char/string in this string
    template <typename TokenT>
    auto count(TokenT &&token, Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::count(*this, std::forward<TokenT>(token));
            else
                return NoCaseApi::count(*this, std::forward<TokenT>(token));
        }
        return Api::count(*this, std::forward<TokenT>(token));
    }

    // Split this string up into components based on a delimiter
    template <typename ContainerT, typename DelimT>
    auto split(DelimT &&delim, bool includeEmpty = false, Opt<size_t> max = {},
               Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::template split<ContainerT>(*this, delim,
                                                           includeEmpty, max);
            else
                return NoCaseApi::template split<ContainerT>(*this, delim,
                                                             includeEmpty, max);
        }
        return Api::template split<ContainerT>(*this, delim, includeEmpty, max);
    }

    // Splits the string in two at a position
    constexpr Pair<ThisType, ThisType> splitAt(int pos) const noexcept {
        if (pos < 0) return {substr(0, size() + pos), substr(-pos)};
        return {substr(0, size() - pos), substr(pos)};
    }

    // Slices this view into two views, at a delimiter
    template <typename DelimT>
    constexpr Pair<ThisType, ThisType> slice(
        DelimT &&delim, Opt<bool> caseAware = {},
        bool retainDelimInFirst = false) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::slice(*this, std::forward<DelimT>(delim),
                                      retainDelimInFirst);
            else
                return NoCaseApi::slice(*this, std::forward<DelimT>(delim),
                                        retainDelimInFirst);
        }
        return Api::slice(*this, std::forward<DelimT>(delim),
                          retainDelimInFirst);
    }

    // Check if this string ends with another string/char
    template <typename TrailingT>
    auto endsWith(TrailingT &&trailing,
                  Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::endsWith(*this,
                                         std::forward<TrailingT>(trailing));
            else
                return NoCaseApi::endsWith(*this,
                                           std::forward<TrailingT>(trailing));
        }
        return Api::endsWith(*this, std::forward<TrailingT>(trailing));
    }

    // Check if this string starts with another string
    template <typename LeadingT>
    auto startsWith(LeadingT &&leading,
                    Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::startsWith(*this, leading);
            else
                return NoCaseApi::startsWith(*this,
                                             std::forward<LeadingT>(leading));
        }
        return Api::startsWith(*this, std::forward<LeadingT>(leading));
    }

    // Check if this string contains another
    template <typename InnerT>
    auto contains(InnerT &&inner, Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::contains(*this, std::forward<InnerT>(inner));
            else
                return NoCaseApi::contains(*this, std::forward<InnerT>(inner));
        }
        return Api::contains(*this, std::forward<InnerT>(inner));
    }

    // Checks if this string is equal to another
    template <typename EqualsT>
    bool equals(EqualsT &&other, Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::equals(*this, std::forward<EqualsT>(other));
            else
                return NoCaseApi::equals(*this, std::forward<EqualsT>(other));
        }
        return Api::equals(*this, std::forward<EqualsT>(other));
    }

    // Checks if this string is equal to another (case-insensitive)
    template <typename EqualsT>
    bool equalsNoCase(EqualsT &&other) const noexcept {
        return NoCaseApi::equals(*this, std::forward<EqualsT>(other));
    }

    // Replaces all instances of a token with a value in a new string.
    template <typename StrTypeT>
    StrTypeT replace(std::basic_string_view<CharacterType> token,
                     std::basic_string_view<CharacterType> replacement,
                     Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::template replace<StrTypeT>(*this, token,
                                                           replacement);
            else
                return NoCaseApi::template replace<StrTypeT>(*this, token,
                                                             replacement);
        }
        return Api::template replace<StrTypeT>(*this, token, replacement);
    }

    template <typename StrTypeT>
    auto replace(CharacterType token,
                 CharacterType replacement) const noexcept {
        StrTypeT res = *this;
        return res.replace(token, replacement);
    }
};

}  // namespace ap::string

namespace std {
// Allow our views to work in hashes
template <typename CharacterType, typename Traits>
struct hash<::ap::string::StrView<CharacterType, Traits>> {
    using argument_type = ::ap::string::StrView<CharacterType, Traits>;
    using result_type = size_t;

    result_type operator()(const argument_type &str) const noexcept {
        return hash<basic_string_view<CharacterType, Traits>>{}(str);
    }
};

}  // namespace std
