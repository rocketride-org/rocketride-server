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

namespace ap::string {

// Expandable array of generic Str type strings
template <typename CharT, typename TraitT = std::char_traits<CharT>,
          typename AllocT = std::allocator<CharT>>
class StrVector : public std::vector<Str<CharT, TraitT, AllocT>> {
    using StringType = Str<CharT, TraitT, AllocT>;
    using CharType = CharT;

    // The base of this class
    using Base = std::vector<StringType>;

public:
    // Public declarations
    using Base::begin;
    using Base::end;

    // Default construction
    StrVector() = default;

    // Initializer list construction
    StrVector(std::initializer_list<StringType> list) noexcept : Base(list) {}

    // Move/copy constructors
    StrVector(StrVector &&vec) noexcept : Base(_mv(vec)) {}

    StrVector(const StrVector &vec) noexcept : Base(vec) {}

    // Move/copy assignment operators
    decltype(auto) operator=(StrVector &&other) noexcept {
        if (this != &other) Base::operator=(_mv(other));
        return *this;
    }

    decltype(auto) operator=(const StrVector &other) noexcept {
        if (this != &other) Base::operator=(other);
        return *this;
    }

    // Constructors from base vector type
    StrVector(std::vector<StringType> &&vec) noexcept : Base(_mv(vec)) {}

    StrVector(const std::vector<StringType> &vec) noexcept : Base(vec) {}

    // Assignment from base vector type
    decltype(auto) operator=(std::vector<StringType> &&vec) noexcept {
        if (this != &vec) Base::operator=(_mv(vec));
        return *this;
    }

    decltype(auto) operator=(const std::vector<StringType> &vec) noexcept {
        if (this != &vec) Base::operator=(vec);
        return *this;
    }

    // Assignment from disparate types
    template <typename Character, typename Traits, typename Allocator>
    decltype(auto) operator=(
        const StrVector<Character, Traits, Allocator> &vec) noexcept {
        util::transform(*this, vec);
        return *this;
    }

    // Joins all characters in the vector with a delimiter
    StringType join(const CharType chr) const {
        StringType str;

        // Loop through the elements
        for (unsigned int index = 0; index < this->size(); index++) {
            // If this is not the first, add a seperator
            if (index) str += chr;

            // Add this element
            str += this->at(index);
        }

        // Return what we build
        return str;
    }

    // Sorts the given text vector
    void sort(void) noexcept {
        // Sort the strings
        std::sort(begin(), end(),
                  [](const auto &a, const auto &b) { return a < b; });
    }

    // Finds a string in this vector
    int indexOf(const StringType &find) const noexcept {
        // Loop through the elements and locate it
        if (auto iter =
                std::find_if(begin(), end(),
                             [&find](const auto &str) { return str == find; });
            iter != end())
            return numericCast<int>(std::distance(begin(), iter));

        // Nope, not found
        return -1;
    }
};

}  // namespace ap::string

namespace ap {
// This ones been pretty popular and has legacy usage so declare it in
// ap space so it just works
using TextVector = string::StrVector<TextChr>;
using iTextVector = string::StrVector<TextChr, string::NoCase<TextChr>>;

namespace traits {
// Ensure we get treated like a vector everywhere
template <typename... Types>
struct IsVector<string::StrVector<Types...>> {
    static constexpr bool value = true;
};
}  // namespace traits
}  // namespace ap
