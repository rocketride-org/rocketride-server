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

#include <apLib/ap.h>

namespace ap::log {

Atomic<bool> &initialized() noexcept {
    // Start out initialized as we are mostly concerned with tear down guards
    static Atomic<bool> init = {true};
    return init;
}

// trace option, series of levels to enable:
//	--trace=dev,job on dev,job levels
application::Opt Trace{"--trace", plat::IsDebug ? "Dev" : ""};

// Turn a log option on/off
// 	--log.<log option name>=<log option value>
// 	--log.includeDateTime=true
// 	--log.dateTimeFormat="%m/%d/%y"
static application::Opt DateTimeFormat{"--log.dateTimeFormat"};
static application::Opt DecorationColor{"--log.decorationColor"};
static application::Opt DisableAllColors{"--log.disableAllColors"};
static application::Opt ForceDecoration{"--log.forceDecoration"};
static application::Opt IncludeDateTime{"--log.includeDateTime"};
static application::Opt IncludeDiskLoad{"--log.includeDiskLoad"};
static application::Opt IncludeFile{"--log.includeFile"};
static application::Opt IncludeFunction{"--log.includeFunction"};
static application::Opt IncludeMemory{"--log.includeMemory"};
static application::Opt IncludeThreadId{"--log.includeThreadId"};
static application::Opt IncludeThreadName{"--log.includeThreadName"};
static application::Opt IsAtty{"--log.isAtty"};
static application::Opt LogFile{"--log.file"};
static application::Opt LogTruncate{"--log.truncate", "0"};

// Initializes the log subsystem
void init() noexcept {
    // Log to file if indicated
    if (LogFile) {
        file::Path logPath = *LogFile;
        const auto truncateLogFile = _fs<bool>(*LogTruncate);

        FILE *logFile = nullptr;
#if ROCKETRIDE_PLAT_WIN
        // On Windows, allow the log file to be read while the application is
        // running
        logFile =
            _wfsopen(logPath.plat(), truncateLogFile ? L"w" : L"a", _SH_DENYWR);
#else
        logFile = fopen(logPath.plat(), truncateLogFile ? "w" : "a");
#endif

        if (!logFile)
            dev::fatality(_location, "Failed to open log file", logPath, errno);
        else
            options().logFile = logFile;
    }

    // Allow manual specification of whether stdout is a terminal
    if (IsAtty)
        options().isAtty = _fs<bool>(*IsAtty);
    else
        options().isAtty = ::IsAtty(FileNo(options().logFile));

    // Disable colors if stdout is not a terminal
    if (!options().isAtty)
        options().disableAllColors = true;
    else if (DisableAllColors)
        options().disableAllColors = _fs<bool>(*DisableAllColors);

    if (DateTimeFormat) options().dateTimeFormat = _fs<Text>(*DateTimeFormat);
    if (DecorationColor)
        options().decorationColor = _fs<Color>(*DecorationColor);
    if (ForceDecoration)
        options().forceDecoration = _fs<bool>(*ForceDecoration);
    if (IncludeDateTime)
        options().includeDateTime = _fs<bool>(*IncludeDateTime);
    if (IncludeDiskLoad)
        options().includeDiskLoad = _fs<bool>(*IncludeDiskLoad);
    if (IncludeFile) options().includeFile = _fs<bool>(*IncludeFile);
    if (IncludeFunction)
        options().includeFunction = _fs<bool>(*IncludeFunction);
    if (IncludeMemory) options().includeMemory = _fs<bool>(*IncludeMemory);
    if (IncludeThreadId)
        options().includeThreadId = _fs<bool>(*IncludeThreadId);
    if (IncludeThreadName)
        options().includeThreadName = _fs<bool>(*IncludeThreadName);

    // Turn them on as sticky levels
    if (auto ccode = log::enableLevel<true>(Trace))
        dev::fatality(_location, "Failed to enable log levels", ccode, Trace);

    // At exit always reset our colors
    std::atexit([] {
        std::cout << Color::Reset;
        ::fflush(stdout);
    });
}

void deinit() noexcept {
#if defined(ROCKETRIDE_PLAT_UNX)
    // On UNIX-like systems, SMB client is a singleton
    // Dump its contains before closing log output
    ap::file::smb::client().printStatistics();
#endif
    // Close log file if logging to file
    if (options().logFile != stdout) fclose(options().logFile);
    initialized() = false;
}

}  // namespace ap::log
