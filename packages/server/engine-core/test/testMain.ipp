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
    using _this = Listener;

    using EventListenerBase::EventListenerBase;  // inherit constructor

    void testCaseStarting(Catch::TestCaseInfo const& info) override {
        auto guard = lock();
        m_case = info.name;
        updatePrefix();
        guard = {};
    }

    void testCaseEnded(Catch::TestCaseStats const& stats) override {
        auto guard = lock();
        m_case.clear();
        updatePrefix();
    }

    void testRunStarting(Catch::TestRunInfo const& info) override {
        auto guard = lock();
        m_run = _mv((std::string)info.name);
        updatePrefix();
    }

    void testRunEnded(Catch::TestRunStats const& stats) override {
        auto guard = lock();
        m_run.clear();
        updatePrefix();
    }

    void sectionStarting(Catch::SectionInfo const& info) override {
        auto guard = lock();
        m_section = info.name;
        updatePrefix();
    }

    void sectionEnded(Catch::SectionStats const& stats) override {
        auto guard = lock();
        m_section.clear();
        updatePrefix();
    }

    static auto currentPrefix() noexcept {
        return makePair(lock(), TextView{m_prefix});
    }

private:
    static async::MutexLock::Guard lock() noexcept { return m_lock.acquire(); }

    static void updatePrefix() noexcept {
        m_prefix = m_case;
        if (m_section && m_section != m_case) m_prefix += "(" + m_section + ")";
    }

    _inline Text m_prefix, m_run, m_section, m_case;
    _inline async::MutexLock m_lock;
};

CATCH_REGISTER_LISTENER(Listener)

namespace ap::application {

Error TestMain() noexcept {
    // Custom prefix hook, shows current test name
    auto& opts = log::options();
    opts.customPrefixCb = [](StackText& hdr) {
        if (auto [guard, testName] = Listener::currentPrefix(); testName)
            hdr = _ts(Color::Blue, testName, Color::Reset, " ", hdr);
    };
    opts.noFlush = true;

    // Fast exit on interrupt
    async::globalCancelFailsafe() = 0s;

    // Enable some fixed default logs
    log::enableLevel<true>(Lvl::Test, Lvl::Perf, Lvl::Dev);

    // Log some stats from application
    LOG(Test, "Exec path:", application::execPath());
    LOG(Test, "Args:", application::cmdline());

    try {
        Catch::Session session;

        // // Configure Catch to break into the debugger when a unit test fails.
        // Without this, Catch leaves the stack
        // // context of the failure, making it very hard to troubleshoot.  On
        // by default in debug builds. if (_fs<bool>(*Break)) { 	LOG(Test,
        // "Configuring Catch2 to break into the debugger on test failure");
        // 	const Text execPath = _ts(application::execPath());
        // 	auto catch2Options = std::array<const char *, 3>{
        // 		execPath,	// Catch2 requires path as the first parameter (argv
        // style)
        // 		"--break",	// Break into debugger on test failure
        // 		"--abort"	// Treat any assertion failure as a test failure
        // 	};
        // 	if (auto retCode =
        // session.applyCommandLine(_cast<int>(catch2Options.size()),
        // &catch2Options.front())) 		return APERRL(Test, Ec::InvalidParam, "Error
        // in Catch2 configuration", retCode);
        // }

        if (auto retCode =
                session.run(application::argc(), application::argv()))
            return APERR(Ec::Bug, "Unit test run failed with code:", retCode);
    } catch (const Error& e) {
        return APERRL(Always, Ec::Bug, e);
    } catch (const std::exception& e) {
        return APERRL(Always, Ec::Bug, e);
    }

    return {};
}

}  // namespace ap::application
