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
//	Entry point for the node tests.
//
//	The engine is brought up by engine_test_run inside the module - the same
//	shape engine uses with engine_run - and calls back here to run the test
//	framework, which only this binary links.
//
//-----------------------------------------------------------------------------

#include "catch.hpp"
#include "test.h"

// These need to go after catch/test.h. Without this comment
// the vscode reformatter puts these above
#include <engine.h>
#include <testMain.ipp>
#include <sstream>

namespace {
//-------------------------------------------------------------------------
/// @details
///		Run the test framework over the value of --testArgs
///	@param[in]	testArgs
///		The test names to run, as given on the command line
///	@returns
///		The test framework's result code
//-------------------------------------------------------------------------
int runTests(const char *testArgs) noexcept {
    using namespace ap;

    // Create arguments from options
    std::vector<const Utf8Chr *> arguments;

    // std::vector<const Utf8Chr*> can only hold pointers, so argumentList will
    // remain throughout
    std::list<Text> argumentList;
    std::istringstream iss(testArgs ? testArgs : "");
    Text arg;
    while (iss >> arg) {
        argumentList.push_front(arg);
        arguments.push_back(argumentList.front());
    }

    return ap::application::TestMain(arguments).code().value();
}
}  // namespace

#if ROCKETRIDE_PLAT_WIN
// Switched on _WIN32 to match the argv character type engine.h declares
int wmain(int argc, const wchar_t **argv) noexcept {
    return engine_test_run(argc, argv, &runTests);
}
#else
int main(int argc, const char **argv) noexcept {
    return engine_test_run(argc, argv, &runTests);
}
#endif
