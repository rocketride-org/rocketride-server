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

namespace engine::store::filter::filesys::base {
template <log::Lvl LvlT>
class IBaseEndpoint;
}

namespace engine::permission {

//-------------------------------------------------------------------------
/// @details
///		The instance task runs the the pipeline to sign and index
///		the entries
//-------------------------------------------------------------------------
class permissions {
public:
    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobInstance;

    //-------------------------------------------------------------------------
    /// @details
    /// 	This function will start a worker thread to gather the
    ///		permissions
    ///	@param[in]	object
    ///		The object information about the object being processed
    ///	@returns
    ///		Error
    //-------------------------------------------------------------------------
    template <log::Lvl LvlT>
    Error beginPerm(
        Entry &object, perms::PermissionInformation &permissions,
        store::filter::filesys::base::IBaseEndpoint<LvlT> &endpoint) noexcept {
        // Clear the os path
        m_osPath.clear();

        // Clear the pending error
        m_pendingError = {};

        // Get the capabilities of this protocol
        uint32_t caps;
        if (auto ccode = Url::getCaps(object.url(), caps)) return ccode;

        // If this supports the file system security
        if (caps & Url::PROTOCOL_CAPS::SECURITY) {
            // bypasses URL in form of smb://hostname, by returning no error
            if constexpr (LvlT == log::Lvl::ServiceSmb) {
                file::Path path;
                if (auto ccode = Url::toPath(object.url(), path)) return ccode;

                if (!path.valid()) return {};
            }

            // Map the path
            if (auto ccode = Url::osPath(object.url(), m_osPath)) return ccode;

            if (auto ccode =
                    getPermissions(object, m_osPath, permissions, endpoint))
                return ccode;
        }

        // And it is running
        return {};
    }

    //-------------------------------------------------------------------------
    /// @details
    /// 	This function sets a system name
    ///	@param[in]	systemName
    ///		Name of the system
    //-------------------------------------------------------------------------
    void setSystemName(const Text &systemName) noexcept {
        m_systemName = systemName;
    }

    template <log::Lvl LvlT>
    ErrorOr<std::list<Text>> outputPermissions(
        perms::PermissionInformation &permissions,
        store::filter::filesys::base::IBaseEndpoint<LvlT> &endpoint) noexcept;

private:
    //-----------------------------------------------------------------
    // Private API
    //-----------------------------------------------------------------
    template <log::Lvl LvlT>
    Error getPermissions(
        Entry &entry, Text &osPath, perms::PermissionInformation &permissions,
        store::filter::filesys::base::IBaseEndpoint<LvlT> &endpoint) noexcept;

#ifdef ROCKETRIDE_PLAT_UNX
    template <log::Lvl LvlT>
    ErrorOr<int> getEffectivePermissions(
        struct stat &entryStat, const Text &path,
        store::filter::filesys::base::IBaseEndpoint<LvlT> &endpoint) noexcept;
#endif

#ifdef ROCKETRIDE_PLAT_WIN
    template <log::Lvl LvlT>
    Error getEffectivePermissions(
        perms::PermissionSet &entryPermission, Text &osPath,
        store::filter::filesys::base::IBaseEndpoint<LvlT> &endpoint) noexcept;
#endif
    Error mapId(TextView idStr, std::unordered_set<Text> &mappedIds,
                perms::PermissionInformation &permissionInfo) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		The path we are currently working on
    //-----------------------------------------------------------------
    Text m_osPath;

    //-----------------------------------------------------------------
    /// @details
    ///		Pending error is the error that is returned from the
    ///		thread. We only display it if the close indicates there
    ///		was no other error in processing the file
    //-----------------------------------------------------------------
    Error m_pendingError;

    //-----------------------------------------------------------------
    /// @details
    ///		System name to extract permissions from
    Text m_systemName;
};

}  // namespace engine::permission
