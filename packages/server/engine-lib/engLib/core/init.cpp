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

#include <engLib/eng.h>

namespace engine {
using ap::file::Path;

//-------------------------------------------------------------------------
/// @details
///		This will be set if app wants to stream our command line to us
//-------------------------------------------------------------------------
application::Opt Stream{"--stream"};
application::Opt AutoTerm{"--autoterm"};

//-------------------------------------------------------------------------
/// @details
///		If we are in streaming command mode, this will be set to the
///		command that was sent
//-------------------------------------------------------------------------
Text StreamCommand;

//-------------------------------------------------------------------------
/// @details
/// 	Deinit the engine - cleanup all subsystems
//-------------------------------------------------------------------------
void deinit() noexcept {
    // Stop stdin monitoring thread (clears callback internally)
    application::stopStdinMonitor();

    java::deinit();
    python::deinit();
    task::deinit();
    monitor::deinit();
    store::deinit();
}

//-------------------------------------------------------------------------
/// @details
///		Initializes the engine subsystem
//-------------------------------------------------------------------------
Error init() noexcept {
    // Read the config string from the input
    if (Stream) {
        std::getline(std::cin, StreamCommand);
    }

    // First do the monitor so we can render stuff
    if (auto ccode = monitor::init()) return ccode;

    // Setup stdin monitoring (always enabled)
    // When stdin closes (parent dies), exit only if --autoterm specified
    application::setStdinCloseCallback([]() {
        if (AutoTerm) {
            LOG(Always, "stdin closed - immediate exit");
            application::quickExit(0);
        }
    });

    // Start background monitoring thread that polls every 1 second
    // - Unix: Uses poll() to detect POLLHUP, POLLERR, POLLNVAL
    // - Windows: Uses PeekNamedPipe() to detect ERROR_BROKEN_PIPE
    application::startStdinMonitor();

    // Core macros
    config::vars().add("execPath", application::execDir().gen());
    config::vars().add("cwd", file::cwd().gen());
    config::vars().add("plat", file::cwd().gen());

    // Function to check if this is the path to the testdata folder. If
    // it is, it returns the true, and sets the path to the resolved, normalized
    // path. If not, it returns false
    const auto validateTestData = localfcn(Path && path)->ErrorOr<Path> {
        // Add the testdata dir to it
        auto checkPath = path / "testdata";

        // Resolve it
        checkPath = checkPath.resolve();

        // If it exists, return it
        if (file::exists(checkPath)) return checkPath;

        // Return an error
        return APERR(Ec::NotFound, "Path not found", checkPath);
    };

    // Find the testdata
    ErrorOr<Path> res;
    Path testdata;
    if (res = validateTestData(file::cwd()))
        testdata = *res;
    else if (res = validateTestData(application::execDir()))
        testdata = *res;
    else if (res = validateTestData(application::execDir() / ".." / ".."))
        testdata = *res;
    else
        testdata = file::cwd() / "testdata";

    // Add the testdata linkage - always. This will replace %testdata%
    config::vars().add("testdata", testdata.gen());

    // Attempt to load the user.json
    if (auto usr = config::user()) {
        // Get the variables
        const auto variables = usr->lookup("variables");

        // Enumerate and add them to the substition list
        for (auto itr = variables.begin(); itr != variables.end(); itr++) {
            const auto key = itr.key().asString();
            const auto value = itr->asString();
            config::vars().add(key, value);
        }
    }

    // Add the trace variable
    config::vars().add("trace", *ap::log::Trace);

    // Init python
    if (auto ccode = python::init()) return ccode;

    // Setup the stream registry
    if (auto ccode = stream::init()) return ccode;

    // Setup the services registry
    if (auto ccode = store::init()) return ccode;

    // Setup job factories
    if (auto ccode = task::init()) return ccode;

    // Initialize permissions
    if (auto ccode = perms::init()) return ccode;

    return {};
}
}  // namespace engine
