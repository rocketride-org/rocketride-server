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

#include <engLib/eng.h>

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Deinitialize the storage engine - removes all storage related
///		factories
//-------------------------------------------------------------------------
void deinit() noexcept {
    filter::s3::deinit();

    // Register our command factories
    Factory::deregisterFactory(
        // Instances
        filter::bottom::IFilterInstance::Factory,
        filter::classify::IFilterInstance::Factory,
        filter::indexer::IFilterInstance::Factory,
        filter::hash::IFilterInstance::Factory,
        filter::parse::IFilterInstance::Factory,
        filter::pipe::IFilterInstance::Factory,

        filter::null::IFilterInstance::Factory,
        filter::filesys::filesys::IFilterInstance::Factory,
        filter::filesys::smb::IFilterInstance::Factory,
        filter::objstore::IFilterInstance::Factory,
        filter::s3::IFilterInstance::Factory,
        filter::azure::IFilterInstance::Factory,
        filter::zip::IFilterInstance::Factory,
        filter::python::IFilterInstance::Factory,
        filter::sharepoint::IFilterInstance::Factory,
        // Outlook - enterprise and personal variants
        filter::outlook::IFilterInstance::FactoryEnterprise,
        filter::outlook::IFilterInstance::FactoryPersonal,

        // Global data
        filter::bottom::IFilterGlobal::Factory,
        filter::classify::IFilterGlobal::Factory,
        filter::indexer::IFilterGlobal::Factory,
        filter::hash::IFilterGlobal::Factory,
        filter::parse::IFilterGlobal::Factory,
        filter::pipe::IFilterGlobal::Factory,

        filter::null::IFilterGlobal::Factory,
        filter::filesys::filesys::IFilterGlobal::Factory,
        filter::filesys::smb::IFilterGlobal::Factory,
        filter::objstore::IFilterGlobal::Factory,
        filter::s3::IFilterGlobal::Factory,
        filter::azure::IFilterGlobal::Factory,
        filter::zip::IFilterGlobal::Factory,
        filter::python::IFilterGlobal::Factory,
        filter::sharepoint::IFilterGlobal::Factory,
        // Outlook - enterprise and personal variants
        filter::outlook::IFilterGlobal::FactoryEnterprise,
        filter::outlook::IFilterGlobal::FactoryPersonal,

        // Endpoints
        filter::null::IFilterEndpoint::Factory,
        filter::filesys::filesys::IFilterEndpoint::Factory,
        filter::filesys::smb::IFilterEndpoint::Factory,
        filter::objstore::IFilterEndpoint::Factory,
        filter::s3::IFilterEndpoint::Factory,
        filter::azure::IFilterEndpoint::Factory,
        filter::zip::IFilterEndpoint::Factory,
        filter::python::IFilterEndpoint::Factory,
        filter::sharepoint::IFilterEndpoint::Factory,
        // Outlook - enterprise and personal variants
        filter::outlook::IFilterEndpoint::FactoryEnterprise,
        filter::outlook::IFilterEndpoint::FactoryPersonal);

    // Deinit the services controllers
    IServices::deinit();
}

//-------------------------------------------------------------------------
/// @details
///		Initialize the storage engine - adds all storage related
///		factories
//-------------------------------------------------------------------------
Error init() noexcept {
    filter::s3::init();

    // Init the service controllers
    if (auto ccode = IServices::init()) return ccode;

    // Register our command factories
    if (auto ccode = Factory::registerFactory(
            // Instances
            filter::bottom::IFilterInstance::Factory,
            filter::classify::IFilterInstance::Factory,
            filter::indexer::IFilterInstance::Factory,
            filter::hash::IFilterInstance::Factory,
            filter::parse::IFilterInstance::Factory,
            filter::pipe::IFilterInstance::Factory,

            filter::null::IFilterInstance::Factory,
            filter::filesys::filesys::IFilterInstance::Factory,
            filter::filesys::smb::IFilterInstance::Factory,
            filter::objstore::IFilterInstance::Factory,
            filter::s3::IFilterInstance::Factory,
            filter::azure::IFilterInstance::Factory,
            filter::zip::IFilterInstance::Factory,
            filter::python::IFilterInstance::Factory,
            filter::sharepoint::IFilterInstance::Factory,
            // Outlook - enterprise and personal variants
            filter::outlook::IFilterInstance::FactoryEnterprise,
            filter::outlook::IFilterInstance::FactoryPersonal,

            // Global data
            filter::bottom::IFilterGlobal::Factory,
            filter::classify::IFilterGlobal::Factory,
            filter::indexer::IFilterGlobal::Factory,
            filter::hash::IFilterGlobal::Factory,
            filter::parse::IFilterGlobal::Factory,
            filter::pipe::IFilterGlobal::Factory,

            filter::null::IFilterGlobal::Factory,
            filter::filesys::filesys::IFilterGlobal::Factory,
            filter::filesys::smb::IFilterGlobal::Factory,
            filter::objstore::IFilterGlobal::Factory,
            filter::s3::IFilterGlobal::Factory,
            filter::azure::IFilterGlobal::Factory,
            filter::zip::IFilterGlobal::Factory,
            filter::python::IFilterGlobal::Factory,
            filter::sharepoint::IFilterGlobal::Factory,
            // Outlook - enterprise and personal variants
            filter::outlook::IFilterGlobal::FactoryEnterprise,
            filter::outlook::IFilterGlobal::FactoryPersonal,

            // Endpoints
            filter::null::IFilterEndpoint::Factory,
            filter::filesys::filesys::IFilterEndpoint::Factory,
            filter::filesys::smb::IFilterEndpoint::Factory,
            filter::objstore::IFilterEndpoint::Factory,
            filter::s3::IFilterEndpoint::Factory,
            filter::azure::IFilterEndpoint::Factory,
            filter::zip::IFilterEndpoint::Factory,
            filter::python::IFilterEndpoint::Factory,
            filter::sharepoint::IFilterEndpoint::Factory,
            // Outlook - enterprise and personal variants
            filter::outlook::IFilterEndpoint::FactoryEnterprise,
            filter::outlook::IFilterEndpoint::FactoryPersonal)) {
        store::deinit();
        return ccode;
    }

    return {};
}
}  // namespace engine::store
