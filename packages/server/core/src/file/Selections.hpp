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

namespace ap::file {
//-------------------------------------------------------------------------
// Selections groups two glob groups together treating one as
// an include list and another as an exclude list
//
//	Note:
//		* Entering a glob like C: is very inneficient. This will cause
//		the whole system to be scanned. Enter it as C:/*. This informs
//		the scanner that C: is a container and to select all files on
//		C: by scanning only C:
//
//		* In general, if the terminal node is a directory, specify
//		as a directory by appending /* to it. This will allow the scanner
//		to optimize and initiate the scan on the full path given
//		rather than the parent of the full path (ie - C:/Python/* is
//		much more efficient than C:/Python)
//
//		* Specify a glob (C:/Python27/**/README.txt) will select all
//		readme.txt files within subdirectories of Python27, but NOT
//		C:/Python27/README.txt (the /**/ forces the scanner to look only
//		in subdirectories of Python27. To include C:/Python27/README.txt
//		as well, a specific rule needs to be created with specifying it
//
//		* Specify a glob like C:/Python27/README.* will select only
//		files README files directly in C:/Python27, not any of its
//		subdirectories
//
//		* Adding the /s option to the end of any path will effectively
//		add two rules - C:/Python27/README.txt /s will automatically
//		add C:/Python27/README.txt AND C:/Python27/**/README.txt
//
//-------------------------------------------------------------------------
class Selections {
public:
    //-------------------------------------------------------------
    // Contructor
    //-------------------------------------------------------------
    Selections() = default;

    //-------------------------------------------------------------
    // Setup our loggin info
    //-------------------------------------------------------------
    _const auto LogLevel = Lvl::Selections;

    //-------------------------------------------------------------
    /// @details
    ///		Add an include glob
    /// @param[in]	pattern
    ///		The glob pattern
    //-------------------------------------------------------------
    Error addInclude(Text pattern, uint32_t flags) noexcept {
        LOGT("Adding include:", pattern);
        return addPattern(m_includes, pattern, flags);
    }

    //-------------------------------------------------------------
    /// @details
    ///		Add an exclude glob
    /// @param[in]	pattern
    ///		The glob pattern
    //-------------------------------------------------------------
    Error addExclude(Text pattern) noexcept {
        LOGT("Adding exclude:", pattern);
        return addPattern(m_excludes, pattern, 0l);
    }

    //-------------------------------------------------------------
    /// @details
    ///		Add the includes from the service
    /// @param[in]	service
    ///		The service entry
    //-------------------------------------------------------------
    Error addIncludes(json::Value &service) noexcept {
        // Get the include section
        auto includes = service["include"];

        // Loop through them
        for (auto &include : includes) {
            Text path;
            bool flagClassify = false;
            bool flagIndex = false;
            bool flagOcr = false;
            bool flagMagick = false;
            bool flagSign = false;
            bool flagPermissions = false;
            bool flagVectorize = false;
            uint32_t flags = 0;

            // Get the parameters
            if (auto ccode =
                    include.lookupAssign("path", path) ||
                    include.lookupAssign("classify", flagClassify) ||
                    include.lookupAssign("index", flagIndex) ||
                    include.lookupAssign("ocr", flagOcr) ||
                    include.lookupAssign("imageEnhancement", flagMagick) ||
                    include.lookupAssign("signing", flagSign) ||
                    include.lookupAssign("permissions", flagPermissions) ||
                    include.lookupAssign("vectorize", flagVectorize))
                return ccode;

            // Setup the flags
            if (flagClassify) flags |= ap::flags::ENTRY_FLAGS::CLASSIFY;
            if (flagIndex) flags |= ap::flags::ENTRY_FLAGS::INDEX;
            if (flagOcr) flags |= ap::flags::ENTRY_FLAGS::OCR;
            if (flagMagick) flags |= ap::flags::ENTRY_FLAGS::MAGICK;
            if (flagSign) flags |= ap::flags::ENTRY_FLAGS::SIGNING;
            if (flagPermissions) flags |= ap::flags::ENTRY_FLAGS::PERMISSIONS;
            if (flagVectorize) flags |= ap::flags::ENTRY_FLAGS::VECTORIZE;

            // Add the entry
            if (auto ccode = addInclude(path, flags)) return ccode;
        }
        return {};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Add the excludes from the service
    /// @param[in]	excludes
    ///		Vector of excluded paths
    //-------------------------------------------------------------
    Error addExcludes(TextVector &excludes) noexcept {
        // Loop through them
        for (auto &exclude : excludes) {
            if (auto ccode = addExclude(exclude)) return ccode;
        }
        return {};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Add the excludes from the service
    /// @param[in]	service
    ///		The service entry
    //-------------------------------------------------------------
    Error addExcludes(json::Value &service) noexcept {
        // Get the exclude section as an array based on new react schema
        LOGT("Service JSON: ", service);
        auto excludes = service["exclude"];

        for (auto &entry : excludes) {
            Text path;
            if (auto ccode = entry.lookupAssign("path", path)) return ccode;

            // Add the exclude entry
            if (auto ccode = addExclude(path)) return ccode;
        }

        return {};
    }

    //-------------------------------------------------------------
    /// @details
    ///		Determines if a path is included
    /// @param[in]	path
    ///		The path to check
    ///	@param[out]	flags
    ///		Receives the flags for the matching rule
    //-------------------------------------------------------------
    auto isIncluded(const Path &path, uint32_t &flags) const noexcept {
        // The path is excluded
        auto excluded = [&](TextView reason) {
            ASSERT(reason);
            LOGT("Excluded: {} ({})", path, reason);
            return false;
        };

        // If there are explicit inclusions but they don't match this path,
        // exclude If there are no explicit inclusions, everything is included
        // by default
        if (m_includes && !m_includes.matches(path, flags))
            return excluded("Not explicitly included");

        // If there are explicit exclusions and they match this path, exclude
        if (m_excludes.matches(path)) return excluded("Explicitly excluded");

        // Determine if this is a removable drive
        if (m_excludeExternalDrives && file::isOnRemovableDrive(path))
            return excluded("On external drive");

        // Otherwise, included
        LOGT("Included: {} [{}]", path, flags);
        return true;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Determines if a path is excluded by the file name
    /// @param[in]	path
    ///		The path to check
    //-------------------------------------------------------------
    auto isExcludedByFileName(const Path &path) const noexcept {
        for (const auto &exclude : m_excludes) {
            uint32_t flags = 0;
            // If the last rule (file name rule) is exact and the exclude
            // matches to the path
            if (exclude.rule(exclude.ruleCount() - 1).type ==
                    globber::Glob::Rule::Type::EXACT &&
                exclude.matches(path, flags)) {
                LOGT("Excluded: {} (Explicitly excluded by absolute rule {})",
                     path, exclude.pattern());
                return true;
            }
        }
        return false;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Determines if a path is included - this is called when
    ///		flags are not required
    /// @param[in]	path
    ///		The path to check
    //-------------------------------------------------------------
    auto isIncluded(const Path &path) const noexcept {
        uint32_t flags;
        return isIncluded(path, flags);
    }

    //-------------------------------------------------------------
    /// @details
    ///		This function determines the resolved list of paths
    ///		which are included
    /// @param[in]	normalizeCase
    ///		Default to normalizing the case which will essentially
    ///		make sure the drive letter is uppercased
    //-------------------------------------------------------------
    ErrorOr<std::vector<Path>> resolve(
        bool normalizeCase = true) const noexcept {
        // Walk the includes, extract out the raw paths with wildcards stripped
        std::vector<Path> targetPaths;

        Path withinPath = m_withinPath;
#if ROCKETRIDE_PLAT_WIN
        // If this is on a file system and on windows normalize the case
        // to what exists on disk
        if ((m_caps & url::UrlConfig::PROTOCOL_CAPS::FILESYSTEM) &&
            withinPath && normalizeCase) {
            if (auto normalized = normalizePathCase(withinPath))
                withinPath = _mv(*normalized);
        }
#endif

        // Adds a path to the path set, will normalize if windows and
        // normalizeCase is set to true, and this is a filesys path
        auto addPath = [&](Path path) noexcept -> Error {
#if ROCKETRIDE_PLAT_WIN
            // If this is on a file system and on windows normalize the case
            // to what exists on disk
            if ((m_caps & url::UrlConfig::PROTOCOL_CAPS::FILESYSTEM) && path &&
                normalizeCase) {
                if (auto normalized = normalizePathCase(path))
                    path = _mv(*normalized);
            }
#endif

#if ROCKETRIDE_PLAT_LIN
            // Start from root if no more specific path specified for Linux file
            // system
            if ((m_caps & url::UrlConfig::PROTOCOL_CAPS::FILESYSTEM) && !path) {
                path = "/";
            }
#endif

            if (withinPath) {
                if (withinPath.isChildOf(path))
                    // Save the rescan path only if it is a child of the include
                    // path
                    targetPaths.push_back(withinPath);
                else if (path.isChildOf(withinPath))
                    // Save the include path only if it is a child of the rescan
                    // path
                    targetPaths.push_back(_mv(path));
                else
                    LOGT("Include skipped:", path);
            } else {
                // Save the path
                targetPaths.push_back(_mv(path));
            }
            return {};
        };

        // Rip through the includes, based on the type, add a path
        for (auto &include : m_includes) {
            // Get the pattern
            const auto pattern = include.pattern();

            // Build the path from the pattern
            const Path sourcePath{pattern};

            // Build the target path up until we find a wildcard or possible
            // range specifier
            Path targetPath;
            size_t index = 0;
            if (sourcePath.isUnc() && sourcePath.count() >= 2) {
                // Make the valid UNC root path
                const auto &host = sourcePath.at(index++);
                const auto &share = sourcePath.at(index++);
                if (share == "*")
                    targetPath = string::format("//{}", host);
                else
                    targetPath = string::format("//{}/{}", host, share);
            }
            for (; index < sourcePath.count(); index++) {
                // Get the component
                auto component = sourcePath.at(index);

                // Add the component to the target
                targetPath /= component;

                // If this has a wildcard, stop here
                if (component.find('*') != string::npos ||
                    component.find('?') != string::npos ||
                    component.find('[') != string::npos)
                    break;
            }

            // If there was a pattern specified, add it and continue on
            if (targetPath.count() > 1) {
                // Add the parent path
                if (auto ccode = addPath(targetPath.parent())) return ccode;
                continue;
            }

            // Add the parent path
            if (auto ccode = addPath(targetPath.parent())) return ccode;
        }

        // If no selections, we used to error out here, but, for different types
        // of source endpoints, they may not actually have the concept of
        // include paths
        // if (targetPaths.empty())
        //    return APERRT(Ec::InvalidSelection, "No valid includes could be
        //    found");

        // Walk through all the paths
        std::vector<Path> paths;
        for (auto targetIndex = 0; targetIndex < targetPaths.size();
             targetIndex++) {
            // Say we did not find it
            int32_t parentIndex = targetIndex;

            // See if this is a child of another path
            for (auto index = 0; index < targetPaths.size(); index++) {
                // If this is a child of some other parent path, set it
                if (index != targetIndex) {
                    if (targetPaths[targetIndex].isChildOf(
                            targetPaths[index])) {
                        parentIndex = index;
                    }
                }
            }

            // Determine if it is a duplicate
            bool bAddPath = true;
            for (auto pathIndex = 0; pathIndex < paths.size(); pathIndex++) {
                if (paths[pathIndex] == targetPaths[parentIndex]) {
                    bAddPath = false;
                    break;
                }
            }

            // If this is not a child of another path, save it
            if (bAddPath) paths.push_back(targetPaths[parentIndex]);
        }

        // Return the vector we built
        return paths;
    }

    //-------------------------------------------------------------
    /// @details
    ///		Load the includes/excludes from the service entry
    /// @param[out]	selections
    ///		Receives the selection ino
    ///	@param[in]	service
    ///		The services key to load
    //-------------------------------------------------------------
    static Error loadSelections(Selections &selections,
                                json::Value &service) noexcept {
        Text type;
        if (auto ccode = service.lookupAssign("type", type)) return ccode;

        if (type == "smb" || type == "filesys")
            selections.m_caseAware = plat::PathCaseMode;

        // check for available shares on a server if needed
        if (type == "smb") {
            if (selections.m_shareConfig.names.empty())
                return APERRL(
                    ServiceSmb, Ec::InvalidParam,
                    "Invalid param: can not find a share on this server");

            if (auto ccode =
                    modifyIncludeAndExclude(selections.m_shareConfig, service))
                return ccode;
        }

        // Get the capability flags
        if (auto ccode = url::UrlConfig::getCaps(type, selections.m_caps))
            return ccode;

        // Add the includes/excludes
        if (auto ccode = selections.addIncludes(service) ||
                         selections.addExcludes(service))
            return ccode;

        // Check if we are rescanning a specific folder
        if (service["parameters"].isMember("withinPath"))
            // Make the full UNC path for Samba source
            selections.m_withinPath =
                (type == "smb" ? "//" : "") +
                service["parameters"]["withinPath"].asString();

        return {};
    }

    //-------------------------------------------------------------
    /// @details
    ///    Modify the includes/excludes from the service entry
    /// @param[in] server
    ///    The server name or ip
    /// @param[in] shares
    ///    The shares that are available on the server
    /// @param[in/out] service
    ///    The services key to modify
    //-------------------------------------------------------------
    static Error modifyIncludeAndExclude(const file::smb::Share &m_shareConfig,
                                         json::Value &service) noexcept {
        // Get the include section
        auto includes = service["include"];
        // Get the exclude section
        auto excludes = service["exclude"];

        json::Value newIncludes = json::ValueType::arrayValue;
        json::Value newExcludes = json::ValueType::arrayValue;

        // Loop through include items
        for (auto &include : includes) {
            Text path;
            bool flagClassify = false;
            bool flagIndex = false;
            bool flagOcr = false;
            bool flagMagick = false;
            bool flagSign = false;
            bool flagPermissions = false;
            bool flagVectorize = false;

            // Get the parameters
            if (auto ccode =
                    include.lookupAssign("path", path) ||
                    include.lookupAssign("classify", flagClassify) ||
                    include.lookupAssign("index", flagIndex) ||
                    include.lookupAssign("ocr", flagOcr) ||
                    include.lookupAssign("imageEnhancement", flagMagick) ||
                    include.lookupAssign("signing", flagSign) ||
                    include.lookupAssign("permissions", flagPermissions) ||
                    include.lookupAssign("vectorize", flagVectorize))
                return ccode;

            Path uncPath = {path};
            if (!uncPath.isUnc())
                return APERRL(ServiceSmb, Ec::InvalidParam,
                              "Include path in not UNC-formatted", path);

            if (uncPath.count() >= 2 && uncPath.at(0) == m_shareConfig.server) {
                globber::Glob matcher;
                if (auto ccode = globber::createPathMatcher(
                        uncPath.at(1), 0, matcher, plat::PathCaseMode))
                    return ccode;

                globber::Globs includes;
                includes.add(_mv(matcher));

                for (auto &shareName : m_shareConfig.names) {
                    if (includes.matches(shareName)) {
                        json::Value obj = json::ValueType::objectValue;

                        obj["path"] =
                            uncPath.count() > 2
                                ? string::format("\\\\{}\\{}\\{}",
                                                 m_shareConfig.server,
                                                 shareName, uncPath.subpth(2))
                                : string::format("\\\\{}\\{}",
                                                 m_shareConfig.server,
                                                 shareName);
                        obj["classify"] = flagClassify;
                        obj["index"] = flagIndex;
                        obj["ocr"] = flagOcr;
                        obj["imageEnhancement"] = flagMagick;
                        obj["signing"] = flagSign;
                        obj["permissions"] = flagPermissions;
                        obj["vectorize"] = flagVectorize;

                        // Append this include to the new array
                        newIncludes.append(obj);
                    }
                }
            } else
                return APERRL(ServiceSmb, Ec::InvalidParam,
                              "Include path in not UNC-formatted or points to "
                              "invalid server",
                              path);
        }

        // Loop through exclude items
        for (auto &exclude : excludes) {
            Text path;

            // Get the parameters
            if (auto ccode = exclude.lookupAssign("path", path)) return ccode;

            Path uncPath = {path};
            if (!uncPath.isUnc())
                return APERRL(ServiceSmb, Ec::InvalidParam,
                              "Exclude path in not UNC-formatted", path);

            if (uncPath.count() >= 2 && uncPath.at(0) == m_shareConfig.server) {
                globber::Glob matcher;
                if (auto ccode = globber::createPathMatcher(
                        uncPath.at(1), 0, matcher, plat::PathCaseMode))
                    return ccode;

                globber::Globs excludes;
                excludes.add(_mv(matcher));

                for (auto &shareName : m_shareConfig.names) {
                    if (excludes.matches(shareName)) {
                        json::Value obj = json::ValueType::objectValue;

                        obj["path"] =
                            uncPath.count() > 2
                                ? string::format("\\\\{}\\{}\\{}",
                                                 m_shareConfig.server,
                                                 shareName, uncPath.subpth(2))
                                : string::format("\\\\{}\\{}",
                                                 m_shareConfig.server,
                                                 shareName);
                        // Append this exclude to the new array
                        newExcludes.append(obj);
                    }
                }
            } else
                return APERRL(ServiceSmb, Ec::InvalidParam,
                              "Exclude path in not UNC-formatted or points to "
                              "invalid server",
                              path);
        }

        // remove include and exclude sections from config
        service.removeMember("include");
        service.removeMember("exclude");

        // add the adjusted include and exclude sections, which have been
        // expanded for each share name
        service["include"] = newIncludes;
        service["exclude"] = newExcludes;

        return {};
    }

    //-----------------------------------------------------------------
    /// @details
    ///		Return CRC32 of the current include/exclude configuration
    //-----------------------------------------------------------------
    uint32_t getHash() const noexcept {
        boost::crc_32_type crc;
        auto process_glob = [&crc](const globber::Glob &glob) {
            auto pattern = glob.pattern();
            crc.process_bytes(
                pattern.data(),
                pattern.size() * sizeof(decltype(pattern)::value_type));

            auto flags = glob.flags();
            crc.process_bytes(&flags, sizeof(flags));

            crc.process_byte(glob.caseAware());
        };
        for (const auto &include : m_includes) process_glob(include);
        for (const auto &exclude : m_excludes) process_glob(exclude);
        crc.process_byte(m_excludeExternalDrives);
        return crc.checksum();
    }

    void setExcludeExternalDrives(bool flag) noexcept {
        m_excludeExternalDrives = flag;
    }

    void setshareConfig(const file::smb::Share &share) noexcept {
        m_shareConfig = share;
    }

private:
    //-------------------------------------------------------------
    /// @details
    ///		Add a glob to the glob group
    /// @param[in]	patterns
    ///		The glob group
    /// @param[in]	pattern
    ///		The glob pattern
    /// @param[in]	flags
    ///		The glob flags
    //-------------------------------------------------------------
    Error addPattern(globber::Globs &patterns, Text pattern,
                     uint32_t flags) noexcept {
        // While we have a leading /, \ or space
        Text::size_type i = 0;
        for (; i < pattern.size(); ++i) {
            if (pattern[i] == '/' || pattern[i] == '\\') {
                // stop if we have leading UNC \\ or //
                if (i + 1 < pattern.size() && pattern[i] == pattern[i + 1])
                    break;
            }
            // stop if not space
            else if (pattern[i] != ' ') {
                break;
            }
        }
        pattern = pattern.substr(i);

        // Trim it
        pattern.trim();

        // If it ends with /s we will add two globs
        if (pattern.endsWith(" /s")) {
            // Remove the /s and trim it
            pattern = pattern.substr(0, pattern.size() - 3);
            pattern.trim();

            // Add the normal path
            if (auto ccode = addPattern(patterns, pattern, flags)) return ccode;

            // Create a glob path
            Path globPath{pattern};

            Path path = globPath.parent();
            path /= "**";
            path /= globPath.fileName();

            return addPattern(patterns, (Text)path, flags);
        }

        // Create a glob matcher
        globber::Glob matcher;
        if (auto ccode = globber::createPathMatcher(pattern, flags, matcher,
                                                    m_caseAware))
            return ccode;

        // This happens if the platform invalidated this include, ignore
        // it with no error code otherwise we'll fail to add an include path
        if (!matcher.valid()) return {};

        LOGT("Added:", matcher);
        return patterns.add(_mv(matcher));
    }

    //-------------------------------------------------------------
    /// @details
    ///		Capabilities flags
    //-------------------------------------------------------------
    uint32_t m_caps;

    //-------------------------------------------------------------
    /// @details
    ///		List of globs to include
    //-------------------------------------------------------------
    globber::Globs m_includes;

    //-------------------------------------------------------------
    /// @details
    ///		A specific folder to rescan
    //-------------------------------------------------------------
    Path m_withinPath;

    //-------------------------------------------------------------
    /// @details
    ///		List of globs to include
    //-------------------------------------------------------------
    globber::Globs m_excludes;

    //-------------------------------------------------------------
    /// @details
    ///		Exclude external drives
    //-------------------------------------------------------------
    bool m_excludeExternalDrives = false;

    //-------------------------------------------------------------
    /// @details
    ///		Parsed configuration containing host, etc
    //-------------------------------------------------------------
    file::smb::Share m_shareConfig;

    //-------------------------------------------------------------
    /// @details
    ///		Service paths are case sensitivity
    //-------------------------------------------------------------
    bool m_caseAware = false;
};

}  // namespace ap::file
