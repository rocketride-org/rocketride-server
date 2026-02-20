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
//	Utility macros
//
#pragma once

// Help indirection for converting pre-processor bits to string
#define APUTIL_MAKE_STR(...) #__VA_ARGS__

// This macro declares the global overloads to allow for a range based for of
// the enum values use only with incrementing enum types, you must set _last and
// _end values for this to work the _end value should be the highest invalid
// value, only useful for contiguous enumeration values. example:
//		enum class MyEnum {
//			_begin,
//			Foo = _begin,
//			Bar,
//			_end
//		};
//	APUTIL_DEFINE_ENUM_ITER(MyEnum)
//
#define APUTIL_DEFINE_ENUM_ITER_COMMON(Declaration, T)                        \
                                                                              \
    Declaration T operator++(T &e) noexcept { return e = ::ap::EnumNext(e); } \
    Declaration T operator++(T &e, int) noexcept {                            \
        auto r = e;                                                           \
        e = ::ap::EnumNext(e);                                                \
        return r;                                                             \
    }                                                                         \
    Declaration T operator*(T e) noexcept { return e; }                       \
    Declaration T begin(T e) noexcept { return T::_begin; }                   \
    Declaration T end(T e) noexcept { return T::_end; }

#define APUTIL_DEFINE_ENUM_ITER(T) APUTIL_DEFINE_ENUM_ITER_COMMON(inline, T)

// This macro defines an enumeration, and then a static array of strings
// that it parses from the stringization of the entire variable argument
// set. This allows you to not only define offsets to enumerations midway
// through the definition, but it is also smart enough to parse the resulting
// strings and detect any offsets.
//
// Example:
// 	APUTIL_DEFINE_ENUM(MyEnum, 0, End, FIRST = _begin, SECOND = 10, THIRD = 11
//
// 	Once defined the following is true:
// 		MyEnum::FIRST = 0
// 		MyEnum::SECOND = 10
// 		MyEnum::THIRD = 11
// 		MyEnum::FOURTH
//
// 		MyEnumNames[0] == "FIRST"
// 		MyEnumNames[10] == "SECOND"
// 		MyEnumNames[11] == "THIRD"
// 		MyEnumNames[21] == "FOURTH"
// 		MyEnumNames.size() == 12
//
// The static array of names returned will use the string::NoChars trait
// for automatic case insensitivity checking, just make sure the
// level string is on the left size of your == check.
//
// Two forms of this macro exist, to facilitate stream overloads
// for converting the enum to a string we have to friend or inline
// depending on if the enum is declared within a class scope or not
// (APUTIL_DEFINE_ENUM_C) vs declaring it in a namespace scope
// (APUTIL_DEFINE_ENUM)
//
#define APUTIL_DEFINE_ENUM_COMMON(Declaration, EnumType, Name, Begin, End,   \
                                  ...)                                       \
                                                                             \
    EnumType Name : uint32_t{_begin = Begin, __VA_ARGS__, _end = End};       \
                                                                             \
    _const size_t Max##Name##s = End;                                        \
                                                                             \
    _const auto Name##Names = ::ap::string::view::tokenizeEnum<Begin, End>(  \
        ::ap::string::StrView<char, ::ap::string::NoCase<char>>{             \
            APUTIL_MAKE_STR(__VA_ARGS__)});                                  \
                                                                             \
    Declaration decltype(auto) operator<<(std::ostream &stream,              \
                                          const Name &arg) noexcept {        \
        return stream << Name##Names[EnumIndex(arg)];                        \
    }                                                                        \
                                                                             \
    Declaration decltype(auto) operator>>(std::istream &stream,              \
                                          Name &arg) noexcept(false) {       \
        std::string name;                                                    \
        stream >> name;                                                      \
        ::ap::string::StrView<char, ::ap::string::NoCase<char>> iname{name}; \
        if (auto pos =                                                       \
                std::find(Name##Names.begin(), Name##Names.end(), iname);    \
            pos != Name##Names.end()) {                                      \
            arg = EnumFrom<Name>(std::distance(Name##Names.begin(), pos));   \
            return stream;                                                   \
        }                                                                    \
        throw std::invalid_argument("Failed to map enum");                   \
    }                                                                        \
    APUTIL_DEFINE_ENUM_ITER_COMMON(Declaration, Name)

#define APUTIL_DEFINE_ENUM_C(Name, Begin, End, ...) \
    APUTIL_DEFINE_ENUM_COMMON(friend, enum class, Name, Begin, End, __VA_ARGS__)

#define APUTIL_DEFINE_ENUM(Name, Begin, End, ...) \
    APUTIL_DEFINE_ENUM_COMMON(inline, enum class, Name, Begin, End, __VA_ARGS__)

// This macro defines a bitmask enumeration, and enables bit operations
// on the values
#define APUTIL_DEFINE_ENUM_BITMASK_COMMON(Declaration, Name, Begin, End, ...) \
    APUTIL_DEFINE_ENUM_COMMON(Declaration, enum, Name, Begin, End,            \
                              __VA_ARGS__)                                    \
    /** Enable bitwise operators for this enum type */                        \
    inline Name operator|(Name lhs, Name rhs) noexcept {                      \
        using Underlying = std::underlying_type_t<Name>;                      \
        return static_cast<Name>(static_cast<Underlying>(lhs) |               \
                                 static_cast<Underlying>(rhs));               \
    }                                                                         \
    inline Name operator&(Name lhs, Name rhs) noexcept {                      \
        using Underlying = std::underlying_type_t<Name>;                      \
        return static_cast<Name>(static_cast<Underlying>(lhs) &               \
                                 static_cast<Underlying>(rhs));               \
    }                                                                         \
    inline Name operator^(Name lhs, Name rhs) noexcept {                      \
        using Underlying = std::underlying_type_t<Name>;                      \
        return static_cast<Name>(static_cast<Underlying>(lhs) ^               \
                                 static_cast<Underlying>(rhs));               \
    }                                                                         \
    inline Name operator~(Name rhs) noexcept {                                \
        using Underlying = std::underlying_type_t<Name>;                      \
        return static_cast<Name>(~static_cast<Underlying>(rhs));              \
    }                                                                         \
    inline bool operator!(Name rhs) noexcept {                                \
        return static_cast<std::underlying_type_t<Name>>(rhs) == 0;           \
    }                                                                         \
    DEFINE_BITMASK_OPERATORS()                                                \
    template <>                                                               \
    struct enable_bitmask_operators<Name> {                                   \
        static const bool enable = true;                                      \
    };

#define APUTIL_DEFINE_ENUM_BITMASK(Name, Begin, End, ...) \
    APUTIL_DEFINE_ENUM_BITMASK_COMMON(inline, Name, Begin, End, __VA_ARGS__)

#define APUTIL_DEFINE_ENUM_BITMASK_C(Name, Begin, End, ...) \
    APUTIL_DEFINE_ENUM_BITMASK_COMMON(friend, Name, Begin, End, __VA_ARGS__)
