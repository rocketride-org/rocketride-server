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

#include "test.h"

TEST_CASE("file::snap") {
#if 0
	SECTION("create") {
		for (auto persist : {true, false}) {
			// Make a file to snapshot
			auto test = testPath() / "test_file.txt";
			REQUIRE(!file::put(test, "Hi there!"_tv));

			// Snapshot just the volume we're running on
			auto logScope = enableTestLogging(Lvl::Snap);
			auto ctx = file::snap::create({ test }, persist);
			if (!ctx && ctx.ccode() == Ec::NotSupported) {
				REQUIRE(!plat::IsWindows);
				LOG(Test, "Skipping test, snapshots not supported on target platform");
				return;
			}
			LOG(Test, "Context", ctx);

			REQUIRE(plat::IsWindows);

			REQUIRE(ctx);
			REQUIRE(ctx->snaps.size() == 1);

			// Now map our path and try to read the file
			auto mapped = file::snap::map(*ctx, test);
			auto test2 = file::snap::map(*ctx, mapped);
			REQUIRE(mapped != test2);
			REQUIRE(mapped != test);
			REQUIRE(*file::fetch<TextChr>(mapped) == "Hi there!"_tv);

			// We should delete if the context was not deleted
			ctx.reset();
			REQUIRE(!file::fetch<TextChr>(mapped));
		}
	}

	SECTION("list") {
		auto ctx = file::snap::create({testPath()}, false);
		if (!ctx && ctx.ccode() == Ec::NotSupported) {
			REQUIRE(!plat::IsWindows);
			LOG(Test, "Skipping test, snapshots not supported on target platform");
			return;
		}

		auto listed = file::snap::list(false);

		LOG(Test, "Listed:", listed);
		LOG(Test, "Checking for:", *ctx->snaps.begin());

		REQUIRE(_findIf(listed->snaps, *ctx->snaps.begin()) != listed->snaps.end());

		// Now since it was a temp snapshot destroy the context and it should go
		// away, we should not find it in the list 
		auto missingSnap = *ctx->snaps.begin();
		ctx.reset();

		listed = file::snap::list(false);

		LOG(Test, "Listed:", listed);
		LOG(Test, "Checking for:", missingSnap);
		REQUIRE(_findIf(listed->snaps, missingSnap) == listed->snaps.end());
	}

	SECTION("json/detach/destroy") {
		// Make a file to snapshot
		auto test = testPath() / "test_file.txt";
		REQUIRE(!file::put(test, "Hi there!"_tv));

		// Snapshot just the volume we're running on
		auto logScope = enableTestLogging(Lvl::Snap);
		auto ctx = file::snap::create({ test }, true);
		if (!ctx && ctx.ccode() == Ec::NotImplemented) {
			REQUIRE(!plat::IsWindows);
			LOG(Test, "Skipping test, snapshots not supported on target platform");
			return;
		}

		// Now map our path and try to read the file
		auto mapped = file::snap::map(*ctx, test);
		auto test2 = file::snap::map(*ctx, mapped);
		REQUIRE(mapped != test);
		REQUIRE(test2 != mapped);
		REQUIRE(*file::fetch<TextChr>(mapped) == "Hi there!"_tv);

		// Export it as a json value so we can test importing it
		auto val = _tj(*ctx);
		LOG(Test, "Json context", val);

		// Detach the persistent snapshot, it will remain
		file::snap::detach(*ctx);
		REQUIRE(*file::fetch<TextChr>(mapped) == "Hi there!"_tv);

		// Now resetting the context will not delete the snapshots
		// as we detached it
		ctx.reset();
		REQUIRE(*file::fetch<TextChr>(mapped) == "Hi there!"_tv);

		for (auto destroy : {false, true}) {
			// Marshal from json and re-test the map
			ctx = _fj<file::snap::Context>(val);
			auto mapped3 = file::snap::map(*ctx, test);
			REQUIRE(mapped3 != test);
			auto res = file::snap::map(*ctx, mapped3);
			REQUIRE(res == test);

			// If we are to destroy it and verify its gone
			if (destroy) {
				REQUIRE(!file::snap::destroy(*ctx));
				REQUIRE(!file::fetch<TextChr>(mapped));
			}
			else {
				// Ensure a un-marshaled context doesn't destroy the
				// snapshots when it destructs
				ctx.reset();
				REQUIRE(*file::fetch<TextChr>(mapped) == "Hi there!"_tv);
			}
		}
	}
#endif
}
