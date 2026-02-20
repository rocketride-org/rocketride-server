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
//	String api
//
#pragma once

namespace ap::string {

// The immutable string api, this api exists a we want to re-use these
// algorithms in both our Str and StrView classes, across all specializations.
// These apis are also a way to use an immutable approach to string operations.
//
// Note these apis are not exactly easy to use stand alone, they are meant
// to provide maximum flexibility and code re-use between the Str and StrView
// classes.
template <typename ChrT, typename TraitsT, typename AllocT,
          typename CompareTraitsT = TraitsT>
struct StrApi {
    // Some handy aliases to save our fingers
    using CharacterType = ChrT;
    using AllocatorType = AllocT;
    using TraitsType = TraitsT;
    using CompareTraitsType = CompareTraitsT;
    using ViewType = std::basic_string_view<CharacterType, TraitsType>;
    using CompareViewType =
        std::basic_string_view<CharacterType, CompareTraitsType>;
    using StringType =
        std::basic_string<CharacterType, TraitsType, AllocatorType>;
    _const auto npos = StringType::npos;

    // Convert a string view to a lower case string object
    template <typename StrTypeT = StringType>
    static auto toLower(ViewType str,
                        const AllocatorType &allocator = {}) noexcept {
        // Construct the result and use the allocator given
        StrTypeT result(allocator);

        // Empty views will crash us so don't do anything if its empty
        if (str.empty()) return result;

        result.reserve(str.size());

        // Loop through all the chars in the string and append the lower case
        // version to the result
        for (auto &chr : str)
            result += _nc<typename StrTypeT::value_type>(::tolower(chr));

        return result;
    }

    // Convert a string view to a upper case string object
    template <typename StrTypeT = StringType>
    static auto toUpper(ViewType str,
                        const AllocatorType &allocator = {}) noexcept {
        // Construct the result and use the allocator given
        StrTypeT result(allocator);

        // Empty views will crash us so don't do anything if its empty
        if (str.empty()) return result;

        // Loop through all the chars in the string and append the upper case
        // version to the result
        result.reserve(str.size());

        for (auto &chr : str)
            result += _nc<typename StrTypeT::value_type>(::toupper(chr));

        return result;
    }

    // Extract an enclosed portion of the string, between two
    // delimiters
    template <typename StrTypeT = StringType>
    static auto extractEnclosed(ViewType str, CharacterType leadingDelim,
                                CharacterType trailingDelim = '\0',
                                const AllocatorType &allocator = {}) noexcept {
        if (!trailingDelim) trailingDelim = leadingDelim;

        // Construct the result and use the allocator given
        StrTypeT result(allocator);

        // Empty views will crash us so don't do anything if its empty
        if (str.empty()) return result;

        result.reserve(str.size());

        // Locate leading and trailing
        auto isLeadingDelim = [&](const auto &chr) noexcept {
            return CompareTraitsType::compare(&chr, &leadingDelim, 1) == 0;
        };
        auto isTrailingDelim = [&](const auto &chr) noexcept {
            return CompareTraitsType::compare(&chr, &trailingDelim, 1) == 0;
        };

        // If either leading or trailing are not found, return hte string as is
        auto firstDelim = std::find_if(str.begin(), str.end(), isLeadingDelim);
        if (firstDelim == str.end())
            return result.assign(str.begin(), str.end());

        auto lastDelim =
            std::find_if(str.rbegin(), str.rend(), isTrailingDelim);
        if (lastDelim == str.rend())
            return result.assign(str.begin(), str.end());

        // If the trailing was found before the leading, just return the
        // unmodified string as we'll treat this as an invalid request
        auto firstIndex = std::distance(str.begin(), firstDelim);
        auto secondIndex = std::distance(begin(str), lastDelim.base()) - 1;
        if (firstIndex >= secondIndex)
            return result.assign(str.begin(), str.end());

        return result.assign(std::next(firstDelim),
                             std::prev(lastDelim.base()));
    }

    // Enclose a string within one or two delimiters
    template <typename StrTypeT = StringType>
    static auto enclose(ViewType str, CharacterType leadingDelim,
                        CharacterType trailingDelim = '\0',
                        const AllocatorType &allocator = {}) noexcept {
        StrTypeT result(allocator);

        if (!trailingDelim) trailingDelim = leadingDelim;

        if (!leadingDelim) return result.assign(str.begin(), str.end());

        if (!startsWith(str, leadingDelim)) result = leadingDelim;

        result += str;
        if (!endsWith(str, trailingDelim)) result += trailingDelim;

        return result;
    }

    // Remove any matching characters, leading on the string
    template <typename StrTypeT = StringType>
    static auto trimLeading(ViewType str,
                            std::initializer_list<CharacterType> charSet =
                                {'\t', '\n', '\r', ' ', '\0'},
                            const AllocatorType &allocator = {}) noexcept {
        StrTypeT result(allocator);

        if (str.empty()) return result;

        // Locate the first position that doesn't match any of our whitespace
        // chars
        auto iter = str.begin();
        for (; iter != str.end(); iter++) {
            auto isWhitespace =
                std::any_of(charSet.begin(), charSet.end(),
                            [&](const auto &setChr) noexcept {
                                return CompareTraitsType::compare(
                                           &(*iter), &setChr, 1) == 0;
                            });
            if (!isWhitespace) break;
        }

        // Copy the remaining
        result.reserve(std::distance(iter, str.end()));
        std::transform(iter, str.end(), std::back_inserter(result),
                       [](const auto &chr) { return chr; });
        return result;
    }

    // Remove any matching characters, trailing on the string
    template <typename StrTypeT = StringType>
    static auto trimTrailing(ViewType str,
                             std::initializer_list<CharacterType> charSet =
                                 {'\t', '\n', '\r', ' ', '\0'},
                             const AllocatorType &allocator = {}) noexcept {
        StrTypeT result(allocator);

        if (str.empty()) return result;

        // Locate the first position, in reverse, that doesn't match any of our
        // whitespace chars
        auto iter = str.rbegin();
        for (; iter != str.rend(); iter++) {
            auto isWhitespace =
                std::any_of(charSet.begin(), charSet.end(),
                            [&](const auto &setChr) noexcept {
                                return CompareTraitsType::compare(
                                           &(*iter), &setChr, 1) == 0;
                            });
            if (!isWhitespace) break;
        }

        // Copy the remaining
        result.reserve(std::distance(str.begin(), iter.base()));
        std::transform(str.begin(), iter.base(), std::back_inserter(result),
                       [](const auto &chr) { return chr; });
        return result;
    }

    // Remove any matching characters, trailing and leading on the string
    template <typename StrTypeT = StringType>
    static auto trim(ViewType str,
                     std::initializer_list<CharacterType> charSet = {'\t', '\n',
                                                                     '\r', ' ',
                                                                     '\0'},
                     const AllocatorType &allocator = {}) noexcept {
        return trimTrailing<StrTypeT>(
            trimLeading<StrTypeT>(str, charSet, allocator), charSet, allocator);
    }

    // Count occurrences of one or more characters or strings in a string
    template <typename... Tokens>
    static auto count(ViewType str, Tokens &&...tokens) noexcept {
        // Create a little lambda to count either characters, or string
        // occurrences
        auto counter = [&](const auto &token) noexcept {
            if constexpr (std::is_same_v<std::decay_t<decltype(token)>,
                                         CharacterType>) {
                size_t occurrences = 0;
                size_t start = 0;
                while ((start = str.find({&token, 1}, start)) != npos) {
                    ++occurrences;
                    start++;
                }
                return occurrences;
            } else {
                size_t occurrences = 0;
                size_t start = 0;
                while ((start = str.find({token.data(), token.size()},
                                         start)) != npos) {
                    ++occurrences;
                    start += token.length();
                }
                return occurrences;
            }
        };

        // Expand the parameter pack, and apply the + operator on all the
        // results
        return (counter(std::forward<Tokens>(tokens)) + ...);
    }

    // See if the string ends with some other string
    static auto endsWithView(ViewType str, ViewType trailing) noexcept {
        if (str.empty() || trailing.empty() || trailing.size() > str.size())
            return false;

        return CompareTraitsType::compare(&str.at(str.size() - trailing.size()),
                                          trailing.data(),
                                          trailing.size()) == 0;
    }

    template <typename T>
    static auto endsWith(ViewType str, T &&trailing) noexcept {
        if constexpr (std::is_convertible_v<T, CharacterType>) {
            return endsWithView(str, {&trailing, 1});
        } else if constexpr (traits::IsSameTypeV<T, ViewType>) {
            return endsWithView(str, trailing);
        } else if constexpr (traits::IsSameTypeV<T, CompareViewType>) {
            return endsWithView(str, {trailing.data(), trailing.size()});
        } else if constexpr (std::is_base_of_v<T, ViewType> ||
                             std::is_base_of_v<T, CompareViewType>) {
            return endsWithView(str, {trailing.data(), trailing.size()});
        } else if constexpr (std::is_convertible_v<T, const CharacterType *>) {
            return endsWithView(str,
                                static_cast<const CharacterType *>(trailing));
        } else {
            return endsWithView(str, {trailing.data(), trailing.size()});
        }
    }

    // See if the string starts with some other string
    constexpr static auto startsWithView(ViewType str,
                                         ViewType leading) noexcept {
        if (leading.empty() || leading.size() > str.size()) return false;

        return CompareTraitsType::compare(str.data(), leading.data(),
                                          leading.size()) == 0;
    }

    template <typename T>
    constexpr static auto startsWith(ViewType str, T &&leading) noexcept {
        if constexpr (std::is_convertible_v<T, CharacterType>) {
            return startsWithView(str, {&leading, 1});
        } else if constexpr (traits::IsSameTypeV<T, ViewType>) {
            return startsWithView(str, leading);
        } else if constexpr (traits::IsSameTypeV<T, CompareViewType>) {
            return startsWithView(str, {leading.data(), leading.size()});
        } else if constexpr (std::is_base_of_v<T, ViewType> ||
                             std::is_base_of_v<T, CompareViewType>) {
            return startsWithView(str, {leading.data(), leading.size()});
        } else if constexpr (std::is_convertible_v<T, const CharacterType *>) {
            return startsWithView(str,
                                  static_cast<const CharacterType *>(leading));
        } else {
            return startsWithView(str, {leading.data(), leading.size()});
        }
    }

    // See if the string contains another
    static auto containsView(ViewType str, ViewType inner) noexcept {
        CompareViewType _str{str.data(), str.size()};
        CompareViewType _inner{inner.data(), inner.size()};
        return _str.find(_inner) != npos;
    }

    template <typename T>
    static auto contains(ViewType str, T &&inner) noexcept {
        if constexpr (std::is_convertible_v<T, CharacterType>) {
            return containsView(str, {&inner, 1});
        } else if constexpr (traits::IsSameTypeV<T, ViewType>) {
            return containsView(str, inner);
        } else if constexpr (traits::IsSameTypeV<T, CompareViewType>) {
            return containsView(str, {inner.data(), inner.size()});
        } else if constexpr (std::is_base_of_v<T, ViewType> ||
                             std::is_base_of_v<T, CompareViewType>) {
            return containsView(str, {inner.data(), inner.size()});
        } else if constexpr (std::is_convertible_v<T, const CharacterType *>) {
            return containsView(str, static_cast<const CharacterType *>(inner));
        } else {
            return containsView(str, {inner.data(), inner.size()});
        }
    }

    // Remove one or more tokens from a string
    template <typename StrTypeT, typename... Tokens>
    static auto remove(ViewType _str, const AllocatorType &allocator,
                       Tokens &&...tokens) noexcept {
        StrTypeT result(_str.begin(), _str.end(), allocator);

        if (_str.empty()) return result;

        auto removeField = [&](const auto &field) noexcept {
            Opt<size_t> fieldSize;
            _forever() {
                // Bootstrap to the comparison trait they requested
                auto str = CompareViewType{result.data(), result.size()};

                // Find the token
                size_t pos;
                if constexpr (traits::IsDetectedExact<size_t,
                                                      traits::DetectSizeMethod,
                                                      decltype(field)>{})
                    pos = str.find({field.data(), field.size()}, 0);
                else
                    pos = str.find(field, 0);

                // If not found, bail
                if (pos == npos) return;

                // If we haven't determined the size of the token yet, do so now
                if (!fieldSize) {
                    if constexpr (traits::IsDetectedExact<
                                      size_t, traits::DetectSizeMethod,
                                      decltype(field)>{})
                        fieldSize = field.size();
                    else if constexpr (std::is_convertible_v<
                                           decltype(field),
                                           const CharacterType *>)
                        fieldSize = TraitsType::length(
                            static_cast<const CharacterType *>(field));
                    else if constexpr (traits::IsSameTypeV<CharacterType,
                                                           decltype(field)>)
                        fieldSize = 1;
                    else
                        static_assert(sizeof(field) == 0,
                                      "Unsupported argument for remove");
                }

                // If the token is empty, bail (otherwise, we'll loop
                // infinitely)
                if (!fieldSize.value()) break;

                // Remove the token
                result.erase(pos, fieldSize.value());
            }
        };

        (removeField(std::forward<Tokens>(tokens)), ...);

        return result;
    }

    // Split a string into a series of components
    template <typename ContainerT>
    static auto split(ViewType _str, ViewType delim, bool includeEmpty = false,
                      Opt<size_t> max = {},
                      const AllocatorType &allocator = {}) noexcept {
        // Bootstrap to the comparison trait they requested
        auto str = CompareViewType{_str.data(), _str.size()};

        // Ready the result and reserve
        ContainerT result;
        result.reserve(count(_str, delim) + 1);

        size_t start = 0, next = 0;
        while ((next = str.find({delim.data(), delim.size()}, next)) != npos) {
            if (next != start) {
                result.emplace_back(str.begin() + start, str.begin() + next,
                                    allocator);
                if (includeEmpty && next + delim.length() == str.size() &&
                    endsWith(_str, delim)) {
                    result.emplace_back(allocator);
                    return result;
                }
            } else if (includeEmpty)
                result.emplace_back(allocator);
            next = next + delim.length();
            start = next;
        }

        if (start != _str.size())
            result.emplace_back(_str.substr(start), allocator);

        return result;
    }

    template <typename ContainerT>
    static auto split(ViewType str, CharacterType delim,
                      bool includeEmpty = false, Opt<size_t> max = {},
                      const AllocatorType &allocator = {}) noexcept {
        return split<ContainerT>(str, {&delim, 1}, includeEmpty, max,
                                 allocator);
    }

    // Slices a string into two strings
    constexpr static auto slice(ViewType _str, ViewType delim,
                                bool retainDelimInFirst = false) noexcept {
        // Bootstrap to the comparison trait they requested
        auto str = CompareViewType{_str.data(), _str.size()};

        // Locate the delimiter, if not found the result is just a first
        // with the string value, and an empty second
        auto pos = str.find({delim.data(), delim.size()}, 0);
        if (pos == npos)
            return Pair<ViewType, ViewType>{{str.data(), str.size()}, {}};

        // Chop the string in two and account for the delimiter length
        auto first =
            str.substr(0, retainDelimInFirst ? pos + delim.size() : pos);
        auto second = str.substr(pos + delim.size());

        // Coax c++ into constructing the resulting pair from our comparison
        // view types
        return Pair<ViewType, ViewType>{{first.data(), first.size()},
                                        {second.data(), second.size()}};
    }

    constexpr static auto slice(ViewType str, CharacterType delim,
                                bool retainDelimInFirst = false) noexcept {
        return slice(str, {&delim, 1}, retainDelimInFirst);
    }

    // Replace a string portion with another string portion
    template <typename StrTypeT = StringType>
    static auto replace(ViewType _str, ViewType token, ViewType replacement,
                        const AllocatorType &allocator = {}) noexcept {
        // Bootstrap to the comparison trait they requested
        auto str = CompareViewType{_str.data(), _str.size()};

        // Ready the result
        StrTypeT result(_str.begin(), _str.end(), allocator);

        if (token.empty() || result.empty()) return result;

        size_t pos = 0, offset = 0;
        int total = 0;
        _forever() {
            pos = str.find({token.data(), token.size()}, pos);
            if (pos == npos) break;

            result.replace(pos + offset, token.size(), replacement);
            pos += token.size();
            if (replacement.size() > token.size())
                offset += replacement.size() - token.size();
            else
                offset -= token.size() - replacement.size();
            total++;
        }

        return result;
    }

    // Checks if two strings are equal
    static auto equals(ViewType left, ViewType right) noexcept {
        if (left.empty() || right.empty()) return false;
        if (left.size() != right.size()) return false;

        return CompareTraitsType::compare(left.data(), right.data(),
                                          right.size()) == 0;
    }
};

}  // namespace ap::string
