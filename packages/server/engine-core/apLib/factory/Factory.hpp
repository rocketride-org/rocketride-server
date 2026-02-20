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

namespace ap {

// Find a factory of the given type with the given name
inline ErrorOr<FACTORY> Factory::findFactory(iTextView type,
                                             iTextView name) noexcept {
    if (auto iter = factories().find({type, name}); iter != factories().end())
        return *iter;
    return APERRL(Error, Ec::FactoryNotFound,
                  "Could not find a factory for type:", string::enclose(type),
                  "name:", string::enclose(name));
}

// Find all factories of a given type
inline Factory::Names Factory::getFactories(iTextView type) noexcept {
    Names result;
    for (const auto &factory : factories()) {
        if (factory.type == type) result.emplace_back(factory.name);
    }
    return result;
}

// Generic factory create method forwards all args to the assumed
// present static factory api in the type, and returns a wrapped
// unique ptr as the result
template <typename T, typename... Args>
inline ErrorOr<Ptr<T>> Factory::make(Location location,
                                     Args &&...args) noexcept {
    if constexpr (traits::IsDetected<DetectFactoryInterface, T>()) {
        // Keep expanding the factory type until we get to the factory
        auto res = make<typename T::FactoryInterface>(
            location, std::forward<Args>(args)...);
        if (!res) return res.ccode();

        // Cast it
        return castMovePtr<T>(_mv(*res));
    } else {
        // Directly instantiate
        return T::__factory(location, 0, {std::forward<Args>(args)...});
    }
}

template <typename T, typename... Args>
inline ErrorOr<Ptr<T>> Factory::makeFlag(Location location,
                                         uint32_t requiredFlags,
                                         Args &&...args) noexcept {
    if constexpr (traits::IsDetected<DetectFactoryInterface, T>()) {
        // Keep expanding the factory type until we get to the factory
        auto res = makeFlag<typename T::FactoryInterface>(
            location, requiredFlags, std::forward<Args>(args)...);
        if (!res) return res.ccode();

        // Cast it
        return castMovePtr<T>(_mv(*res));
    } else {
        // Directly instantiate
        return T::__factory(location, requiredFlags,
                            {std::forward<Args>(args)...});
    }
}

// Like make above but this one will look for the factory
// entry
template <typename T, typename... Args>
inline ErrorOr<Ptr<T>> Factory::find(Location location, uint32_t requiredFlags,
                                     TextView name, Args &&...args) noexcept {
    // Lookup the factory registration
    auto factory = findFactory(T::FactoryType, name);
    if (!factory) return _mv(factory.ccode());

    if (requiredFlags && !(factory->flags & requiredFlags))
        return APERR(Ec::InvalidParam,
                     "Factory flags: {} don't match required: {}",
                     factory->flags, requiredFlags);

    // Instantiate then upcast
    auto factoryCallback = _reCast<ErrorOr<Ptr<T>> (*)(
        Location, typename T::FactoryArgs) noexcept>(factory->method);
    auto ptr = factoryCallback(location, {std::forward<Args>(args)...});
    if (!ptr) return _mv(ptr.ccode());

    return castMovePtr<T>(_mv(*ptr));
}

// Object deleter, called when a Ptr destructs with a live held
// ptr instance. We use this to track our object lifetimes simply.
template <typename T>
inline void Factory::objectDeleter(T *instance) noexcept {
    auto enabled = log::isLevelEnabled(Lvl::Factory);

    // If debug mode, report the instance to the global instance map
#if defined(ROCKETRIDE_FACTORY_DEBUG)
    if (enabled) log::write(_location, "Destroying {} ptr: {,x}", info, ptr);
#else
    // Generically log on behalf of the type using it global log level
    // constant, log if either factory log level or the types log level
    // is enabled
    if (enabled)
        log::write(_location, "Destroying: {} ptr: {,x}", util::typeName<T>(),
                   _reCast<uintptr_t>(instance));
#endif

    delete instance;
}

// Called to construct with arguments a managed instance
template <typename T, typename C, typename... Args>
inline ErrorOr<Ptr<C>> Factory::objectConstructor(Location location,
                                                  Args &&...args) noexcept {
    // It might be handy some day to allow exceptions in our constructors
    // so we will for now catch exceptions on a new to allow this
    auto res = error::call(_location,
                           [&] { return new T(std::forward<Args>(args)...); });
    if (!res) return res.ccode();
    return objectWrapper<C>(location, _mv(*res));
}

// Called to report a constructed instance ptr. We are able to track
// the lifetimes of anything constructed with a factor Ptr since we
// hook into its destruction with a callback.
template <typename T, typename F, bool Log>
inline Ptr<T> Factory::objectWrapper(Location location, F *instance) noexcept {
    // Verify the ptr isn't null, and automatically log on behalf of the type
    // using the fact that its log level is a constant we can access generically
    ASSERTD_MSG(instance, "Null ptr:", location, util::typeName<F>());

    auto enabled = log::isLevelEnabled(Lvl::Factory);

    // If debug mode, report the instance to the global instance map
#if defined(ROCKETRIDE_FACTORY_DEBUG)
    {
        auto [ptr, info] = addInstance(location, instance);

        // log if either factory log level or the types log level
        if (enabled && location)
            log::write(_location, "Instantiated: {} ptr: {,x}", info, ptr);
    }
#else
    // log if either factory log level or the types log level
    if (Log && enabled && location) {
        log::write(_location, "Instantiated: {} location: {} ptr: {,x}",
                   util::typeName<F>(), location, _reCast<uintptr_t>(instance));
    }
#endif

    // Now poly cast to the resulting type, this does a static cast on release
    // builds, and a dynamic cast in debug builds, it will assert if the cast
    // is invalid on debug essentially
    return Ptr<T>{_polyCast<T *>(instance), &Factory::objectDeleter};
}

}  // namespace ap
