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

TEST_CASE("crypto::Hash") {
    _const auto Data = "1234456789"_tv;
    _const auto ExpectedSha512Hash =
        "3f24aae825311e787c1be7071a0cf6d2bacfa685fef4a129b14e22066b8675ddb1ff34bb73d7b1a832850bd05cc592e03427f31c57596e108e9fe7a5d06bedc1"_tv;
    _const auto ExpectedSha224Hash =
        "41284b7c42c8037cbf86b185559b878a9682bf943aca55125d9378b8"_tv;
    _const auto ExpectedSha384Hash =
        "69d52b3d5fa87f8fc3ccef73c394a80949e54f21e0978108a872550abe11b04c28280ecaafed9932151d00cfb2dc04c3"_tv;

    SECTION("Sha512") {
        auto hash = crypto::Sha512::make(Data);
        auto str = _ts(hash);
        LOG(Test, str);
        REQUIRE(str == ExpectedSha512Hash);

        auto hash2 = _fs<crypto::Sha512Hash>(str);
        REQUIRE(hash2 == hash);
    }

    SECTION("Sha512File") {
        auto path = testPath() / "file.txt";
        file::put(path, Data);
        file::FileStream stream(path, file::Mode::READ);

        auto logScope = enableTestLogging(Lvl::FileStream);

        // Memory map mode
        {
            LOG(Test, "Mapped mode");
            auto data = stream.mmap();
            LOG(Test, "1");
            auto hash = crypto::Sha512::make(*data);
            LOG(Test, "2");
            auto str = _ts(hash);
            LOG(Test, "3");
            REQUIRE(str == ExpectedSha512Hash);

            LOG(Test, "4");
            auto hash2 = _fs<crypto::Sha512Hash>(str);
            LOG(Test, "5");
            REQUIRE(hash2 == hash);
        }

        // Input adapter mode
        {
            LOG(Test, "Adapter mode");
            auto hash =
                crypto::Sha512::make(memory::adapter::makeInput(stream));
            auto str = _ts(hash);
            REQUIRE(str == ExpectedSha512Hash);

            auto hash2 = _fs<crypto::Sha512Hash>(str);
            REQUIRE(hash2 == hash);
        }
    }

    SECTION("SHA3-224") {
        auto hash = crypto::Sha224::make(Data);
        auto str = _ts(hash);
        LOG(Test, str);
        REQUIRE(str == ExpectedSha224Hash);

        auto hash2 = _fs<crypto::Sha224Hash>(str);
        REQUIRE(hash2 == hash);
    }

    SECTION("SHA3-384") {
        auto hash = crypto::Sha384::make(Data);
        auto str = _ts(hash);
        LOG(Test, str);
        REQUIRE(str == ExpectedSha384Hash);

        auto hash2 = _fs<crypto::Sha384Hash>(str);
        REQUIRE(hash2 == hash);
    }
}
