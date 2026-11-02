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

namespace engine::config {

Text &nodeId(bool verify) noexcept {
    static Text id;
    if (verify && !id) dev::fatality(_location, "NodeId not defined");
    return id;
}

Paths &paths() noexcept {
    static Paths pths;
    return pths;
}

util::Vars &vars() noexcept {
    static util::Vars vrs;
    return vrs;
}

Ptr<engine::monitor::Monitor> &monitor() noexcept {
    static Ptr<engine::monitor::Monitor> mon =
        nullPtr<engine::monitor::Monitor>();
    return mon;
}

const ErrorOr<json::Value> &user() noexcept {
    auto fetch = [] {
        // Cwd first
        if (auto res =
                file::fetchFromData<json::Value>(file::cwd() / "user.json"))
            return res;

        // Didn't find it in cwd, well try exec path
        if (auto res = file::fetchFromData<json::Value>(application::execDir() /
                                                        "user.json"))
            return res;

        // Now, look two levels up so to see if it is there. This will be for
        // running in the build/engine directory
        auto path = application::execDir() / ".." / ".." / "user.json";

        // Resolve it
        path = path.resolve();

        // Attempt to fetch
        return file::fetchFromData<json::Value>(path);
    };

    static ErrorOr<json::Value> res = fetch();

    if (!res) res = json::Value{};

    return res;
}

}  // namespace engine::config
