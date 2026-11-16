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

struct Listener : Catch::EventListenerBase {
    using Parent = Catch::EventListenerBase;
    using Parent::Parent;

    //-------------------------------------------------------------------------
    /// @details
    ///		Starting a header for logging the test name. Clears the custom
    ///		prefix so that it appears on the far left column
    //-------------------------------------------------------------------------
    void startHeader() {
        // Custom prefix hook, shows current test name
        auto& opts = log::options();

        // Save the current prefix
        m_currentPrefix = opts.customPrefixCb;

        // Setup to print just the test name in blue
        opts.customPrefixCb = [](StackText& hdr) { hdr = ""; };
    }

    //-------------------------------------------------------------------------
    /// @details
    ///		Ending a header for logging the test name. Restores the custom
    ///		prefix so further details are tabbed in
    //-------------------------------------------------------------------------
    void endHeader() {
        // Custom prefix hook, shows current test name
        auto& opts = log::options();

        opts.customPrefixCb = m_currentPrefix;
        return;
    }

    //-------------------------------------------------------------------------
    /// @details
    ///		Start a main test case
    ///	@param[in] info
    ///		Info about the test case
    //-------------------------------------------------------------------------
    void testCaseStarting(Catch::TestCaseInfo const& info) override {
        auto guard = lock();

        m_section.clear();

        startHeader();
        LOG(Always, _ts(Color::Cyan, info.name, Color::Reset));
        endHeader();
    }

    //-------------------------------------------------------------------------
    /// @details
    ///		End a main test case
    ///	@param[in] info
    ///		Info about the test case
    //-------------------------------------------------------------------------
    void testCaseEnded(Catch::TestCaseStats const& stats) override {}

    //-------------------------------------------------------------------------
    /// @details
    ///		Start running tests
    ///	@param[in] info
    ///		Info about the test
    //-------------------------------------------------------------------------
    void testRunStarting(Catch::TestRunInfo const& info) override {}

    //-------------------------------------------------------------------------
    /// @details
    ///		Completed running tests
    ///	@param[in] info
    ///		Info about the test
    //-------------------------------------------------------------------------
    void testRunEnded(Catch::TestRunStats const& stats) override {}

    //-------------------------------------------------------------------------
    /// @details
    ///		Start running a test section
    ///	@param[in] info
    ///		Info about the test case
    //-------------------------------------------------------------------------
    void sectionStarting(Catch::SectionInfo const& info) override {
        auto guard = lock();
        m_section.push_back(info.name);

        // Reset the counters
        MONITOR(reset);

        // And start them
        MONITOR(startCounters);
    }

    //-------------------------------------------------------------------------
    /// @details
    ///		Completed running a test section
    ///	@param[in] info
    ///		Info about the test case
    //-------------------------------------------------------------------------
    void sectionEnded(Catch::SectionStats const& stats) override {
        auto guard = lock();

        // Stop the counter accumulation
        MONITOR(stopCounters);

        const TextView spacer =
            "                                                           "_tv;
        const size_t columns = 48;

        auto sectionName = m_section.join(':');

        TextView space;
        if (columns < sectionName.size())
            space = ""_tv;
        else
            space = spacer.substr(0, columns - sectionName.size());

        if (!stats.assertions.failed && !stats.assertions.failedButOk) {
            LOG(Always, _ts(Color::Cyan, sectionName.substr(0, columns), space,
                            Color::Green, "Passed", Color::Reset));
        } else {
            LOG(Always,
                _ts(Color::Cyan, sectionName.substr(0, columns), space, " ",
                    Color::Green, stats.assertions.passed, " Passed, ",
                    Color::Reset, Color::Red, " ", stats.assertions.failed,
                    " Failed, ", Color::Reset, Color::Yellow, " ",
                    stats.assertions.failedButOk, " Warnings", Color::Reset));
        }

        m_section.pop_back();
    }

private:
    //-------------------------------------------------------------------------
    /// @details
    ///		Console lock
    //-------------------------------------------------------------------------
    static async::MutexLock::Guard lock() noexcept { return m_lock.acquire(); }

    //-------------------------------------------------------------------------
    /// @details
    ///		Stored callback when outputting a test case header
    //-------------------------------------------------------------------------
    Function<void(StackText&)> m_currentPrefix;

    //-------------------------------------------------------------------------
    /// @details
    ///		Nested list of sections we are running
    //-------------------------------------------------------------------------
    _inline TextVector m_section;

    //-------------------------------------------------------------------------
    /// @details
    ///		The actual lock
    //-------------------------------------------------------------------------
    _inline async::MutexLock m_lock;
};

CATCH_REGISTER_LISTENER(Listener)

namespace ap::application {
const TextView spacer =
    "                                                           "_tv;

Error TestMain(std::vector<const Utf8Chr*> arguments) noexcept {
    // Custom prefix hook, shows current test name
    auto& opts = log::options();
    opts.customPrefixCb = [](StackText& hdr) { hdr = _ts("    ", hdr); };
    opts.noFlush = true;

    // Fast exit on interrupt
    async::globalCancelFailsafe() = 0s;

    try {
        Catch::Session session;

        // Removed this, what seems like a complete hack, since it was
        // interfering with vscode and its ability to run tests
        //
        // Configure Catch to break into the debugger when a unit test fails.
        // Without this, Catch leaves the stack context of the failure, making
        // it very hard to troubleshoot.  On by default in debug builds. if
        // (_fs<bool>(*Break)) {
        //     LOG(Test, "Configuring Catch2 to break into the debugger on test
        //     failure"); const Text execPath = _ts(application::execPath());
        //     auto catch2Options = std::array<const char*, 3>{
        //         execPath,   // Catch2 requires path as the first parameter
        //         (argv style)
        //         "--break",  // Break into debugger on test failure
        //         "--abort"   // Treat any assertion failure as a test failure
        //     };
        //     if (auto retCode =
        //     session.applyCommandLine(_cast<int>(catch2Options.size()),
        //     &catch2Options.front()))
        //         return APERRL(Test, Ec::InvalidParam, "Error in Catch2
        //         configuration", retCode);
        // }

        // Get execPath
        std::vector<const Utf8Chr*> cmdArguments;
        CmdLine& cmdline = application::cmdline();
        if (cmdline.argc() <= 0) return APERR(Ec::Failed, "Exec path missing");

        cmdArguments.push_back(Text(cmdline[0]));

        if (!arguments.empty())
            cmdArguments.insert(cmdArguments.end(), arguments.begin(),
                                arguments.end());

        if (auto retCode = session.run(_cast<int>(cmdArguments.size()),
                                       cmdArguments.data()))
            return APERR(Ec::Failed,
                         "Unit test run failed with code:", retCode);
    } catch (const Error& e) {
        return APERRL(Always, Ec::Bug, e);
    } catch (const std::exception& e) {
        return APERRL(Always, Ec::Bug, e);
    }

    return {};
}

}  // namespace ap::application
