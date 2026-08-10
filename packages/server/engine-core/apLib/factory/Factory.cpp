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
//	This module hosts the factory registry and all mutation of it
//

namespace ap {

//-------------------------------------------------------------------------
/// @details
///		The factory registry for the process
//-------------------------------------------------------------------------
Factory::Set &Factory::factories() noexcept {
    static Set factorySet;
    return factorySet;
}

//-------------------------------------------------------------------------
/// @details
///		Find a factory of the given type with the given name
///	@returns
///		The factory, or Ec::FactoryNotFound
//-------------------------------------------------------------------------
ErrorOr<FACTORY> Factory::findFactory(iTextView type,
                                      iTextView name) noexcept {
    if (auto iter = factories().find({type, name}); iter != factories().end())
        return *iter;

    // Not registered, so map the node declaring it and look again
    if (loadNode(name)) {
        if (auto iter = factories().find({type, name});
            iter != factories().end())
            return *iter;
    }

    return APERRL(Error, Ec::FactoryNotFound,
                  "Could not find a factory for type:", string::enclose(type),
                  "name:", string::enclose(name));
}

//-------------------------------------------------------------------------
/// @details
///		The declared node modules for the process
//-------------------------------------------------------------------------
Factory::Nodes &Factory::nodes() noexcept {
    static Nodes nodeSet;
    return nodeSet;
}

//-------------------------------------------------------------------------
/// @details
///		Whether this process can host node modules
//-------------------------------------------------------------------------
bool &Factory::nodeModulesSupported() noexcept {
    static bool supported = true;
    return supported;
}

//-------------------------------------------------------------------------
/// @details
///		Serializes node loading. findFactory misses on any thread, while
///		loading mutates both the node set and the factory registry
//-------------------------------------------------------------------------
static async::MutexLock &nodeLock() noexcept {
    static async::MutexLock lock;
    return lock;
}

//-------------------------------------------------------------------------
/// @details
///		Declares a node module, to be loaded when a factory of the same
///		name is first looked up
///	@param[in]	name
///		The factory name the node provides
///	@param[in]	libPath
///		The node's shared library
//-------------------------------------------------------------------------
Error Factory::registerNode(iTextView name,
                            const file::Path &libPath) noexcept {
    auto guard = nodeLock().acquire();

    auto [iter, inserted] = nodes().insert({(iText) name, NODE{libPath}});
    if (!inserted)
        return APERRL(Error, Ec::InvalidParam, "Node already registered",
                      string::enclose(name));

    LOG(Factory, "Register node", string::enclose(name), libPath);
    return Error{};
}

//-------------------------------------------------------------------------
/// @details
///		Maps the node module declaring a factory name and lets its
///		initializeNode register what it provides
///	@returns
///		Whether a node was loaded, so the caller looks the factory up again
//-------------------------------------------------------------------------
bool Factory::loadNode(iTextView name) noexcept {
    auto guard = nodeLock().acquire();

    auto found = nodes().find(name);
    if (found == nodes().end()) return false;

    auto &node = found->second;
    if (node.loadAttempted) return false;
    node.loadAttempted = true;

    // Skipped where the host does not share the engine module
    if (!nodeModulesSupported()) {
        LOG(Factory, "Node", string::enclose(name),
            "skipped, this host does not share the engine module");
        return false;
    }

    LOG(Factory, "Loading node", string::enclose(name), node.libPath);

    // Logged, not returned - findFactory raises the FactoryNotFound
    if (!file::exists(node.libPath)) {
        LOG(Factory, "The node library", node.libPath, "was not found");
        return false;
    }

    // Bound before either runs, so a node missing one is not half-registered
    auto initNode =
        plat::dynamicBind<bool()>(node.libPath, ROCKETRIDE_NODE_INIT);
    if (!initNode) {
        LOG(Factory, "The node", node.libPath, "has no", ROCKETRIDE_NODE_INIT,
            initNode.ccode());
        return false;
    }

    auto deinitNode =
        plat::dynamicBind<void()>(node.libPath, ROCKETRIDE_NODE_DEINIT);
    if (!deinitNode) {
        LOG(Factory, "The node", node.libPath, "has no",
            ROCKETRIDE_NODE_DEINIT, deinitNode.ccode());
        return false;
    }

    // Let the node register its factories
    if (!(*initNode)()) {
        LOG(Factory, "The node", node.libPath, "failed to initialize");
        return false;
    }

    // Remember how to unregister them again
    node.deinit = *deinitNode;

    LOG(Factory, "Loaded node", string::enclose(name));
    return true;
}

//-------------------------------------------------------------------------
/// @details
///		Lets every loaded node pull its factories back out of the registry.
///		They point into the node modules, so this has to run while those
///		are still mapped.
//-------------------------------------------------------------------------
void Factory::unloadNodes() noexcept {
    auto guard = nodeLock().acquire();

    for (auto &[name, node] : nodes()) {
        if (!node.deinit) continue;
        LOG(Factory, "Unloading node", string::enclose(name));
        node.deinit();
        node.deinit = nullptr;
    }

    nodes().clear();
}

//-------------------------------------------------------------------------
/// @details
///		Find all factories of a given type
//-------------------------------------------------------------------------
Factory::Names Factory::getFactories(iTextView type) noexcept {
    Names result;
    for (const auto &factory : factories()) {
        if (factory.type == type) result.emplace_back(factory.name);
    }
    return result;
}

//-------------------------------------------------------------------------
/// @details
///		Expands a factory's comma-delimited name list into one entry per
///		alias
//-------------------------------------------------------------------------
std::vector<FACTORY> Factory::expand(const FACTORY &factory) noexcept {
    std::vector<FACTORY> result;
    auto fields = string::view::tokenizeArray<10>(factory.name, ',');
    for (auto &&name : fields) {
        if (!name) break;
        result.push_back({factory.type, name, factory.flags, factory.method});
    }
    return result;
}

//-------------------------------------------------------------------------
/// @details
///		Registers a single factory (and each of its aliases)
///	@returns
///		Error
//-------------------------------------------------------------------------
Error Factory::registerFactoryEntry(const FACTORY &factory) noexcept {
    auto expansions = expand(factory);
    if (expansions.empty())
        return APERRL(Error, Ec::InvalidParam, "Invalid factory", factory);

    for (auto &expanded : expansions) {
        auto [iter, inserted] = factories().insert(expanded);
        if (!inserted)
            return APERRL(Error, Ec::InvalidParam, "Factory already registered",
                          factory);
        LOG(Factory, "Register", expanded);
    }

    return Error{};
}

//-------------------------------------------------------------------------
/// @details
///		De-registers a single factory (and each of its aliases)
//-------------------------------------------------------------------------
void Factory::deregisterFactoryEntry(const FACTORY &factory) noexcept {
    for (auto &expanded : expand(factory)) factories().erase(expanded);
}

}  // namespace ap
