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

// Unix path api, plugs into FilePath to provide unixy style path parsing
template <typename ChrT, typename AllocT = std::allocator<ChrT>>
struct UnxPathApi {
    // Alias our string types for our templated type. we will treat
    // unix paths as case sensitive
    using StrType = string::Str<ChrT, UnxPathTrait<ChrT>, AllocT>;
    using ViewType = string::StrView<ChrT, UnxPathTrait<ChrT>>;
    using AllocatorType = AllocT;

    // List of knwon windows path prefixes
    _const ViewType HomePrefix = "~/";
    _const ViewType CwdPrefix = "./";
    _const ViewType SharePrefix = "//";
    _const ViewType RootPrefix = "/";

    // Called when a FilePath is constructed, unix paths don't need
    // any post construction tasks
    static auto construct(StrType &path) noexcept {}

    // This array holds pair with:
    //		first - the prefix to match in the path
    //		second - the path type it must be if the prefix in 0 exists
    _const Array<Pair<ViewType, PathType>, 4> PrefixList{
        std::make_pair(HomePrefix, PathType::ABSOLUTE),
        std::make_pair(CwdPrefix, PathType::RELATIVE),
        std::make_pair(SharePrefix, PathType::SHARE),
        std::make_pair(RootPrefix, PathType::ABSOLUTE)};

    // Removes a child from the comp list, unix uses the
    // prefix to retain the root dir so we do not need
    // to limit the number of components on a parent
    template <typename CompListT>
    static Pair<size_t, CompListT> parent(size_t length,
                                          CompListT comps) noexcept {
        if (!comps.empty()) {
            length -= comps.back().size();
            comps.pop_back();
        }
        return {length, _mv(comps)};
    }

    // Recognize the path format given a path, note unx paths don't
    // ever have prefixes
    static Pair<PathType, ViewType> classify(ViewType path) noexcept {
        // If empty it is always invalid
        if (!path) return {PathType::INVALID, {}};

        // Extract the prefix if set
        ViewType prefix;
        auto type = PathType::RELATIVE;
        for (auto &[p, t] : PrefixList) {
            if (path.startsWith(p)) {
                type = t;
                prefix = p;
                break;
            }
        }
        return {type, prefix};
    }

    // Check if path is empty
    template <typename CompListT>
    static bool empty(ViewType path, CompListT comps) noexcept {
        return !path;
    }

    // Convert this path to a generic path form
    static StrType gen(PathType, ViewType prefix, ViewType path,
                       const AllocatorType &alloc = {}) noexcept {
        // Already in gen format
        return StrType{prefix, alloc}.append(path);
    }

    // Convert this path to a platform specific form
    static StrType plat(PathType type, ViewType prefix, ViewType path, bool,
                        bool trailingSep,
                        const AllocatorType &alloc = {}) noexcept {
        auto res = gen(type, prefix, path, alloc);
        if (trailingSep && !res.endsWith(UnxSep)) res.append(UnxSep);
        return res;
    }
};

}  // namespace ap::file
