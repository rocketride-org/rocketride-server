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

#include <engLib/eng.h>

namespace engine::store::filter::filesys::smb {

//-----------------------------------------------------------------
/// @details
///     Begins the endpoint and checks the format of the service
///     confing and accessibility of SMB share as well as other
///     base conditions
/// @param[in]  openMode
///     The open mode
/// @returns
///     Error
//-----------------------------------------------------------------
Error IFilterEndpoint::beginEndpoint(OPEN_MODE openMode_) noexcept {
    // Call the parent
    if (auto ccode = Parent::beginEndpoint(openMode_)) return ccode;

    // Parse config and get the host, etc
    if (auto ccode = config.parameters.lookupAssign(
                         "server", config.shareConfig.server) ||
                     config.parameters.lookupAssign(
                         "name", config.shareConfig.originalName) ||
                     config.parameters.lookupAssign(
                         "username", config.shareConfig.username) ||
                     config.parameters.lookupAssign(
                         "password", config.shareConfig.password))
        return ccode;

    // Validate config
    if (!config.shareConfig.valid())
        return APERR(Ec::InvalidParam, "Invalid SMB configuration");
    if (!config.shareConfig.validUserName()) {
        if (config.jobConfig["type"].asString() == "configureService") {
            return APERR(Ec::InvalidParam,
                         "Invalid SMB configuration: user name should be "
                         "specified using domain-like format");
        }
        LOG(Always,
            "Please correct SMB configuration: user name should be specified "
            "using domain-like format");
        MONITOR(status,
                "Please correct SMB configuration: user name should be "
                "specified using domain-like format");
    }

    // Check if storePath is valid for share config
    if (config.serviceMode == SERVICE_MODE::TARGET) {
        Text path(config.storePath.str());

        if (path.startsWith("//") || path.startsWith("\\\\"))
            return APERR(Ec::InvalidParam, "Invalid targetPath:", path);

        // create the path
        config.storePath =
            Path(("//" + config.shareConfig.server + "/" + path));

        // Path should be UNC and greater than or equal to 2
        if (!config.storePath.isUnc() && config.storePath.length() >= 2)
            return APERR(Ec::InvalidParam,
                         "Invalid storePath: UNC path expected");

        if (config.shareConfig.server != config.storePath.at(0))
            return APERR(Ec::InvalidParam,
                         "UNC storePath does not match SMB server");
    } else if (config.serviceMode == SERVICE_MODE::SOURCE) {
        auto transformPath = [this](json::Value &service,
                                    TextView sectionName) noexcept -> Error {
            auto &section = config.serviceConfig[sectionName];

            for (auto &sectionEntry : section) {
                Text path;

                // Get the parameters
                if (auto ccode = sectionEntry.lookupAssign("path", path))
                    return ccode;

                if (path.startsWith("//") || path.startsWith("\\\\"))
                    return APERR(Ec::InvalidParam, "Invalid path:", path);

                path = "//" + config.shareConfig.server + "/" + path;
                sectionEntry["path"] = path;
            }
            return {};
        };

        if (auto ccode = transformPath(config.serviceConfig, "include") ||
                         transformPath(config.serviceConfig, "exclude"))
            return ccode;

        if (config.jobConfig["type"].asString() == "configureService") {
            if (auto ccode =
                    validatePaths(config.serviceConfig, "include", true) ||
                    validatePaths(config.serviceConfig, "exclude", false))
                return ccode;

            // Previously, loadSelections && resolve were called.
            // However, with wildcard support it is not needed anymore.
            // Reason:
            //      Validation is done on the platform, and platform might not
            //      have access to the shares. And if wildcards are used - real
            //      validation could not be performed. It is possible that as
            //      the result of mount none of shares would be mounted.
        }
    }

    // Returns if is a stat for the "deleted" resource
    // Prevents connection to the deleted resource which might not be available
    // at all
    bool deleted = config.serviceConfig.lookup<bool>("deleted");
    if (deleted) return {};

    // Do not mount SMB connection in case of validation
    if (openMode_ != OPEN_MODE::CONFIG) {
#if ROCKETRIDE_PLAT_WIN
        file::smb::impersonateNetworkService();
#endif

        // check include paths first
        // do not limit check to OPEN_MODE::SOURCE because it could be equal to
        // OPEN_MODE::SCAN for example also
        auto &includeSection = config.serviceConfig["include"];
        for (auto &sectionEntry : includeSection) {
            Text path;

            // Get the parameters
            if (auto ccode = sectionEntry.lookupAssign("path", path))
                return ccode;

            Text shareName = Path{path}.at(1);
            if (ap::globber::containsWildcard(shareName)) {
                // get list of all possible shares
                ErrorOr<std::vector<Text>> shares =
                    file::smb::enumShares(config.shareConfig, shareName);
                if (shares.hasCcode()) return shares.ccode();

                config.shareConfig.names.insert(config.shareConfig.names.end(),
                                                shares.value().begin(),
                                                shares.value().end());
            } else {
                config.shareConfig.names.push_back(shareName);
            }
        }

        // check storePath if is not empty -> add it
        // it is needed for OPEN_MODE::TARGET (is it needed just for
        // OPEN_MODE::TARGET?)
        if (config.storePath) {
            Text shareName = Path{config.storePath}.at(1);
            config.shareConfig.names.emplace_back(shareName);
        }

        // mount shares
        auto mounts = file::smb::mount(config.shareConfig);
        if (mounts.hasCcode()) return mounts.ccode();

        if (mounts
                .hasValue())  // avoid sigabort in Linux because mounts is empty
            m_mounts = _mv(*mounts);

        if (m_mounts.empty()) return APERR(Ec::InvalidParam, "Nothing mounted");
    }

    return {};
}

//-----------------------------------------------------------------
/// @details
///		Make static, finalized configs
/// @param[out]  key
///     The unique key idenifing endpoing configuration.
/// @returns
///     Error
//-----------------------------------------------------------------
Error IFilterEndpoint::getConfigSubKey(Text &key) noexcept {
    if (config.serviceMode == SERVICE_MODE::SOURCE) {
        // Source endpoint is unique by server host and share name
        key = _ts(config.shareConfig.server, "/",
                  config.shareConfig.originalName);
    } else {
        // Build a standalone key - pretty much fixed
        key = _ts(config.storePath);
    }
    return {};
}

//-----------------------------------------------------------------
/// @details
///		Check validness of entries from the corresponding section
/// @param[in]  service
///     The service configuration.
/// @param[in]  sectionName
///     The service name to test for the configuration validness.
/// @param[in]  checkEmpty
///     Checks if correspondent section is empty.
/// @returns
///     Error
//-----------------------------------------------------------------
Error IFilterEndpoint::validatePaths(json::Value &service, TextView sectionName,
                                     bool checkEmpty) noexcept {
    if (config.serviceMode == SERVICE_MODE::SOURCE) {
        // Get the corresponding section
        auto section = service[sectionName];

        if (checkEmpty && section.empty())
            return APERRL(ServiceSmb, Ec::InvalidParam, "Section", sectionName,
                          "is empty");

        for (auto &sectionEntry : section) {
            Text path;

            // Get the parameters
            if (auto ccode = sectionEntry.lookupAssign("path", path))
                return ccode;

            Path uncPath = {path};
            if (!uncPath.isUnc())
                return APERRL(ServiceSmb, Ec::InvalidParam, "Path from",
                              sectionName, "in not UNC-formatted:", path);

            if (uncPath.count() < 3)
                return APERRL(ServiceSmb, Ec::InvalidParam, "Path from",
                              sectionName,
                              "has to have at least 3 elements:", path);

            if (config.shareConfig.server != uncPath.at(0))
                return APERRL(
                    ServiceSmb, Ec::InvalidParam,
                    string::format("Server name `{}` is not equal to server "
                                   "name from {} section path: {}",
                                   config.shareConfig.server, sectionName,
                                   path));
        }
    }
    return {};
}
}  // namespace engine::store::filter::filesys::smb
