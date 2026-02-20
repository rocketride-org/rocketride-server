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

#pragma once

namespace ap::file {

// Deal with the fact that we cannot generically declare string
// literals when the encoding type changes
template <typename ViewType, typename Enable = void>
struct PathPrefixList;

template <typename ViewType>
struct PathPrefixList<
    ViewType, typename std::enable_if_t<sizeof(typename ViewType::value_type) ==
                                        sizeof(Utf8Chr)>> {
    _const ViewType LongGen = R"(//?/)";
    _const ViewType UncGen = R"(//UNC/)";
    _const ViewType LongUncGen = R"(//?/UNC/)";
    _const ViewType DeviceGen = R"(//./)";
    _const ViewType LongSnapGen =
        R"(//?/GlobalRoot/Device/HarddiskVolumeShadowCopy)";
    _const ViewType SnapGen = R"(GlobalRoot/Device/HarddiskVolumeShadowCopy)";
    _const ViewType ShareGen = R"(//)";
    _const ViewType SepGen = R"(/)";

    _const ViewType LongPlat = R"(\\?\)";
    _const ViewType UncPlat = R"(\\UNC\)";
    _const ViewType LongUncPlat = R"(\\?\UNC\)";
    _const ViewType DevicePlat = R"(\\.\)";
    _const ViewType LongSnapPlat =
        R"(\\?\GlobalRoot\Device\HarddiskVolumeShadowCopy)";
    _const ViewType SnapPlat = R"(GlobalRoot\Device\HarddiskVolumeShadowCopy)";
    _const ViewType SharePlat = R"(\)";
    _const ViewType SepPlat = R"(\)";

    _const ViewType Vol = R"(Volume{)";
};

template <typename ViewType>
struct PathPrefixList<
    ViewType, typename std::enable_if_t<sizeof(typename ViewType::value_type) ==
                                        sizeof(Utf16Chr)>> {
    _const ViewType LongGen = LR"(//?/)";
    _const ViewType UncGen = LR"(//UNC/)";
    _const ViewType LongUncGen = LR"(//?/UNC/)";
    _const ViewType DeviceGen = LR"(//./)";
    _const ViewType LongSnapGen =
        LR"(//?/GlobalRoot/Device/HarddiskVolumeShadowCopy)";
    _const ViewType SnapGen = LR"(GlobalRoot/Device/HarddiskVolumeShadowCopy)";
    _const ViewType ShareGen = LR"(//)";
    _const ViewType SepGen = LR"(/)";

    _const ViewType LongPlat = LR"(\\?\)";
    _const ViewType UncPlat = LR"(\\UNC\)";
    _const ViewType LongUncPlat = LR"(\\?\UNC\)";
    _const ViewType DevicePlat = LR"(\\.\)";
    _const ViewType LongSnapPlat =
        LR"(\\?\GlobalRoot\Device\HarddiskVolumeShadowCopy)";
    _const ViewType SnapPlat = LR"(GlobalRoot\Device\HarddiskVolumeShadowCopy)";
    _const ViewType SharePlat = LR"(\\)";
    _const ViewType SepPlat = LR"(\)";

    _const ViewType Vol = LR"(Volume{)";
};

// Windows path api, plugs into FilePath to provide Windows-style path parsing
template <typename ChrT, typename AllocT = std::allocator<ChrT>>
struct WinPathApi {
    // Alias our string types for our templated type, we
    // will treat windows paths as case insensitive
    using StrType = string::Str<ChrT, WinPathTrait<ChrT>, AllocT>;
    using ViewType = string::StrView<ChrT, WinPathTrait<ChrT>>;
    using AllocatorType = AllocT;
    using Prefixes = PathPrefixList<ViewType>;

    // Setup our prefix list
    _const auto LongPrefix = Prefixes::LongGen;
    _const auto UncPrefix = Prefixes::UncGen;
    _const auto LongUncPrefix = Prefixes::LongUncGen;
    _const auto DevicePrefix = Prefixes::DeviceGen;
    _const auto SnapPrefix = Prefixes::SnapGen;
    _const auto LongSnapPrefix = Prefixes::LongSnapGen;
    _const auto SharePrefix = Prefixes::ShareGen;
    _const auto VolPrefix = Prefixes::Vol;
    _const auto SepPlat = Prefixes::SepPlat;
    _const auto SepGen = Prefixes::SepGen;

    // This array holds tuple with:
    //		0 - the prefix to match in the path
    //		1 - the path type it must be if the prefix in 0 exists
    //		2 - the prefix to return to the FilePath if not empty
    //			(otherwise the detected prefix is returned)
    _const std::array PrefixList{
        makeTuple(LongUncPrefix, PathType::UNC, ViewType{}),
        makeTuple(LongSnapPrefix, PathType::SNAP, LongPrefix),
        makeTuple(LongPrefix, PathType::INVALID, ViewType{}),
        makeTuple(UncPrefix, PathType::UNC, ViewType{}),
        makeTuple(DevicePrefix, PathType::DEVICE, ViewType{}),
        makeTuple(SharePrefix, PathType::SHARE, ViewType{})};

    // Called when a FilePath is constructed, for windows we use this
    // time to upper case any drive letters in the path
    static auto construct(StrType &path) noexcept {
        auto pos = path.find_first_of(':');
        if (pos == string::npos || pos == 0) return;
        pos--;
        if (!string::inRangeInclusive<string::NoCase, ChrT>('A', path[pos],
                                                            'Z'))
            return;
        if (pos && string::inRangeInclusive<string::NoCase, ChrT>(
                       'A', path[pos - 1], 'Z'))
            return;
        if (pos + 1 < path.size() &&
            string::inRangeInclusive<string::NoCase, ChrT>('A', path[pos + 1],
                                                           'Z'))
            return;
        path[pos] = string::toUpper(path[pos]);
    }

    // Removes a child from the comp list, windows always
    // leaves one component
    template <typename CompListT>
    static Pair<size_t, CompListT> parent(size_t length,
                                          CompListT comps) noexcept {
        if (!comps.empty()) {
            length -= comps.back().size();
            comps.pop_back();
        }
        return {length, _mv(comps)};
    }

    // Determine the path type and its prefix
    static Pair<PathType, ViewType> classify(ViewType path) noexcept {
        // Extract the prefix if set
        ViewType prefix;
        auto type = PathType::INVALID;
        for (auto &[p, t, r] : PrefixList) {
            if (path.startsWith(p)) {
                path.remove_prefix(r ? r.size() : p.size());
                prefix = r ? r : p;
                type = t;
                break;
            }
        }

        // See if we already know the answer just from the prefix
        if (type != PathType::INVALID) return {type, prefix};

        // If the path is empty it is invalid
        if (!path) return {PathType::INVALID, prefix};

        // If the path only has one character, slash is absolute
        // and anything else is relative
        if (path.size() == 1) {
            if (isSep(path[0])) return {PathType::ABSOLUTE, prefix};
            return {PathType::RELATIVE, prefix};
        }

        // See if its a drive letter
        if (path[1] == ':') {
            if (string::inRangeInclusive<string::NoCase, ChrT>('A', path[0],
                                                               'Z')) {
                // C:file 	= RELATIVE
                // C: 		= ABSOLUTE (it really isn't but we need to say it
                // is) C:/file	= ABSOLUTE
                if (path.size() < 3 || isSep(path[2]))
                    return {PathType::ABSOLUTE, prefix};
                else
                    return {PathType::RELATIVE, prefix};
            }

            // A colon without a drive letter in this case is definitely invalid
            return {PathType::INVALID, prefix};
        }

        // If its a snap path
        if (path.startsWith(SnapPrefix)) return {PathType::SNAP, prefix};

        // If its a volume uuid path its not relative either
        if (!path.startsWith(VolPrefix)) {
            // If it does not begin with \, it is relative
            //		path\file
            if (!isSep(path[0]) && !prefix) return {PathType::RELATIVE, prefix};
        }

        // It has a singled separator, or its a Volume{ uuid path
        //		Volume{UUID}...
        //		\path\file
        return {PathType::ABSOLUTE, prefix};
    }

    // Convert this path to a generic path form
    static StrType gen(PathType type, ViewType, ViewType path,
                       const AllocatorType &alloc = {}) noexcept {
        // UNC paths, or share paths, always require at least the share
        // prefix if they are going to make any sense
        StrType res(alloc);
        res = path;
        if (isUnc(type)) res = SharePrefix + res;

        return res.replace(SepPlat, SepGen);
    }

    // Check if path is empty
    template <typename CompListT>
    static bool empty(ViewType path, CompListT &&comps) noexcept {
        return !path || comps.empty();
    }

    // Convert this path to a platform specific form, in our windows
    // case the long prefix is slightly different depending on the path
    // type
    static StrType plat(PathType type, ViewType prefix, ViewType path,
                        bool longForm, bool trailingSep,
                        const AllocatorType &alloc = {}) noexcept {
        StrType res(alloc);
        res = path;

        if (longForm) {
            switch (type) {
                case PathType::DEVICE:
                    // Device paths don't use long prefixes
                    break;

                case PathType::UNC:
                    // Depending on how the path was constructed it may already
                    // had a long prefix
                    if (longForm) {
                        if (prefix.startsWith(LongPrefix))
                            res = prefix + path;
                        else
                            res = LongUncPrefix + res;
                        break;
                    }

                    res = prefix + res;
                    break;

                case PathType::SHARE:
                    // Share paths are just slightly different then UNC, they
                    // never use a long prefix either as you must use the UNC
                    // prefix whenever you do that
                    if (longForm) {
                        res = LongUncPrefix + res;
                        break;
                    }
                    res = SharePrefix + res;
                    break;

                default:
                    res = LongPrefix + res;
                    break;
            }
        } else {
            // UNC/Share paths always require the share prefix
            if (isUnc(type)) res = SharePrefix + res;
        }

        res.replace(SepGen, SepPlat);
        if (trailingSep && !res.endsWith(SepPlat)) res.append(SepPlat);
        return res;
    }
};

}  // namespace ap::file
