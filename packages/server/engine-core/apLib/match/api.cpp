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
//	Public match api
//
#include <apLib/ap.h>

namespace ap::globber {
// All matchers in rocketride are allowed to start with an os
// qualifier, this qualifier is the os name within <>'s, the
// name itself can be a glob, this function will attempt to
// extract this and match it against an os name, while also
// pruning the callers string
Opt<plat::Type> parseAndRemoveOsQualifier(Text &pattern) noexcept {
    // Extract the first instance of a <>
    auto comps = string::split(pattern, ">", false, 1);

    // No comps, no os prefix
    if (comps.empty()) return {};

    // Got some comps, first component has the os if it leads with
    // a <, if so grab the os prefix at position 1
    if (!comps[0].startsWith("<")) return {};
    auto osPrefix = comps[0].substr(1);

    // Now wildcards are used here to use glob to match it
    auto osMatch = Glob(osPrefix, 0);

    // If its invalid, well its invalid
    if (!osMatch.valid()) return {};

    // See if we match any os type names
    Opt<plat::Type> osType;
    util::anyOf(plat::TypeNames, [&](const auto &osName) noexcept {
        if (osMatch.matches(osName)) {
            osType = plat::mapName(osName);
            return true;
        }
        return false;
    });

    // If we found one, remove the leading portion from the callers
    // string
    if (osType) pattern = pattern.substr(osMatch.pattern().size() + 2);

    return osType;
}

// Construct a match from a path string
Error createPathMatcher(Text path, uint32_t flags, Glob &matcher,
                        bool caseAware) noexcept {
    // Trim it first
    path.trim();

    // Convert all seps to generic
    path.replace(file::WinSep, file::GenSep);

    // Extract the os qualifier if one is set
    if (auto osType = globber::parseAndRemoveOsQualifier(path); osType) {
        // So it does specify an os, if it doesn't match ours silently
        // return 0 but don't populate the match
        if (osType.value() != plat::CurrentType) return {};
    }

    // Save the path
    matcher = {_mv(path), flags, caseAware};

    if (matcher.failed())
        return {matcher.ccode(), _location, "Invalid glob", path};

    return {};
}

// checks if a given path contains wildcards
bool containsWildcard(const Text &pattern) noexcept {
    return pattern.find_first_of("*?["_t) != Text::npos;
}
}  // namespace ap::globber
