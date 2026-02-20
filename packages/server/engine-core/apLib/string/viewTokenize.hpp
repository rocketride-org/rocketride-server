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

//
// 	Static StrView tokenization apis which allows for compile time parsing
//	of string views.
//
//	Original project used for inspiration:
//		https://github.com/simber/string_view-building-blocks
//
#pragma once

namespace ap::string::view {

// A split result is a little structure that holds the left and right
// portions of the split operation
template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
struct SplitResult {
    StrView<ChrT, TraitsT> left;
    StrView<ChrT, TraitsT> right;
};

template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
constexpr bool operator==(const SplitResult<ChrT, TraitsT>& lhs,
                          const SplitResult<ChrT, TraitsT>& rhs) noexcept {
    return lhs.left == rhs.left && lhs.right == rhs.right;
}

template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
inline std::ostream& operator<<(
    std::ostream& os, const SplitResult<ChrT, TraitsT>& splitted) noexcept {
    return os << splitted.left << " " << splitted.right;
}

// Splits the portions around the start and length size arguments
template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
constexpr auto splitAround(StrView<ChrT, TraitsT> input, size_t start,
                           size_t length) noexcept {
    return SplitResult<ChrT, TraitsT>{
        input.substr(0, start),
        input.substr(std::min(start + length, input.size()))};
}

// Splits the portions around the start and end of a substring
template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
constexpr SplitResult<ChrT, TraitsT> splitAround(
    StrView<ChrT, TraitsT> input, StrView<ChrT, TraitsT> sub) noexcept {
    auto subPos = input.find(sub);
    if (subPos == npos) return {};
    return SplitResult<ChrT, TraitsT>{input.substr(0, subPos),
                                      input.substr(subPos + sub.length())};
};

template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
constexpr auto splitAtPosition(StrView<ChrT, TraitsT> input,
                               size_t pos) noexcept {
    return splitAround(input, pos, 1);
}

template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
constexpr auto splitAtToken(StrView<ChrT, TraitsT> input, ChrT chr) noexcept {
    if (auto pos = input.find_first_of(chr); pos != npos)
        return splitAround(input, pos, 1);
    return SplitResult<ChrT, TraitsT>{input};
}

template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
constexpr auto splitAtToken(StrView<ChrT, TraitsT> input,
                            StrView<ChrT, TraitsT> token) noexcept {
    return splitAround(input, input.find_first_of(token), token.size());
}

namespace detail {

// Token state holds the current state of the next iteration in
// the token iterator
template <typename ChrT, typename TraitsT, typename SplitterT>
class TokenState {
public:
    using ViewType = StrView<ChrT, TraitsT>;

    constexpr TokenState() noexcept {}

    constexpr TokenState(ViewType input, SplitterT splitter) noexcept
        : m_data({ViewType(), input}), m_splitter(std::move(splitter)) {}

    constexpr ViewType token() const noexcept { return m_data.left; }

    constexpr ViewType remainder() const noexcept { return m_data.right; }

    constexpr bool empty() const noexcept {
        return remainder().empty() && token().empty();
    }

    constexpr void split() noexcept { m_data = m_splitter(remainder()); }

private:
    SplitResult<ChrT, TraitsT> m_data;
    SplitterT m_splitter;
};

}  // namespace detail

// The token iterator walks the string as each delimiter is located.
template <typename ChrT, typename TraitsT, typename SplitterT>
class TokenIter {
public:
    using ViewType = StrView<ChrT, TraitsT>;
    using value_type = ViewType;
    using difference_type = std::ptrdiff_t;
    using pointer = const ViewType*;
    using reference = ViewType;
    using iterator_category = std::forward_iterator_tag;
    using StateType = detail::TokenState<ChrT, TraitsT, SplitterT>;

    constexpr TokenIter() noexcept = default;

    constexpr TokenIter(ViewType input, SplitterT splitter)
        : m_state(input, std::move(splitter)) {
        advance();
    }

    constexpr reference operator*() const noexcept { return m_state.token(); }

    constexpr TokenIter& operator++() noexcept {
        advance();
        return *this;
    }

    constexpr TokenIter operator++(int) noexcept {
        TokenIter tmp = *this;
        advance();
        return tmp;
    }

    constexpr bool operator==(const TokenIter& rhs) const noexcept {
        return (!m_state.empty() && !rhs.m_state.empty())
                   ? (m_state.remainder().data() ==
                          rhs.m_state.remainder().data() &&
                      m_state.remainder().size() ==
                          rhs.m_state.remainder().size())
                   : (m_state.empty() == rhs.m_state.empty());
    }

    constexpr bool operator!=(const TokenIter& rhs) const noexcept {
        return !(*this == rhs);
    }

    constexpr bool valid() const noexcept { return m_state != nullptr; }

private:
    StateType m_state;

    constexpr void advance() noexcept { m_state.split(); }
};

// This structure takes a string view, and holds the resulting range
// for the tokenization to occur at
template <typename ChrT, typename TraitsT, typename SplitterT>
class TokenRange {
public:
    using iterator = TokenIter<ChrT, TraitsT, SplitterT>;
    using const_iterator = iterator;
    using ViewType = typename iterator::ViewType;

    constexpr TokenRange(ViewType view, SplitterT splitter) noexcept
        : m_begin(view, std::move(splitter)) {}

    constexpr auto begin() const noexcept { return m_begin; }
    constexpr auto end() const noexcept { return iterator(); }
    constexpr auto count() const noexcept {
        return std::distance(begin(), end());
    }

private:
    iterator m_begin;
};

// SingleSplitter just splits at a single delimiter
// position, no trimming on results
template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
class SingleSplitter {
public:
    using ViewType = StrView<ChrT, TraitsT>;

    constexpr SingleSplitter() noexcept : m_delimiter() {}

    constexpr SingleSplitter(ChrT delimiter) noexcept
        : m_delimiter(delimiter) {}

    constexpr auto operator()(ViewType input) const noexcept {
        return splitAtPosition(
            input, std::min(input.find_first_of(m_delimiter), input.size()));
    }

private:
    ChrT m_delimiter;
};

// SingleSplitterTrimmer does the work of breaking the string into two
// components based on the next token iterator chunk
template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
class SingleSplitterTrimmer {
public:
    using ViewType = StrView<ChrT, TraitsT>;

    constexpr SingleSplitterTrimmer() noexcept
        : m_whitespate(), m_delimiter() {}

    constexpr SingleSplitterTrimmer(ChrT delimiter,
                                    ViewType whitespace) noexcept
        : m_whitespate(whitespace), m_delimiter(delimiter) {}

    constexpr auto operator()(ViewType input) const noexcept {
        input = input.trimLeft(m_whitespate);
        auto splitted = splitAtPosition(
            input, std::min(input.find_first_of(m_delimiter), input.size()));
        splitted.left = splitted.left.trimRight(m_whitespate);
        return splitted;
    }

private:
    ViewType m_whitespate;
    ChrT m_delimiter;
};

// Tokenize and return a token range for manual iteration of results
// NO trimming of results
template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
constexpr auto tokenize(StrView<ChrT, TraitsT> view, ChrT delimiter) noexcept {
    return TokenRange<ChrT, TraitsT, SingleSplitter<ChrT, TraitsT>>{
        view, {delimiter}};
}

// Tokenize and return a token range for manual iteration of results
template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
constexpr auto tokenizeTrim(
    StrView<ChrT, TraitsT> view, ChrT delimiter,
    StrView<ChrT, TraitsT> whitespace = "\t\r\n ") noexcept {
    return TokenRange<ChrT, TraitsT, SingleSplitterTrimmer<ChrT, TraitsT>>{
        view, {delimiter, whitespace}};
}

// Tokenize breaks a string view into an array of string views, each
// separated by the original delimiter, and NO trimming done to results.
// This is the non constexpr version with a vector result
template <typename ChrT, typename TraitsT = std::char_traits<ChrT>>
auto tokenizeVector(StrView<ChrT, TraitsT> view, ChrT delimiter,
                    StrView<ChrT, TraitsT> trimChars = {}) noexcept {
    std::vector<StrView<ChrT, TraitsT>> result;

    auto loadResults = [&](auto&& range) {
        for (auto str : range) result.push_back({str.data(), str.size()});
    };

    if (trimChars) {
        auto range =
            TokenRange<ChrT, TraitsT, SingleSplitterTrimmer<ChrT, TraitsT>>{
                view, {delimiter, trimChars}};
        loadResults(range);
    } else {
        auto range = TokenRange<ChrT, TraitsT, SingleSplitter<ChrT, TraitsT>>{
            view, {delimiter}};
        loadResults(range);
    }

    return result;
}

// Tokenize breaks a string view into an array of string views, each
// separated by the original delimiter, and NO trimming done to results.
template <size_t Max, typename ChrT, typename TraitsT = std::char_traits<ChrT>>
constexpr auto tokenizeArray(StrView<ChrT, TraitsT> view,
                             ChrT delimiter) noexcept {
    static_assert(Max >= 1);

    // Construct a range which will
    auto range = TokenRange<ChrT, TraitsT, SingleSplitter<ChrT, TraitsT>>{
        view, {delimiter}};
    std::array<StrView<ChrT, TraitsT>, Max> result = {};
    size_t index = 0;
    size_t trailing = 0;
    for (auto str : range) {
        if (index < Max)
            result[index++] = {str.data(), str.size()};
        else
            trailing += str.size() + sizeof(ChrT);
    }
    if (trailing)
        result.back() = {result.back().data(), result.back().size() + trailing};
    return result;
}

// Tokenize breaks a string view into an array of string views, each
// separated by the original delimiter, and each trimmed of white space.
template <size_t Max, typename ChrT, typename TraitsT = std::char_traits<ChrT>>
constexpr auto tokenizeArrayTrim(
    StrView<ChrT, TraitsT> view, ChrT delimiter,
    StrView<ChrT, TraitsT> whitespace = "\t\r\n ") noexcept {
    // Construct a range which will
    auto range =
        TokenRange<ChrT, TraitsT, SingleSplitterTrimmer<ChrT, TraitsT>>{
            view, {delimiter, whitespace}};
    std::array<StrView<ChrT, TraitsT>, Max> result = {};
    size_t index = 0;
    for (auto str : range) {
        if (index < Max) result[index++] = {str.data(), str.size()};
    }
    return result;
}

// Compile time atoi, limited support use with caution, no hex or
// floating points are supported.
namespace detail {
constexpr bool isDigit(char c) noexcept { return c <= '9' && c >= '0'; }

constexpr int toInt(const char* str, int value = 0) noexcept {
    if (!*str) return value;
    if (isDigit(*str)) return toInt(str + 1, (*str - '0') + value * 10);
    return value;
}
}  // namespace detail

constexpr int toInt(const char* str) {
    // Hand off to the recursion version in the detail space
    return detail::toInt(str);
}

// Sometimes you just want the results in a vector, overload transform
// so we can plug into the _tr macro
template <typename ChrT, typename TraitsT, typename SplitT>
inline void __transform(TokenRange<ChrT, TraitsT, SplitT> range,
                        std::vector<StrView<ChrT, TraitsT>>& target) noexcept {
    target.clear();
    std::transform(range.begin(), range.end(), std::back_inserter(target),
                   [&](const auto& ti) { return ti; });
}

// This is a special use case for tokenization of inline macros that
// are declaring enumerations. It will detect strings after
// the trim which have a assignment in them, and parse the offset
// to move the position of that definition as needed.
//
// Example:
// 	_const auto EnumStr = tokanizeEnum<2, 12>(
// 		"john = 2,"
// 		"mark = 4,"
// 		"bob = 5"_tv,
// 	);
//
// 	EnumStr[2] == "john"
// 	EnumStr[4] == "mark"
// 	EnumStr[5] == "bob"
template <size_t Begin, size_t End, typename ChrT,
          typename TraitsT = std::char_traits<ChrT>>
constexpr auto tokenizeEnum(StrView<ChrT, TraitsT> view) noexcept {
    // Allocate a tokenizer and ready an array
    std::array<StrView<ChrT, TraitsT>, End> result = {};
    auto tokenizer = tokenizeTrim<ChrT, TraitsT>(view, ',');

    // Iterate the results
    size_t nextIndex = 0;
    for (auto entry : tokenizer) {
        // See if there's a = in there
        auto split = splitAtToken(entry, '=');
        auto right = split.right.trim(' ');
        auto left = split.left.trim(' ');

        // Ignore the magic begin one
        if (!right.empty()) {
            // Figure out the index
            if (right == "_begin")
                nextIndex = Begin;
            else
                nextIndex = toInt(right.data());
        }

        // Assign it and proceed
        if (nextIndex < result.size()) result[nextIndex++] = left;
    }

    return result;
}

// Cursor based extraction of enclosed strings, will not consider
// the delimiter character if it was preceded by an un-escaped backslash
// Note: The StrView arg secondDelim is passed directly to the find_ apis in
// StrView, which when given a string view consider _any_ of the individual
// characters and not the string as a whole
template <template <typename ChrT> typename TraitsT = Case>
inline StrView<char> extractNext(size_t& cursor, StrView<char> _str,
                                 char firstDelim,
                                 StrView<char> secondDelim) noexcept {
    // Wrap the callers view in another, with their requested trait
    StrView<char, TraitsT<char>> str{_str};

    // Resume where we left off
    auto start = cursor;

    auto locate = [&str](auto delim, auto start,
                         bool skipRedundant) noexcept -> Pair<size_t, size_t> {
        // Locate the first non escaped delimiter
        _forever() {
            // Sanity check
            if (start >= str.size()) return {string::npos, string::npos};

            // Locate the first position from the starting position
            start = str.find_first_of(delim, start);
            if (start == string::npos) return {string::npos, string::npos};

            // No need to check for escape if start is zero
            if (start == 0) break;

            // Next go in reverse and find the first non occurrence of a
            // backslash
            auto escapedPos = string::npos;
            for (auto ptr = str.data() + start - 1; ptr >= str.data(); --ptr) {
                // When we find a match we're done and this position is the
                // result
                if (*ptr != '\\') {
                    escapedPos = std::distance(str.data(), ptr);
                    break;
                }
            }

            // If we found one see how many back it was, if it was an odd number
            // of slashes then it wasn't escaped, say $ is our delim:
            //	   "\\\\$" is not escaped
            //		"\\\$" is escaped
            //	     "\\$" is not escaped
            //	      "\$" is escaped
            if (escapedPos != string::npos) {
                auto escCount = (start - 1) - escapedPos;
                if (!(escCount % 2)) break;
            }

            // Escaped, move to the next pos
            start++;
        }

        // Skip over either ALL consecutive delims or just one
        size_t skip = string::npos;
        if (skipRedundant) skip = str.find_first_not_of(delim, start + 1);

        if (skip && skip != string::npos) return {start, skip};
        return {start, start + 1};
    };

    // Locate the first delim, skipping redundant ones along the way. (They
    // would result in empty tokens, so we can ignore them.)
    auto [beg, begSkip] = locate(firstDelim, start, true);
    if (beg == string::npos) return {};
    if (begSkip != string::npos) beg = begSkip;

    // Now the second where the first left of, this time
    // do not skip redundant ones
    auto [end, skip] = locate(secondDelim, beg + 1, false);
    if (end == string::npos) return {};

    // Alright update the cursor at the end of the token
    // depending on if skip is set
    if (skip == string::npos)
        cursor = end;
    else
        cursor = skip;

    // And return a view to this portion of the token as a sub view
    return str.substr(beg, (end - beg));
}

template <template <typename ChrT> typename TraitsT = Case>
inline StrView<char> extractNext(size_t& cursor, StrView<char> _str,
                                 char firstDelim,
                                 Opt<char> secondDelim = {}) noexcept {
    auto second = secondDelim.value_or(firstDelim);
    return extractNext<TraitsT>(cursor, _str, firstDelim, {&second, 1});
}

}  // namespace ap::string::view
