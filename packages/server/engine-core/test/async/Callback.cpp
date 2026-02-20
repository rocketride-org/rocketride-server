// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

#include "test.h"

using namespace async;

TEST_CASE("async::Callback") {
    SECTION("basic") {
        Callback callback([&](Text val) { REQUIRE(val == "bobo"); }, "bobo");

        callback.invoke(_location);
    }

    SECTION("basic2") {
        auto callback = Callback::makeCopy(
            [&](Text val, int henry) {
                REQUIRE(val == "bobo");
                REQUIRE(henry == 5);
            },
            "bobo", 5);

        callback.invoke(_location);
    }

    SECTION("Basic3") {
        auto called = true;
        Callback callback([&]() { called = true; });

        callback.invoke(_location);
    }

    SECTION("InvokerNonVoidReturn") {
        auto invoker =
            Callback::allocateInvoker([&]() -> Text { return "hello"; });
        invoker->invoke(_location);
        REQUIRE(std::any_cast<Text>(invoker->m_result) == "hello");
    }

    SECTION("InvokerVoidReturn") {
        bool called = false;
        auto cb = [&]() { called = true; };

        auto invoker = Callback::allocateInvoker(cb);

        invoker->invoke(_location);
        REQUIRE(called == true);
    }

    SECTION("InvokerVoidReturnWithArgs") {
        bool called = false;
        auto cb = [&](const Text &question) {
            REQUIRE(question == "huh?");
            called = true;
        };

        auto invoker = Callback::allocateInvoker(cb, "huh?");

        invoker->invoke(_location);
        REQUIRE(called == true);
    }

    SECTION("InvokerNonVoidReturnWithArgs") {
        auto cb = [](const Text &question) -> Text {
            if (question == "huh?")
                return "what?";
            else
                return "no idea";
        };

        auto invoker = Callback::allocateInvoker(cb, "huh?");

        invoker->invoke(_location);
        REQUIRE(std::any_cast<Text>(invoker->m_result) == "what?");

        auto invoker2 = Callback::allocateInvoker(cb, "");

        invoker2->invoke(_location);
        REQUIRE(std::any_cast<Text>(invoker2->m_result) == "no idea");
    }

    SECTION("CopiedArgs") {
        auto cb = [](const Text &question) { REQUIRE(question == "huh?"); };

        Callback::InvokerPtr invoker;
        {
            Text question = "huh?";
            invoker = Callback::allocateInvoker_CopyArgs(cb, question);
        }

        invoker->invoke(_location);
    }

    SECTION("NoThrow") {
        auto cb = [](const Text &question) {
            throw std::runtime_error("Oops");
        };

        Callback::InvokerPtr invoker;
        {
            Text question = "huh?";
            invoker = Callback::allocateInvoker_CopyArgs(cb, question);
        }

        auto e = invoker->invoke(_location);
        REQUIRE(e);
    }
}
