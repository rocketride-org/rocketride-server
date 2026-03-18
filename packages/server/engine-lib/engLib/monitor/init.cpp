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

namespace engine::monitor {
namespace {
//---------------------------------------------------------------------
// Determines if the final MONCCODE(exit...) is
// called - we need to be able to shut this off
//---------------------------------------------------------------------
bool g_showExitCode = true;
}  // namespace

//-------------------------------------------------------------------------
// Monitor option, describes the factory name to instantiate
// for custom monitor types, two main types are supported
// out of the box:
//		--monitor=Console	- renders human readable stuff
//		--monitor=App		- rendered output optimized for parsing
//-------------------------------------------------------------------------
application::Opt MonitorType{"--monitor", "Console"};

//-------------------------------------------------------------------------
/// @details
///		Turns on/off the display off the final exit code
///	@param[in]	showCode
///		True = show the final exit code, false do not show it
//-------------------------------------------------------------------------
bool setShowExitCode(bool showCode) noexcept {
    // We need to be able to shut this off in order to
    // support the python launcher
    g_showExitCode = showCode;

    // Return the current setting
    return g_showExitCode;
}

//-------------------------------------------------------------------------
/// @details
///		Returns the show exit code to enable/disable the final status display
//-------------------------------------------------------------------------
bool getShowExitCode() noexcept { return g_showExitCode; }

//-------------------------------------------------------------------------
/// @details
///		Starts and initializes the appropriate monitor
//-------------------------------------------------------------------------
Error init() noexcept {
    // Register monitor factories
    if (auto ccode = Factory::registerFactory(Console::Factory, App::Factory,
                                              TestConsole::Factory))
        return ccode;

    auto type = MonitorType.val();

    auto monitor = Factory::make<Monitor>(_location, type);
    if (!monitor) return monitor.ccode();

    config::monitor() = _mv(*monitor);

    // Notify the monitor of any crash dump created
    dev::crashDumpCreatedCallback() = [](const file::Path &dumpPath) noexcept {
        if (config::monitor()) MONITOR(onCrashDumpCreated, _location, dumpPath);
    };

    // Init the monitor
    MONITOR(startMonitor);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Stops and deinitializes the monitor
//-------------------------------------------------------------------------
void deinit() noexcept {
    // Stop the monitor
    if (config::monitor()) MONITOR(stopMonitor);

    // Deregister the factory so we don't start it again
    Factory::deregisterFactory(Console::Factory, App::Factory,
                               TestConsole::Factory);

    // Request any threads in the monitor to terminate at this time
    config::monitor() = {};
}

}  // namespace engine::monitor
