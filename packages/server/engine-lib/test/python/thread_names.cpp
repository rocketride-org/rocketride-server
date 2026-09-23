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
// One name per thread on both sides of the language boundary.
//
// The engine keeps a thread's name in its thread context, Python in its
// threading.Thread.  Whoever started the thread named it: the engine its own
// threads, Python its own (asyncio_0, ThreadPoolExecutor-0_1).  Each side
// knows a thread it did not start only by a placeholder, "External" in the
// engine and "Dummy-N" in Python, and has to take the other side's name.  The
// profiler and the logs then agree on which thread did what.
//
// NOTE: as in profiler.cpp, assertions never run on a worker thread: Catch2's
// macros are not thread safe.  Workers record what they saw, the Catch2
// thread asserts.
// =============================================================================

#include <pybind11/embed.h>

#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "test.h"

namespace py = pybind11;

// Named rather than anonymous: a unity build puts this file in one unit with
// profiler.cpp, whose anonymous namespace would then be this one too
namespace thread_names {

// Every wait is bounded: a deadlock in a GIL path must fail the run, not hang
constexpr auto kTimeout = std::chrono::seconds(60);

/// A thread's name as each side sees it
struct Names {
    std::string engine;
    std::string python;
};

/// The calling thread's name in the engine
std::string engineName() {
    return std::string{ap::async::getCurrentThreadName()};
}

/// The calling thread's name in Python; GIL must be held
std::string pythonName() {
    return py::cast<std::string>(
        py::module_::import("threading").attr("current_thread")().attr("name"));
}

//---------------------------------------------------------------------
/// @details
///     Both names on a thread outside Python, reading Python's through
///     the engine's real seam into Python, as a pipeline filter does
//---------------------------------------------------------------------
Names bothNames() {
    Names names;
    if (callPython(localfcn()->Error {
            names.python = pythonName();
            return {};
        }))
        names.python = "<callPython failed>";
    names.engine = engineName();
    return names;
}

//---------------------------------------------------------------------
/// @details
///     Signals the Catch2 thread that a worker is done, so it can wait
///     with a timeout.  Not std::latch, which has no timed wait
//---------------------------------------------------------------------
class Done {
public:
    void signal() noexcept {
        {
            std::lock_guard<std::mutex> guard(m_mutex);
            m_done = true;
        }
        m_cv.notify_all();
    }

    bool wait() noexcept {
        std::unique_lock<std::mutex> guard(m_mutex);
        return m_cv.wait_for(guard, kTimeout, [&] { return m_done; });
    }

private:
    std::mutex m_mutex;
    std::condition_variable m_cv;
    bool m_done = false;
};

//---------------------------------------------------------------------
/// @details
///     What a worker reports, held by shared_ptr rather than on the
///     Catch2 thread's stack: a worker abandoned on timeout keeps
///     running while Catch2 unwinds the failed case, and would write
///     into destroyed objects
//---------------------------------------------------------------------
struct State {
    Names names;
    Done done;
};

//---------------------------------------------------------------------
/// @details
///     Starts a Python thread named @p name that calls into the engine,
///     the way the data path hands a document to the engine from an
///     asyncio worker, and returns what that thread saw.  With
///     @p engineFirst the engine creates its thread context before the
///     call reaches UnlockPython, as a cancellation check or a log line
///     would.  Runs on the Catch2 thread.
//---------------------------------------------------------------------
Names fromPythonThread(const char *name, bool engineFirst) {
    Names names;
    if (callPython(localfcn()->Error {
            py::exec(R"PY(
import threading as _rr_threading
import engtest_thread_names as _rr_thread_names


def rr_thread_names_run(name, engine_first):
    seen = []
    # daemon: a worker stuck in a GIL path must not hold up Py_FinalizeEx()
    # at the end of the run, which waits for every other thread
    thread = _rr_threading.Thread(
        name=name,
        daemon=True,
        target=lambda: seen.append(_rr_thread_names.enter_engine(engine_first)))
    thread.start()
    thread.join(60)
    return seen[0] if seen else ('<no result>', '<no result>')
)PY");
            auto seen = py::module_::import("__main__")
                            .attr("rr_thread_names_run")(name, engineFirst)
                            .cast<py::tuple>();
            names.engine = seen[0].cast<std::string>();
            names.python = seen[1].cast<std::string>();
            return {};
        }))
        names.engine = names.python = "<callPython failed>";
    return names;
}

}  // namespace thread_names

// Called from a thread Python started: the engine side of that thread
PYBIND11_EMBEDDED_MODULE(engtest_thread_names, m) {
    m.def("enter_engine", [](bool engineFirst) {
        if (engineFirst)
            (void)thread_names::engineName();

        thread_names::Names names;
        {
            // The engine's entry from Python, as a pipe write takes it
            engine::python::UnlockPython unlock;
            names.engine = thread_names::engineName();

            // On to a Python node, as the engine does, through the real seam
            if (callPython(localfcn()->Error {
                    names.python = thread_names::pythonName();
                    return {};
                }))
                names.python = "<callPython failed>";
        }
        return py::make_tuple(names.engine, names.python);
    });
}

//-----------------------------------------------------------------------------
// A thread Python started keeps Python's name, and the engine takes it too.
//-----------------------------------------------------------------------------
TEST_CASE("python::thread_names::python_thread") {
    auto names = thread_names::fromPythonThread("rr-py-thread", false);

    CHECK(names.engine == "rr-py-thread");
    CHECK(names.python == "rr-py-thread");
}

//-----------------------------------------------------------------------------
// Same, when the engine made its thread context before the thread reached
// UnlockPython: the placeholder it started with gives way to Python's name.
//-----------------------------------------------------------------------------
TEST_CASE("python::thread_names::python_thread_engine_first") {
    auto names = thread_names::fromPythonThread("rr-py-engine-first", true);

    CHECK(names.engine == "rr-py-engine-first");
    CHECK(names.python == "rr-py-engine-first");
}

//-----------------------------------------------------------------------------
// A thread the engine started gives its name to Python.
//-----------------------------------------------------------------------------
TEST_CASE("python::thread_names::engine_thread") {
    auto state = std::make_shared<thread_names::State>();
    auto thread =
        std::make_unique<ap::async::Thread>(_location, "rr-engine", [state] {
            state->names = thread_names::bothNames();
            state->done.signal();
        });
    REQUIRE_NO_ERROR(thread->start());

    if (!state->done.wait()) {
        // Joining a hung thread would hang the run; leak it instead. Its copy
        // of the shared state keeps what it writes to alive
        (void)thread.release();
        FAIL("engine thread did not finish within the timeout");
    }
    thread.reset();

    CHECK(state->names.engine == "rr-engine");
    CHECK(state->names.python == "rr-engine");
}

//-----------------------------------------------------------------------------
// A thread neither side started keeps the engine's placeholder on both sides.
//-----------------------------------------------------------------------------
TEST_CASE("python::thread_names::foreign_thread") {
    auto state = std::make_shared<thread_names::State>();
    std::thread thread([state] {
        state->names = thread_names::bothNames();
        state->done.signal();
    });

    if (!state->done.wait()) {
        // Detached, and its copy of the shared state outlives this case
        thread.detach();
        FAIL("foreign thread did not finish within the timeout");
    }
    thread.join();

    CHECK(state->names.engine == "External");
    CHECK(state->names.python == "External");
}
