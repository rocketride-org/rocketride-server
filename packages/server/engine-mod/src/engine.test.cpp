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

//-----------------------------------------------------------------------------
//
//	The bootstrap for a test binary that hosts this module.
//
//	It mirrors engine_run: the launcher owns a main() and nothing else, and
//	the sequence that brings the engine up lives in here. A test binary needs
//	the same sequence, and running it from the outside would mean exporting
//	every piece of it, so it runs here and calls back to run the tests.
//
//	Unlike engtest, node modules are left enabled. That binary links engLib
//	statically and has to switch them off, since loading a node would give the
//	process a second copy of the engine state; a host of this module shares
//	one engine with the nodes it loads.
//
//-----------------------------------------------------------------------------

#include <engLib/eng.h>

#include <engine.h>

#if ROCKETRIDE_PLAT_WIN
using ArgChr = wchar_t;
#else
using ArgChr = char;
#endif

namespace {
using namespace ap;

//-------------------------------------------------------------------------
// The options the test binaries accept
//-------------------------------------------------------------------------
application::Opt NodeId{"--nodeId", "node"};

//-------------------------------------------------------------------------
/// @details
///		The runner handed to us by the test binary, so engineTestMain can
///		reach it without a parameter of its own
//-------------------------------------------------------------------------
engine_test_runner &testRunner() noexcept {
    static engine_test_runner runner = nullptr;
    return runner;
}

//-------------------------------------------------------------------------
/// @details
///		The temp directory the tests work in, beside the executable
//-------------------------------------------------------------------------
file::Path testPath() noexcept {
    static file::Path path =
        application::execDir() / "test_files" /
        _ts(Format::HEX, crypto::randomNumber<uint16_t>());

    if (auto ccode = file::mkdir(path))
        dev::fatality(_location, "Failed to create path", path, ccode);

    return path;
}

//-------------------------------------------------------------------------
/// @details
///		Bring the engine up, then run the tests
//-------------------------------------------------------------------------
ErrorCode engineTestMain() noexcept {
    ::engine::monitor::MonitorType.setValue("TestConsole");

    // Now, reset the options based on the command line options
    ::ap::application::Options::get().init();

    // Init/deinit drivers
    auto guardEngine = util::Scope{
        []() noexcept {
            if (auto ccode = engine::init())
                dev::fatality(_location, "Failed engine init", ccode);
        },
        []() noexcept {
            engine::deinit();
        }};

    // Enable some fixed default logs
    log::enableLevel<true>(Lvl::Perf, Lvl::Dev);

    // Point the engine at the test directory
    const auto path = testPath();
    config::paths() = path;
    if (auto ccode = config::paths().makePaths()) return ccode.code();

    LOG(Test, "Executable   :", application::execPath());
    LOG(Test, "Arguments    :", application::cmdline());
    LOG(Test, "Test path    :", path);

    // Running as the interpreter rather than as a test host
    if (engine::python::isPython())
        return engine::python::execPython().code();

    if (auto isJava = engine::java::isJava(); isJava)
        return engine::java::execJava().code();

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

    // Hand over to the test framework, which lives in the test binary
    auto res = testRunner() ? (*testRunner())() : -1;
    LOG(Test, "Test returning code", res);

    // The framework's result becomes this process's exit code
    return ErrorCode(res, std::generic_category());
}
}  // namespace

extern "C" ENGINE_API int engine_test_run(int argc, const ArgChr **argv,
                                          engine_test_runner runner) noexcept {
    testRunner() = runner;
    return ::ap::application::bootstrap(argc, argv, &engineTestMain);
}
