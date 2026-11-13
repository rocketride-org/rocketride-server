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

#pragma once

namespace engine::task::monitorTest {
//-------------------------------------------------------------------------
/// @details
///		This is called by the app for engine API testing [APPLAT-1506]
//-------------------------------------------------------------------------
class Task : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our log level
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobMonitorTest;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, ITask>("monitorTest");

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		Execute the task
    //-----------------------------------------------------------------
    Error exec() noexcept override {
        bool testJava = true;
        bool crashJava = false;

        // Get our paramters
        taskConfig().lookupAssign("testJava", testJava);
        taskConfig().lookupAssign("crashJava", crashJava);

        // Test logging within the JVM
        if (testJava) {
            if (auto ccode = testJavaVM(crashJava)) return ccode;
        }

        // Raw stdout
        LOG(Always, "this is stdout");

        // Raw stderr
        std::cerr << "this is stderr" << std::endl << std::flush;

        // >CNT
        // (automatic)

        // >DUMP
        const file::Path dumpPath{"crash/dump"};
        MONITOR(onCrashDumpCreated, _location, dumpPath);

        // >ERR
        MONERR(error, Ec::Failed, "this is an error");

        // >EXIT
        // (automatic)

        // >INF
        MONITOR(info, "key", _tj("value"));

        // >JOB
        // (automatic)

        // >OBJ
        MONITOR(object, "filesys://foo/bar", 1_kb);

        // >WRN
        MONERR(warning, Ec::Failed, "this is a warning");

        return {};
    }

private:
    //-----------------------------------------------------------------
    ///	@details
    ///		Test logging within the JVM
    //-----------------------------------------------------------------
    Error testJavaVM(bool forceCrash = false) noexcept {
        // Initialize the JVM and our logging subsystem within the JVM
        if (auto ccode = java::init()) return ccode;

        // Setup the reference to our jni interface
        GET_JAVA_JNI(jni);

        if (auto ccode = _callChk([&] { java::Logging::testMonitor(jni); }))
            return ccode;

        if (forceCrash) {
            LOGT("Forcing crash within the JVM");
            java::Crasher::crash(jni);
        }

        return {};
    }
};

}  // namespace engine::task::monitorTest
