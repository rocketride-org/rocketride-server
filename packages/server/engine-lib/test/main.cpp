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

#include "catch.hpp"
#include "test.h"

// These need to go after catch/test.h. Without this comment
// the vscode reformatter puts these above
#include <apLib/application/mainstub.ipp>
#include <testMain.ipp>
#include <sstream>

application::Opt NodeId{"--nodeId", "node"};
application::Opt TestArgs{"--testArgs"};

namespace ap::application {
//-------------------------------------------------------------------------
/// @details
///		Setup the paths. This looks in the curent directory and all the
///		way up to the root for the testdata and testdata/source directory
///		Once it is found, the rest of the paths are set to the dir
//-------------------------------------------------------------------------
Error setPaths() {
    // Setup the paths
    config::paths() = testPath();

    // Make the paths we need
    if (auto ccode = config::paths().makePaths()) return ccode;

    // Output some info
    LOG(Test, "Executable   :", application::execPath());
    LOG(Test, "Arguments    :", application::cmdline());
    LOG(Test, "Test path    :", testPath());
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Main entry point -- setup the environment and call the
///		TestMain to actually execute the tests
//-------------------------------------------------------------------------
ErrorCode Main() {
    // Set the new efault to the test console

    ::engine::monitor::MonitorType.setValue("TestConsole");

    // Now, reset the options based on the command line options
    ::ap::application::Options::get().init();

    // Init drivers
    auto ccode = engine::init();
    if (ccode) dev::fatality(_location, "Failed engine init", ccode);

    // Enable some fixed default logs
    log::enableLevel<true>(Lvl::Perf, Lvl::Dev);

    // Attempt to set the path
    if (auto ccode = setPaths()) return ccode.code();

    // Init python
    if (engine::python::isPython()) {
        if (auto ccode = engine::python::execPython()) return ccode;
        return {};
    }

    // Init java
    if (auto ccode = engine::java::isJava()) {
        if (auto ccode = engine::java::execJava()) return ccode;
        return {};
    }

#if ROCKETRIDE_PLAT_LIN
    // Abort if running under WSL1 (Word DB unit tests will fail)
    if (plat::isWsl1())
        dev::fatality(_location,
                      "Word DB does not work under WSL1: "
                      "https://github.com/microsoft/WSL/issues/902");
#endif

    // Setup configs for our test
    config::nodeId(false) = *NodeId;
    config::vars().add("NodeId", config::nodeId());

    // Create arguments from options
    std::vector<const Utf8Chr *> arguments;
    // std::vector<const Utf8Chr*> can only hold pointers, so argumentList will
    // remain throughout
    std::list<Text> argumentList;
    std::istringstream iss(TestArgs.val());
    Text arg;
    while (iss >> arg) {
        argumentList.push_front(arg);
        arguments.push_back(argumentList.front());
    }

    // Run the tests
    auto res = TestMain(arguments);
    LOG(Test, "Test returning code", res);

    engine::deinit();

    return res;
}
}  // namespace ap::application
