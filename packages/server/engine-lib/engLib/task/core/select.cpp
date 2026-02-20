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
//-----------------------------------------------------------------
/// @details
///		This function sets up the selections for the task. This
///		is from the services include[]/exclude[] arrays
///	@param[in]	serviceConfig
///		The service configuration
//-----------------------------------------------------------------
ErrorOr<std::vector<Path>> IServiceEndpoint::initSelections() noexcept {
    Error ccode;
    auto &serviceConfig = config.serviceConfig;

    // Get the endpoint protocol type
    auto type = getLogicalType(serviceConfig);
    if (!type) return type.ccode();

    // Get the capability flags
    uint32_t caps;
    if (ccode = url::UrlConfig::getCaps(*type, caps)) return ccode;

    // Load the selections
    m_pSelections = new file::Selections();
    if (*type == "smb") m_pSelections->setshareConfig(config.shareConfig);

    // By default, we will use include/excludes unless the driver declares it
    // is going to do it itself, in which case add * to select everything
    // the driver gives us
    if (serviceConfig.isMember("useSelectMode") &&
        serviceConfig["useSelectMode"].asString() == "driver") {
        // Setup the flags - these are fixed and usually only used by
        // the instance task. We set them here because some of the drivers
        // that may be present in the pipeline check it and don't do anythin
        // if they are not set. This is a bit of a hack, but it works
        uint32_t flags = 0;
        flags |= ap::flags::ENTRY_FLAGS::INDEX;
        flags |= ap::flags::ENTRY_FLAGS::CLASSIFY;
        flags |= ap::flags::ENTRY_FLAGS::SIGNING;
        flags |= ap::flags::ENTRY_FLAGS::PERMISSIONS;

        // And add it
        m_pSelections->addInclude((Text) "*", flags);
    } else {
        file::Selections::loadSelections(*m_pSelections, serviceConfig);
    }

    // If this is a file system, but not the network (SMB), then
    // add the local OS excludes and the data paths we use. This
    // really be done in the driver itself, but let's keep it here
    // for now
    if (caps & url::UrlConfig::PROTOCOL_CAPS::FILESYSTEM &&
        !(caps & url::UrlConfig::PROTOCOL_CAPS::NETWORK)) {
        // Get the os excludes
        TextVector osExcludes =
            config.taskConfig.lookup<TextVector>("osExcludes");

        // Add the os excludes if necessary
        if (serviceConfig["parameters"].lookup<bool>("excludeEnableGlobal"))
            m_pSelections->addExcludes(osExcludes);

        // Get external drives exclude flag
        bool excludeExternalDrives = true;
        if (ccode = serviceConfig["parameters"].lookupAssign(
                "excludeExternalDrives", excludeExternalDrives))
            return ccode;
        m_pSelections->setExcludeExternalDrives(
            serviceConfig["parameters"].lookup<bool>("excludeExternalDrives"));

        // Always exclude our paths
        m_pSelections->addExclude((Text)config::paths().control);
        m_pSelections->addExclude((Text)config::paths().data);
        m_pSelections->addExclude((Text)config::paths().log);
        m_pSelections->addExclude((Text)config::paths().cache);
    }

    auto selectionPaths = m_pSelections->resolve(true);

    // Return the paths or an error
    return selectionPaths;
}

//-----------------------------------------------------------------
/// @details
///		This function sets up the selections for the task. This
///		is from the services include[]/exclude[] arrays
///	@param[in]	serviceConfig
///		The service configuration
//-----------------------------------------------------------------
Error IServiceEndpoint::deinitSelections() noexcept {
    if (m_pSelections) {
        delete m_pSelections;
        m_pSelections = nullptr;
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Given a path, this function will determine if it is to
///		be exluded by the file name rules or not
///	@param[in]	path
///		Path to check
//-----------------------------------------------------------------
bool IServiceEndpoint::isExcludedByFileName(const Path &path) noexcept {
    // Determine if it is included or not
    if (m_pSelections->isExcludedByFileName(path)) {
        LOGT("Excluded", path);
        return true;
    }

    return false;
}

//-----------------------------------------------------------------
/// @details
///		Given a path, this function will determine if it is to
///		be included or not
///	@param[in]	path
///		Path to check
///	@returns
///		Error
//-----------------------------------------------------------------
bool IServiceEndpoint::isIncluded(const Path &path, uint32_t &flags) noexcept {
    // Determine if it is included or not
    if (!m_pSelections->isIncluded(path, flags)) {
        LOGT("Excluded", path);
        return false;
    }

    // Prevent files with crazy names from gumming up our pipeline
    for (auto ch : path.gen()) {
        switch (ch) {
            case '*':
                MONERR(warning, Ec::Excluded,
                       "Skipping file with unsupported asterisk in path", path);
                return false;

            case '\n':
            case '\r':
                MONERR(warning, Ec::Excluded,
                       "Skipping file with unsupported newline in path", path);
                return false;
        }
    }

    return true;
};

//-----------------------------------------------------------------
/// @details
///		Return CRC32 of the current selection settings
//-----------------------------------------------------------------
uint32_t IServiceEndpoint::getSelectionsHash() const noexcept {
    return m_pSelections->getHash();
}

}  // namespace engine::store
