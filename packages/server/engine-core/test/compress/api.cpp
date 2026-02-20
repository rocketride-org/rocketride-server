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

TEST_CASE("compress::api") {
    SECTION("Lz4") {
        using namespace compress;

        REQUIRE(_ts(Type::LZ4) == "LZ4");
        REQUIRE(_fs<Type>("LZ4") == Type::LZ4);
        REQUIRE(_fs<Type>("lz4") == Type::LZ4);

        auto validate = [&](const auto& value) {
            Buffer compData;
            auto len = *deflate<Type::LZ4>(value, compData);
            LOG(Test, "Compressed {,s} to {,s} ", len, compData.size());

            Buffer decompData;
            decompData.resize(len);
            *inflate<Type::LZ4>(compData, decompData);

            REQUIRE(memory::viewCast(value) == decompData);
        };

        SECTION("Text-LZ4") { validate("HHHHHHHHHHHHHHHHHHHHHHHHHH"_t); }

        SECTION("Vector-LZ4") {
            std::vector<int> vals;
            for (auto i : util::makeRange<0, 10000>()) vals.push_back(i);
            validate(vals);
        }
    }

    SECTION("Uint32") {
        auto validate = [&](const auto& value) {
            using namespace compress;

            Buffer compData;
            auto start = time::now();
            auto len = *deflate<Type::UINT32>(value, compData);
            LOG(Test, "Compressed {,s} to {,s} in {}", len * sizeof(uint32_t),
                compData.size(), time::now() - start);

            memory::Data<uint32_t> decompData;
            decompData.resize(len);
            start = time::now();
            *inflate<Type::UINT32>(compData, decompData);
            LOG(Test, "Decompressed in {}", time::now() - start);

            auto res = memory::viewCast<uint32_t>(value) == decompData;
            if (!res) {
                LOG(Test, "Failed to validate {} == {}",
                    memory::viewCast<uint32_t>(value).size(),
                    decompData.size());
                REQUIRE(res);
            }
        };
    }

    SECTION("FastPFor") {
        auto validate = [&](const auto& value) {
            using namespace compress;

            memory::Data<uint32_t> compData;
            auto start = time::now();
            auto len = *deflate<Type::FASTPFOR>(value, compData);
            LOG(Test, "Compressed {,s} to {,s} in {}", len * sizeof(uint32_t),
                compData.size() * sizeof(uint32_t), time::now() - start);

            std::vector<uint32_t> decompData;
            decompData.resize(len);
            start = time::now();
            *inflate<Type::FASTPFOR>(compData, decompData);
            LOG(Test, "Decompressed in {}", time::now() - start);

            auto res = value == decompData;
            if (!res) {
                LOG(Test, "Failed to validate");
                REQUIRE(res);
            }
        };

        SECTION("SmallVector-FastPFor") {
            std::vector<uint32_t> vals;
            vals.reserve(1);
            for (auto i = 0; i < 1; i++) vals.push_back(i);
            validate(vals);
        }
    }
}
