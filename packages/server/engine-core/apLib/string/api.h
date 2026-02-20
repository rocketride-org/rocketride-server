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

namespace ap::string {

// Handy utility methods for numeric type rendering
template <typename Number>
Text toHex(Number number, FormatOptions options = {Format::PREFIX}) noexcept;

template <typename Number>
Text toHumanSize(Number size, size_t maxPrecision = 2,
                 FormatOptions options = {}) noexcept;

template <typename Number>
Text toHumanCount(Number value, FormatOptions options = {}) noexcept;

template <typename ChrT>
ChrT toLower(ChrT chr) noexcept;

template <typename ChrT>
ChrT toUpper(ChrT chr) noexcept;

Text toLower(TextView str) noexcept;
Text toUpper(TextView str) noexcept;

template <template <typename ChrT> typename TraitT, typename ChrT>
int compare(ChrT lhs, ChrT rhs) noexcept;

template <template <typename ChrT> typename TraitT, typename ChrT>
bool inRangeInclusive(ChrT start, ChrT subject, ChrT end) noexcept;

template <template <typename ChrT> typename TraitT, typename ChrT>
bool inRangeExclusive(ChrT start, ChrT subject, ChrT end) noexcept;

template <template <typename ChrT> typename TraitT, typename ChrT,
          typename... ChrTs>
bool isEqual(ChrT left, ChrTs... right) noexcept;

template <template <typename ChrT> typename TraitT, typename ChrT,
          typename... ChrTs>
bool isLess(ChrT left, ChrTs... right) noexcept;

template <template <typename ChrT> typename TraitT, typename ChrT,
          typename... ChrTs>
bool isGreater(ChrT left, ChrTs... right) noexcept;

template <template <typename ChrT> typename TraitT, typename ChrT,
          typename... ChrTs>
bool isLessEqual(ChrT left, ChrTs... right) noexcept;

template <template <typename ChrT> typename TraitT, typename ChrT,
          typename... ChrTs>
bool isGreaterEqual(ChrT left, ChrTs... right) noexcept;

Text enclose(TextChr chr, TextChr firstDelim = '\'',
             TextChr secondDelim = '\0') noexcept;
Text enclose(TextView str, TextChr firstDelim = '\'',
             TextChr secondDelim = '\0') noexcept;

Text extract(TextView str, TextChr firstDelim = '\'',
             TextChr secondDelim = '\0', bool caseAware = true) noexcept;

template <typename ContainerT = std::vector<Text>>
ContainerT split(TextView str, TextView delim, bool includeEmpty = false,
                 Opt<size_t> max = {}, bool caseAware = true) noexcept;

Text joinVector(TextView delim, const std::vector<Text>& comps) noexcept;

template <typename ContainerT = std::vector<Text>>
Text concat(const ContainerT& parts, TextView delim,
            bool includeEmpty = false) noexcept;

size_t find(TextView str, TextView token, bool caseAware = true) noexcept;

bool equals(TextView str, TextView other, bool caseAware = true) noexcept;
bool startsWith(TextView str, TextView leading, bool caseAware = true) noexcept;
bool endsWith(TextView str, TextView trailing, bool caseAware = true) noexcept;
bool endsWithControlOrColor(TextView str) noexcept;

Text addLeading(TextView str, TextView leading, bool caseAware = true) noexcept;
Text addTrailing(TextView str, TextView trailing,
                 bool caseAware = true) noexcept;

template <typename... Tokens>
Text remove(TextView str, Opt<bool> caseAware, Tokens&&... tokens) noexcept;

template <typename... Tokens>
Text remove(TextView str, Tokens&&... tokens) noexcept;

Text removeLeading(TextView str, TextView leading,
                   bool caseAware = true) noexcept;
Text removeTrailing(TextView str, TextView trailing,
                    bool caseAware = true) noexcept;

Text trimLeading(TextView str,
                 InitList<char> leading = {'\t', '\n', '\r', ' ', '\0'},
                 bool caseAware = true) noexcept;
Text trimTrailing(TextView str,
                  InitList<char> trailing = {'\t', '\n', '\r', ' ', '\0'},
                  bool caseAware = true) noexcept;

inline Text trim(TextView str,
                 InitList<char> chars = {'\t', '\n', '\r', ' ', '\0'},
                 bool caseAware = true) noexcept {
    return trimTrailing(trimLeading(str, chars, caseAware), chars, caseAware);
}

template <typename F = Text, typename S = Text>
Pair<F, S> slice(TextView str, TextView delim, bool caseAware = true,
                 bool retainDelimInFirst = false) noexcept;

Text replace(TextView _str, TextView token, TextView replacement,
             bool caseAware = true) noexcept;

inline auto replace(TextView _str, Utf8Chr token, Utf8Chr replacement,
                    bool caseAware = true) noexcept {
    return replace(_str, {&token, 1}, {&replacement, 1}, caseAware);
}

inline auto replace(TextView _str, TextView token, Utf8Chr replacement,
                    bool caseAware = true) noexcept {
    return replace(_str, token, {&replacement, 1}, caseAware);
}

inline auto replace(TextView _str, Utf8Chr token, TextView replacement,
                    bool caseAware = true) noexcept {
    return replace(_str, {&token, 1}, replacement, caseAware);
}

Text repeat(TextView val, size_t count) noexcept;

// Returns true if the character is the ASCII range, i.e. 0 to 0x7f (127),
// constexpr compatible hence declaration being in this .h
template <typename ChrT, typename = std::enable_if_t<traits::IsPodV<ChrT>>>
constexpr bool isAscii(ChrT chr) noexcept {
    return (chr & (~_cast<ChrT>(0x7f))) == 0;
}

template <typename ContT,
          typename = std::enable_if_t<traits::IsStringOrContainerV<ContT>>>
bool isAscii(const ContT& str) noexcept {
    return _allOf(str, isAscii<typename traits::ValueT<ContT>>);
}

// Returns true if the character is an ASCII numeric value, constexpr
// compatible hence declaration being in this .h
template <typename ChrT, typename = std::enable_if_t<traits::IsPodV<ChrT>>>
constexpr bool isNumeric(ChrT chr, bool hex = false) noexcept {
    if (chr >= '0' && chr <= '9') return true;
    if (hex && ((chr >= 'a' && chr <= 'f') || (chr >= 'A' && chr <= 'F')))
        return true;
    return false;
}

// Returns true if the string represents a positive or negative floating point
// or integral number
template <typename ContT,
          typename = std::enable_if_t<traits::IsStringOrContainerV<ContT>>>
bool isNumeric(const ContT& str, bool hex = false) noexcept {
    if (str.empty()) return true;

    size_t i = {};

    // If the string represents a negative number, i.e. begins with '-', skip
    // the minus
    if (str[i] == '-') ++i;

    // If it's a hexadecimal string and begins with the hex prefix, "0x", skip
    // the prefix
    if (hex && (str.size() - i) >= 2 && str[i] == '0' && str[i + 1] == 'x')
        i += 2;

    // If we skipped a prefix, but there are no remaining characters (e.g. just
    // "0x" or "-"), it's not a number
    if (i > 0 && i >= str.size()) return false;

    // Check each remaining character, allowing for one decimal
    bool decimalSeen = {};
    for (; i < str.size(); ++i) {
        if (str[i] == '.') {
            if (decimalSeen) return false;
            decimalSeen = true;
        } else if (!isNumeric<typename traits::ValueT<ContT>>(str[i], hex))
            return false;
    }

    return true;
}

// Returns true if the character is an  ASCII digit or hexadecimal digit
template <typename ChrT, typename = std::enable_if_t<traits::IsPodV<ChrT>>>
constexpr bool isHex(ChrT chr) noexcept {
    return isNumeric(chr, true);
}

template <typename ContT,
          typename = std::enable_if_t<traits::IsStringOrContainerV<ContT>>>
bool isHex(const ContT& str) noexcept {
    return isNumeric(str, true);
}

// Returns true if the character is an ascii symbol value, constexpr
// compatible hence declaration being in this .h
template <typename ChrT, typename = std::enable_if_t<traits::IsPodV<ChrT>>>
constexpr bool isSymbol(ChrT ch) noexcept {
    if (ch >= '!' && ch <= '~') {    // 33 to 126
        if (ch >= '!' && ch <= '/')  // 33 to 47
            return true;
        else if (ch >= ':' && ch <= '@')  // 58 to 64
            return true;
        else if (ch >= '[' && ch <= '`')  // 91 to 97
            return true;
        else if (ch >= '{' && ch <= '~')  // 123 to 126
            return true;
    }
    return false;
}

template <typename ContT,
          typename = std::enable_if_t<traits::IsStringOrContainerV<ContT>>>
bool isSymbol(const ContT& str) noexcept {
    return _allOf(str, isSymbol<typename traits::ValueT<ContT>>);
}

// Returns true for characters that usually occur inside a numerical expression
// (see http://www.unicode.org/reports/tr14/tr14-43.html#IS)
constexpr bool isUtfInfixNumeric(Utf16Chr ch) {
    switch (ch) {
        case 0x002C:  // COMMA
        case 0x002E:  // FULL STOP
        case 0x003A:  // COLON
        case 0x003B:  // SEMICOLON
        case 0x037E:  // GREEK QUESTION MARK (canonically equivalent to 003B)
        case 0x0589:  // ARMENIAN FULL STOP
        case 0x060C:  // ARABIC COMMA
        case 0x060D:  // ARABIC DATE SEPARATOR
        case 0x07F8:  // NKO COMMA
        case 0x2044:  // FRACTION SLASH
        case 0xFE10:  // PRESENTATION FORM FOR VERTICAL COMMA
        case 0xFE13:  // PRESENTATION FORM FOR VERTICAL COLON
        case 0xFE14:  // PRESENTATION FORM FOR VERTICAL SEMICOLON
            return true;

        default:
            return false;
    }
}

// Handy function to help us not double append control characters, if the
// type is utf8 or utf16 it'll check if its one of the control character values
// all other type cause this function to return false
template <typename ChrT>
constexpr bool isControl(ChrT&& chr) noexcept {
    if constexpr (traits::IsSameTypeV<Utf8Chr, ChrT> ||
                  traits::IsSameTypeV<ChrT, Utf16Chr>) {
        switch (chr) {
            case '\n':
            case '\r':
            case '\t':
                return true;
            default:
                return false;
        }
    } else
        return false;
}

template <typename ChrT, typename = std::enable_if_t<traits::IsPodV<ChrT>>>
constexpr bool isHorizontalSpace(ChrT chr) noexcept {
    switch (chr) {
        case ' ':   // Space
        case '\t':  // Tab
            return true;

        default:
            if constexpr (sizeof(ChrT) >= 2) {
                switch (chr) {
                    case 0x00A0:  // NO-BREAK SPACE
                    case 0x1680:  // OGHAM SPACE MARK
                    case 0x2000:  // EN QUAD
                    case 0x2001:  // EM QUAD
                    case 0x2002:  // EN SPACE
                    case 0x2003:  // EM SPACE
                    case 0x2004:  // THREE-PER-EM SPACE
                    case 0x2005:  // FOUR-PER-EM SPACE
                    case 0x2006:  // SIX-PER-EM SPACE
                    case 0x2007:  // FIGURE SPACE
                    case 0x2008:  // PUNCTUATION SPACE
                    case 0x2009:  // THIN SPACE
                    case 0x200A:  // HAIR SPACE
                    case 0x202F:  // NARROW NO-BREAK SPACE
                    case 0x205F:  // MEDIUM MATHEMATICAL SPACE
                    case 0x3000:  // IDEOGRAPHIC SPACE
                        return true;
                }
            }
    }
    return false;
}

template <typename ContT,
          typename = std::enable_if_t<traits::IsStringOrContainerV<ContT>>>
bool isHorizontalSpace(const ContT& str) noexcept {
    return _allOf(str, isHorizontalSpace<typename traits::ValueT<ContT>>);
}

template <typename ChrT, typename = std::enable_if_t<traits::IsPodV<ChrT>>>
constexpr bool isVerticalSpace(ChrT chr) noexcept {
    switch (chr) {
        case '\f':  // Formfeed page break
        case '\n':  // Newline
        case '\r':  // Carriage return
        case '\v':  // Vertical tab
            return true;

        default:
            if constexpr (sizeof(ChrT) >= 2) {
                switch (chr) {
                    case 0x0085:  // NEXT LINE
                    case 0x2028:  // LINE SEPARATOR
                    case 0x2029:  // PARAGRAPH SEPARATOR
                        return true;
                }
            }
    }
    return false;
}

template <typename ContT,
          typename = std::enable_if_t<traits::IsStringOrContainerV<ContT>>>
bool isVerticalSpace(const ContT& str) noexcept {
    return _allOf(str, isVerticalSpace<typename traits::ValueT<ContT>>);
}

template <typename ChrT, typename = std::enable_if_t<traits::IsPodV<ChrT>>>
constexpr bool isSpace(ChrT chr) noexcept {
    return isHorizontalSpace(chr) || isVerticalSpace(chr);
}

template <typename ContT,
          typename = std::enable_if_t<traits::IsStringOrContainerV<ContT>>>
bool isSpace(const ContT& str) noexcept {
    return _allOf(str, isSpace<typename traits::ValueT<ContT>>);
}

// Given a string, creates a vector of views each delimited by a delimiter
// NOte: This api should only be used if you know what you are doing as
// the views will go invalid the moment the source string deconstruction.
template <typename ChrT, typename TraitsT>
inline auto tokenizeView(Str<ChrT, TraitsT>& str, ChrT delimiter) noexcept {
    return view::tokenizeVector<ChrT, TraitsT>(StrView<ChrT, TraitsT>{str},
                                               delimiter, {&delimiter, 1});
}

template <typename ChrT, typename TraitsT>
inline auto tokenizeView(Str<ChrT, TraitsT>& str, ChrT delimiter,
                         StrView<ChrT, TraitsT> trimChars) noexcept {
    return view::tokenizeVector<ChrT, TraitsT>(StrView<ChrT, TraitsT>{str},
                                               delimiter, trimChars);
}

}  // namespace ap::string
