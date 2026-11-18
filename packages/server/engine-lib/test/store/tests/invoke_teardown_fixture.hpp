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

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "../store.h"

//-----------------------------------------------------------------------------
// The harness of the tests in invoke_teardown.cpp: the test filters and
// their factories, a log capture, a capture monitor, the Fixture that
// builds and ends the pipeline, and the helpers that call into filters and
// Python nodes the way Python does.
//
// Functions and variables at namespace scope are inline, so more than one
// file may include this header.
//
// Named, not anonymous: a unity build puts every test file in one unit
//-----------------------------------------------------------------------------
namespace invoke_teardown {

// Every wait is bounded: a deadlock must fail the run, not hang it
inline constexpr auto kTimeout = std::chrono::seconds(60);

// The drain deadline of the cases that let it run out, and the most such an
// end may take: far below the 60 s a held call waits to be released
inline constexpr auto kDeadline = std::chrono::milliseconds(300);
inline constexpr auto kEndLimit = std::chrono::seconds(10);

// How much earlier than asked a timed wait may end, for timer rounding
inline constexpr auto kTimerSlack = std::chrono::milliseconds(50);

// The least time an end that waited out kDeadline takes
inline constexpr auto kDeadlineWaited = kDeadline - kTimerSlack;

//-------------------------------------------------------------------------
/// @details
///     A manual-reset event with a bounded wait. Catch2 macros are never
///     used on a worker thread; workers only set gates and state
//-------------------------------------------------------------------------
class Gate {
public:
    void set() noexcept {
        {
            std::lock_guard<std::mutex> guard(m_mutex);
            m_set = true;
        }
        m_cv.notify_all();
    }

    bool isSet() noexcept {
        std::lock_guard<std::mutex> guard(m_mutex);
        return m_set;
    }

    /// True when the gate was set within the timeout
    bool wait(std::chrono::milliseconds timeout = kTimeout) noexcept {
        std::unique_lock<std::mutex> guard(m_mutex);
        return m_cv.wait_for(guard, timeout, [&] { return m_set; });
    }

private:
    std::mutex m_mutex;
    std::condition_variable m_cv;
    bool m_set = false;
};

//-------------------------------------------------------------------------
/// @details
///     What the test and its threads share. Held by shared_ptr so a thread
///     abandoned after a failed wait never writes into destroyed objects
//-------------------------------------------------------------------------
struct State {
    /// Set by the target once it is inside control()
    Gate entered;

    /// Set by the test to let the target return from control()
    Gate release;

    /// Set by the worker when its call has finished
    Gate workerDone;

    /// Set by the target just before control() returns
    std::atomic<bool> targetReturned{false};

    /// Set by the test: the target's control() declines the control
    /// (Ec::PreventDefault) when it returns
    std::atomic<bool> declineControl{false};

    /// The worker's thread, set by the worker before it calls
    std::thread::id workerId;

    /// Set by the releaser once it holds the GIL, which the end lets go of
    /// only while it waits for a call
    Gate endWaiting;

    /// Set by the test: the target's end lets control() return and waits
    /// for the worker, so the call leaves before the stack is armed
    std::atomic<bool> returnDuringEnd{false};

    /// Set by the test: the next rr_test_build begin waits for buildRelease
    std::atomic<bool> holdBuild{false};

    /// Set by that begin once it waits, and by the test to end the wait
    Gate buildEntered;
    Gate buildRelease;

    /// The held rr_test_build filter, and the thread that ended it
    ServiceInstanceWeak heldFilter;
    std::atomic<bool> heldEnded{false};
    std::thread::id heldEndedOn;

    /// Set by the test: every rr_test_build begin fails
    std::atomic<bool> failBuild{false};

    /// Set by the test: the next rr_test_caller begin counts a call on its
    /// filter, as a node's own thread may do from beginInstance. The call
    /// stays in flight until the test resets heldCall; its guard holds the
    /// filter and the head of its stack until then
    std::atomic<bool> callOnBegin{false};
    std::unique_ptr<IServiceFilterInstance::CallGuard> heldCall;

    /// Set by the test: the next rr_test_caller begin fails, after it has
    /// counted the call that callOnBegin asks for
    std::atomic<bool> failCallerBegin{false};

    /// The filter that call runs on, and the head of its stack
    ServiceInstanceWeak heldCaller;
    ServiceInstanceWeak heldHead;

    /// Where the last rr_test_caller filter was freed: on which thread, and
    /// whether the endpoint the test watches was still alive then
    struct Freed {
        std::thread::id on;
        bool endpointAlive = false;
    };

    /// Sets the endpoint a later caller free is compared with
    void watchEndpoint(ServiceEndpointWeak endpoint) noexcept {
        std::lock_guard<std::mutex> guard(freedLock);
        watchedEndpoint = _mv(endpoint);
    }

    /// Called by the destructor of a caller filter, on the thread that
    /// frees it
    void callerFreed() noexcept {
        std::lock_guard<std::mutex> guard(freedLock);
        lastCallerFreed = {std::this_thread::get_id(),
                           !watchedEndpoint.expired()};
    }

    /// The last record callerFreed() made
    Freed callerFree() noexcept {
        std::lock_guard<std::mutex> guard(freedLock);
        return lastCallerFreed;
    }

    /// What the worker's call threw, if anything
    std::mutex errorLock;
    Error workerError;
    bool workerThrewOther = false;

    void setError(Error error) noexcept {
        std::lock_guard<std::mutex> guard(errorLock);
        workerError = _mv(error);
    }
    Error error() noexcept {
        std::lock_guard<std::mutex> guard(errorLock);
        return workerError;
    }

    /// Guards the two members below, which the caller filters' destructors
    /// write on whichever thread frees them
    std::mutex freedLock;
    ServiceEndpointWeak watchedEndpoint;
    Freed lastCallerFreed;
};

//-------------------------------------------------------------------------
/// @details
///     The state the test filters report to. Set by the fixture before the
///     pipeline is built and cleared when it is gone
//-------------------------------------------------------------------------
inline std::mutex g_activeLock;
inline std::shared_ptr<State> g_active;

inline std::shared_ptr<State> activeState() noexcept {
    std::lock_guard<std::mutex> guard(g_activeLock);
    return g_active;
}

inline void setActiveState(std::shared_ptr<State> state) noexcept {
    {
        std::lock_guard<std::mutex> guard(g_activeLock);
        std::swap(g_active, state);
    }
    // The old state is let go outside the lock: freeing it may free a held
    // call's filter, whose destructor reads the active state
}

inline constexpr auto CallerType = "rr_test_caller"_itv;
inline constexpr auto TargetType = "rr_test_target"_itv;
inline constexpr auto SlowType = "rr_test_slow"_itv;
inline constexpr auto BuildType = "rr_test_build"_itv;
inline constexpr auto TestLevel = Lvl::ServiceNull;

//-------------------------------------------------------------------------
/// @details
///     The global of every test filter type: it adds nothing to its parent
//-------------------------------------------------------------------------
class TestGlobal : public IServiceFilterGlobal {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterGlobal;
    using Parent::Parent;

    _const auto LogLevel = TestLevel;

    /// The factory that makes this global for the given filter type
    static auto factory(iTextView type) noexcept {
        return Factory::makeFactory<TestGlobal, Parent>(type);
    }
};

//-------------------------------------------------------------------------
/// @details
///     The filter the Python side calls into. When the test asks, its
///     begin counts a call on it that stays in flight, and may then fail.
///     It reports where it is freed
//-------------------------------------------------------------------------
class CallerInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;

    _const auto LogLevel = TestLevel;
    _const auto Factory =
        Factory::makeFactory<CallerInstance, Parent>(CallerType);

    ~CallerInstance() override {
        if (auto state = activeState())
            state->callerFreed();
    }

    virtual Error beginFilterInstance() noexcept override {
        auto state = activeState();
        if (state && state->callOnBegin.exchange(false)) {
            state->heldCaller = instance;
            state->heldHead = pipe->instance;
            try {
                state->heldCall =
                    std::make_unique<IServiceFilterInstance::CallGuard>(
                        instance.lock());
            } catch (const Error &error) {
                return error;
            }
            if (state->failCallerBegin.exchange(false))
                return APERR(Ec::Failed, "The caller's begin fails here");
        }
        return Parent::beginFilterInstance();
    }
};

//-------------------------------------------------------------------------
/// @details
///     The control target. control() announces that it is running and then
///     blocks until released, with the GIL released the way a Python node
///     does while it works. When the test asks, it then declines the
///     control
//-------------------------------------------------------------------------
class TargetInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;

    _const auto LogLevel = TestLevel;
    _const auto Factory =
        Factory::makeFactory<TargetInstance, Parent>(TargetType);

    virtual Error control(py::object &) noexcept override {
        auto state = activeState();
        if (!state)
            return {};

        state->entered.set();
        {
            engine::python::UnlockPython unlock;
            state->release.wait();
        }
        state->targetReturned = true;
        if (state->declineControl)
            return APERR(Ec::PreventDefault, "The target declines");
        return {};
    }

    /// When the test asks, lets control() return and waits for the worker
    /// before this filter ends
    virtual Error endFilterInstance() noexcept override {
        auto state = activeState();
        if (state && state->returnDuringEnd.exchange(false)) {
            state->release.set();
            state->workerDone.wait();
        }
        return Parent::endFilterInstance();
    }
};

//-------------------------------------------------------------------------
/// @details
///     The slow data node. writeText() announces that it is running and then
///     blocks until released. The GIL is already released around the data
///     callback that reaches it, so it must not release it again. It does not
///     consume the text: it passes it on to the next filter when it returns
//-------------------------------------------------------------------------
class SlowInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;

    _const auto LogLevel = TestLevel;
    _const auto Factory = Factory::makeFactory<SlowInstance, Parent>(SlowType);

    virtual Error writeText(const Utf16View &text) noexcept override {
        auto state = activeState();
        if (!state)
            return Parent::writeText(text);

        state->entered.set();
        state->release.wait();
        state->targetReturned = true;
        return Parent::writeText(text);
    }
};

//-------------------------------------------------------------------------
/// @details
///     A filter that acts while a pipe is built. Its begin passes, unless
///     the test asks it to fail, or to wait until released; a filter that
///     waited reports when, and on which thread, it was ended
//-------------------------------------------------------------------------
class BuildInstance : public IServiceFilterInstance {
public:
    using Config = IServiceConfig;
    using Parent = IServiceFilterInstance;
    using Parent::Parent;

    _const auto LogLevel = TestLevel;
    _const auto Factory =
        Factory::makeFactory<BuildInstance, Parent>(BuildType);

    virtual Error beginFilterInstance() noexcept override {
        auto state = activeState();
        if (state && state->failBuild)
            return APERR(Ec::Failed, "The pipe build fails here");

        if (state && state->holdBuild.exchange(false)) {
            m_held = true;
            state->heldFilter = instance;
            state->buildEntered.set();
            state->buildRelease.wait();
        }
        return Parent::beginFilterInstance();
    }

    virtual Error endFilterInstance() noexcept override {
        auto state = activeState();
        if (state && std::exchange(m_held, false)) {
            state->heldEndedOn = std::this_thread::get_id();
            state->heldEnded = true;
        }
        return Parent::endFilterInstance();
    }

private:
    bool m_held = false;
};

//-------------------------------------------------------------------------
/// @details
///     A monitor that reports itself as the app monitor, which turns on the
///     debugger's ENTER/LEAVE events, and records every "other" event
//-------------------------------------------------------------------------
class CaptureMonitor : public engine::monitor::TestConsole {
public:
    using Parent = engine::monitor::TestConsole;
    using Parent::Parent;
    _const auto Factory = Factory::makeFactory<CaptureMonitor,
                                               engine::monitor::Monitor>(
        "RrCaptureMonitor");

    virtual bool isAppMonitor() noexcept override { return true; }

    virtual void other(TextView key, TextView param) noexcept override {
        std::lock_guard<std::mutex> guard(m_lock);
        m_events.emplace_back(std::string{key.data(), key.size()},
                              std::string{param.data(), param.size()});
    }

    /// Number of events recorded so far, to count from later
    size_t mark() noexcept {
        std::lock_guard<std::mutex> guard(m_lock);
        return m_events.size();
    }

    /// Debugger events from the mark on whose text contains the given word
    size_t count(size_t from, const char *word) noexcept {
        std::lock_guard<std::mutex> guard(m_lock);
        size_t total = 0;
        for (size_t i = from; i < m_events.size(); ++i)
            if (m_events[i].first == "DBG" &&
                m_events[i].second.find(word) != std::string::npos)
                ++total;
        return total;
    }

private:
    std::mutex m_lock;
    std::vector<std::pair<std::string, std::string>> m_events;
};

//-------------------------------------------------------------------------
/// @details
///     Sends the engine log to a file for the lifetime of the object, so the
///     test can read back what LOG(Always, ...) wrote
//-------------------------------------------------------------------------
class LogCapture {
public:
    LogCapture() {
        m_path = std::filesystem::temp_directory_path() /
                 ("rr_invoke_teardown_" +
                  std::to_string(reinterpret_cast<uintptr_t>(this)) + ".log");
        m_file = std::fopen(m_path.string().c_str(), "w+b");
        m_previous = ap::log::options().logFile;
        if (m_file)
            ap::log::options().logFile = m_file;
    }

    ~LogCapture() {
        ap::log::options().logFile = m_previous;
        if (m_file)
            std::fclose(m_file);
        std::error_code ignored;
        std::filesystem::remove(m_path, ignored);
    }

    LogCapture(const LogCapture &) = delete;
    LogCapture &operator=(const LogCapture &) = delete;

    bool ok() const noexcept { return m_file != nullptr; }

    /// Everything written so far
    std::string text() {
        std::string out;
        if (!m_file)
            return out;

        std::fflush(m_file);
        std::fseek(m_file, 0, SEEK_END);
        const auto size = std::ftell(m_file);
        if (size > 0) {
            out.resize(static_cast<size_t>(size));
            std::fseek(m_file, 0, SEEK_SET);
            out.resize(std::fread(out.data(), 1, out.size(), m_file));
        }
        std::fseek(m_file, 0, SEEK_END);
        return out;
    }

private:
    std::filesystem::path m_path;
    FILE *m_file = nullptr;
    FILE *m_previous = nullptr;
};

/// Registers the test filter factories and removes them again
class FactoryScope {
public:
    FactoryScope() {
        m_error = Factory::registerFactory(
            CallerInstance::Factory, TestGlobal::factory(CallerType),
            TargetInstance::Factory, TestGlobal::factory(TargetType),
            SlowInstance::Factory, TestGlobal::factory(SlowType),
            BuildInstance::Factory, TestGlobal::factory(BuildType),
            CaptureMonitor::Factory);
    }
    ~FactoryScope() {
        Factory::deregisterFactory(
            CallerInstance::Factory, TestGlobal::factory(CallerType),
            TargetInstance::Factory, TestGlobal::factory(TargetType),
            SlowInstance::Factory, TestGlobal::factory(SlowType),
            BuildInstance::Factory, TestGlobal::factory(BuildType),
            CaptureMonitor::Factory);
    }
    FactoryScope(const FactoryScope &) = delete;
    FactoryScope &operator=(const FactoryScope &) = delete;

    const Error &error() const noexcept { return m_error; }

private:
    Error m_error;
};

/// Installs the capture monitor as the engine monitor and restores the old one
class MonitorScope {
public:
    MonitorScope() {
        auto made = Factory::make<engine::monitor::Monitor>(
            _location, Text{"RrCaptureMonitor"});
        if (!made) {
            m_error = made.ccode();
            return;
        }
        m_previous = _mv(engine::config::monitor());
        engine::config::monitor() = _mv(*made);
        m_monitor = static_cast<CaptureMonitor *>(
            engine::config::monitor().get());
        m_installed = true;
    }
    ~MonitorScope() {
        if (m_installed)
            engine::config::monitor() = _mv(m_previous);
    }
    MonitorScope(const MonitorScope &) = delete;
    MonitorScope &operator=(const MonitorScope &) = delete;

    const Error &error() const noexcept { return m_error; }
    CaptureMonitor &monitor() noexcept { return *m_monitor; }

private:
    Ptr<engine::monitor::Monitor> m_previous =
        nullPtr<engine::monitor::Monitor>();
    CaptureMonitor *m_monitor = nullptr;
    bool m_installed = false;
    Error m_error;
};

/// Sets the drain deadline and restores the previous one
class DeadlineScope {
public:
    DeadlineScope() : m_previous(IServiceEndpoint::drainDeadline().load()) {}
    ~DeadlineScope() { IServiceEndpoint::drainDeadline().store(m_previous); }
    DeadlineScope(const DeadlineScope &) = delete;
    DeadlineScope &operator=(const DeadlineScope &) = delete;

    void set(time::Duration deadline) noexcept {
        IServiceEndpoint::drainDeadline().store(deadline);
    }

private:
    time::Duration m_previous;
};

/// The error a callable throws, empty when it does not throw
template <typename Fn>
Error thrownError(Fn &&fn) {
    try {
        fn();
    } catch (const Error &error) {
        return error;
    }
    return {};
}

//-------------------------------------------------------------------------
/// @details
///     Makes one call into a filter callback the way Python does: through
///     a handle bound to the filter's weak self link. forwardTo() holds the
///     filter and passes its call gate for the length of the call, so the
///     call is counted, or refused once the gate is closed
//-------------------------------------------------------------------------
template <typename Callback, typename... Args>
void callAsPython(const ServiceInstanceWeak &filter, Callback callback,
                  Args &&...args) {
    pythonBase::FilterHandle handle{filter};
    pythonBase::forwardTo(callback)(handle, std::forward<Args>(args)...);
}

/// The error a text write into the filter throws when made the way Python
/// makes it; empty when the write passes
inline Error writeTextAsPython(const ServiceInstanceWeak &filter) {
    return thrownError([&] {
        callAsPython(filter, &IServiceFilterInstance::cb_writeText, u"x");
    });
}

/// True once endEndpoint() has taken its snapshot: from then on no pipe is
/// handed out. Read under the stack lock, which guards it
inline bool endStarted(IServiceEndpoint &ep) {
    util::Guard stackGuard{[&] { ep.m_stackLock.lock(); },
                           [&] { ep.m_stackLock.unlock(); }};
    return ep.m_ending;
}

/// Polls until the end of the endpoint has started; false after kTimeout
inline bool waitEndStarted(IServiceEndpoint &ep) {
    const auto until = std::chrono::steady_clock::now() + kTimeout;
    while (!endStarted(ep)) {
        if (std::chrono::steady_clock::now() >= until)
            return false;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return true;
}

/// How the fixture opens its object
enum class Open { Plain, Index };

//-------------------------------------------------------------------------
/// @details
///     Weak links to one stack: its head, its caller filter and its
///     endpoint. Taken when the test lets go of the stack, to check later
///     that nothing keeps it alive
//-------------------------------------------------------------------------
struct StackWatch {
    ServiceInstanceWeak pipe;
    ServiceInstanceWeak caller;
    ServiceEndpointWeak endpoint;

    /// True once the head and the caller filter are both freed
    bool freed() const noexcept { return pipe.expired() && caller.expired(); }
};

//-------------------------------------------------------------------------
/// @details
///     One scenario's setup and cleanup: factories, capture monitor, log
///     capture, deadline, state, and the pipeline
///     [pipe, rr_test_caller, rr_test_target, rr_test_build, null, bottom]
///     opened with one object. Members are destroyed in reverse order, so
///     the pipeline is torn down before the globals it depends on are
///     restored
//-------------------------------------------------------------------------
class Fixture {
public:
    /// @param[in] filters
    ///     The filter types below the pipe filter
    /// @param[in] open
    ///     Open::Index opens the object with Entry::FLAGS::INDEX, which a
    ///     real Python response node needs
    explicit Fixture(TextVector filters = {"rr_test_caller", "rr_test_target",
                                           "rr_test_build"},
                     Open open = Open::Plain)
        : state(std::make_shared<State>()),
          filter(filters),
          m_open(open) {}

    ~Fixture() {
        // Let any blocked call, build or end finish before the pipeline
        // goes away
        state->release.set();
        state->buildRelease.set();
        if (m_worker.joinable()) {
            if (state->workerDone.wait())
                m_worker.join();
            else
                m_worker.detach();
        }
        if (m_end.joinable())
            m_end.join();
        state->heldCall.reset();

        // The control object is a Python object: release it under the GIL
        if (m_control) {
            auto control = _mv(m_control);
            const auto release = localfcn()->Error {
                control.reset();
                return {};
            };
            [[maybe_unused]] const auto ignored = callPython(release);
        }

        // Nothing may report to this state any more
        setActiveState(nullptr);
    }

    Fixture(const Fixture &) = delete;
    Fixture &operator=(const Fixture &) = delete;

    /// Builds the pipeline and opens one object; call from the test thread
    void setup() {
        REQUIRE_NO_ERROR(factories.error());
        REQUIRE_NO_ERROR(monitors.error());
        REQUIRE(logCapture.ok());

        setActiveState(state);

        // The control object handed to cb_control
        m_control = std::make_unique<py::object>();
        const auto make = localfcn()->Error {
            *m_control = py::dict();
            return {};
        };
        REQUIRE_NO_ERROR(callPython(make));

        REQUIRE_NO_ERROR(filter.connect());

        auto opened =
            m_open == Open::Index
                ? filter.openObject("x.txt"_tv, Entry::FLAGS::INDEX)
                : filter.openObject("x.txt"_tv);
        REQUIRE_NO_ERROR(opened);
        pipe = *opened;

        // The pipe filter is at index 0; the caller sits right below it
        caller = pipe->pDown;
        REQUIRE(caller);

        // What a pipeline's control rows set up: "tool" is served by the
        // filter at stack index 2, the target
        caller->controller["tool"] = {2};
    }

    /// Starts the worker: under the GIL, as Python would, it makes one call
    /// on the caller filter and records what the call threw. The worker
    /// holds only the filter's weak self link, as a Python handle does
    template <typename Call>
    void startWorker(Call call) {
        auto shared = state;
        ServiceInstanceWeak target = caller->instance;
        auto *control = m_control.get();
        m_worker = std::thread([shared, target, control, call] {
            shared->workerId = std::this_thread::get_id();
            const auto python = localfcn()->Error {
                try {
                    call(target, *control);
                } catch (const Error &error) {
                    shared->setError(error);
                } catch (...) {
                    std::lock_guard<std::mutex> guard(shared->errorLock);
                    shared->workerThrewOther = true;
                }
                return {};
            };
            if (auto ccode = callPython(python))
                shared->setError(ccode);
            shared->workerDone.set();
        });
    }

    /// Starts the worker with control("tool") on the caller. Without a node
    /// id the control walks the filters that serve "tool" (the chain
    /// dispatch); with one it goes to that filter only (the targeted one)
    void startControl(std::string nodeId = {}) {
        startWorker([nodeId](const auto &target, py::object &control) {
            std::string classType = "tool";
            callAsPython(target, &IServiceFilterInstance::cb_control,
                         classType, control, nodeId);
        });
    }

    /// Waits for the worker to finish its call and joins it. The call may
    /// throw an Error, which the test reads with state->error(), and
    /// nothing else
    void finishWorker() {
        REQUIRE(state->workerDone.wait());
        m_worker.join();
        REQUIRE_FALSE(state->workerThrewOther);
    }

    /// The control object, for calls made on the test thread
    py::object &control() { return *m_control; }

    /// Lets go of the fixture's references to the stack, so that only the
    /// engine and the calls in flight hold it, and returns weak links to
    /// it. The caller filter's destructor compares with this endpoint
    StackWatch dropStack() {
        StackWatch watch{pipe->instance, caller->instance, pipe->endpoint};
        state->watchEndpoint(watch.endpoint);
        caller.reset();
        pipe.reset();
        return watch;
    }

    /// Ends the endpoint and returns how long that took
    std::chrono::milliseconds disconnect(Error &result) {
        const auto start = std::chrono::steady_clock::now();
        result = filter.disconnect();
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start);
    }

    /// Ends the endpoint, requires that the end reports no error, and
    /// returns how long the end took
    std::chrono::milliseconds endPipeline() {
        Error ended;
        const auto took = disconnect(ended);
        REQUIRE_NO_ERROR(ended);
        return took;
    }

    /// Ends the endpoint on its own thread, as a task does while a node is
    /// still working; the test must not use the filter until finishEnd()
    void startEnd() {
        m_end = std::thread([this] {
            m_endResult = filter.disconnect();
            m_endDone.set();
        });
    }

    /// Waits for the end started by startEnd() and returns its result
    Error finishEnd() {
        REQUIRE(m_endDone.wait());
        m_end.join();
        return m_endResult;
    }

    /// True once the end started by startEnd() has returned
    bool endReturned() noexcept { return m_endDone.isSet(); }

    FactoryScope factories;
    MonitorScope monitors;
    LogCapture logCapture;
    DeadlineScope deadline;
    std::shared_ptr<State> state;
    IFilterTest filter;

    /// Strong references, like the ones a Python-side caller keeps
    ServicePipe pipe;
    ServiceInstance caller;

private:
    Open m_open = Open::Plain;
    std::unique_ptr<py::object> m_control;
    std::thread m_worker;
    std::thread m_end;
    Gate m_endDone;
    Error m_endResult;
};

//-------------------------------------------------------------------------
/// @details
///     Python references to the handles of a real Python node, held across
///     the end of the pipeline. They are Python objects, so they are released
///     under the GIL when the holder goes away
//-------------------------------------------------------------------------
class PythonHandles {
public:
    PythonHandles() = default;
    PythonHandles(const PythonHandles &) = delete;
    PythonHandles &operator=(const PythonHandles &) = delete;

    ~PythonHandles() {
        const auto release = localfcn()->Error {
            node = py::object();
            pipe = py::object();
            endpoint = py::object();
            borrowed = py::object();
            return {};
        };
        [[maybe_unused]] const auto ignored = callPython(release);
    }

    /// self.instance of the node: an engLib.IFilterInstanceHandle
    py::object node;

    /// instance.pipe of the node: an engLib.IServiceFilterPipeHandle
    py::object pipe;

    /// self.IEndpoint.endpoint of the node: the engine endpoint
    py::object endpoint;

    /// A pipe the node borrowed with endpoint.getPipe()
    py::object borrowed;
};

/// The message of the Python exception a callable raises, empty when it does
/// not raise. Call under the GIL
template <typename Fn>
std::string pythonFailure(Fn &&fn) {
    try {
        fn();
    } catch (py::error_already_set &error) {
        const std::string what = error.what();
        return what.empty() ? std::string{"<raised>"} : what;
    }
    return {};
}

/// What a node handle's next, currentObject and getControllerNodeIds('tool')
/// raise; empty where they do not raise
struct LinkReads {
    std::string next;
    std::string currentObject;
    std::string controllerIds;
};

/// Reads next and currentObject and calls getControllerNodeIds('tool') on a
/// node handle. Call under the GIL
inline LinkReads readLinks(const py::object &node) {
    LinkReads reads;
    reads.next = pythonFailure([&] { py::object(node.attr("next")); });
    reads.currentObject =
        pythonFailure([&] { py::object(node.attr("currentObject")); });
    reads.controllerIds = pythonFailure(
        [&] { node.attr("getControllerNodeIds")(py::str("tool")); });
    return reads;
}

//-------------------------------------------------------------------------
/// @details
///     What node code sees when it catches a refused node.writeText('x'):
///     the exception's code compared with rocketlib's Ec.PipelineEnded, and
///     its text
//-------------------------------------------------------------------------
struct NodeRefusal {
    /// exc.code == Ec.PipelineEnded.value
    bool codeMatches = false;

    /// exc.message == 'The pipeline has ended' and
    /// str(exc).startswith('PipelineEnded: The pipeline has ended at (')
    bool textMatches = false;

    /// repr(exc.code) and str(exc); empty when the call did not raise
    std::string code;
    std::string text;
};

/// Runs node.writeText('x') as node code would, and reports the exception it
/// raised. Call under the GIL
inline NodeRefusal refusedWrite(const py::object &node) {
    py::dict scope;
    scope["__builtins__"] = py::module_::import("builtins");
    scope["node"] = node;
    py::exec(
        "from rocketlib import Ec\n"
        "code = ''\n"
        "text = ''\n"
        "codeMatches = False\n"
        "textMatches = False\n"
        "try:\n"
        "    node.writeText('x')\n"
        "except Exception as exc:\n"
        "    code = repr(getattr(exc, 'code', None))\n"
        "    text = str(exc)\n"
        "    codeMatches = exc.code == Ec.PipelineEnded.value\n"
        "    textMatches = (\n"
        "        exc.message == 'The pipeline has ended'\n"
        "        and str(exc).startswith(\n"
        "            'PipelineEnded: The pipeline has ended at (')\n"
        "    )\n",
        scope);

    NodeRefusal refusal;
    refusal.codeMatches = scope["codeMatches"].cast<bool>();
    refusal.textMatches = scope["textMatches"].cast<bool>();
    refusal.code = scope["code"].cast<std::string>();
    refusal.text = scope["text"].cast<std::string>();
    return refusal;
}

//-------------------------------------------------------------------------
/// @details
///     Gives a Python node class an endInstance that raises, and replaces
///     writeText on one node object with a counter, so a test can see
///     whether the engine still enters that node. The class is restored
///     when the object goes away
//-------------------------------------------------------------------------
class RaisingEnd {
public:
    RaisingEnd() = default;
    RaisingEnd(const RaisingEnd &) = delete;
    RaisingEnd &operator=(const RaisingEnd &) = delete;

    ~RaisingEnd() {
        const auto restore = localfcn()->Error {
            util::Guard release{[&] {
                m_class = py::object();
                m_original = py::object();
                m_scope = py::object();
            }};
            if (!m_class)
                return {};
            if (m_original.is_none())
                py::delattr(m_class, "endInstance");
            else
                py::setattr(m_class, "endInstance", m_original);
            return {};
        };
        [[maybe_unused]] const auto ignored = callPython(restore);
    }

    /// Patches the class of the node's object. Nodes built after this
    /// raise in endInstance
    Error patch(pythonBase::IPythonInstanceBase &node) {
        const auto python = localfcn()->Error {
            py::dict scope;
            scope["__builtins__"] = py::module_::import("builtins");
            py::exec(
                "entered = []\n"
                "def endInstance(self):\n"
                "    raise RuntimeError('endInstance fails here')\n"
                "def writeText(text):\n"
                "    entered.append(text)\n",
                scope);
            m_scope = scope;

            py::object cls = node.getPythonInstance().attr("__class__");
            m_original = cls.attr("__dict__").attr("get")("endInstance");
            py::setattr(cls, "endInstance", scope["endInstance"]);
            m_class = cls;
            return {};
        };
        return callPython(python);
    }

    /// Replaces writeText on the node's object with the counter
    Error countEntries(pythonBase::IPythonInstanceBase &node) {
        const auto python = localfcn()->Error {
            py::setattr(node.getPythonInstance(), "writeText",
                        m_scope["writeText"]);
            return {};
        };
        return callPython(python);
    }

    /// How often the engine entered the counted writeText
    size_t entries() {
        size_t count = 0;
        const auto python = localfcn()->Error {
            count = py::len(m_scope["entered"]);
            return {};
        };
        [[maybe_unused]] const auto ignored = callPython(python);
        return count;
    }

private:
    py::object m_class;
    py::object m_original;
    py::object m_scope;
};

}  // namespace invoke_teardown
