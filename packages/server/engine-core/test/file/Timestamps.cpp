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

using namespace ap;

TEST_CASE("file::Timestamps") {
    const auto tmpFilePath = test::testPath() / "timestamp_tmp.txt";

    SECTION("Creation Time") {
        auto beforeCreateTime = time::nowSystem();

        // Delete tmp file if exists
        if (file::exists(tmpFilePath)) {
            REQUIRE_FALSE(file::remove(tmpFilePath));
        }

        // Create temporary file
        file::put(tmpFilePath, "Hello world"_tv);

        auto info = file::stat(tmpFilePath);

        REQUIRE(info);

        auto createTime = info->createTime;

        auto afterCreateTime = time::nowSystem();

        std::time_t t_beforeCreateTime =
            std::chrono::system_clock::to_time_t(beforeCreateTime);
        std::time_t t_afterCreateTime =
            std::chrono::system_clock::to_time_t(afterCreateTime);
        std::time_t t_createTime =
            std::chrono::system_clock::to_time_t(createTime);
        std::time_t t_modifyTime =
            std::chrono::system_clock::to_time_t(info->modifyTime);
        std::time_t t_accessTime =
            std::chrono::system_clock::to_time_t(info->accessTime);

        REQUIRE(t_beforeCreateTime <= t_createTime);

        REQUIRE(t_afterCreateTime >= t_createTime);

        REQUIRE(t_modifyTime == t_createTime);

        REQUIRE(t_accessTime == t_createTime);

#ifdef ROCKETRIDE_PLAT_UNX
#ifndef ROCKETRIDE_PLAT_MAC
        REQUIRE(info->createTime == info->changeTime);
#endif
#endif
    }

    SECTION("Modify & Access Time") {
        auto info = file::stat(tmpFilePath);

        REQUIRE(info);

        auto createTime = info->createTime;

        // Sleep for 2 seconds
        async::sleep(2100ms);

        // Update temporary file
        file::put(tmpFilePath, "Hello world x2"_tv);

        info = file::stat(tmpFilePath);

        REQUIRE(info);

        REQUIRE(info->createTime == createTime);

        // Modify time should be greater than the creation time
        REQUIRE(info->createTime < info->modifyTime);

        // Access time could stay the same or be greater than creation time
        REQUIRE(info->accessTime >= info->createTime);

        // Change time is updated along modify time
#if ROCKETRIDE_PLAT_UNX
        REQUIRE(info->modifyTime == info->changeTime);
#endif
    }
}
