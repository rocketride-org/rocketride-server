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
//	The apravai string class
//
#pragma once

namespace ap::string {

// This is a generic specialization of std::basic_string which is used to
// enable functionality that does not come in the standard, namely conversions
// to and from TextView, auto encoding conversions using thread local data
// and automatic construction from different encoding types including
// type generic size detection to allow for disparate integral types
template <typename Character, typename Traits = Case<Character>,
          typename Allocator = std::allocator<Character>>
class Str : public std::basic_string<Character, Traits, Allocator> {
public:
    using Chr = Character;
    using CharacterType = Character;
    using AllocatorType = Allocator;
    using TraitsType = Traits;
    using Parent = std::basic_string<CharacterType, TraitsType, AllocatorType>;

    using ViewType = StrView<CharacterType, TraitsType>;
    using ThisType = Str<CharacterType, TraitsType, AllocatorType>;
    using SizeType = typename Parent::size_type;

    // Api implementation aliases
    using Api = ::ap::string::StrApi<CharacterType, TraitsType, AllocatorType>;
    using NoCaseApi =
        ::ap::string::StrApi<CharacterType, TraitsType, AllocatorType,
                             NoCase<CharacterType>>;
    using CaseApi = ::ap::string::StrApi<CharacterType, TraitsType,
                                         AllocatorType, Case<CharacterType>>;

    // Expected STL types
    using Parent::npos;
    using typename Parent::allocator_type;
    using typename Parent::const_pointer;
    using typename Parent::const_reference;
    using typename Parent::difference_type;
    using typename Parent::pointer;
    using typename Parent::reference;
    using typename Parent::size_type;
    using typename Parent::traits_type;
    using typename Parent::value_type;

    // Parent methods we don't need to specialize
    using Parent::at;
    using Parent::back;
    using Parent::begin;
    using Parent::c_str;
    using Parent::clear;
    using Parent::copy;
    using Parent::data;
    using Parent::empty;
    using Parent::end;
    using Parent::find;
    using Parent::find_first_not_of;
    using Parent::find_first_of;
    using Parent::front;
    using Parent::push_back;
    using Parent::rbegin;
    using Parent::rend;
    using Parent::size;

    // Constructors
    Str(ViewType view, const AllocatorType &alloc = AllocatorType()) noexcept
        : Parent(alloc) {
        if (!view.empty()) assign(view);
    }

    template <typename TraitsT>
    Str(StrView<CharacterType, TraitsT> view,
        const AllocatorType &alloc = AllocatorType()) noexcept
        : Parent(alloc) {
        if (!view.empty()) assign(ViewType{view.data(), view.size()});
    }

#if 0
	template<typename T, typename = std::enable_if_t<traits::IsConvertableToStdStringViewV<T, CharacterType, TraitsType>>>
	Str(const T &view, const AllocatorType &alloc = AllocatorType()) noexcept :
		Parent(alloc) {
		if (!view.empty()) {
			if constexpr (sizeof(typename T::value_type) == sizeof(CharacterType)) {
				// Do something special if the traits don't match, just assign
				// it as a raw character list if so
				if constexpr (std::is_same_v<TraitsType, typename T::traits_type>)
					assign(view);
				else
					Parent::assign(&view.front(), view.size());
			} else {
				assign(_tr<ThisType, StrView<typename T::value_type>>({ view.data(), view.size() }));
			}
		}
	}

	template<typename T, typename = std::enable_if_t<traits::IsConvertableToStdStringViewV<T, CharacterType, TraitsType>>>
	Str(const T& view, const std::size_t offset, const std::size_t count, const AllocatorType &alloc = AllocatorType()) noexcept :
		Parent(alloc) {
		if (!view.empty()) {
			if constexpr (sizeof(typename T::value_type) == sizeof(CharacterType)) {
				// Do something special if the traits don't match, just assign it as a raw
				// character list if so
				if constexpr (std::is_same_v<TraitsType, typename T::traits_type>)
					assign(view, offset, count);
				else {
					auto iter = view.begin() + offset;
					Parent::assign(&(*iter), count);
				}
			} else {
				auto other = _tr<ThisType, StrView<typename T::value_type>>({ view.data(), view.size() });
				assign(other, offset, count);
			}
		}
	}
#endif

    template <typename ChrT, typename TraitT, typename AllocT>
    Str(const std::basic_string<ChrT, TraitT, AllocT> &other,
        const AllocatorType &alloc = AllocatorType()) noexcept
        : Parent(alloc) {
        if constexpr (sizeof(ChrT) == sizeof(CharacterType))
            assign(_reCast<const CharacterType *>(other.c_str()), other.size());
        else
            __transform(StrView<ChrT>{other.c_str(), other.size()}, *this);
    }

    template <typename ChrT, typename TraitT, typename AllocT>
    decltype(auto) operator=(
        const std::basic_string<ChrT, TraitT, AllocT> &other) noexcept {
        if constexpr (sizeof(ChrT) == sizeof(CharacterType))
            assign(_reCast<const CharacterType *>(other.c_str()), other.size());
        else
            __transform(StrView<ChrT>{other.c_str(), other.size()}, *this);
        return *this;
    }

    template <typename ChrT,
              typename = std::enable_if_t<std::is_integral_v<ChrT>>>
    Str(const ChrT *str, size_t len,
        const AllocatorType &alloc = AllocatorType()) noexcept
        : Parent(alloc) {
        if constexpr (sizeof(CharacterType) == sizeof(ChrT))
            assign(_reCast<const CharacterType *>(str), len);
        else
            __transform(StrView<ChrT>{str, len}, *this);
    }

    template <typename ChrT,
              typename = std::enable_if_t<std::is_integral_v<ChrT>>>
    Str(const ChrT *str, const AllocatorType &alloc = AllocatorType()) noexcept
        : Parent(alloc) {
        if constexpr (sizeof(CharacterType) == sizeof(ChrT))
            assign(_reCast<const CharacterType *>(str));
        else
            __transform(StrView<ChrT>{str}, *this);
    }

    Str(std::initializer_list<CharacterType> list,
        const AllocatorType &alloc = AllocatorType()) noexcept
        : Parent(std::move(list), alloc) {}

    // Allow construction from a string with a different trait
    template <typename ChrT, typename CharTraits, typename Alloc>
    Str(const Str<ChrT, CharTraits, Alloc> &str,
        const AllocatorType &alloc = {}) noexcept
        : Parent(alloc) {
        if constexpr (sizeof(ChrT) == sizeof(CharacterType))
            assign(_reCast<const CharacterType *>(str.c_str()), str.size());
        else
            __transform(StrView<ChrT, CharTraits>{str}, *this);
    }

    Str(const Str &str) noexcept : Parent(str) {}

    Str(const Str &str, const AllocatorType &alloc) noexcept
        : Parent(str, alloc) {}

    Str() noexcept : Parent() {}

    explicit Str(const AllocatorType &alloc) noexcept : Parent(alloc) {}

    Str(const Str &str, const std::size_t offset,
        const AllocatorType &alloc = AllocatorType()) noexcept
        : Parent(str, offset, alloc) {}

    Str(const Str &str, const std::size_t offset, const SizeType count,
        const AllocatorType &alloc = AllocatorType()) noexcept
        : Parent(str, offset, count, alloc) {}

    Str(const CharacterType *const str, const SizeType count) noexcept
        : Parent(str, count) {}

    Str(const CharacterType *const str, const SizeType count,
        const AllocatorType &alloc) noexcept
        : Parent(str, count, alloc) {}

    Str(const CharacterType *const str) noexcept : Parent(str) {}

    template <typename Alloc = AllocatorType,
              std::enable_if_t<traits::IsAllocator<Alloc>::value, int> = 0>
    Str(const CharacterType *const str, const Alloc &alloc) noexcept
        : Parent(str, alloc) {}

    Str(const SizeType count, const CharacterType chr,
        const AllocatorType &alloc = AllocatorType()) noexcept
        : Parent(count, chr, alloc) {}

    template <typename Alloc = AllocatorType,
              std::enable_if_t<traits::IsAllocator<Alloc>::value, int> = 0>
    Str(const SizeType count, const CharacterType chr,
        const Alloc &alloc) noexcept
        : Parent(count, chr, alloc) {}

    template <typename Iter,
              typename = std::enable_if_t<traits::IsIteratorV<Iter>>>
    Str(Iter first, Iter last) noexcept : Parent(first, last) {}

    template <typename Iter,
              typename = std::enable_if_t<traits::IsIteratorV<Iter>>>
    Str(Iter first, Iter last, const AllocatorType &alloc) noexcept
        : Parent(first, last, alloc) {}

    Str(Str &&str) noexcept
        :  // On Linux, the Clang string implementation isn't forwarding the
           // moved string's allocator; do so explicitly
          Parent(std::move(str), str.get_allocator()) {}

    Str(Str &&str, const AllocatorType &alloc) noexcept
        : Parent(std::move(str), alloc) {}

#if 0
	template<typename Iter, typename Alloc = std::allocator<traits::IterValueT<Iter>>,
		std::enable_if_t<std::conjunction_v<
			traits::IsIterator<Iter>,
			traits::IsAllocator<Alloc>
		>, int> = 0>
	Str(Iter, Iter, Alloc = Alloc())
		-> Str<traits::IterValueT<Iter>, std::char_traits<traits::IterValueT<Iter>>, Alloc>;

	template<typename ChrType, typename Traits, typename Alloc = std::allocator<ChrType>, std::enable_if_t<traits::IsAllocator<Alloc>, int> = 0>
	Str<Str<ChrType, Traits>, traits::GuideSizeTypeT<Alloc>, traits::GuideSizeTypeT<Alloc>, const Alloc& = Alloc()
		-> Str<ChrType, Traits, Alloc>;

	template<typename ChrType, typename Traits, typename Alloc = std::allocator<ChrType>, std::enable_if_t<traits::IsAllocator<Alloc>, int> = 0>
	Str(std::basic_string_view<ChrType, Traits>, traits::GuideSizeTypeT<Alloc>, traits::GuideSizeTypeT<Alloc>, const Alloc& = Alloc())
		-> Str<ChrType, Traits, Alloc>;
#endif

    // Assignment operators
    template <typename ChrT, typename TraitsT>
    auto &operator=(StrView<ChrT, TraitsT> view) noexcept {
        if (view.empty()) {
            clear();
        } else if constexpr (sizeof(ChrT) == sizeof(CharacterType)) {
            assign(_reCast<const CharacterType *>(view.data()), view.size());
        } else {
            __transform(view, *this);
        }
        return *this;
    }

    auto &operator=(const CharacterType chr) noexcept {
        Parent::operator=(chr);
        return *this;
    }

    auto &operator=(const CharacterType *const ptr) noexcept {
        Parent::operator=(ptr);
        return *this;
    }

    auto &operator=(std::initializer_list<CharacterType> list) noexcept {
        return assign(list);
    }

    // Move operator
    auto &operator=(Str &&str) noexcept {
        Parent::operator=(std::move(str));
        return *this;
    }

    // Copy assignment operator
    auto &operator=(const Str &str) noexcept {
        Parent::operator=(str);
        return *this;
    }

    // Substr
    template <typename... Args>
    [[nodiscard]] auto substr(Args &&...args) const noexcept {
        auto result = Parent::substr(std::forward<Args &&>(args)...);
        return ThisType(std::move(result));
    }

    [[nodiscard]] ViewType substrView(size_t pos,
                                      size_t count = npos) const noexcept {
        if (pos >= size()) return {};

        if (count != npos)
            return ViewType(&at(pos), std::min(size() - pos, count));

        return ViewType(&at(pos), size() - pos);
    }

    // Append operator
    auto &operator+=(const CharacterType *str) noexcept { return append(str); }

    template <typename ChrT,
              typename = std::enable_if<std::is_integral_v<ChrT> &&
                                        sizeof(ChrT) == sizeof(CharacterType)>>
    auto &operator+=(std::initializer_list<ChrT> chrs) noexcept {
        for (auto &chr : chrs) Parent::append((CharacterType)chr, 1);
        return *this;
    }

    template <typename TraitsType, typename AllocatorType>
    auto &operator+=(
        const Str<CharacterType, TraitsType, AllocatorType> &str) noexcept {
        return append(str);
    }

    template <typename TraitsType, typename AllocatorType>
    auto &operator+=(
        Str<CharacterType, TraitsType, AllocatorType> &&str) noexcept {
        return append(_mv(str));
    }

    auto &operator+=(StrView<CharacterType, TraitsType> str) noexcept {
        return append(str);
    }

    template <typename ChrT, typename = std::enable_if_t<
                                 std::is_integral_v<ChrT> &&
                                 sizeof(ChrT) == sizeof(CharacterType)>>
    auto &operator+=(ChrT chr) noexcept {
        return append(chr);
    }

    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<std::is_integral_v<ChrT> &&
                                    sizeof(ChrT) == sizeof(CharacterType)>>
    auto &operator+=(StrView<ChrT, TraitsT> str) noexcept {
        return append(str);
    }

    // Append methods
    template <typename ChrT, typename = std::enable_if_t<sizeof(ChrT) ==
                                                         sizeof(CharacterType)>>
    auto &append(const ChrT *str) noexcept {
        if (str) Parent::append((const CharacterType *)str);
        return *this;
    }

    template <typename TraitsType, typename AllocatorType>
    auto &append(
        const Str<CharacterType, TraitsType, AllocatorType> &str) noexcept {
        if (!str.empty()) Parent::append(str.data(), str.size());
        return *this;
    }

    template <typename TraitsType, typename AllocatorType>
    auto &append(Str<CharacterType, TraitsType, AllocatorType> &&str) noexcept {
        if (!str.empty()) {
            if (empty()) {
                // @@ TODO The open-ended variadic function template for assign
                // above is eating the rvalue qualifier; call the parent class'
                // implementation for now
                Parent::assign(_mv(str));
            } else
                Parent::append(str.data(), str.size());
        }
        return *this;
    }

    auto &append(StrView<CharacterType, TraitsType> str) noexcept {
        if (!str.empty()) Parent::append(str.data(), str.size());
        return *this;
    }

    template <typename ChrT, typename = std::enable_if_t<sizeof(ChrT) ==
                                                         sizeof(CharacterType)>>
    Str &append(ChrT chr) noexcept {
        Parent::append(1, (CharacterType)chr);
        return *this;
    }

    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<std::is_integral_v<ChrT> &&
                                    sizeof(ChrT) == sizeof(CharacterType)>>
    auto &append(StrView<ChrT, TraitsT> str) noexcept {
        Parent::append(str.data(), str.size());
        return *this;
    }

    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<sizeof(ChrT) == sizeof(CharacterType)>>
    auto &append(std::basic_string_view<ChrT, TraitsT> str) noexcept {
        if (!str.empty())
            Parent::append((const CharacterType *)str.data(), str.size());
        return *this;
    }

    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<sizeof(ChrT) == sizeof(CharacterType)>>
    auto &append(std::basic_string<ChrT, TraitsT> str) noexcept {
        Parent::append(_reCast<const CharacterType *>(str.c_str()), str.size());
        return *this;
    }

    template <typename InputIterator,
              typename = std::enable_if_t<traits::IsIteratorV<InputIterator>>>
    auto &append(InputIterator first, InputIterator second) noexcept {
        Parent::append(first, second);
        return *this;
    }

    template <
        typename ChrT, typename TraitsT,
        typename = std::enable_if_t<sizeof(ChrT) == sizeof(CharacterType)>>
    auto &append(std::basic_string<CharacterType, TraitsType> str,
                 size_t subpos, size_t sublen) noexcept {
        auto _str = str.substr(subpos, sublen);
        Parent::append((const CharacterType *)_str.c_str(), _str.size());
        return *this;
    }

    // Shrink to fit, we specialize this since the standard will not shrink a
    // small optimized string
    size_t shrink_to_fit() noexcept {
        Parent::shrink_to_fit();
        trimTrailing({'\0'});
        return size();
    }

    // Assignment methods
    template <typename... Args>
    auto &assign(Args &&...args) noexcept {
        Parent::assign(std::forward<Args &&>(args)...);
        return *this;
    }

    // Insertion methods
    template <typename ChrT, typename = std::enable_if_t<
                                 std::is_integral_v<ChrT> &&
                                 sizeof(ChrT) == sizeof(CharacterType)>>
    auto &insert(size_t pos, const ChrT *str) noexcept {
        Parent::insert(pos, _cast<CharacterType *>(str));
        return *this;
    }

    template <typename... Args>
    auto &insert(Args &&...args) noexcept {
        Parent::insert(std::forward<Args &&>(args)...);
        return *this;
    }

    // Erase methods
    template <typename... Args>
    auto &erase(Args &&...args) noexcept {
        Parent::erase(std::forward<Args &&>(args)...);
        return *this;
    }

    // Replace methods
    auto &replace(size_t pos, size_t len, ViewType str) noexcept {
        Parent::replace(pos, len, str.data(), str.size());
        return *this;
    }

    auto &replace(size_t pos, size_t len, const Str &str) noexcept {
        Parent::replace(pos, len, str);
        return *this;
    }

    auto &replace(size_t pos, size_t len, size_t n, CharacterType c) noexcept {
        Parent::replace(pos, len, n, c);
        return *this;
    }

    auto &replace(size_t pos, size_t len, const CharacterType *c) noexcept {
        Parent::replace(pos, len, c);
        return *this;
    }

    auto &replace(CharacterType token, CharacterType replacement) noexcept {
        for (auto i = 0; i < size(); i++) {
            if (TraitsType::eq(at(i), token)) at(i) = replacement;
        }
        return *this;
    }

    auto &replace(ViewType token, ViewType replacement,
                  Opt<bool> caseAware = {}) noexcept {
        if (caseAware) {
            if (caseAware.value())
                return *this = CaseApi::replace(*this, token, replacement,
                                                Parent::get_allocator());
            else
                return *this = NoCaseApi::replace(*this, token, replacement,
                                                  Parent::get_allocator());
        }

        return *this = Api::replace(*this, token, replacement,
                                    Parent::get_allocator());
    }

    auto &replaceAnyOf(ViewType chars, CharacterType replacement) noexcept {
        for (auto pos = Parent::find_first_of(chars); pos != Parent::npos;
             pos = Parent::find_first_of(chars, pos + 1)) {
            at(pos) = replacement;
        }
        return *this;
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

    template <typename CharTrait = TraitsType>
    StrView<Character, CharTrait> toView() const noexcept {
        return {c_str(), size()};
    }

    template <typename CharTrait = TraitsType>
    operator StrView<Character, CharTrait>() const noexcept {
        return toView();
    }

    template <typename CharTrait = TraitsType>
    operator std::basic_string_view<Character, CharTrait>() const noexcept {
        return {c_str(), size()};
    }

    // If our traits don't match enable this assignment operator so we can have
    // compatibility between our various char_traits
    template <typename CharTrait, typename Alloc>
    auto operator=(Str<Character, CharTrait, Alloc> &str) noexcept
        -> std::enable_if_t<!std::is_same_v<CharTrait, TraitsType>,
                            ThisType &> {
        assign(str.c_str());
        return *this;
    }

    template <typename CharTrait, typename>
    auto operator=(std::basic_string_view<Character, CharTrait> str) noexcept
        -> std::enable_if_t<!std::is_same_v<CharTrait, TraitsType>,
                            ThisType &> {
        if (str.empty())
            clear();
        else
            assign(&str.front(), str.size());
        return *this;
    }

    template <typename CharTrait, typename>
    auto operator=(StrView<Character, CharTrait> str) noexcept
        -> std::enable_if_t<!std::is_same_v<CharTrait, TraitsType>,
                            ThisType &> {
        if (str.empty())
            clear();
        else
            assign(&str.front(), str.size());
        return *this;
    }

    // Equality with strings with differing traits
    template <
        typename CharTrait, typename Alloc,
        typename = std::enable_if_t<!std::is_same_v<CharTrait, TraitsType>>>
    constexpr bool operator==(
        const Str<Character, CharTrait, Alloc> &str) const noexcept {
        if (size() != str.size()) return false;

        // If the right-hand string is case-insensitive, use its traits
        if constexpr (traits::IsSameTypeV<CharTrait, NoCase<Character>>)
            return string::NoCase<Character>::compare(c_str(), str.c_str(),
                                                      size()) == 0;
        else
            return TraitsType::compare(c_str(), str.c_str(), size()) == 0;
    }

    // Inequality with strings with differing traits
    template <
        typename CharTrait, typename Alloc,
        typename = std::enable_if_t<!std::is_same_v<CharTrait, TraitsType>>>
    constexpr bool operator!=(
        const Str<Character, CharTrait, Alloc> &str) const noexcept {
        return !(operator==(str));
    }

    // Equality with STL string views with differing traits
    template <typename CharTrait, typename = std::enable_if_t<
                                      !std::is_same_v<CharTrait, TraitsType>>>
    constexpr bool operator==(
        std::basic_string_view<Character, CharTrait> str) const noexcept {
        if (size() != str.size()) return false;

        // Use our traits as the authoritative comparator in this case
        return TraitsType::compare(c_str(), str.data(), size()) == 0;
    }

    // Inequality with STL string views with differing traits
    template <typename CharTrait, typename = std::enable_if_t<
                                      !std::is_same_v<CharTrait, TraitsType>>>
    constexpr bool operator!=(
        std::basic_string_view<Character, CharTrait> str) const noexcept {
        return !(operator==(str));
    }

    // Equality with string view with differing traits
    template <typename CharTrait, typename = std::enable_if_t<
                                      !std::is_same_v<CharTrait, TraitsType>>>
    constexpr bool operator==(
        StrView<Character, CharTrait> str) const noexcept {
        if (size() != str.size()) return false;

        // If the right-hand string view is case-insensitive, use its traits
        if constexpr (traits::IsSameTypeV<CharTrait, NoCase<Character>>)
            return string::NoCase<Character>::compare(c_str(), str.data(),
                                                      size()) == 0;
        else
            return TraitsType::compare(c_str(), str.data(), size()) == 0;
    }

    // Equality with string view with differing traits
    template <typename CharTrait, typename = std::enable_if_t<
                                      !std::is_same_v<CharTrait, TraitsType>>>
    constexpr bool operator!=(
        StrView<Character, CharTrait> str) const noexcept {
        return !(operator==(str));
    }

    template <typename ChrT>
    decltype(auto) threadLocalCast() const noexcept {
        if constexpr (sizeof(CharacterType) == sizeof(ChrT))
            return _reCast<const ChrT *>(c_str());
        else {
            // Use the most efficient path here, which will re-use the heap in
            // the arg and populate it directly
            _thread_local async::Tls<Str<ChrT>> converted(_location);
            __transform(*this, *converted);
            return converted->c_str();
        }
    }

#if ROCKETRIDE_PLAT_WIN
    operator const char *() const noexcept { return threadLocalCast<char>(); }
    operator const wchar_t *() const noexcept {
        return threadLocalCast<wchar_t>();
    }
    explicit operator const char16_t *() const noexcept {
        return threadLocalCast<char16_t>();
    }
    explicit operator const char32_t *() const noexcept {
        return threadLocalCast<char32_t>();
    }
#else
    operator const char *() const noexcept { return threadLocalCast<char>(); }
    explicit operator const wchar_t *() const noexcept {
        return threadLocalCast<wchar_t>();
    }
    explicit operator const char16_t *() const noexcept {
        return threadLocalCast<char16_t>();
    }
    explicit operator const char32_t *() const noexcept {
        return threadLocalCast<char32_t>();
    }
#endif

    operator std::wstring() const noexcept {
        if constexpr (sizeof(Character) == sizeof(wchar_t))
            return {data(), size()};
        else
            return _cast<const wchar_t *>(*this);
    }

    operator StrView<CharacterType, TraitsType>() const noexcept {
        return {c_str(), size()};
    }

    template <typename ChrT = CharacterType,
              typename = std::enable_if_t<std::is_integral_v<ChrT>>>
    decltype(auto) ptr() const noexcept {
        return _cast<const ChrT *>(*this);
    }

    // Boolean explicit operator
    explicit operator bool() const noexcept { return empty() == false; }

    // Make this string lowercase
    decltype(auto) lowerCase() & noexcept {
        for (auto &chr : *this) chr = _cast<CharacterType>(::tolower(chr));
        return *this;
    }

    decltype(auto) lowerCase() && noexcept {
        for (auto &chr : *this) chr = _cast<CharacterType>(::tolower(chr));
        return _mv(*this);
    }

    // Make this string uppercase
    decltype(auto) upperCase() & noexcept {
        for (auto &chr : *this) chr = _cast<CharacterType>(::toupper(chr));
        return *this;
    }

    decltype(auto) upperCase() && noexcept {
        for (auto &chr : *this) chr = _cast<CharacterType>(::toupper(chr));
        return _mv(*this);
    }

    // Remove one instance of a leading and trailing quote character. The string
    // will be modified as a result.
    decltype(auto) removeQuotes() noexcept {
        return *this = Api::extractEnclosed(*this, '"', '"',
                                            Parent::get_allocator());
    }

    // Enclose this string with two delimiters
    decltype(auto) enclose(CharacterType leadingDelim,
                           CharacterType secondDelim = '\0') noexcept {
        return *this = Api::enclose(*this, leadingDelim, secondDelim,
                                    Parent::get_allocator());
    }

    // Extracts a portion of the string within two delimiters. The string
    // will be modified as a result.
    decltype(auto) extractEnclosed(CharacterType leadingDelim,
                                   CharacterType trailingDelim = '\0',
                                   Opt<bool> caseAware = {}) noexcept {
        if (caseAware) {
            if (caseAware.value())
                return *this = CaseApi::extractEnclosed(
                           *this, leadingDelim, trailingDelim,
                           Parent::get_allocator());
            else
                return *this = NoCaseApi::extractEnclosed(
                           *this, leadingDelim, trailingDelim,
                           Parent::get_allocator());
        }
        return *this = Api::extractEnclosed(*this, leadingDelim, trailingDelim,
                                            Parent::get_allocator());
    }

    // Trim characters from the leading and trailing portions
    // of this string. This string instance will be modified.
    decltype(auto) trim(std::initializer_list<CharacterType> charSet =
                            {'\t', '\n', '\r', ' ', '\0'},
                        Opt<bool> caseAware = {}) noexcept {
        if (caseAware) {
            if (caseAware.value())
                return *this = CaseApi::trim(*this, charSet,
                                             Parent::get_allocator());
            else
                return *this = NoCaseApi::trim(*this, charSet,
                                               Parent::get_allocator());
        }
        return *this = Api::trim(*this, charSet, Parent::get_allocator());
    }

    // Trim characters from the leading portions
    // of this string. This string instance will be modified.
    decltype(auto) trimLeading(std::initializer_list<CharacterType> charSet =
                                   {'\t', '\n', '\r', ' ', '\0'},
                               Opt<bool> caseAware = {}) noexcept {
        if (caseAware) {
            if (caseAware.value())
                return *this = NoCaseApi::trimLeading(*this, charSet,
                                                      Parent::get_allocator());
            else
                return *this = CaseApi::trimLeading(*this, charSet,
                                                    Parent::get_allocator());
        }

        return *this =
                   Api::trimLeading(*this, charSet, Parent::get_allocator());
    }

    decltype(auto) trimLeading(ViewType leading,
                               Opt<bool> caseAware = {}) noexcept {
        if (startsWith(leading, caseAware)) *this = substr(leading.size());
        return *this;
    }

    // Trim characters from the trailing portions
    // of this string. This string instance will be modified.
    decltype(auto) trimTrailing(std::initializer_list<CharacterType> charSet =
                                    {'\t', '\n', '\r', ' ', '\0'},
                                Opt<bool> caseAware = {}) noexcept {
        if (caseAware) {
            if (caseAware.value())
                return *this = CaseApi::trimTrailing(*this, charSet,
                                                     Parent::get_allocator());
            else
                return *this = NoCaseApi::trimTrailing(*this, charSet,
                                                       Parent::get_allocator());
        }
        return *this =
                   Api::trimTrailing(*this, charSet, Parent::get_allocator());
    }

    decltype(auto) trimTrailing(ViewType trailing,
                                Opt<bool> caseAware = {}) noexcept {
        if (endsWith(trailing, caseAware))
            *this = substr(0, size() - trailing.size());
        return *this;
    }

    // Count occurrence of a char/string in this string
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

    // Slice this string up into two parts, optionally include slice character
    // in first
    template <typename DelimT>
    auto slice(DelimT &&delim, Opt<bool> caseAware = {},
               bool retainDelimInFirst = false) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::slice(*this, delim, retainDelimInFirst);
            else
                return NoCaseApi::slice(*this, delim, retainDelimInFirst);
        }
        return Api::slice(*this, delim, retainDelimInFirst);
    }

    // Split this string up into components based on a delimiter
    template <typename DelimT>
    auto split(DelimT &&delim, bool includeEmpty = false, Opt<size_t> max = {},
               Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::template split<std::vector<ThisType>>(
                    *this, delim, includeEmpty, max, Parent::get_allocator());
            else
                return NoCaseApi::template split<std::vector<ThisType>>(
                    *this, delim, includeEmpty, max, Parent::get_allocator());
        }
        return Api::template split<std::vector<ThisType>>(
            *this, delim, includeEmpty, max, Parent::get_allocator());
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

    // Check if this string starts with another string
    template <typename LeadingT>
    auto startsWith(LeadingT &&leading,
                    Opt<bool> caseAware = {}) const noexcept {
        if (caseAware) {
            if (caseAware.value())
                return CaseApi::startsWith(*this,
                                           std::forward<LeadingT>(leading));
            else
                return NoCaseApi::startsWith(*this,
                                             std::forward<LeadingT>(leading));
        }
        return Api::startsWith(*this, std::forward<LeadingT>(leading));
    }

    // Remove one or more tokens from this string.
    template <typename... Tokens>
    decltype(auto) remove(Opt<bool> caseAware, Tokens &&...tokens) noexcept {
        if (caseAware) {
            if (caseAware.value())
                return *this = CaseApi::template remove<ThisType>(
                           *this, Parent::get_allocator(),
                           std::forward<Tokens>(tokens)...);
            else
                return *this = NoCaseApi::template remove<ThisType>(
                           *this, Parent::get_allocator(),
                           std::forward<Tokens>(tokens)...);
        }
        return *this = Api::template remove<ThisType>(
                   *this, Parent::get_allocator(),
                   std::forward<Tokens>(tokens)...);
    }

    // Remove one or more tokens from this string.
    template <typename... Tokens>
    decltype(auto) remove(Tokens &&...tokens) noexcept {
        return remove({}, std::forward<Tokens>(tokens)...);
    }

    explicit operator size_t() const noexcept {
        return Parent::operator size_t();
    }
};

// Here is where we declare our global operators, these ensure our
// string types can be used with inline operations such as
// "str" + str = str
template <typename ChrTL, typename TraitsTL, typename AllocTL, typename ChrTR,
          typename TraitsTR, typename AllocTR>
inline Str<ChrTL, TraitsTL, AllocTL> operator+(
    const Str<ChrTL, TraitsTL, AllocTL> &first,
    const Str<ChrTR, TraitsTR, AllocTR> &second) noexcept {
    Str<ChrTL, TraitsTL, AllocTL> res{first.get_allocator()};
    res = first;
    return res.append(second);
}

template <typename ChrTL, typename TraitsTL, typename AllocTL, typename ChrTR,
          typename TraitsTR>
inline Str<ChrTL, TraitsTL, AllocTL> operator+(
    const Str<ChrTL, TraitsTL, AllocTL> &first,
    StrView<ChrTR, TraitsTR> second) noexcept {
    Str<ChrTL, TraitsTL, AllocTL> res{first.get_allocator()};
    res = first;
    return res.append(second);
}

template <typename ChrTL, typename TraitsTL, typename ChrTR, typename TraitsTR,
          typename AllocTR>
inline Str<ChrTL, TraitsTL> operator+(
    StrView<ChrTL, TraitsTL> first,
    const Str<ChrTR, TraitsTR, AllocTR> &second) noexcept {
    Str<ChrTL, TraitsTL> res = first;
    return res.append(second);
}

template <typename ChrT, typename TraitsT, typename AllocT>
inline Str<ChrT, TraitsT, AllocT> operator+(
    const Str<ChrT, TraitsT, AllocT> &first,
    const Str<ChrT, TraitsT, AllocT> &second) noexcept {
    Str<ChrT, TraitsT, AllocT> res = first;
    res += second;
    return res;
}

template <typename ChrT, typename TraitsT, typename AllocT>
inline Str<ChrT, TraitsT, AllocT> operator+(
    const Str<ChrT, TraitsT, AllocT> &first,
    const std::basic_string<ChrT, TraitsT, AllocT> &second) noexcept {
    Str<ChrT, TraitsT, AllocT> res = first;
    res += second;
    return res;
}

template <typename ChrT, typename TraitsT, typename AllocT>
inline Str<ChrT, TraitsT, AllocT> operator+(
    const Str<ChrT, TraitsT, AllocT> &first, ChrT chr) noexcept {
    Str<ChrT, TraitsT, AllocT> res = first;
    res += chr;
    return res;
}

template <typename ChrT, typename TraitsT, typename TraitsVT>
inline Str<ChrT, TraitsT> operator+(const Str<ChrT, TraitsT> &first,
                                    StrView<ChrT, TraitsVT> second) noexcept {
    auto result = first;
    return result.append(StrView<ChrT, TraitsT>{second.data(), second.size()});
}

// Similar to the above except the first arg here is a view
template <typename ChrT, typename TraitsT, typename AllocT>
inline Str<ChrT, TraitsT, AllocT> operator+(
    const StrView<ChrT, TraitsT> &first,
    const Str<ChrT, TraitsT, AllocT> &second) noexcept {
    Str<ChrT, TraitsT, AllocT> res = first;
    res += second;
    return res;
}

template <typename ChrT, typename TraitsT, typename AllocT>
inline Str<ChrT, TraitsT, AllocT> operator+(
    const StrView<ChrT, TraitsT> &first,
    const std::basic_string<ChrT, TraitsT, AllocT> &second) noexcept {
    Str<ChrT, TraitsT, AllocT> res = first;
    res += second;
    return res;
}

template <typename ChrT, typename TraitsT>
inline Str<ChrT, TraitsT> operator+(const StrView<ChrT, TraitsT> &first,
                                    ChrT chr) noexcept {
    Str<ChrT, TraitsT> res = first;
    res += chr;
    return res;
}

}  // namespace ap::string

// Allow our string to operate in a hash
template <typename CharacterType, typename Traits, typename Allocator>
struct std::hash<::ap::string::Str<CharacterType, Traits, Allocator>> {
    size_t operator()(const ::ap::string::Str<CharacterType, Traits, Allocator>
                          &str) const noexcept {
        return std::hash<std::basic_string<CharacterType, Traits, Allocator>>{}(
            str);
    }
};
