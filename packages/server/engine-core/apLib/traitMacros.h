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

#define TRAIT_NAME(First) First
#define TRAIT_NAME_VALUE(First) First##_V

#define TRAIT_NAME_2(First, Second) First##_##Second
#define TRAIT_NAME_VALUE_2(First, Second) First##_##Second##_V

// The TRAIT_METHOD_EXISTS* macros create traits objects that verify a method is
// callable The detect idiom is a little different here's the usage: 	if
// constexpr(traits::IsDetectedExact<[return type], [trait name], [arg1],
// [argn...]>{})
#define TRAIT_METHOD_EXISTS_EX(TraitName, MethodName, ReturnType) \
    template <typename TestType>                                  \
    using TRAIT_NAME(TraitName) =                                 \
        decltype(std::declval<TestType&>().MethodName());

#define TRAIT_METHOD_EXISTS_EX1(TraitName, MethodName, ReturnType, arg1) \
    template <typename TestType>                                         \
    using TRAIT_NAME(TraitName) =                                        \
        decltype(std::declval<TestType&>().MethodName(std::declval<arg1>()));

#define TRAIT_METHOD_EXISTS_EX2(TraitName, MethodName, ReturnType, arg1, arg2) \
    template <typename TestType>                                               \
    using TRAIT_NAME(TraitName) =                                              \
        decltype(std::declval<TestType&>().MethodName(std::declval<arg1>(),    \
                                                      std::declval<arg2>()));

// The TRAIT_FUNCTION_EXISTS* macros create traits objects that verify a
// function exists. The naming is defined by the user, two templates get made,
// the template structure holding the value, and one postfixed ith _V as a
// constexpr static value

#define TRAIT_FUNCTION_EXISTS_EX(TraitName, FunctionName, ReturnType)  \
    template <typename TemplateType>                                   \
    struct TRAIT_NAME(TraitName) {                                     \
    private:                                                           \
        typedef std::true_type yes;                                    \
        typedef std::false_type no;                                    \
                                                                       \
        template <typename TestType>                                   \
        static auto test(int) -> decltype(FunctionName(), yes());      \
                                                                       \
        template <typename>                                            \
        static no test(...);                                           \
                                                                       \
    public:                                                            \
        static constexpr bool value =                                  \
            std::is_same<decltype(test<TemplateType>(0)), yes>::value; \
    };                                                                 \
                                                                       \
    template <typename TemplateType>                                   \
    static constexpr bool TRAIT_NAME_VALUE(TraitName) =                \
        TRAIT_NAME(TraitName)<TemplateType>::value

#define TRAIT_FUNCTION_EXISTS_EX1(TraitName, FunctionName, ReturnType, arg1) \
    template <typename TemplateType>                                         \
    struct TRAIT_NAME(TraitName) {                                           \
    private:                                                                 \
        typedef std::true_type yes;                                          \
        typedef std::false_type no;                                          \
                                                                             \
        template <typename TestType>                                         \
        static auto test(int)                                                \
            -> decltype(FunctionName(std::declval<arg1>()), yes());          \
                                                                             \
        template <typename>                                                  \
        static no test(...);                                                 \
                                                                             \
    public:                                                                  \
        static constexpr bool value =                                        \
            std::is_same<decltype(test<TemplateType>(0)), yes>::value;       \
    };                                                                       \
                                                                             \
    template <typename TemplateType>                                         \
    static constexpr bool TRAIT_NAME_VALUE(TraitName) =                      \
        TRAIT_NAME(TraitName)<TemplateType>::value

#define TRAIT_FUNCTION_EXISTS_EX2(TraitName, FunctionName, ReturnType, arg1,  \
                                  arg2)                                       \
    template <typename TemplateType>                                          \
    struct TRAIT_NAME(TraitName) {                                            \
    private:                                                                  \
        typedef std::true_type yes;                                           \
        typedef std::false_type no;                                           \
                                                                              \
        template <typename TestType>                                          \
        static auto test(int) -> decltype(FunctionName(std::declval<arg1>(),  \
                                                       std::declval<arg2>()), \
                                          yes());                             \
                                                                              \
        template <typename>                                                   \
        static no test(...);                                                  \
                                                                              \
    public:                                                                   \
        static constexpr bool value =                                         \
            std::is_same<decltype(test<TemplateType>(0)), yes>::value;        \
    };                                                                        \
                                                                              \
    template <typename TemplateType>                                          \
    static constexpr bool TRAIT_NAME_VALUE(TraitName) =                       \
        TRAIT_NAME(TraitName)<TemplateType>::value

#define TRAIT_FUNCTION_EXISTS_EX3(TraitName, FunctionName, ReturnType, arg1,   \
                                  arg2, arg3)                                  \
    template <typename TemplateType>                                           \
    struct TRAIT_NAME(TraitName) {                                             \
    private:                                                                   \
        typedef std::true_type yes;                                            \
        typedef std::false_type no;                                            \
                                                                               \
        template <typename TestType>                                           \
        static auto test(int)                                                  \
            -> decltype(FunctionName(std::declval<arg1>, std::declval<arg2>(), \
                                     std::declval<arg3>()),                    \
                        yes());                                                \
                                                                               \
        template <typename>                                                    \
        static no test(...);                                                   \
                                                                               \
    public:                                                                    \
        static constexpr bool value =                                          \
            std::is_same<decltype(test<TemplateType>(0)), yes>::value;         \
    };                                                                         \
                                                                               \
    template <typename TemplateType>                                           \
    static constexpr bool TRAIT_NAME_VALUE(TraitName) =                        \
        TRAIT_NAME(TraitName)<TemplateType>::value

// The TRAIT_FUNCTION_EXISTS* macros create traits objects that verify a
// function exists. The naming is enforced as FunctionExists_<function name>
// which will be a struct having a member 'value'. It also makes a inline
// constexpr boolean type postfixed with V e.g. FunctionExists_<function name>_V
// that you can check without de-referencing the static value member.
#define TRAIT_FUNCTION_EXISTS(FunctionName, ReturnType)                   \
    TRAIT_FUNCTION_EXISTS_EX(FunctionExists_##FunctionName, FunctionName, \
                             ReturnType)
#define TRAIT_FUNCTION_EXISTS_1(FunctionName, ReturnType, arg1)            \
    TRAIT_FUNCTION_EXISTS_EX1(FunctionExists_##FunctionName, FunctionName, \
                              ReturnType, arg1)
#define TRAIT_FUNCTION_EXISTS_2(FunctionName, ReturnType, arg1, arg2)      \
    TRAIT_FUNCTION_EXISTS_EX2(FunctionExists_##FunctionName, FunctionName, \
                              ReturnType, arg1, arg2)
#define TRAIT_FUNCTION_EXISTS_3(FunctionName, ReturnType, arg1, arg2, arg3) \
    TRAIT_FUNCTION_EXISTS_EX3(FunctionExists_##FunctionName, FunctionName,  \
                              ReturnType, arg1, arg2, arg3)

// TRAIT_METHOD_EXISTS* macros create traits objects that verify a method exists
// on a given class. The naming is enforced as MethodExists_[method name] which
// will be a struct having a member 'value'. It also makes a inline constexpr
// boolean type postfixed with V e.g. MethodExists_[method name]_V that you can
// check without de-referencing the static value member.
#define TRAIT_METHOD_EXISTS(MethodName, ReturnType) \
    TRAIT_METHOD_EXISTS_EX(MethodExists_##MethodName, MethodName, ReturnType)
#define TRAIT_METHOD_EXISTS_1(MethodName, ReturnType, arg1)                    \
    TRAIT_METHOD_EXISTS_EX1(MethodExists_##MethodName, MethodName, ReturnType, \
                            arg1)
#define TRAIT_METHOD_EXISTS_2(MethodName, ReturnType, arg1, arg2)              \
    TRAIT_METHOD_EXISTS_EX2(MethodExists_##MethodName, MethodName, ReturnType, \
                            arg1, arg2)

// TRAIT_HAS_TYPE(type) - Creates a trait to check of the type has an inner type
// matching the name of the macros argument.
#define TRAIT_HAS_TYPE(TypeName)                                               \
    template <typename, typename = void>                                       \
    struct TRAIT_NAME(HasType, TypeName) : std::false_type {};                 \
                                                                               \
    template <typename T>                                                      \
    struct TRAIT_NAME(HasType, TypeName)<T, std::void_t<typename T::TypeName>> \
        : std::true_type {};                                                   \
                                                                               \
    template <typename T>                                                      \
    static constexpr bool TRAIT_NAME_VALUE_2(HasType, TypeName) =              \
        TRAIT_NAME_2(HasType, TypeName)<T>::value

// TRAIT_HAS_MEMBER(type) - Creates a trait to check of the type has an inner
// member matching the name of the macros argument also incidently works with
// inner types, however the HAS_TYPE traits are more strict and *only* work with
// types.
#define TRAIT_HAS_MEMBER(TypeName)                                  \
    template <typename T>                                           \
    struct TRAIT_NAME_2(HasMember, TypeName) {                      \
        struct Fallback {                                           \
            int TypeName;                                           \
        };                                                          \
        struct Derived : T, Fallback {};                            \
                                                                    \
        template <typename C, C>                                    \
        struct ChT;                                                 \
                                                                    \
        template <typename C>                                       \
        static char (&f(ChT<int Fallback::*, &C::TypeName>*))[1];   \
        template <typename C>                                       \
        static char (&f(...))[2];                                   \
                                                                    \
        static bool const value = sizeof(f<Derived>(0)) == 2;       \
    };                                                              \
                                                                    \
    template <typename T>                                           \
    static constexpr bool TRAIT_NAME_VALUE_2(HasMember, TypeName) = \
        TRAIT_NAME_2(HasMember, TypeName)<T>::value
