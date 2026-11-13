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

namespace ap {

// Constructs a managed factory ptr
template <typename T, typename... Args>
inline ErrorOr<Ptr<T>> makePtr(Location location, Args &&...args) noexcept {
    return Factory::objectConstructor<T, T>(location,
                                            std::forward<Args>(args)...);
}

// Ptr casting for our managed Ptr type
template <typename CastTo, typename CastFrom>
inline Ptr<CastTo> castMovePtr(Ptr<CastFrom> &&ptr) noexcept {
    return Factory::objectWrapper<CastTo, CastFrom, false>({}, ptr.release());
}

template <typename CastTo, typename CastFrom>
inline CastTo *castPtr(Ptr<CastFrom> &ptr) noexcept {
    if constexpr (traits::IsSameTypeV<CastTo, CastFrom>)
        return ptr.get();
    else
        return _polyCast<CastTo *>(ptr.get());
}

template <typename CastTo, typename CastFrom>
inline const CastTo *castPtr(const Ptr<CastFrom> &ptr) noexcept {
    if constexpr (traits::IsSameTypeV<CastTo, CastFrom>)
        return ptr.get();
    else
        return _polyCast<const CastTo *>(ptr.get());
}

// Calls you back to let you set it up yourself
template <typename T, typename C>
ErrorOr<Ptr<C>> makePtrSetup(Location location,
                             const Function<Error(T &)> &setup) noexcept {
    auto ptr = makePtr<T>(location);
    if (ptr) {
        if (auto ccode = setup(*ptr.get())) return ccode;
        return castMovePtr<C>(_mv(*ptr));
    }
    return ptr.ccode();
}

// Sometimes its handy to make, and then downcast to the base type
// this api combines both
template <typename T, typename C, typename... Args>
inline ErrorOr<Ptr<C>> makePtrCast(Location location, Args &&...args) noexcept {
    auto res = makePtr<T>(location, std::forward<Args>(args)...);
    if (res)
        return Factory::objectWrapper<C, T, false>(location, res.release());
    return _mv(res.ccode());
}

// Initializes a unique ptr to a null default state
template <typename T>
inline Ptr<T> nullPtr() noexcept {
    return Ptr<T>{nullptr, &Factory::objectDeleter};
}

// Initializes a shared ptr to a null default state
template <typename T>
inline SharedPtr<T> nullSharedPtr() noexcept {
    return SharedPtr<T>{nullptr, &Factory::objectDeleter};
}

}  // namespace ap
