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

#include <chrono>
#include <memory>
#include <string>
#include <thread>
#include <utility>

#include "../store.h"
#include "invoke_teardown_fixture.hpp"

//-----------------------------------------------------------------------------
// A pipeline can end while a Python call (an invoke or a data callback) is
// still running on one of its filters. These tests end the endpoint with such
// a call in flight and check that the call finishes safely, that the end
// waits for it up to the drain deadline, that the last call to leave an
// ended stack frees it, and that calls made after the end are refused. They
// also check that no pipe is handed out or published once the end has
// started.
//
// The pipeline is [pipe, rr_test_caller, rr_test_target, rr_test_build, null,
// bottom]. A worker thread plays the Python side: through a handle, as Python
// does, it calls control on the caller filter, which dispatches to the
// target's control(). The target blocks in control() until the test releases
// it. rr_test_build does nothing unless the test asks it to hold or fail its
// begin while a pipe is built.
//
// The fixture, the test filters and the helpers are in
// invoke_teardown_fixture.hpp.
//-----------------------------------------------------------------------------

TEST_CASE("store::invokeTeardown") {
    using invoke_teardown::kDeadline;
    using invoke_teardown::kDeadlineWaited;
    using invoke_teardown::kEndLimit;

    invoke_teardown::Fixture fx;
    fx.setup();

    //-----------------------------------------------------------------
    // The pipeline ends while the target is still inside control(). The
    // end gives up at the drain deadline and keeps every link for the call.
    // The test then lets go of the stack, so the call is its last holder.
    // The call finishes safely, its result is delivered, the late return
    // is logged and left out of the debugger events (an ENTER with no
    // LEAVE), and when it leaves, its own thread frees the stack: the
    // filter it ran on first, the endpoint after it.
    //-----------------------------------------------------------------
    SECTION("the end gives up at the deadline; the late call is delivered") {
        const auto from = fx.monitors.monitor().mark();
        fx.startControl();
        REQUIRE(fx.state->entered.wait());

        fx.deadline.set(kDeadline);
        const auto took = fx.endPipeline();

        // The end returned at the deadline with the target still held
        REQUIRE(took >= kDeadlineWaited);
        REQUIRE(took < kEndLimit);
        REQUIRE_FALSE(fx.state->targetReturned.load());
        REQUIRE(fx.caller->hasEnded());

        // Every link stays while the call is in flight, the pipe filter's
        // link to itself included: a late return reaches the debugger
        // through it (Binder::callMethods)
        REQUIRE(fx.pipe->pipe.get() == fx.pipe.get());
        REQUIRE(fx.caller->pipe.get() == fx.pipe.get());
        REQUIRE(fx.caller->endpoint.get() != nullptr);

        auto log = fx.logCapture.text();
        CHECK(log.find("still in flight") != std::string::npos);
        CHECK(log.find("rr_test_caller(pipe 0, 1)") != std::string::npos);

        // From here on only the engine and the call hold the stack, and the
        // stack's links keep the endpoint alive
        const auto stack = fx.dropStack();
        REQUIRE_FALSE(stack.endpoint.expired());

        // Now let the target return and the worker finish
        fx.state->release.set();
        fx.finishWorker();

        REQUIRE(fx.state->targetReturned.load());
        REQUIRE_NO_ERROR(fx.state->error());

        // The late call was the last holder of the stack: the worker's
        // thread freed it, the caller filter while the endpoint was still
        // alive, and then the endpoint
        REQUIRE(stack.freed());
        REQUIRE(stack.endpoint.expired());
        const auto freed = fx.state->callerFree();
        REQUIRE(freed.on == fx.state->workerId);
        REQUIRE(freed.endpointAlive);

        log = fx.logCapture.text();
        CHECK(log.find("invoke returned after the pipeline ended") !=
              std::string::npos);

        // The debugger saw the call enter but never leave
        CHECK(fx.monitors.monitor().count(from, "ENTER") >= 1);
        CHECK(fx.monitors.monitor().count(from, "LEAVE") == 0);
    }

    //-----------------------------------------------------------------
    // Once the pipeline has ended, a control call and a data callback on
    // the ended filter are refused instead of touching released links.
    // The filter is still alive (the fixture holds it), so the refusal
    // comes from its closed gate, and a refused call is not counted.
    //-----------------------------------------------------------------
    SECTION("calls after the end are refused") {
        fx.endPipeline();
        REQUIRE(fx.caller->hasEnded());

        const ServiceInstanceWeak target = fx.caller->instance;
        std::string classType = "tool";
        const auto control = invoke_teardown::thrownError([&] {
            invoke_teardown::callAsPython(
                target, &IServiceFilterInstance::cb_control, classType,
                fx.control(), std::string{});
        });
        REQUIRE_ERROR(control, Ec::PipelineEnded, PipelineEndedMessage);

        const auto text = invoke_teardown::writeTextAsPython(target);
        REQUIRE_ERROR(text, Ec::PipelineEnded, PipelineEndedMessage);
        REQUIRE(fx.caller->callsInFlight() == 0);
    }

    //-----------------------------------------------------------------
    // The end waits for a call that returns within the deadline. The test
    // holds the GIL across the end, and the end lets go of it only while
    // it waits for a call; so the releaser, which needs the GIL, lets the
    // call return only during that wait. The call completes before the end
    // returns, nothing is reported as late, and the debugger events are
    // balanced.
    //-----------------------------------------------------------------
    SECTION("the end waits for a call that returns in time") {
        fx.deadline.set(30s);

        const auto from = fx.monitors.monitor().mark();
        fx.startControl();
        REQUIRE(fx.state->entered.wait());

        Error ended;
        bool endWasWaiting = false;
        bool targetReturnedAtEnd = false;
        std::thread releaser;
        {
            engine::python::LockPython gil;

            auto state = fx.state;
            releaser = std::thread([state] {
                const auto release = localfcn()->Error {
                    state->endWaiting.set();
                    state->release.set();
                    return {};
                };
                [[maybe_unused]] const auto ignored = callPython(release);
            });

            fx.disconnect(ended);
            endWasWaiting = fx.state->endWaiting.isSet();
            targetReturnedAtEnd = fx.state->targetReturned.load();
        }
        releaser.join();
        fx.finishWorker();

        REQUIRE_NO_ERROR(ended);
        REQUIRE(endWasWaiting);
        REQUIRE(targetReturnedAtEnd);
        REQUIRE_NO_ERROR(fx.state->error());
        REQUIRE(fx.caller->hasEnded());

        const auto log = fx.logCapture.text();
        CHECK(log.find("invoke returned after the pipeline ended") ==
              std::string::npos);
        CHECK(log.find("still in flight") == std::string::npos);

        const auto enters = fx.monitors.monitor().count(from, "ENTER");
        const auto leaves = fx.monitors.monitor().count(from, "LEAVE");
        CHECK(enters >= 1);
        CHECK(enters == leaves);

        // The end released the filters' links itself, so with the fixture's
        // references gone nothing keeps the stack alive
        REQUIRE(fx.dropStack().freed());
    }

    //-----------------------------------------------------------------
    // With a call held, the end waits with the gates open for half of the
    // deadline only, and then closes them. A new call made while the end
    // still waits is refused and is not counted. The held call is then let
    // go, and the end's second wait sees it return. The deadline here is
    // long, so that half of it and all of it stay far apart on a slow
    // machine too.
    //-----------------------------------------------------------------
    SECTION("with a call held, the gates close at half the deadline") {
        constexpr auto longDeadline = std::chrono::seconds(4);
        constexpr auto half = longDeadline / 2;
        fx.deadline.set(longDeadline);

        fx.startControl();
        REQUIRE(fx.state->entered.wait());

        const auto start = std::chrono::steady_clock::now();
        fx.startEnd();

        // Watch the gate of the filter the held call runs on
        const auto until = start + invoke_teardown::kTimeout;
        while (!fx.caller->hasEnded() &&
               std::chrono::steady_clock::now() < until)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        const auto closedAfter = std::chrono::steady_clock::now() - start;
        REQUIRE(fx.caller->hasEnded());

        // A new call is refused while the end still waits
        const ServiceInstanceWeak target = fx.caller->instance;
        const auto refused = invoke_teardown::writeTextAsPython(target);
        const bool endReturned = fx.endReturned();
        REQUIRE_ERROR(refused, Ec::PipelineEnded, PipelineEndedMessage);
        REQUIRE_FALSE(endReturned);
        REQUIRE(fx.caller->callsInFlight() == 1);

        // The gates closed after half of the deadline, not after all of it
        REQUIRE(closedAfter >= half - invoke_teardown::kTimerSlack);
        REQUIRE(closedAfter < longDeadline);

        // The end's second wait sees the held call return
        fx.state->release.set();
        fx.finishWorker();
        REQUIRE_NO_ERROR(fx.finishEnd());
        REQUIRE_NO_ERROR(fx.state->error());
        CHECK(fx.logCapture.text().find("still in flight") ==
              std::string::npos);
    }

    //-----------------------------------------------------------------
    // The global cancel flag cuts the end's wait short: with a long
    // deadline and the call still held, the end returns at once, says the
    // drain was cut short, and keeps the links for the call. The test then
    // lets go of the stack; the call returns safely and frees it.
    //-----------------------------------------------------------------
    SECTION("a cancel cuts the end's wait short") {
        fx.startControl();
        REQUIRE(fx.state->entered.wait());

        fx.deadline.set(30s);
        std::chrono::milliseconds took{};
        {
            // Just the flag: globalCancel() also arms the exit fail-safe
            util::Guard cancel{[] { ap::async::globalCancelFlag() = true; },
                               [] { ap::async::globalCancelFlag() = false; }};
            took = fx.endPipeline();
        }
        REQUIRE(took < kEndLimit);
        REQUIRE_FALSE(fx.state->targetReturned.load());
        CHECK(fx.logCapture.text().find("cancel requested") !=
              std::string::npos);

        const auto stack = fx.dropStack();
        fx.state->release.set();
        fx.finishWorker();
        REQUIRE_NO_ERROR(fx.state->error());
        REQUIRE(stack.freed());
    }

    //-----------------------------------------------------------------
    // The call leaves the stack after the drain gave up and before the end
    // arms the stack: the target's end lets it return and waits for it. No
    // later call will leave the stack, so arming it must release it at
    // once. The test lets go of the stack before the end, so the end frees
    // it.
    //-----------------------------------------------------------------
    SECTION("a stack that is idle when armed is released at once") {
        fx.startControl();
        REQUIRE(fx.state->entered.wait());

        fx.state->returnDuringEnd = true;
        fx.deadline.set(kDeadline);
        const auto stack = fx.dropStack();
        fx.endPipeline();
        REQUIRE(stack.freed());

        // The drain gave up with the call in flight, and the call returned
        // during the end
        const auto log = fx.logCapture.text();
        CHECK(log.find("still in flight") != std::string::npos);
        CHECK(log.find("invoke returned after the pipeline ended") !=
              std::string::npos);
        REQUIRE(fx.state->workerDone.isSet());
        fx.finishWorker();
        REQUIRE(fx.state->targetReturned.load());
        REQUIRE_NO_ERROR(fx.state->error());
    }

    //-----------------------------------------------------------------
    // Two calls are in flight on one stack when the drain gives up: one on
    // the caller and one on the target below it, counted the way
    // forwardTo() counts a call. The stack is ended with its links kept.
    // The first call to leave does not release it, because the other call
    // still runs on the stack; the last one releases it.
    //-----------------------------------------------------------------
    SECTION("a stack with two calls in flight is released by the last") {
        using CallGuard = IServiceFilterInstance::CallGuard;
        ServiceInstance target = fx.caller->downLink();
        REQUIRE(_dynCast<invoke_teardown::TargetInstance *>(target.get()));
        auto onCaller = std::make_unique<CallGuard>(fx.caller);
        auto onTarget = std::make_unique<CallGuard>(_mv(target));

        fx.deadline.set(kDeadline);
        fx.endPipeline();
        const auto log = fx.logCapture.text();
        CHECK(log.find("rr_test_caller(pipe 0, 1)") != std::string::npos);
        CHECK(log.find("rr_test_target(pipe 0, 1)") != std::string::npos);

        // The caller's call leaves first. Only the head's down link holds
        // the caller now, so it stays alive only if the stack kept its links
        const auto stack = fx.dropStack();
        onCaller.reset();
        REQUIRE_FALSE(stack.caller.expired());
        REQUIRE_FALSE(stack.pipe.expired());

        // The last call leaves and releases the stack
        onTarget.reset();
        REQUIRE(stack.freed());
    }

    //-----------------------------------------------------------------
    // A second stack is idle in the pool while a call runs on the first
    // one, and the drain gives up. Both stacks are ended with their links
    // kept and armed: the idle one is released at once, the busy one keeps
    // its links until its call leaves.
    //-----------------------------------------------------------------
    SECTION("an idle stack next to a busy one is released at once") {
        // The first pipe is busy, so this builds a second stack, which goes
        // back to the pool
        invoke_teardown::StackWatch idle;
        {
            ServiceEndpoint ep = fx.pipe->endpoint;
            auto second = ep->getPipe();
            REQUIRE_NO_ERROR(second);
            ServicePipe pipe = *second;
            ServiceInstance caller = pipe->downLink();
            REQUIRE(caller);
            idle.pipe = pipe->instance;
            idle.caller = caller->instance;
            REQUIRE_NO_ERROR(ep->putPipe(pipe));
        }

        fx.startControl();
        REQUIRE(fx.state->entered.wait());

        fx.deadline.set(kDeadline);
        fx.endPipeline();
        CHECK(fx.logCapture.text().find("still in flight") !=
              std::string::npos);

        // Nothing holds the idle stack any more
        REQUIRE(idle.freed());

        // The busy stack keeps its links while its call runs
        REQUIRE(fx.pipe->pipe.get() == fx.pipe.get());
        REQUIRE(fx.caller->pipe.get() == fx.pipe.get());
        const auto busy = fx.dropStack();

        fx.state->release.set();
        fx.finishWorker();
        REQUIRE_NO_ERROR(fx.state->error());
        REQUIRE(busy.freed());
    }

    //-----------------------------------------------------------------
    // Ends the pipeline at the deadline while a control is held in the
    // target, lets go of the stack, and then lets the control return after
    // the end. The late call is the last holder of the stack and frees it.
    //-----------------------------------------------------------------
    const auto controlReturnsAfterEnd = [&](std::string nodeId) {
        fx.startControl(_mv(nodeId));
        REQUIRE(fx.state->entered.wait());

        fx.deadline.set(kDeadline);
        fx.endPipeline();
        REQUIRE_FALSE(fx.state->targetReturned.load());

        const auto stack = fx.dropStack();
        fx.state->release.set();
        fx.finishWorker();
        REQUIRE(fx.state->targetReturned.load());
        REQUIRE(stack.freed());
    };

    //-----------------------------------------------------------------
    // A control sent to one node by its id (the targeted dispatch) that
    // returns after the end: the call returns without an error, the late
    // return is logged, and the debugger gets no LEAVE for it.
    //-----------------------------------------------------------------
    SECTION("a control sent to one node returns after the end") {
        const auto from = fx.monitors.monitor().mark();
        controlReturnsAfterEnd("rr_test_target");

        REQUIRE_NO_ERROR(fx.state->error());
        CHECK(fx.logCapture.text().find(
                  "invoke returned after the pipeline ended") !=
              std::string::npos);
        CHECK(fx.monitors.monitor().count(from, "ENTER") >= 1);
        CHECK(fx.monitors.monitor().count(from, "LEAVE") == 0);
    }

    //-----------------------------------------------------------------
    // A control that walks the filters (the chain dispatch) and is
    // declined after the end: there is no next filter to try once the
    // pipeline has ended, so the caller learns that it has ended.
    //-----------------------------------------------------------------
    SECTION("a control declined after the end reports the end") {
        fx.state->declineControl = true;
        controlReturnsAfterEnd({});

        REQUIRE_ERROR(fx.state->error(), Ec::PipelineEnded,
                      PipelineEndedMessage);
    }

    //-----------------------------------------------------------------
    // Once the end has started, getPipe() hands out no pipe: not an idle
    // one from the pool, and no new one. A call held on the first pipe
    // keeps the end in its drain while the test asks for a pipe.
    //-----------------------------------------------------------------
    const auto noPipeOnceEndStarted = [&](bool withIdlePipe) {
        ServiceEndpoint ep = fx.pipe->endpoint;
        ServiceInstanceWeak weakIdle;
        if (withIdlePipe) {
            auto second = ep->getPipe();
            REQUIRE_NO_ERROR(second);
            weakIdle = (*second)->instance;
            REQUIRE_NO_ERROR(ep->putPipe(*second));
        }

        fx.deadline.set(30s);
        fx.startControl();
        REQUIRE(fx.state->entered.wait());

        fx.startEnd();
        REQUIRE(invoke_teardown::waitEndStarted(*ep));

        auto refused = ep->getPipe();
        REQUIRE_ERROR(refused, Ec::PipelineEnded, PipelineEndedMessage);

        fx.state->release.set();
        fx.finishWorker();
        REQUIRE_NO_ERROR(fx.finishEnd());
        REQUIRE_NO_ERROR(fx.state->error());
        REQUIRE(ep->getPipeCount() == 0);

        REQUIRE(fx.dropStack().freed());
        REQUIRE(weakIdle.expired());
    };

    SECTION("once the end has started, an idle pipe is not handed out") {
        noPipeOnceEndStarted(true);
    }

    SECTION("once the end has started, no new pipe is built") {
        noPipeOnceEndStarted(false);
    }

    //-----------------------------------------------------------------
    // A pipe build that is still running when the end starts is refused
    // where it would publish its stack: the builder gets the refusal, its
    // own thread ends the filters it built before getPipe() returns, and
    // the endpoint never holds the stack.
    //-----------------------------------------------------------------
    SECTION("a pipe build that the end overtakes is refused and ended") {
        ServiceEndpoint ep = fx.pipe->endpoint;

        fx.deadline.set(30s);
        fx.startControl();
        REQUIRE(fx.state->entered.wait());

        // The first pipe is busy, so getPipe() builds a stack; the build
        // waits in the begin of rr_test_build
        fx.state->holdBuild = true;
        Error built;
        bool endedBeforeReturn = false;
        std::thread::id builderId;
        invoke_teardown::Gate builderDone;
        std::thread builder([&, ep] {
            builderId = std::this_thread::get_id();
            auto got = ep->getPipe();
            built = got.check();
            endedBeforeReturn = fx.state->heldEnded.load();
            builderDone.set();
        });
        util::Guard joinBuilder{[&] {
            fx.state->buildRelease.set();
            if (builder.joinable())
                builder.join();
        }};
        REQUIRE(fx.state->buildEntered.wait());

        fx.startEnd();
        REQUIRE(invoke_teardown::waitEndStarted(*ep));
        fx.state->buildRelease.set();
        REQUIRE(builderDone.wait());
        builder.join();

        REQUIRE_ERROR(built, Ec::PipelineEnded, PipelineEndedMessage);
        REQUIRE(endedBeforeReturn);
        REQUIRE(fx.state->heldEndedOn == builderId);
        REQUIRE(fx.state->heldFilter.expired());
        REQUIRE(ep->getPipeCount() == 1);

        fx.state->release.set();
        fx.finishWorker();
        REQUIRE_NO_ERROR(fx.finishEnd());
        REQUIRE(ep->getPipeCount() == 0);
    }

    //-----------------------------------------------------------------
    // A pipe build fails with a call in flight on its half-built stack:
    // rr_test_caller counts a call in its begin, as a node's own thread may
    // do, and then rr_test_build fails its begin. The build closes the
    // gates and waits for the call up to the deadline, then ends the
    // filters and keeps their links. The held call's guard keeps the
    // caller alive, as the guard in forwardTo() does. The caller is not
    // reached from the unbound head, so nothing arms it: a new call on it
    // is refused, is not counted and releases nothing, and its links stay
    // until the held call leaves.
    //-----------------------------------------------------------------
    SECTION("a failed pipe build waits for a call on its stack") {
        ServiceEndpoint ep = fx.pipe->endpoint;
        fx.deadline.set(kDeadline);
        fx.state->callOnBegin = true;
        fx.state->failBuild = true;

        // The first pipe is busy, so this builds a stack, which fails
        const auto start = std::chrono::steady_clock::now();
        auto built = ep->getPipe();
        const auto took = std::chrono::steady_clock::now() - start;
        REQUIRE_ERROR(built, Ec::Failed, "The pipe build fails here");
        REQUIRE(fx.state->heldCall);

        // The build waited for the call before it ended the filters
        REQUIRE(took >= kDeadlineWaited);
        REQUIRE(took < kEndLimit);

        {
            ServiceInstance caller = fx.state->heldCaller.lock();
            REQUIRE(caller);

            const auto refused =
                invoke_teardown::writeTextAsPython(caller->instance);
            REQUIRE_ERROR(refused, Ec::PipelineEnded, PipelineEndedMessage);
            REQUIRE(caller->callsInFlight() == 1);

            // The links the held call was let in with are still there
            REQUIRE(caller->endpoint.get() == ep.get());
            REQUIRE(caller->pipe);
            REQUIRE(caller->pipe->instance.lock() ==
                    fx.state->heldHead.lock());
        }

        // When the held call leaves, nothing keeps the stack alive, and the
        // endpoint never held it
        fx.state->heldCall.reset();
        REQUIRE(fx.state->heldCaller.expired());
        REQUIRE(fx.state->heldHead.expired());
        REQUIRE(ep->getPipeCount() == 1);
    }

    //-----------------------------------------------------------------
    // The begin of rr_test_caller counts a call on its own filter, as a
    // node's own thread may do, and then fails. The failed filter is not
    // in the stack the build ends, so the build closes its gate before it
    // lets go of it. After getPipe() has returned the error, a new call on
    // it is refused and is not counted, and the held call keeps it alive
    // until it leaves.
    //-----------------------------------------------------------------
    SECTION("a filter whose begin fails is closed while its call runs") {
        ServiceEndpoint ep = fx.pipe->endpoint;
        fx.deadline.set(kDeadline);
        fx.state->callOnBegin = true;
        fx.state->failCallerBegin = true;

        // The first pipe is busy, so this builds a stack, which fails
        auto built = ep->getPipe();
        REQUIRE_ERROR(built, Ec::Failed, "The caller's begin fails here");
        REQUIRE(fx.state->heldCall);

        {
            ServiceInstance caller = fx.state->heldCaller.lock();
            REQUIRE(caller);

            const auto refused =
                invoke_teardown::writeTextAsPython(caller->instance);
            REQUIRE_ERROR(refused, Ec::PipelineEnded, PipelineEndedMessage);
            REQUIRE(caller->callsInFlight() == 1);
        }

        // The held call's guard is the last holder of the failed filter and
        // of the head
        fx.state->heldCall.reset();
        REQUIRE(fx.state->heldCaller.expired());
        REQUIRE(fx.state->heldHead.expired());
        REQUIRE(ep->getPipeCount() == 1);
    }
}

//-----------------------------------------------------------------------------
// A data call (a text write) can still be running on a filter when the
// pipeline ends. Teardown gives up at the drain deadline and keeps the
// filters' links, but the ended Python nodes no longer have a Python object.
// When the slow node returns without consuming the text, the engine passes it
// on to the next node; a Python node there refuses the call because the
// pipeline has ended, and the refusal is thrown back to the caller. The test
// has let go of the stack by then, so the late call frees it on its way out.
//
// The pipeline is [pipe, rr_test_caller, rr_test_slow, response_json, ...]. A
// worker thread calls writeText on the caller filter through a handle; the
// slow node blocks in writeText() until the test releases it.
//-----------------------------------------------------------------------------
TEST_CASE("store::invokeTeardownDataChain") {
    invoke_teardown::Fixture fx(
        {"rr_test_caller", "rr_test_slow", "response_json"},
        invoke_teardown::Open::Index);
    fx.setup();

    fx.startWorker([](const ServiceInstanceWeak &target, py::object &) {
        invoke_teardown::callAsPython(
            target, &IServiceFilterInstance::cb_writeText, u"x");
    });
    REQUIRE(fx.state->entered.wait());

    fx.deadline.set(invoke_teardown::kDeadline);
    fx.endPipeline();

    // The end returned at the deadline with the slow node still held, and
    // every link stays, the pipe filter's link to itself included
    REQUIRE_FALSE(fx.state->targetReturned.load());
    REQUIRE(fx.pipe->pipe.get() == fx.pipe.get());
    REQUIRE(fx.caller->pipe.get() == fx.pipe.get());
    const auto log = fx.logCapture.text();
    CHECK(log.find("still in flight") != std::string::npos);

    // From here on only the engine and the call hold the stack
    const auto stack = fx.dropStack();

    // Let the slow node return: the text moves on to the ended Python node,
    // which refuses it
    fx.state->release.set();
    fx.finishWorker();

    REQUIRE(fx.state->targetReturned.load());
    REQUIRE_ERROR(fx.state->error(), Ec::PipelineEnded, PipelineEndedMessage);

    // The late call was the last holder of the stack: the worker's thread
    // freed it while the refusal went back to the caller
    REQUIRE(stack.freed());
    REQUIRE(fx.state->callerFree().on == fx.state->workerId);
}

//-----------------------------------------------------------------------------
// A real Python node holds self.instance as a handle to its filter, and a
// borrowed pipe is a handle too. While the pipeline is alive the handles
// forward calls to the filter. After the pipeline has ended every call and
// property read on them raises the engine's "pipeline has ended" error, and
// giving a borrowed pipe back with putPipe() does nothing.
//
// The pipeline is [pipe, response_json]: the response node is at stack index 1,
// directly below the pipe filter.
//-----------------------------------------------------------------------------
TEST_CASE("store::invokeTeardownPython") {
    using invoke_teardown::pythonFailure;

    // Keeps the engine endpoint alive after the end, so the endpoint object
    // a node holds in Python can still be called; freed last
    ServiceEndpoint keptEndpoint;

    // Declared before the filter so the Python references outlive it and are
    // released last
    invoke_teardown::PythonHandles held;
    IFilterTest filter({"response_json"});

    REQUIRE_NO_ERROR(filter.connect());

    //-----------------------------------------------------------------
    // Node code names the filter classes; those names are the handle
    // classes, and only the node's handle class gets invoke.
    //-----------------------------------------------------------------
    SECTION("the filter class names are the handle classes") {
        bool baseIsHandle = false;
        bool nodeIsHandle = false;
        bool pipeIsHandle = false;
        bool nodeCanInvoke = false;
        bool pipeCanInvoke = true;
        const auto names = localfcn()->Error {
            auto engLib = py::module_::import("engLib");

            // Importing rocketlib adds invoke to the node's handle class
            py::module_::import("rocketlib");
            const auto same = [&](const char *name, const char *handle) {
                return engLib.attr(name).is(engLib.attr(handle));
            };
            baseIsHandle = same("IServiceFilterInstance", "IFilterHandle");
            nodeIsHandle = same("IFilterInstance", "IFilterInstanceHandle");
            pipeIsHandle =
                same("IServiceFilterPipe", "IServiceFilterPipeHandle");
            nodeCanInvoke =
                py::hasattr(engLib.attr("IFilterInstance"), "invoke");
            pipeCanInvoke =
                py::hasattr(engLib.attr("IServiceFilterPipe"), "invoke");
            return {};
        };
        REQUIRE_NO_ERROR(callPython(names));

        REQUIRE(baseIsHandle);
        REQUIRE(nodeIsHandle);
        REQUIRE(pipeIsHandle);
        REQUIRE(nodeCanInvoke);
        REQUIRE_FALSE(pipeCanInvoke);
    }

    //-----------------------------------------------------------------
    // While the pipeline is alive, the node's handles forward calls, and
    // the node's endpoint lends and takes back a pipe. After the end every
    // handle call raises, the endpoint lends no pipe, and the pipe the node
    // still holds cannot be used. Giving that pipe back returns quietly: no
    // stack is left to take it, and a putPipe() in a finally block must not
    // replace the error being handled.
    //-----------------------------------------------------------------
    SECTION("after the end, handle calls raise and putPipe() is quiet") {
        ServiceInstanceWeak weakNode;
        {
            auto opened = filter.openObject("x.txt"_tv, Entry::FLAGS::INDEX);
            REQUIRE_NO_ERROR(opened);
            ServicePipe pipe = *opened;
            keptEndpoint = pipe->endpoint;

            // The response node, directly below the pipe filter
            ServiceInstance node = pipe->pDown;
            REQUIRE(node);
            weakNode = node->instance;
            auto *pyNode =
                _dynCast<pythonBase::IPythonInstanceBase *>(node.get());
            REQUIRE(pyNode);

            // Keep Python references to its handles
            bool nodeIsHandle = false;
            bool pipeIsHandle = false;
            bool pipeIsNone = true;
            bool borrowedIsHandle = false;
            std::string pipeIdFailure;
            std::string listenerFailure;
            std::string pipeHandleFailure;
            std::string putBackFailure;
            std::string borrowedFailure;
            invoke_teardown::LinkReads links;
            const auto reach = localfcn()->Error {
                auto engLib = py::module_::import("engLib");
                py::object pyInstance = pyNode->getPythonInstance();
                held.node = pyInstance.attr("instance");
                held.pipe = held.node.attr("pipe");

                nodeIsHandle = py::isinstance(
                    held.node, engLib.attr("IFilterInstanceHandle"));
                pipeIsNone = held.pipe.is_none();
                pipeIsHandle =
                    !pipeIsNone &&
                    py::isinstance(held.pipe,
                                   engLib.attr("IServiceFilterPipeHandle"));

                // Calls and property reads are forwarded while the pipeline
                // is alive
                pipeIdFailure = pythonFailure(
                    [&] { py::object(held.node.attr("pipeId")); });
                listenerFailure = pythonFailure(
                    [&] { held.node.attr("hasListener")("text"); });
                if (!pipeIsNone)
                    pipeHandleFailure = pythonFailure(
                        [&] { py::object(held.pipe.attr("pipeId")); });
                links = invoke_teardown::readLinks(held.node);

                // The node's endpoint lends a pipe, takes it back, and lends
                // it again; the node keeps the second one
                held.endpoint = pyInstance.attr("IEndpoint").attr("endpoint");
                py::object lent = held.endpoint.attr("getPipe")();
                putBackFailure = pythonFailure(
                    [&] { held.endpoint.attr("putPipe")(lent); });
                held.borrowed = held.endpoint.attr("getPipe")();
                borrowedIsHandle = py::isinstance(
                    held.borrowed, engLib.attr("IServiceFilterPipeHandle"));
                borrowedFailure = pythonFailure(
                    [&] { py::object(held.borrowed.attr("pipeId")); });
                return {};
            };
            REQUIRE_NO_ERROR(callPython(reach));

            REQUIRE(nodeIsHandle);
            REQUIRE_FALSE(pipeIsNone);
            REQUIRE(pipeIsHandle);
            REQUIRE(pipeIdFailure.empty());
            REQUIRE(listenerFailure.empty());
            REQUIRE(pipeHandleFailure.empty());
            REQUIRE(links.next.empty());
            REQUIRE(links.currentObject.empty());
            REQUIRE(links.controllerIds.empty());
            REQUIRE(putBackFailure.empty());
            REQUIRE(borrowedIsHandle);
            REQUIRE(borrowedFailure.empty());

            REQUIRE_NO_ERROR(filter.closeObject(pipe));
        }

        // No strong reference to the node is left on the C++ side, so the end
        // of the pipeline destroys it
        REQUIRE_NO_ERROR(filter.disconnect());
        REQUIRE(weakNode.expired());

        std::string pipeIdFailure;
        std::string listenerFailure;
        std::string pipeHandleFailure;
        std::string getPipeFailure;
        std::string putPipeFailure;
        std::string borrowedFailure;
        invoke_teardown::LinkReads links;
        invoke_teardown::NodeRefusal refusal;
        const auto afterEnd = localfcn()->Error {
            refusal = invoke_teardown::refusedWrite(held.node);
            links = invoke_teardown::readLinks(held.node);
            pipeIdFailure =
                pythonFailure([&] { py::object(held.node.attr("pipeId")); });
            listenerFailure =
                pythonFailure([&] { held.node.attr("hasListener")("text"); });
            pipeHandleFailure =
                pythonFailure([&] { py::object(held.pipe.attr("pipeId")); });
            getPipeFailure =
                pythonFailure([&] { held.endpoint.attr("getPipe")(); });
            putPipeFailure = pythonFailure(
                [&] { held.endpoint.attr("putPipe")(held.borrowed); });
            borrowedFailure = pythonFailure(
                [&] { held.borrowed.attr("writeText")(py::str("x")); });
            return {};
        };
        REQUIRE_NO_ERROR(callPython(afterEnd));

        CHECK(pipeIdFailure.find("pipeline has ended") != std::string::npos);
        CHECK(listenerFailure.find("pipeline has ended") != std::string::npos);
        CHECK(pipeHandleFailure.find("pipeline has ended") !=
              std::string::npos);
        CHECK(links.next.find("pipeline has ended") != std::string::npos);
        CHECK(links.currentObject.find("pipeline has ended") !=
              std::string::npos);
        CHECK(links.controllerIds.find("pipeline has ended") !=
              std::string::npos);
        CHECK(getPipeFailure.find("is not open") != std::string::npos);
        CHECK(borrowedFailure.find("pipeline has ended") != std::string::npos);

        // Giving the borrowed pipe back after the end returns without raising
        CHECK(putPipeFailure.empty());

        // Node code that catches the refusal sees Ec.PipelineEnded and its
        // text
        INFO("exc.code: " << refusal.code << ", str(exc): " << refusal.text);
        CHECK(refusal.codeMatches);
        CHECK(refusal.textMatches);
    }

    //-----------------------------------------------------------------
    // A handle whose filter is still alive, but whose node has ended,
    // reads pyInstance as None: the node's object is gone. A call through
    // it is refused by the closed gate, with the same code and text node
    // code sees when the filter is gone; so are the reads of next and
    // currentObject and a getControllerNodeIds call.
    //-----------------------------------------------------------------
    SECTION("pyInstance of an ended node is None") {
        // Held across the end, as a call still in flight would hold it
        ServiceInstance node;
        bool objectBefore = false;
        {
            auto opened = filter.openObject("x.txt"_tv, Entry::FLAGS::INDEX);
            REQUIRE_NO_ERROR(opened);
            ServicePipe pipe = *opened;
            node = pipe->pDown;
            auto *pyNode =
                _dynCast<pythonBase::IPythonInstanceBase *>(node.get());
            REQUIRE(pyNode);

            const auto reach = localfcn()->Error {
                held.node = pyNode->getPythonInstance().attr("instance");
                objectBefore = !held.node.attr("pyInstance").is_none();
                return {};
            };
            REQUIRE_NO_ERROR(callPython(reach));
            REQUIRE_NO_ERROR(filter.closeObject(pipe));
        }
        REQUIRE_NO_ERROR(filter.disconnect());
        REQUIRE(objectBefore);

        std::string failure;
        bool isNone = false;
        invoke_teardown::NodeRefusal refusal;
        invoke_teardown::LinkReads links;
        const auto afterEnd = localfcn()->Error {
            failure = pythonFailure([&] {
                isNone = held.node.attr("pyInstance").is_none();
            });
            refusal = invoke_teardown::refusedWrite(held.node);
            links = invoke_teardown::readLinks(held.node);
            return {};
        };
        REQUIRE_NO_ERROR(callPython(afterEnd));
        CHECK(failure.empty());
        REQUIRE(isNone);
        CHECK(links.next.find("pipeline has ended") != std::string::npos);
        CHECK(links.currentObject.find("pipeline has ended") !=
              std::string::npos);
        CHECK(links.controllerIds.find("pipeline has ended") !=
              std::string::npos);

        INFO("exc.code: " << refusal.code << ", str(exc): " << refusal.text);
        CHECK(refusal.codeMatches);
        CHECK(refusal.textMatches);
        REQUIRE(node->callsInFlight() == 0);
    }

    //-----------------------------------------------------------------
    // A node whose endInstance raises is still ended: the end reports the
    // raise, and a later engine entry into the node (a late text write) is
    // refused without entering the node's object.
    //-----------------------------------------------------------------
    SECTION("a node whose endInstance raises is still ended") {
        // Restores the node class last, after the node below is gone
        invoke_teardown::RaisingEnd raising;

        // Held across the end, as a call still in flight would hold it
        ServiceInstance node;
        {
            auto opened = filter.openObject("x.txt"_tv, Entry::FLAGS::INDEX);
            REQUIRE_NO_ERROR(opened);
            ServicePipe first = *opened;
            auto *pyFirst =
                _dynCast<pythonBase::IPythonInstanceBase *>(first->pDown.get());
            REQUIRE(pyFirst);
            REQUIRE_NO_ERROR(raising.patch(*pyFirst));

            // The first pipe is busy, so this builds a second node, from
            // the patched class
            auto second = filter.getPipe();
            REQUIRE_NO_ERROR(second);
            node = (*second)->pDown;
            auto *pyNode =
                _dynCast<pythonBase::IPythonInstanceBase *>(node.get());
            REQUIRE(pyNode);
            REQUIRE_NO_ERROR(raising.countEntries(*pyNode));

            REQUIRE_NO_ERROR(filter.putPipe(*second));
            REQUIRE_NO_ERROR(filter.closeObject(first));
        }

        const auto ended = filter.disconnect();
        CHECK(ended.message().contains("endInstance fails here"));

        const Utf16Chr text[] = {Utf16Chr('x')};
        const auto late = node->writeText(Utf16View{text, 1});
        REQUIRE_ERROR(late, Ec::PipelineEnded, PipelineEndedMessage);
        REQUIRE(raising.entries() == 0);
    }
}
