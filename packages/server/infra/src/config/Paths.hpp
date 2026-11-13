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

namespace engine::config {
// The paths structure loads our 5 main paths from
// a json payload and provides some basic apis to
// map a log path name (used in our Uri) to
// its path value
struct Paths {
    // Lookup a path by its logical name
    file::Path &lookup(TextView name) noexcept {
        if (name == "data")
            return data;
        else if (name == "cache")
            return cache;
        else if (name == "control")
            return control;
        else if (name == "log")
            return log;
        dev::fatality(_location, "Invalid path", name);
    }

    explicit operator bool() const noexcept {
        return control && log && cache && data;
    }

    decltype(auto) operator=(const file::Path &base) noexcept {
        control = base / "control";
        log = base / "logs";  // Yes, this is confusing, but it matches the
                              // app's behavior
        cache = base / "cache";
        data = base / "data";
        return *this;
    }

    auto makePaths() const noexcept {
        if (!control || !log || !cache || !data)
            dev::fatality(_location, "Paths not defined");

        return file::mkdir(data) || file::mkdir(control) || file::mkdir(log) ||
               file::mkdir(cache);
    }

    static auto __fromJson(Paths &paths, const json::Value &val) noexcept {
        file::Path base;
        auto ccode = val.lookupAssign("base", base) ||
                     val.lookupAssign("data", paths.data) ||
                     val.lookupAssign("control", paths.control) ||
                     val.lookupAssign("cache", paths.cache) ||
                     val.lookupAssign("log", paths.log);

        if (!ccode && base) paths = base;

        return Error{};
    }

    file::Path data, control, cache, log;
};

}  // namespace engine::config
