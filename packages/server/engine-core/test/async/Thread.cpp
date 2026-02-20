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

TEST_CASE("async::Thread") {
    Thread thread(_location, "A Thread!");
    REQUIRE(thread.cancelled() == false);
    REQUIRE(thread.running() == false);
    REQUIRE(thread.join() == Error{});
    REQUIRE(thread.stop() == Error{});
    REQUIRE(thread.name() == "A Thread!");
    REQUIRE(thread.cancelled() == true);
    REQUIRE(_ts(thread).endsWith("A Thread!"));

    thread.start([&] {
        while (!cancelled()) sleep(.1s);
    });

    REQUIRE(thread.running() == true);
    REQUIRE(!thread.stop());
    REQUIRE(thread.running() == false);

    SECTION("Error propagation") {
        SUBSECTION("Callback returns void") {
            // Base case
            thread.start([]() noexcept { ; });
            REQUIRE_NOTHROW(*thread.join());

            // Callback throws
            thread.start([]() { APERR_THROW(Ec::Unexpected); });
            REQUIRE(thread.join() == Ec::Unexpected);
        }

        SUBSECTION("Callback returns Error") {
            // Base case
            thread.start([]() noexcept -> Error { return {}; });
            REQUIRE_NOTHROW(*thread.join());

            // Callback returns Error
            thread.start(
                []() noexcept -> Error { return APERR(Ec::Unexpected); });
            REQUIRE(thread.join() == Ec::Unexpected);

            // Callback throws
            thread.start([]() -> Error { APERR_THROW(Ec::Unexpected); });
            REQUIRE(thread.join() == Ec::Unexpected);
        }

#if 0
		SUBSECTION("Callback returns ErrorOr") {
			// Base case
			thread.start([]() noexcept -> ErrorOr<int> { return 0; });
			REQUIRE_NOTHROW(*thread.join());

			// Callback returns Error
			thread.start([]() noexcept -> ErrorOr<int> { return APERR(Ec::Unexpected); });
			REQUIRE(thread.join() == Ec::Unexpected);

			// Callback throws
			thread.start([]() -> ErrorOr<int> { APERR_THROW(Ec::Unexpected); });
			REQUIRE(thread.join() == Ec::Unexpected);
		}
#endif
    }
}
