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

// Converts a numeric value to hex, always zero fills to width
// of number, allows for prefxi toggle
template <typename Number>
inline Text toHex(Number number, FormatOptions options) noexcept {
    return toStringOptions(options + Format::HEX, number);
}

// Render a number as a human readable size
template <typename Number>
inline Text toHumanSize(Number size, size_t maxPrecision,
                        FormatOptions options) noexcept {
    const char *units[] = {"B", "kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"};

    int i = 0;
    while (size >= 1024 && i < sizeof(units) / sizeof(char *)) {
        size /= 1024;
        i++;
    }

    if (i == sizeof(units)) i--;

    if constexpr (std::is_floating_point_v<Number>)
        size = util::adjustPrecision(size, maxPrecision);

    return toStringOptions(options + Format::GROUP, size, units[i]);
}

// Render a number as a human readable count
template <typename Number>
inline Text toHumanCount(Number value, FormatOptions options) noexcept {
    return toStringOptions(options + Format::GROUP, value);
}

// Lower cases a string cpy
inline Text lowerCase(TextView str) noexcept { return str.lowerCase<Text>(); }

// Upper cases a string cpy
inline Text upperCase(TextView str) noexcept { return str.upperCase<Text>(); }

// Lower cases a character, only works for ascii types
template <typename ChrT>
inline ChrT toLower(ChrT chr) noexcept {
    return (ChrT)::tolower(chr);
}

// Upper cases a character, only works for ascii types
template <typename ChrT>
inline ChrT toUpper(ChrT chr) noexcept {
    return (ChrT)::toupper(chr);
}

// Compares two characters
template <template <typename ChrT> typename TraitT, typename ChrT>
inline int compare(ChrT lhs, ChrT rhs) noexcept {
    return TraitT<ChrT>::compare(&lhs, &rhs, 1);
}

// Checks if a character is between two characters (inclusive)
template <template <typename ChrT> typename TraitT, typename ChrT>
inline bool inRangeInclusive(ChrT start, ChrT subject, ChrT end) noexcept {
    return isGreaterEqual<TraitT>(subject, start) &&
           isLessEqual<TraitT>(subject, end);
}

// Checks if a character is between two characters (exclusive)
template <template <typename ChrT> typename TraitT, typename ChrT>
inline bool inRangeExclusive(ChrT start, ChrT subject, ChrT end) noexcept {
    return isGreater<TraitT>(subject, start) && isLess<TraitT>(subject, end);
}

// Check if one character is same then many
template <template <typename ChrT> typename TraitT, typename ChrT,
          typename... ChrTs>
inline bool isEqual(ChrT left, ChrTs... right) noexcept {
    // Fold into a array
    std::array<ChrT, sizeof...(ChrTs)> rights = {right...};

    // And check if they all equate to == 0
    return util::allOf(rights, [&](const auto &r) noexcept {
        return TraitT<ChrT>::eq(left, r);
    });
}

// Check if one character is less then many
template <template <typename ChrT> typename TraitT, typename ChrT,
          typename... ChrTs>
inline bool isLess(ChrT left, ChrTs... right) noexcept {
    // Fold into a array
    std::array<ChrT, sizeof...(ChrTs)> rights = {right...};

    // And check if they all equate to < 0
    return util::allOf(rights, [&](const auto &r) noexcept {
        return TraitT<ChrT>::compare(&left, &r, 1) < 0;
    });
}

// Check if one character is greater then many
template <template <typename ChrT> typename TraitT, typename ChrT,
          typename... ChrTs>
inline bool isGreater(ChrT left, ChrTs... right) noexcept {
    // Fold into a array
    std::array<ChrT, sizeof...(ChrTs)> rights = {right...};

    // And check if they all equate to > 0
    return util::allOf(rights, [&](const auto &r) noexcept {
        return TraitT<ChrT>::compare(&left, &r, 1) > 0;
    });
}

// Check if one character is less or equal then many
template <template <typename ChrT> typename TraitT, typename ChrT,
          typename... ChrTs>
inline bool isLessEqual(ChrT left, ChrTs... right) noexcept {
    // Fold into a array
    std::array<ChrT, sizeof...(ChrTs)> rights = {right...};

    // And check if they all equate to <= 0
    return util::allOf(rights, [&](const auto &r) noexcept {
        return TraitT<ChrT>::compare(&left, &r, 1) <= 0;
    });
}

// Check if one character is greater then or equal many
template <template <typename ChrT> typename TraitT, typename ChrT,
          typename... ChrTs>
inline bool isGreaterEqual(ChrT left, ChrTs... right) noexcept {
    // Fold into a array
    std::array<ChrT, sizeof...(ChrTs)> rights = {right...};

    // And check if they all equate to >= 0
    return util::allOf(rights, [&](const auto &r) noexcept {
        return TraitT<ChrT>::compare(&left, &r, 1) >= 0;
    });
}

// Enclose a string within one or two delimiters
inline Text enclose(TextView str, TextChr firstDelim,
                    TextChr secondDelim) noexcept {
    return str.enclose<Text>(firstDelim, secondDelim);
}

inline Text enclose(TextChr chr, TextChr firstDelim,
                    TextChr secondDelim) noexcept {
    return enclose({&chr, 1}, firstDelim, secondDelim);
}

// Extracts a string delimited by a leading and trailing delimiter
inline Text extract(TextView str, TextChr firstDelim, TextChr secondDelim,
                    bool caseAware) noexcept {
    return str.extractEnclosed<Text>(firstDelim, secondDelim, caseAware);
}

// Split a string into a series of components
template <typename ContainerT>
inline ContainerT split(TextView str, TextView delim, bool includeEmpty,
                        Opt<size_t> max, bool caseAware) noexcept {
    return str.split<ContainerT>(delim, includeEmpty, max, caseAware);
}

inline Text joinVector(TextView delim,
                       const std::vector<Text> &comps) noexcept {
    Text result;
    for (auto &comp : comps) {
        if (result) result += delim;
        result += comp;
    }
    return result;
}

// Join a series of strings into a single string using a delimiter
template <typename ContainerT>
inline Text concat(const ContainerT &parts, TextView delim,
                   bool includeEmpty) noexcept {
    static_assert(traits::IsSequenceContainerV<ContainerT>,
                  "Must be a sequence container");
    Text retval;
    for (auto &part : parts) {
        if (part.empty() && !includeEmpty) continue;

        if (!retval.empty()) retval += delim;
        retval += part;
    }

    return retval;
}

// Finds a sub string
inline size_t find(TextView str, TextView token, bool caseAware) noexcept {
    if (!token) return npos;
    if (caseAware) return str.find(token);
    return iTextView{str.data(), str.size()}.find(iTextView{token});
}

// Adds leading string if present
inline Text addLeading(TextView str, TextView leading,
                       bool caseAware) noexcept {
    if (!startsWith(str, leading, caseAware)) return Text{leading} + str;
    return str;
}

// Adds trailing string if present
inline Text addTrailing(TextView str, TextView trailing,
                        bool caseAware) noexcept {
    if (!endsWith(str, trailing, caseAware)) return Text{str} + trailing;
    return str;
}

// Remove one or more tokens from this string.
template <typename... Tokens>
inline Text remove(TextView str, Opt<bool> caseAware,
                   Tokens &&...tokens) noexcept {
    return Text{str}.remove(caseAware, std::forward<Tokens>(tokens)...);
}

// Remove one or more tokens from this string.
template <typename... Tokens>
inline Text remove(TextView str, Tokens &&...tokens) noexcept {
    return remove(str, {}, std::forward<Tokens>(tokens)...);
}

// Removes leading string if present
inline Text removeLeading(TextView str, TextView leading,
                          bool caseAware) noexcept {
    Text res = str;
    while (find(res, leading, caseAware) == 0) res = res.substr(leading.size());
    return res;
}

// Removes trailing string if present
inline Text removeTrailing(TextView str, TextView trailing,
                           bool caseAware) noexcept {
    Text res = str;
    while (endsWith(res, trailing, caseAware))
        res = res.substr(0, str.size() - trailing.size());
    return res;
}

// Trims characters from the front of the string
inline Text trimLeading(TextView str, InitList<char> leading,
                        bool caseAware) noexcept {
    return str.trimLeading<Text>(leading, caseAware);
}

// Trims trailing characters
inline Text trimTrailing(TextView str, InitList<char> trailing,
                         bool caseAware) noexcept {
    return str.trimTrailing<Text>(trailing, caseAware);
}

// Compares two strings
inline bool equals(TextView str, TextView other, bool caseAware) noexcept {
    return str.equals(other, caseAware);
}

// Checks if a string starts with another
inline bool startsWith(TextView str, TextView leading,
                       bool caseAware) noexcept {
    return str.startsWith(leading, caseAware);
}

// Checks if a string ends with another
inline bool endsWith(TextView str, TextView trailing, bool caseAware) noexcept {
    return str.endsWith(trailing, caseAware);
}

// Checks if the string ends in a control character, also smart enough to detect
// a trailing color value as well
inline bool endsWithControlOrColor(TextView str) noexcept {
    if (str.empty()) return false;
    if (isControl(str.back())) return true;
    for (auto c : Color{}) {
        if (str.endsWith(colorCode(c))) return true;
    }
    return false;
}

// Slices a string into two at a delimiter
template <typename F, typename S>
inline Pair<F, S> slice(TextView str, TextView delim, bool caseAware,
                        bool retainDelimInFirst) noexcept {
    auto [first, second] = str.slice(delim, caseAware, retainDelimInFirst);
    static_assert(!traits::IsStrViewV<F> && !traits::IsStrViewV<S>,
                  "Cannot extract a view from another view");
    return Pair<F, S>{_mv(first), _mv(second)};
}

// Replace a string portion with another string portion
inline Text replace(TextView str, TextView token, TextView replacement,
                    bool caseAware) noexcept {
    return str.replace<Text>(token, replacement, caseAware);
}

// Build a string composed of a repetative value
inline Text repeat(TextView val, size_t count) noexcept {
    Text result;
    result.reserve(val.size() * count);
    for (auto i = 0; i < count; i++) result += val;
    return result;
}

}  // namespace ap::string
