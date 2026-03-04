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
//	Log options
//
#pragma once

namespace ap::log {

// Parses this object from json
template <typename JsonT>
inline void Options::__fromJson(Options &opts, const JsonT &val) noexcept {
    if (!val.isObject()) return;

    opts.includeDateTime = val.lookup("decorationColor", opts.decorationColor);
    opts.forceDecoration = val.lookup("forceDecoration", opts.forceDecoration);
    opts.includeDateTime = val.lookup("includeDateTime", opts.includeDateTime);
    opts.includeDiskLoad = val.lookup("includeDiskLoad", opts.includeDiskLoad);
    opts.includeFile = val.lookup("includeFile", opts.includeFile);
    opts.includeFunction = val.lookup("includeFunction", opts.includeFunction);
    opts.includeMemory = val.lookup("includeMemory", opts.includeMemory);
    opts.includeThreadId = val.lookup("includeThreadId", opts.includeThreadId);
    opts.includeThreadName =
        val.lookup("includeThreadName", opts.includeThreadName);
}

// Renders the memory portion
template <typename Buffer>
inline void Options::renderMemory(Buffer &buff) const noexcept {
    auto renderMemoryUsed = [&](const Size &memoryUsed) {
        // Generally we want to see increases at megabyte chunks so
        // cap the human readable size formatting to just megabytes
        if (memoryUsed > Size::kMegabyte)
            _tsb(buff, string::toHumanCount(memoryUsed.asMegabytes()), "MB");
        else
            _tsb(buff, memoryUsed.toString(false));
    };

    // Need to understand how to interpret VmSize: on Linux
    // for now stick to physical memory for that platform
#if ROCKETRIDE_PLAT_WIN
    renderMemoryUsed(memory::stats()->virtualMemoryUsedByProcess);
#else
    renderMemoryUsed(memory::stats()->physicalMemoryUsedByProcess);
#endif

    // Include the additional memory used (currently only JVM heap usage)
    if (auto currentAdditionalMemoryUsed = additionalMemoryUsed.load()) {
        _tsb(buff, "-");
        renderMemoryUsed(currentAdditionalMemoryUsed);
    }

#if ROCKETRIDE_FACTORY_DEBUG
    _tsb(buff, "-", factory::instanceCount());
#endif
}

// Renders a header used in log prefixes
template <typename Buffer>
inline void Options::__toString(Buffer &_buff,
                                const FormatOptions &opts) const noexcept {
    if (!opts.noColors()) _buff << decorationColor;
    _buff << '[';

    // Anytime we write to the buffer we want to add a delimiter if one
    // isn't already there, try and condense that syntax a bit and automate
    // it with a little wrapper that returns a ref to the buffer after
    // appending a delimiter if needed
    auto buff = [&]() noexcept -> decltype(auto) {
        auto delim = opts.delimiter('|');
        if (_buff.back() != delim && _buff.back() != '[') _buff << delim;
        return _buff;
    };

    if (includeThreadId) _tsb(buff(), async::threadId());
    if (includeThreadName) _tsb(buff(), async::ThreadApi::thisCtx()->name());

    if (includeMemory) renderMemory(buff());
#ifndef ROCKETRIDE_PLAT_MAC
    if (includeDiskLoad) {
        if (auto diskLoad = plat::systemDiskUtilization(); !diskLoad.check())
            _tsb(buff(), diskLoad, "%");
    }
#endif
    if (includeDateTime)
        buff() << time::formatDateTime(time::nowLocal(), dateTimeFormat);

    if (includeFunction || includeFile) {
        if (auto location = opts.location())
            location.toString(buff(), includeFunction, includeFile);
    }

    _buff << ']';
    if (!opts.noColors()) _buff << Color::Reset;
}

// Host log options in a static local accessor
inline Options &options() noexcept {
    static Options options = {};
    return options;
}

}  // namespace ap::log
