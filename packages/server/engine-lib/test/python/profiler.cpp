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
// Coverage of engine worker threads by the Python profiler.
//
// yappi hooks a thread either at yappi.start(), which sweeps the thread states
// that exist at that moment, or through threading.Thread's bootstrap.  An
// engine worker is neither: it is created in C++ and gets its PyThreadState
// lazily on its first Python entry through LockPython.  One entering
// mid-session therefore matches no hooking path and everything it runs is
// invisible.
//
// This is the only lane that exercises the real __callPython seam
// deterministically: engtest is one process with no other Python threads, the
// Catch2 thread starts the session before any worker exists and then waits
// natively, so it emits no Python events while the workers run.
//
// NOTE: assertions never run on a worker thread — Catch2's macros are not
// thread safe.  Workers record into atomics and the Catch2 thread asserts.
// =============================================================================

#include <pybind11/embed.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

#include "test.h"

namespace py = pybind11;

namespace {

// Worker threads, and entries each one makes.  Deliberately small: these cases
// measure whether a thread is visible at all, not throughput.
constexpr int kThreads = 4;
constexpr int kCallsPerThread = 25;

// Every wait is bounded.  A deadlock in the GIL-attach path must fail the run,
// not hang it — and std::thread::join() has no timeout, so nothing is joined
// until the workers have reported completion.
constexpr auto kWaitTimeout = std::chrono::seconds(60);

// Owner id used for every session here
constexpr const char *kOwner = "engtest";

//---------------------------------------------------------------------
/// @details
///     Counts completions so the Catch2 thread can wait with a timeout
///     before joining.  Not std::latch — that has no timed wait.
//---------------------------------------------------------------------
class Completion {
public:
    /// Record one arrival and wake any waiter
    void signal() noexcept {
        {
            std::lock_guard<std::mutex> guard(m_mutex);
            ++m_count;
        }
        m_cv.notify_all();
    }

    /// Wait for @p expected arrivals; false on timeout
    bool wait(int expected) noexcept {
        std::unique_lock<std::mutex> guard(m_mutex);
        return m_cv.wait_for(guard, kWaitTimeout,
                             [&] { return m_count >= expected; });
    }

private:
    std::mutex m_mutex;
    std::condition_variable m_cv;
    int m_count = 0;
};

//---------------------------------------------------------------------
/// @details
///     Defines the marker and the helpers results are read through.
///     MUST be called with the GIL held.
//---------------------------------------------------------------------
void definePythonHelpers() {
    py::exec(R"PY(
import sys as _rr_sys
import threading as _rr_threading


def rr_profiler_marker():
    return 1


def rr_profiler_marker_calls(profiler):
    """Marker calls the last completed session captured."""
    return sum(e['ncall'] for e in (profiler._last_stats_data or [])
               if e['key'][2] == 'rr_profiler_marker')


def rr_profiler_other_threads():
    """Thread ids other than the caller currently executing Python.

    Not 'len(...) == 1': called straight from C++ the caller may hold no
    Python frame at all, so a perfectly quiet process reports zero entries.
    """
    me = _rr_threading.get_ident()
    return [tid for tid in _rr_sys._current_frames() if tid != me]
)PY");
}

/// The shared profiler singleton
py::object profilerObject() {
    return py::module_::import("ai.common.cprofile_manager").attr("profiler");
}

/// One of the helpers defined by definePythonHelpers()
py::object helper(const char *name) {
    return py::module_::import("__main__").attr(name);
}

/// Call the marker once; GIL must be held
void callMarker() { helper("rr_profiler_marker")(); }

//---------------------------------------------------------------------
/// @details
///     Drops any session a previous case leaked, then starts a fresh
///     one.  release() only acts on a session this owner started, so it
///     is a no-op when idle.  GIL must be held.
//---------------------------------------------------------------------
void startSession(const char *name) {
    auto profiler = profilerObject();
    profiler.attr("release")(kOwner);
    profiler.attr("start")(kOwner, py::arg("session") = name);
}

/// Stop the session and return the marker calls it captured; GIL must be held
int stopSessionAndCount() {
    auto profiler = profilerObject();
    profiler.attr("stop")(kOwner);
    return py::cast<int>(helper("rr_profiler_marker_calls")(profiler));
}

/// Thread ids other than the caller currently executing Python; GIL must be held
int otherPythonThreads() {
    return static_cast<int>(py::len(helper("rr_profiler_other_threads")()));
}

//---------------------------------------------------------------------
/// @details
///     Preconditions this whole lane rests on, checked on the Catch2
///     thread before any worker exists.  Returned rather than asserted
///     in place: a Catch2 assertion inside a callPython lambda would be
///     caught by __call and turned into an Error.
//---------------------------------------------------------------------
struct Preconditions {
    bool hasRegister = false;
    int otherThreads = -1;
};

Preconditions readPreconditions() {
    Preconditions pre;
    REQUIRE_NO_ERROR(callPython(localfcn()->Error {
        definePythonHelpers();
        pre.hasRegister =
            py::hasattr(profilerObject(), "register_current_thread");
        pre.otherThreads = otherPythonThreads();
        return {};
    }));
    return pre;
}

}  // namespace

//-----------------------------------------------------------------------------
// The "before" number, produced on every run of every build: threads that take
// the GIL without going through __callPython are invisible to the profiler.
//
// Same GIL acquisition and thread-state pinning as production — it skips
// setupDebug() as well as the seam, but setupDebug() installs no profile hook,
// so the seam is the only profiling-relevant difference.
//
// This case is never tagged [!shouldfail], which is why the preconditions live
// here: a stale dist/server/ai would make the seam swallow an AttributeError
// and report zero, and in a case expected to fail that would look like success.
//-----------------------------------------------------------------------------
TEST_CASE("python::profiler::control") {
    const auto pre = readPreconditions();

    INFO(
        "dist/server/ai has no register_current_thread — run "
        "./builder ai:sync before engtest");
    REQUIRE(pre.hasRegister);

    INFO("another Python thread is running ("
         << pre.otherThreads
         << "); this lane's determinism assumes engtest is quiet");
    REQUIRE(pre.otherThreads == 0);

    REQUIRE_NO_ERROR(callPython(localfcn()->Error {
        startSession("engtest-control");
        return {};
    }));

    Completion completion;
    std::vector<std::thread> threads;
    for (int i = 0; i < kThreads; ++i) {
        threads.emplace_back([&] {
            for (int c = 0; c < kCallsPerThread; ++c) {
                // Straight to LockPython: no __callPython, so no seam
                engine::python::LockPython lock;
                callMarker();
            }
            completion.signal();
        });
    }

    if (!completion.wait(kThreads)) {
        // Joining would hang forever, and ~thread() on a joinable thread
        // terminates before Catch2 can report anything
        for (auto &thread : threads) thread.detach();
        FAIL("control workers did not finish within the timeout");
    }
    for (auto &thread : threads) thread.join();

    int captured = -1;
    REQUIRE_NO_ERROR(callPython(localfcn()->Error {
        captured = stopSessionAndCount();
        return {};
    }));

    INFO("control captured " << captured << " of "
                             << kThreads * kCallsPerThread
                             << " marker calls, expected 0");
    REQUIRE(captured == 0);
}

//-----------------------------------------------------------------------------
// The "after" number: the same threads entering through __callPython must be
// captured completely.  Each thread makes kCallsPerThread separate entries, one
// per item as the engine does, so registration on the first entry has to
// survive the rest — this covers pinning within a single session too.
//
// It carried [!shouldfail] on the commit that introduced it, where it failed
// with 0 == 100; the seam is what turns it green.
//-----------------------------------------------------------------------------
TEST_CASE("python::profiler::cold_threads") {
    REQUIRE_NO_ERROR(callPython(localfcn()->Error {
        definePythonHelpers();
        startSession("engtest-cold");
        return {};
    }));

    Completion completion;
    std::atomic<int> callFailures{0};
    std::vector<std::thread> threads;
    for (int i = 0; i < kThreads; ++i) {
        threads.emplace_back([&] {
            for (int c = 0; c < kCallsPerThread; ++c) {
                // The real production seam
                if (callPython(localfcn()->Error {
                        callMarker();
                        return {};
                    }))
                    ++callFailures;
            }
            completion.signal();
        });
    }

    if (!completion.wait(kThreads)) {
        for (auto &thread : threads) thread.detach();
        FAIL("cold_threads workers did not finish within the timeout");
    }
    for (auto &thread : threads) thread.join();

    int captured = -1;
    REQUIRE_NO_ERROR(callPython(localfcn()->Error {
        captured = stopSessionAndCount();
        return {};
    }));

    REQUIRE(callFailures.load() == 0);

    INFO("cold_threads captured " << captured << " marker calls, expected "
                                  << kThreads * kCallsPerThread);
    REQUIRE(captured == kThreads * kCallsPerThread);
}

//-----------------------------------------------------------------------------
// Invariant guard, NOT a before/after discriminator — this passes without the
// seam as well, because a thread state that is still alive gets swept up by the
// next start().
//
// It fails if LockPython's unbalanced inc_ref() (lock.hpp:42-45) ever goes
// away: the thread state would then be destroyed when the first entry returns,
// while the seam's once-per-thread guard stays set, so nothing would ever
// re-register the thread.
//-----------------------------------------------------------------------------
TEST_CASE("python::profiler::pinned_across_sessions") {
    Completion entered;
    Completion proceed;
    Completion finished;
    std::atomic<int> callFailures{0};

    REQUIRE_NO_ERROR(callPython(localfcn()->Error {
        definePythonHelpers();
        startSession("engtest-pinned-1");
        return {};
    }));

    std::thread worker([&] {
        // First entry of this thread, inside session 1
        if (callPython(localfcn()->Error {
                callMarker();
                return {};
            }))
            ++callFailures;
        entered.signal();

        // Park natively while the session is swapped underneath
        if (!proceed.wait(1))
            return;

        for (int c = 0; c < kCallsPerThread; ++c)
            if (callPython(localfcn()->Error {
                    callMarker();
                    return {};
                }))
                ++callFailures;
        finished.signal();
    });

    const bool arrived = entered.wait(1);
    if (arrived) {
        REQUIRE_NO_ERROR(callPython(localfcn()->Error {
            // Session 1's numbers are discarded; only session 2 is counted
            profilerObject().attr("stop")(kOwner);
            startSession("engtest-pinned-2");
            return {};
        }));
    }
    proceed.signal();

    const bool completed = arrived && finished.wait(1);
    if (!completed) {
        worker.detach();
        FAIL("pinned worker did not finish within the timeout");
    }
    worker.join();

    int captured = -1;
    REQUIRE_NO_ERROR(callPython(localfcn()->Error {
        captured = stopSessionAndCount();
        return {};
    }));

    REQUIRE(callFailures.load() == 0);

    INFO("pinned thread captured " << captured << " marker calls in session 2, "
                                   << "expected " << kCallsPerThread);
    REQUIRE(captured == kCallsPerThread);
}
