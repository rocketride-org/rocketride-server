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

namespace ap::traits {

// Remove deepest const removes the const from something like 'char const *'
template <typename T>
struct remove_deepest_const_impl {
    typedef T type;
};

template <typename T>
struct remove_deepest_const_impl<const T> {
    typedef T type;
};

template <typename T>
struct remove_deepest_const_impl<T*> {
    typedef typename remove_deepest_const_impl<T>::type* type;
};

template <typename T>
struct remove_deepest_const_impl<T* const> {
    typedef typename remove_deepest_const_impl<T>::type* const type;
};

template <typename T>
struct remove_deepest_const_impl<T&> {
    typedef typename remove_deepest_const_impl<T>::type& type;
};

template <typename T>
struct remove_deepest_const_impl<T&&> {
    typedef typename remove_deepest_const_impl<T>::type&& type;
};

template <typename T>
using remove_deepest_const_t = typename remove_deepest_const_impl<T>::type;

// Strip a type of its qualifiers
template <typename T>
using StripT = remove_deepest_const_t<std::decay_t<T>>;

// Compare two types, decays the types, and removes all constness
template <typename T, typename Y>
using IsSameType = std::is_same<StripT<T>, StripT<Y>>;

template <typename T, typename Y>
constexpr auto IsSameTypeV = IsSameType<T, Y>::value;

#if ROCKETRIDE_PLAT_WIN

#define APTRAIT_DEF(Name, Type)              \
                                             \
    template <typename T, typename... Types> \
    struct Is##Name {                        \
        static constexpr bool value = false; \
    };                                       \
                                             \
    template <typename... Types>             \
    struct Is##Name<Type<Types...>> {        \
        static constexpr bool value = true;  \
    };                                       \
                                             \
    template <typename... Types>             \
    constexpr bool Is##Name##V =             \
        Is##Name<::ap::traits::StripT<Types...>>::value

#else

#define APTRAIT_DEF(Name, Type)              \
                                             \
    template <typename T, typename... Types> \
    struct Is##Name {                        \
        static constexpr bool value = false; \
    };                                       \
                                             \
    template <typename... Types>             \
    struct Is##Name<Type<Types...>> {        \
        static constexpr bool value = true;  \
    };                                       \
                                             \
    template <typename... Types>             \
    constexpr bool Is##Name##V = Is##Name<std::decay_t<Types>...>::value

#endif

// @description
// Is detected idiom helper
struct nonesuch {
    nonesuch() = delete;
    ~nonesuch() = delete;
    nonesuch(nonesuch const&) = delete;
    void operator=(nonesuch const&) = delete;
};

namespace detail {
template <typename...>
using void_t = void;

template <typename Default, typename AlwaysVoid,
          template <typename...> typename Op, typename... Args>
struct Detector {
    using value_t = std::false_type;
    using type = Default;
};

template <typename Default, template <typename...> typename Op,
          typename... Args>
struct Detector<Default, void_t<Op<Args...>>, Op, Args...> {
    using value_t = std::true_type;
    using type = Op<Args...>;
};

}  // namespace detail

template <template <typename...> typename Op, typename... Args>
using IsDetected =
    typename detail::Detector<nonesuch, void, Op, Args...>::value_t;

template <template <typename...> typename Op, typename... Args>
using DetectedT = typename detail::Detector<nonesuch, void, Op, Args...>::type;

template <typename Default, template <typename...> typename Op,
          typename... Args>
using DetectedOr = detail::Detector<Default, void, Op, Args...>;

template <typename Expected, template <typename...> typename Op,
          typename... Args>
using IsDetectedExact = std::is_same<Expected, DetectedT<Op, Args...>>;

template <typename>
struct ReturnType;

template <typename R, typename... Args>
struct ReturnType<R (*)(Args...)> {
    using Type = R;
};

template <typename... T>
using ReturnTypeV = typename ReturnType<T...>::Type;

// @description
// This trait evals to true if the type can be used with the >> operator on the
// given stream class.
template <typename StreamClass, typename T>
class HasStreamInOverload {
    template <typename SStreamClass, typename TT>
    static auto test(int)
        -> decltype(std::declval<SStreamClass&>() >> std::declval<TT&>(),
                    std::true_type());

    template <typename, typename>
    static auto test(...) -> std::false_type;

public:
    static const bool value = decltype(test<StreamClass, T>(0))::value;
};

template <typename StreamClass, typename T>
constexpr bool HasStreamInOverloadV =
    HasStreamInOverload<StreamClass, T>::value;

// @description
// This trait checks if the operator == comparison would work on the two types
template <typename L, typename R>
class HasGlobalEqualityOperator {
    template <typename LL, typename RR>
    static auto test(int)
        -> decltype(std::declval<LL&>() == std::declval<RR&>(),
                    std::true_type());

    template <typename, typename>
    static auto test(...) -> std::false_type;

public:
    static const bool value = decltype(test<L, R>(0))::value;
};

template <typename L, typename R>
constexpr bool HasGlobalEqualityOperatorV =
    HasGlobalEqualityOperator<L, R>::value;

// This trait evals to true if the type can be used with the << operator on the
// given stream class.
template <typename StreamClass, typename T>
class HasStreamOutOverload {
    template <typename SStreamClass, typename TT>
    static auto test(int)
        -> decltype(std::declval<SStreamClass&>() << std::declval<const TT&>(),
                    std::true_type());

    template <typename, typename>
    static auto test(...) -> std::false_type;

public:
    static const bool value = decltype(test<StreamClass, T>(0))::value;
};

template <typename StreamClass, typename T>
constexpr bool HasStreamOutOverloadV =
    HasStreamOutOverload<StreamClass, T>::value;

// ElemT - Gets the element value type
template <typename T>
using ElemT = typename T::element_type;

// TupleTypeV - Gets the tuple type
template <typename T>
using TypleTypeV = typename T::tuple_element;

// ValueT - Gets the value type
template <typename T>
using ValueT = typename T::value_type;

// KeyT - Gets the key type
template <typename T>
using KeyT = typename T::key_type;

// MappedT - Gets the mapped type
template <typename T>
using MappedT = typename T::mapped_type;

// IterValue - Gets the iterator internal value type
template <typename _Iter>
using IterValueT = typename std::iterator_traits<_Iter>::value_type;

// Extract allocator type
template <typename T>
using AllocatorTypeT = typename T::allocator_type;

// Basic is traits
APTRAIT_DEF(Optional, std::optional);
APTRAIT_DEF(Deque, std::deque);
APTRAIT_DEF(ForwardList, std::forward_list);
APTRAIT_DEF(List, std::list);
APTRAIT_DEF(Pair, std::pair);
APTRAIT_DEF(Array, std::array);
APTRAIT_DEF(Atomic, std::atomic);
APTRAIT_DEF(Vector, std::vector);
APTRAIT_DEF(Map, std::map);
APTRAIT_DEF(MultiMap, std::multimap);
APTRAIT_DEF(FlatMap, ::fc::flat_map);
APTRAIT_DEF(Set, std::set);
APTRAIT_DEF(FlatSet, ::fc::flat_set);
APTRAIT_DEF(FlatMultiMap, ::fc::flat_multimap);
APTRAIT_DEF(UnorderedMap, std::unordered_map);
APTRAIT_DEF(UnorderedSet, std::unordered_set);
APTRAIT_DEF(Variant, std::variant);
APTRAIT_DEF(UniquePtr, std::unique_ptr);
APTRAIT_DEF(SharedPtr, std::shared_ptr);
APTRAIT_DEF(ChronoDuration, std::chrono::duration);
APTRAIT_DEF(Tuple, std::tuple);
APTRAIT_DEF(WeakPtr, std::weak_ptr);

// HasPodType
template <typename, typename = void>
struct PodType : std::false_type {};

template <typename T>
struct PodType<
    T, std::conditional_t<false, std::void_t<typename T::PodType>, void>>
    : T::PodType {};

template <typename T>
constexpr bool PodTypeV = PodType<T>::value;

// IsPod - means you can memcpy this kinda thing, we also allow for
// custom override if you declare PodType in your class definition, this
// will override the is_trivial check
template <typename T>
constexpr auto IsPodV =
    (std::is_trivial_v<T> && std::is_standard_layout_v<T>) ||
    (std::is_standard_layout_v<T> && PodTypeV<T>);

template <typename T>
constexpr auto IsPodPairV =
    IsPodV<typename T::first_type> && IsPodV<typename T::second_type>;

template <typename T>
constexpr auto IsErrorV = IsSameTypeV<T, Error>;

APTRAIT_DEF(ErrorOr, ErrorOr);

// IsFilesystemPath
template <typename T>
using IsFilesystemPath = IsSameType<T, std::filesystem::path>;

template <typename T>
constexpr bool IsFilesystemPathV = IsSameTypeV<T, std::filesystem::path>;

// IsSequenceContainer
template <typename T>
struct IsSequenceContainer {
    static constexpr bool value = IsArrayV<T> || IsDequeV<T> ||
                                  IsForwardListV<T> || IsListV<T> ||
                                  IsVectorV<T>;
};

template <typename T>
constexpr bool IsSequenceContainerV = IsSequenceContainer<T>::value;

// IsAssociativeContainer
template <typename T>
struct IsAssociativeContainer {
    static constexpr bool value = IsMultiMapV<T> || IsMapV<T> ||
                                  IsFlatMapV<T> || IsSetV<T> || IsFlatSetV<T> ||
                                  IsFlatMultiMapV<T>;
};

template <typename T>
constexpr bool IsAssociativeContainerV = IsAssociativeContainer<T>::value;

// IsUnorderedAssociativeContainer
template <typename T>
struct IsUnorderedAssociativeContainer {
    static constexpr bool value = IsUnorderedMapV<T> || IsUnorderedSetV<T>;
};

template <typename T>
constexpr bool IsUnorderedAssociativeContainerV =
    IsUnorderedAssociativeContainer<T>::value;

// IsContainer
template <typename T>
struct IsContainer {
    static constexpr bool value = IsSequenceContainerV<T> ||
                                  IsAssociativeContainerV<T> ||
                                  IsUnorderedAssociativeContainerV<T>;
};

template <typename T>
constexpr bool IsContainerV = IsContainer<T>::value;

// IsPointer
template <class T>
constexpr bool IsPointerV = std::is_pointer_v<T>;

namespace iter_helper {

// To allow ADL with custom begin/end
using std::begin;
using std::end;

template <typename T>
using IterableCheck = std::void_t<
    std::enable_if_t<std::is_same_v<decltype(begin(std::declval<T>())),
                                    decltype(end(std::declval<T>()))>>,
    decltype(*begin(std::declval<T>()))>;

template <typename T, typename = void>
struct IsIterable : std::false_type {};

template <typename T>
struct IsIterable<T, IterableCheck<T>> : std::true_type {};

}  // namespace iter_helper

template <typename T>
using IsIterable = iter_helper::IsIterable<T>;

template <class T>
constexpr bool IsIterableV = IsIterable<T>::value;

// HasPointer
template <typename, typename = void>
struct HasPointer : std::false_type {};

template <typename T>
struct HasPointer<
    T, std::conditional_t<false, std::void_t<typename T::pointer>, void>>
    : std::true_type {};

template <typename T>
constexpr bool HasPointerV = HasPointer<T>::value;

// HasValueType
template <typename, typename = void>
struct HasValueType : std::false_type {};

template <typename T>
struct HasValueType<
    T, std::conditional_t<false, std::void_t<typename T::value_type>, void>>
    : std::true_type {};

template <typename T>
constexpr bool HasValueTypeV = HasValueType<T>::value;

// HasElementType
template <typename, typename = void>
struct HasElementType : std::false_type {};

template <typename T>
struct HasElementType<
    T, std::conditional_t<false, std::void_t<typename T::element_type>, void>>
    : std::true_type {};

template <typename T>
constexpr bool HasElementTypeV = HasElementType<T>::value;

// HasAllocatorType
template <typename, typename = void>
struct HasAllocatorType : std::false_type {};

template <typename T>
struct HasAllocatorType<
    T, std::conditional_t<false, std::void_t<typename T::allocator_type>, void>>
    : std::true_type {};

template <typename T>
constexpr bool HasAllocatorTypeV = HasAllocatorType<T>::value;

template <typename T>
struct IsPtr {
    static constexpr bool value = false;
};

template <typename Type>
struct IsPtr<Ptr<Type>> {
    static constexpr bool value = true;
};

template <typename Types>
constexpr bool IsPtrV = IsPtr<std::decay_t<Types>>::value;

// IsSmartPtr
template <typename T>
constexpr bool IsSmartPtrV =
    (IsPtrV<T> || IsUniquePtrV<T> || IsWeakPtrV<T> || IsSharedPtrV<T>);

// IsPointerish
template <typename T>
constexpr bool IsPointerishV = (IsPointerV<T> || IsSmartPtrV<T>);

// IsBool

template <typename T>
using IsBool = std::is_same<T, bool>;

template <typename T>
constexpr auto IsBoolV = std::is_same_v<T, bool>;

// Variadic conditionals, usage:
//		IfAll<condition1, condition2, ...>
template <typename T, template <typename> typename... Ps>
using IfAll = typename std::conjunction<Ps<T>...>::value;

template <typename T, template <typename> typename... Ps>
using IfAny = typename std::disjunction<Ps<T>...>::value;

template <typename T, template <typename> typename... Ps>
using IfNone = typename std::negation<std::disjunction<Ps<T>...>>::value;

// Common methods we may want to detect
template <typename TestType>
using DetectResizeMethod =
    decltype(std::declval<TestType&>().resize(std::declval<size_t>()));

template <typename TestType>
using DetectSizeMethod = decltype(std::declval<TestType&>().size());

template <typename TestType>
using DetectReserveMethod =
    decltype(std::declval<TestType&>().reserve(std::declval<size_t>()));

template <typename ArgType>
using DetectCloseMethodPtr = decltype(std::declval<ArgType>()->close());

template <typename ArgType>
using DetectRemoveMethodPtr = decltype(std::declval<ArgType>()->remove());

template <typename ArgType, typename ModeType>
using DetectOpenMethod =
    decltype(std::declval<ArgType&>()->open(std::declval<const ModeType>)());

// This is a way to detect internal types of containers, instantiate your type
// in it then you can access its inner definitions e.g.:
//		Identity<decltype(MyThing)>::type::MyInnerType
template <typename T>
struct Identity {
    typedef T type;
};

template <typename T>
using IdentifyValueType = typename Identity<std::decay_t<T>>::type::value_type;

template <typename T>
struct IteratorTraits {
    using ValueType = typename std::iterator_traits<T>::value_type;
};

template <typename T>
struct ContainerTraits {
    using ValueType = IdentifyValueType<T>;

    _const auto IsConst = std::is_const<T>::value;
    _const auto IsValueTypeConst = std::is_const<ValueType>::value;
    _const auto IsValueTypeIntegral = std::is_integral_v<ValueType>;

    _const auto IsSequence = traits::IsSequenceContainerV<T>;
    _const auto IsAssociative = traits::IsAssociativeContainerV<T>;

    _const auto HasResize =
        traits::IsDetectedExact<void, traits::DetectResizeMethod, T>{};
    _const auto HasSize =
        traits::IsDetectedExact<size_t, traits::DetectSizeMethod, T>{};
    _const auto HasReserve =
        traits::IsDetectedExact<void, traits::DetectReserveMethod, T>{};
};

template <typename Iterator>
using IdentifyIteratorValueType =
    typename std::iterator_traits<Iterator>::value_type;

// Alias VoidType
template <class... T>
using VoidType = void;

// Detect the iterator category from a type
template <typename Iterator>
using IteratorCategoryT =
    typename std::iterator_traits<Iterator>::iterator_category;

// IsIterator
template <class T, class = void>
constexpr bool IsIteratorV = false;

template <class T>
constexpr bool IsIteratorV<T, VoidType<IteratorCategoryT<T>>> = true;

template <class T>
struct IsIterator : std::bool_constant<IsIteratorV<T>> {};

template <typename T>
using DetectOutputIterator =
    decltype(std::iterator_traits<T>::iterator_category());

template <typename T>
_const auto IsOutputIteratorV =
    traits::IsDetectedExact<std::output_iterator_tag, DetectOutputIterator,
                            T>{};

template <typename T>
using IfOutputIterator = std::enable_if_t<IsOutputIteratorV<T>>;

// IsCopyable
template <typename T>
_const auto IsCopyableV =
    std::is_copy_constructible_v<T> || std::is_copy_assignable_v<T>;

}  // namespace ap::traits
