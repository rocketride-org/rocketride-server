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

#include <apLib/ap.h>

namespace {

using namespace ap;

file::Path& actualCrashDumpLocation() noexcept {
    static file::Path dir = std::filesystem::temp_directory_path();
    return dir;
}

}  // namespace

namespace ap::dev {

size_t g_nextSlot = 1;
std::map<size_t, FatalityHandler> g_fatalityHandlers;
std::map<size_t, CrashDumpLocationChangeHandler> g_crashDumpLocationHandlers;

bool& bugCheck() noexcept {
    static bool check = plat::IsDebug ? true : false;
    return check;
}

size_t registerFatalityHandler(FatalityHandler&& handler) noexcept {
    auto slot = g_nextSlot++;
    g_fatalityHandlers[slot] = _mv(handler);
    return slot;
}

void deRegisterFatalityHandler(size_t slot) noexcept {
    g_fatalityHandlers.erase(slot);
}

size_t registerCrashDumpLocationChangedHandler(
    CrashDumpLocationChangeHandler&& handler) noexcept {
    auto slot = g_nextSlot++;
    g_crashDumpLocationHandlers[slot] = _mv(handler);
    return slot;
}

void deRegisterCrashDumpLocationChangedHandler(size_t slot) noexcept {
    g_crashDumpLocationHandlers.erase(slot);
}

void onFatality(Location location, std::string_view reason) noexcept {
    auto handlers = g_fatalityHandlers;
    for (auto& [slot, handler] : handlers) _call(handler, location, reason);
}

Text& crashDumpPrefix() noexcept {
    static Text prefix;
    return prefix;
}

const file::Path& crashDumpLocation() noexcept {
    return actualCrashDumpLocation();
}

void crashDumpLocation(const file::Path& path) noexcept {
    actualCrashDumpLocation() = path;
    auto handlers = g_crashDumpLocationHandlers;
    for (auto& [slot, handler] : handlers) _call(handler, path);
}

Text createCrashDumpName(TextView extension) noexcept {
    StackTextVector components;

    // Name dumps with the EXE name
    components.emplace_back(application::execPath().fileName(true));

    // Include the version and build hash (if known), which helps with
    // identifying the corresponding symbols
    if (auto version = application::projectVersion())
        components.emplace_back(_mv(version));

    if (auto buildHash = application::buildHash())
        components.emplace_back(_mv(buildHash));

    // Hostname
    components.emplace_back(plat::hostName());

    // Current timestamp (UTC) in abbreviated ISO 8601 format (eliding dashes
    // and colons)
    components.emplace_back(
        time::formatDateTime(time::nowSystem(), "%Y%m%dT%H%M%SZ"));

    // Process ID (for uniqueness)
    components.emplace_back(_ts(async::processId()));

    // User prefix (if set)
    if (auto p = crashDumpPrefix()) components.emplace_back(_mv(p));

    // .mdmp
    components.emplace_back(extension);

    // Build name from dotted components (empty components will not be included)
    // e.g. engtest.1.0.0.1895.b03a284.LEGION.20191115T152352Z.{additional
    // prefix}.13128.mdmp
    return string::concat(components, "."_tv);
}

}  // namespace ap::dev
