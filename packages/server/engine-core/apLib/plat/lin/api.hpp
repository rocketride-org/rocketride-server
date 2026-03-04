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

namespace ap::plat {

inline ErrorOr<Text> osVersion() noexcept {
    // Get specific distro information if /etc/os-release is present
    Text id, version;
    if (auto data = file::fetch<TextChr>("/etc/os-release")) {
        for (auto& line : string::split(*data, "\n")) {
            auto [key, value] = string::slice(line, "=");
            key.trim();
            if (key.equals("ID", false))
                id = value.removeQuotes().trim();
            else if (key.equals("VERSION_ID", false))
                version = value.removeQuotes().trim();

            if (!id.empty() && !version.empty()) break;
        }
    }

    Text retval = "Linux ";
    if (!id.empty())
        retval += (id + " ");
    else
        retval += "unknown_distro ";

    if (!version.empty())
        retval += version;
    else
        retval += "unknown_version";

    return retval;
}

// Parse unique module paths from /proc/self/maps
inline ErrorOr<std::vector<file::Path>> getModulePaths() noexcept {
    // The map pseudo file for engtest was 30kb
    auto maps = file::fetchStringEx("/proc/self/maps", 100_kb);
    if (!maps) return maps.ccode();

    // Collect as a set of strings to efficiently ensure uniqueness
    std::set<Text> modulePaths;
    for (auto& line : maps->split('\n')) {
        auto components = line.split(' ');
        if (components.size() == 6 && components[5].startsWith("/"))
            modulePaths.insert(components[5]);
    }

    // Convert set of unique path strings to vector of paths
    return util::transform<std::vector<file::Path>>(modulePaths);
}

// Render the versioned soname of a given library
inline Text renderSoname(TextView libName, int version) noexcept {
    // e.g. libsmbclient.so.0
    return _fmt("{}.{}.{}", libName, LibraryExtension, version);
}

}  // namespace ap::plat