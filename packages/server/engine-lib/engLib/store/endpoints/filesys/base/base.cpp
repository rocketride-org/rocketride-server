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

namespace engine::store::filter::filesys::base {
//-----------------------------------------------------------------
/// @details
///		Begins the endpoint and does some checking to make sure
///		everything is configured correctly
///	@param[in]	openMode
///		The open mode
///	@returns
///		Error
//-----------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseEndpoint<LvlT>::beginEndpoint(OPEN_MODE openMode_) noexcept {
    // Based on the service type
    switch (config.serviceMode) {
        default:
        case SERVICE_MODE::SOURCE:
            // For source mode, we will be using scans and render so
            // storePath is not required
            break;

        case SERVICE_MODE::TARGET:
            // For target mode, make sure we have a store path first. This
            // is regardless of the format type
            if (!config.storePath)
                return APERR(Ec::InvalidParam, "No storePath specified");
            break;
    }

    // Get our parameters
    if (auto ccode = config.parameters.lookupAssign("excludeExternalDrives",
                                                    m_excludeExternalDrives))
        return ccode;
    if (auto ccode = config.parameters.lookupAssign("excludeSymlinks",
                                                    m_excludeSymlinks))
        return ccode;

    // And call the parent
    return Parent::beginEndpoint(openMode_);
}

//-----------------------------------------------------------------
/// @details
///		Make static, finalized configs
//-----------------------------------------------------------------
template <log::Lvl LvlT>
Error IBaseEndpoint<LvlT>::getConfigSubKey(Text &key) noexcept {
    // Build a standalone key - pretty much fixed
    key = (TextView)config.storePath;
    return {};
}

template <log::Lvl LvlT>
Error IBaseInstance<LvlT>::getPermissions(Entry &entry) noexcept {
    // Startup the worker
    if (auto ccode =
            permissions.beginPerm(entry, m_endpoint.permissionInfo, m_endpoint))
        return ccode;

    return {};
}

template <log::Lvl LvlT>
ErrorOr<std::list<Text>> IBaseInstance<LvlT>::outputPermissions() noexcept {
    return permissions.outputPermissions(m_endpoint.permissionInfo, m_endpoint);
}
}  // namespace engine::store::filter::filesys::base
