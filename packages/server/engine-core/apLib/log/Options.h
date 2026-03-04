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

// Here we define the log options structure, basically a collection
// of flags which can be loaded from json some way
struct Options {
    // Log file
    FILE *logFile = stdout;

    // Whether flush is called on stdout after every log message
    bool noFlush = false;

    // Turns on the file location
    bool includeFile = false;

    // Turns on thread id prefixing in non interpreted trace calls
    bool includeThreadId = false;

    // Turns on thread name prefixing in non interpreted trace calls
    bool includeThreadName = false;

    // Turns on the function name
    bool includeFunction = false;

    // Adds the current application memory usage to the prefix
    bool includeMemory = true;

    // Adds the current disk load to the prefix
    bool includeDiskLoad = false;

    // If true will decorate log lines which are interpreted (use
    // wisely as this breaks the interaction between the rocketride webapp
    // and the engine)
    bool forceDecoration = false;

    // Prefix the log lines with the date/time
    bool includeDateTime = false;

    // Color used for decoration prefix
    Color decorationColor = Color::Green;

    // Global color override-- when set, no colors are ever emitted
    bool disableAllColors = false;

    // The format for the date time
    Text dateTimeFormat = time::DEF_FMT;

    // Whether stdout is a terminal
    bool isAtty = false;

    // Callback for custom prefix
    Function<void(StackText &)> customPrefixCb;

    // Returns true if any flags set above are true
    explicit operator bool() const noexcept {
        return includeFile || customPrefixCb || disableAllColors ||
               forceDecoration || includeDateTime || includeDiskLoad ||
               includeFunction || includeMemory || includeThreadId ||
               includeThreadName;
    }

    template <typename JsonT>
    static void __fromJson(Options &opts, const JsonT &val) noexcept;

    template <typename Buffer>
    void renderMemory(Buffer &buff) const noexcept;

    template <typename Buffer>
    void __toString(Buffer &_buff, const FormatOptions &opts) const noexcept;

    std::atomic<size_t> additionalMemoryUsed = 0;
};

Options &options() noexcept;

}  // namespace ap::log
