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
//	This module contains all the static factories
//
#pragma once

namespace ap {

// Define the structure that is used to track active factories
struct FACTORY {
    // Name of the type of factory (service, node, channel, etc)
    iTextView type;

    // Name of the resources (datanet, datafile, s3, objstore, etc).
    //
    // Wildcards - Primitive support for a wildcard of .* e.g. access.*
    // will match for any name starting with access
    //
    // Lists - Comma delimited lists are allowed here, the first
    // just will alias this factory to an additional type
    //
    // Single - A single string will require an exact match
    iTextView name;

    // Generic bit mask checkable by the instantiator, realm specific
    uint32_t flags = {};

    // Opaque function ptr link to the factory method
    void *method = nullptr;

    // Render this factory as a string
    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "[" << type << "::" << name << "]";
    }
};

// This class contains all the factories to create various objects
class Factory {
public:
    // Log level for factory
    _const auto LogLevel = Lvl::Factory;

    // Alias our factory name list
    using Names = std::vector<iTextView>;

    // Detector for checking if the type declares a FactoryType, if
    // is does the factory will use that type for the result ptr
    template <typename TestType>
    using DetectFactory = std::is_class<typename TestType::Factory>;

    // Detector for checking if the type declares a FactoryType, if
    // is does the factory will use that type for the result ptr
    template <typename TestType>
    using DetectFactoryInterface =
        std::is_class<typename TestType::FactoryInterface>;

    // Detector checks if the class type declares its own object factory
    template <typename ArgType, typename... Args>
    using DetectObjectFactory =
        decltype(std::declval<ArgType &>().objectFactory(
            std::declval<Args>()...));

    // Detect if the type declares a LogLevel
    template <typename T>
    using DetectLogLevel = std::is_enum<decltype(T::LogLevel)>;

    static ErrorOr<FACTORY> findFactory(iTextView type,
                                        iTextView name) noexcept;
    static Names getFactories(iTextView type) noexcept;

    // Define the sorter for factories
    struct Sorter {
        // Set the is_transparent flag key to allowing disparate lookups
        using is_transparent = std::true_type;

        // Sort FACTORY instances
        bool operator()(const FACTORY &lhs, const FACTORY &rhs) const noexcept {
            // Compare types first, so we group them by type
            if (lhs.type < rhs.type) return true;
            if (lhs.type > rhs.type) return false;

            // If either is hosting a wildcard, strip it before the comparison
            if (lhs.name.contains(".*") || rhs.name.contains(".*"))
                return lhs.name.slice('.').first < rhs.name.slice('.').first;

            return lhs.name < rhs.name;
        }

        // Alternate compare between a FACTORY and a pair, supports prefix
        // checks against wildcard factory names e.g. access.*
        bool operator()(const Pair<iTextView, iTextView> &lhs,
                        const FACTORY &rhs) const noexcept {
            return operator()(FACTORY{lhs.first, lhs.second}, rhs);
        }

        bool operator()(const FACTORY &lhs,
                        const Pair<iTextView, iTextView> &rhs) const noexcept {
            return operator()(FACTORY{rhs.first, rhs.second}, lhs);
        }
    };

    // Alias our sorted factory set
    using Set = std::set<FACTORY, Factory::Sorter>;

    // Primary Ptr management apis
    template <typename T>
    static void objectDeleter(T *) noexcept;

    template <typename T, typename F, bool Log = true>
    static Ptr<T> objectWrapper(Location location, F *instance) noexcept;

    template <typename T, typename C, typename... Args>
    static ErrorOr<Ptr<C>> objectConstructor(Location location,
                                             Args &&...args) noexcept;

    // This constexpr api casted FACTORY structure and automatically
    // sets and casts an objectFactory method if declared on the
    // objects type, otherwise the base object types factory is used.
    template <typename ObjectType, typename InterfaceType>
    _const auto makeFactory(iTextView name, uint32_t flags = {}) {
        return FACTORY{
            InterfaceType::FactoryType, name, flags,
            (void *)objectConstructor<ObjectType, InterfaceType,
                                      typename InterfaceType::FactoryArgs>};
    }

    // This constexpr api casted FACTORY structure and automatically
    // sets and casts an objectFactory method if declared on the
    // objects type, otherwise the base object types factory is used.
    template <typename ObjectType, typename InterfaceType>
    _const auto makeFactory(iTextView name,
                            ErrorOr<Ptr<InterfaceType>> (*objectFactory)(
                                Location,
                                typename InterfaceType::FactoryArgs) noexcept,
                            uint32_t flags = {}) {
        return FACTORY{InterfaceType::FactoryType, name, flags,
                       (void *)objectFactory};
    }

    // Factory client usage, make, open (make + open), find (find + make)
    template <typename T, typename... Args>
    static ErrorOr<Ptr<T>> make(Location location, Args &&...args) noexcept;

    template <typename T, typename... Args>
    static ErrorOr<Ptr<T>> makeFlag(Location location, uint32_t requiredFlags,
                                    Args &&...args) noexcept;

    template <typename T, typename... Args>
    static ErrorOr<Ptr<T>> find(Location location, uint32_t requiredFlags,
                                TextView name, Args &&...args) noexcept;

    // Accessor for the global factory set
    static Set &factories() noexcept {
        static Set factorySet;
        return factorySet;
    }

    // Register a factory in the factory set
    template <typename... Args>
    static Error registerFactory(Args &&...args) noexcept {
        auto registerEntry = [&](const FACTORY &factory) {
            auto expansions = expand(factory);
            if (expansions.empty())
                return APERRL(Error, Ec::InvalidParam, "Invalid factory",
                              factory);

            for (auto &expanded : expand(factory)) {
                auto [iter, inserted] = factories().insert(expanded);
                if (!inserted)
                    return APERRL(Error, Ec::InvalidParam,
                                  "Factory already registered", factory);
                LOG(Factory, "Register", expanded);
            }

            return Error{};
        };

        // Use error's || operator here, through the fold expression, will
        // call all factory registrations but return the first error
        return (registerEntry(args) || ...);
    }

    // De-register a factory
    template <typename... Args>
    static void deregisterFactory(const Args &...args) noexcept {
        auto deregisterEntry = [&](const FACTORY &arg) {
            for (auto &expanded : expand(arg))
                Factory::factories().erase(expanded);
        };
        (deregisterEntry(args), ...);
    }

private:
    static std::vector<FACTORY> expand(const FACTORY &factory) noexcept {
        std::vector<FACTORY> result;
        auto fields = string::view::tokenizeArray<10>(factory.name, ',');
        for (auto &&name : fields) {
            if (!name) break;
            result.push_back(
                {factory.type, name, factory.flags, factory.method});
        }
        return result;
    }
#if defined(ROCKETRIDE_FACTORY_DEBUG)
    // Declare our instance structure, it contains callbacks to render
    // the type information and live string conversion for live stats
    // of active instances
    struct Instance {
        // Original location this instance was allocated at
        Location location;

        // Opaque lambda which when called renders the type to a string
        // this allows the type to report additional state information
        // about itself. Note this is only used for debug logging
        // as generally it may not be thread safe to call this.
        Function<Text()> render;

        // Render this instance as a string
        template <typename Buffer>
        auto __toString(Buffer &buff) const noexcept {
            buff << render();
        }
    };

    // Alias our map map, a map of all active instances pointing to
    // additional information for debug logging
    using InstanceMap = std::map<uintptr_t, Instance>;

    // Static method to ensure static construction order for our global
    // instance tracking map
    static auto lockInstanceMap() noexcept {
        static async::Mutex mutex = {};
        static InstanceMap instances = {};
        return makePair(std::unique_lock{mutex}, makeRef(instances));
    }

    // Adds a tracked instance
    template <typename T>
    static auto addInstance(Location location, T *instance) noexcept {
        auto key = _reCast<uintptr_t>(instance);
        auto [guard, instances] = lockInstanceMap();

        Function<Text()> render;
        if constexpr (traits::IsDetected<DetectFactory, T>())
            render = []() noexcept {
                return _ts(util::typeName<T>(), " ", T::Factory);
            };
        else
            render = []() noexcept { return util::typeName<T>(); };

        auto iter = instances.find(key);
        if (iter != instances.end())
            iter->second.render = _mv(render);
        else
            iter =
                instances.emplace(key, Instance{location, _mv(render)}).first;

        ASSERT(instances.find(key) != instances.end());
        return makePair(key, makeRef(iter->second));
    }

    // Removes an instance from the tracked instance list
    template <typename T>
    static auto removeInstance(T *instance) noexcept {
        auto ptr = _reCast<uintptr_t>(instance);
        auto [guard, instances] = lockInstanceMap();
        auto iter = instances.find(ptr);
        ASSERT(iter != instances.end());
        auto info = _mv(iter->second);
        instances.erase(iter);
        return makePair(ptr, _mv(info));
    }

public:
    // Logs all active instances to the trace file
    static void renderInstances() noexcept {
        // Make a copy
        auto instances = lockInstanceMap().second;
        for (const auto &[ptr, info] : instances)
            log::write(info.location, "{,X} => {}", ptr, info);
    }

    // Gets the total number of instances
    static auto countInstances() noexcept {
        auto [guard, instances] = lockInstanceMap();
        return Count(instances.size());
    }
#endif
};

}  // namespace ap
