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

#include <node_api.h>

#include "msservices.hpp"

extern "C" ROCKETRIDE_NODE_API bool initializeNode() noexcept {
    using namespace engine::store::filter;

    if (auto ccode = ap::Factory::registerFactory(
            // Outlook - enterprise and personal variants
            outlook::IFilterInstance::FactoryEnterprise,
            outlook::IFilterInstance::FactoryPersonal,
            outlook::IFilterGlobal::FactoryEnterprise,
            outlook::IFilterGlobal::FactoryPersonal,
            outlook::IFilterEndpoint::FactoryEnterprise,
            outlook::IFilterEndpoint::FactoryPersonal,

            sharepoint::IFilterInstance::Factory,
            sharepoint::IFilterGlobal::Factory,
            sharepoint::IFilterEndpoint::Factory)) {
        LOG(Services, "Failed to register the msServices factories:", ccode);
        return false;
    }

    return true;
}

extern "C" ROCKETRIDE_NODE_API void deinitializeNode() noexcept {
    using namespace engine::store::filter;

    ap::Factory::deregisterFactory(
        // Outlook - enterprise and personal variants
        outlook::IFilterInstance::FactoryEnterprise,
        outlook::IFilterInstance::FactoryPersonal,
        outlook::IFilterGlobal::FactoryEnterprise,
        outlook::IFilterGlobal::FactoryPersonal,
        outlook::IFilterEndpoint::FactoryEnterprise,
        outlook::IFilterEndpoint::FactoryPersonal,

        sharepoint::IFilterInstance::Factory,
        sharepoint::IFilterGlobal::Factory,
        sharepoint::IFilterEndpoint::Factory);
}
