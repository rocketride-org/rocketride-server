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
    return APERRL(Error, Ec::FactoryNotFound,
                  "Could not find a factory for type:", string::enclose(type),
                  "name:", string::enclose(name));
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
