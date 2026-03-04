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
//	Enumeration utilities
//
#pragma once

namespace ap {

// These simple templates handle the conversion to and from
// class enums, by convention all our class enums have two
// tags embedded in them to help these apis out, _last, and _first.
// By having these we can use the enums in interesting ways
// as they are never ambiguously inferred, for example
// you can programatically enumerate all the available Log::Lvls
// enums and pring out their strings, without anything more
// then the level enumeration definition and these apis.
// @usage
//
// for (auto i = EnumFirst<Lvl>; i < EnumLast<Lvl>; i++) {
// 	// Make the enum value into an integer of its underlying type
// 	auto enumValue = EnumFrom<Lvl>(i);
//
// 	// Convert enumValue back from an integer, to its enum
// 	auto indexValue = EnumIndex(enumValue);
// }
template <typename Type, typename = std::enable_if_t<std::is_enum_v<Type>>>
static constexpr auto EnumBegin =
    _cast<std::underlying_type_t<Type>>(Type::_begin);

template <typename Type, typename = std::enable_if_t<std::is_enum_v<Type>>>
static constexpr auto EnumEnd = _cast<std::underlying_type_t<Type>>(Type::_end);

template <typename Type, typename Index,
          typename = std::enable_if_t<std::is_enum_v<Type>>>
static constexpr Type EnumFrom(Index index) noexcept {
    return _cast<Type>(index);
}

template <typename To, typename Type,
          typename = std::enable_if_t<std::is_enum_v<Type>>>
static constexpr To EnumTo(Type op) noexcept {
    static_assert(sizeof(To) >= sizeof(std::underlying_type_t<Type>),
                  "Narrow cast not allowed for enum");
    return _cast<To>(op);
}

template <typename Type, typename = std::enable_if_t<std::is_enum_v<Type>>>
static constexpr auto EnumIndex(Type op) noexcept {
    return _cast<std::underlying_type_t<Type>>(op);
}

template <typename Type, typename = std::enable_if_t<std::is_enum_v<Type>>>
static constexpr auto EnumNext(Type op) noexcept {
    return EnumFrom<Type>(EnumIndex(op) + 1);
}

}  // namespace ap
