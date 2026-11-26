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

TEST_CASE("memory::toData") {
    SECTION("crypto::Sha512") {
        auto hash = crypto::Sha512::make("1234"_tv);

        auto data = *memory::toData(hash);
        REQUIRE(data.size() == crypto::Sha512Hash::DigestLen);

        auto hash2 = *memory::fromData<crypto::Sha512Hash>(data);
        REQUIRE(hash == hash2);
    }

    SECTION("int") {
        auto data = *memory::toData(4);
        REQUIRE(data.size() == sizeof(4));

        REQUIRE(*memory::fromData<decltype(4)>(data) == 4);
    }

    SECTION("Hex") {
        auto text{"abcdef0123456789"_tv};
        auto bin{crypto::hexDecode(text)};

        Buffer buffer(bin.size());
        for (size_t pos{}; pos < bin.size(); ++pos) {
            buffer[pos] = _cast<uint8_t>(bin[pos]);
        }

        auto data = buffer.toView();
        LOG(Test, "Checking if '{}' decodes to '{}'", text, data);

        REQUIRE(data.size() == text.length() / 2);
        REQUIRE(data.at(0) == 0xab);
        REQUIRE(data.at(1) == 0xcd);
        REQUIRE(data.at(2) == 0xef);
        REQUIRE(data.at(3) == 0x01);
        REQUIRE(data.at(4) == 0x23);
        REQUIRE(data.at(5) == 0x45);
        REQUIRE(data.at(6) == 0x67);
        REQUIRE(data.at(7) == 0x89);
    }

    SECTION("Data") {
        Buffer data(5);
        data[0] = 'A';
        data[1] = 'B';
        data[2] = 'C';
        data[3] = 'D';
        data[4] = 'E';

        auto packed = *_td(data);
        auto unpacked = *_fd<decltype(data)>(packed);
        LOG(Test, "Checking if '{}' == '{}'", unpacked, data);
        REQUIRE(unpacked == data);
    }

    auto checkPack = [&](auto cnt) {
        if constexpr (traits::IsContainerV<decltype(cnt)>) {
            auto packed = *_td(cnt);
            auto rawSize = sizeof(traits::ValueT<decltype(cnt)>) * cnt.size();

            LOG(Test, "Data {}", packed);
            LOG(Test, "Raw size {,s}", rawSize);
            LOG(Test, "Packed size {,s}", packed.size());
            LOG(Test, "Pack overhead {,s}", packed.size() - rawSize);

            auto cnt2 = *_fd<decltype(cnt)>(packed);

            REQUIRE(cnt == cnt2);
        } else {
            auto packed = *_td(cnt);
            auto rawSize = sizeof(cnt);

            LOG(Test, "Data {}", packed);
            LOG(Test, "Raw size {,s}", rawSize);
            if constexpr (traits::IsPodV<decltype(cnt)>) {
                LOG(Test, "Packed size {,s}", packed.size());
                if (packed.size() > rawSize)
                    LOG(Test, "Pack overhead {,s}", packed.size() - rawSize);
            }

            auto cnt2 = *_fd<decltype(cnt)>(packed);

            REQUIRE(cnt == cnt2);
        }
    };

    SECTION("Text") {
        Text cnt = "Hi there! Whats up??";
        checkPack(cnt);
    }

#if ROCKETRIDE_PLAT_WIN
    SECTION("Utf16") {
        Utf16 cnt = L"Hi there! Whats up??";
        checkPack(cnt);
    }
#endif

    SECTION("time::SystemStamp") {
        auto stamp = time::nowSystem();
        checkPack(stamp);
    }

    SECTION("file::Path") {
        auto path = application::execPath();
        checkPack(path);
    }

    SECTION("PodVector") {
        std::vector<int> cnt = {1, 2, 3};
        checkPack(cnt);
    }

    SECTION("PodSet") {
        std::set<int> cnt = {1, 2, 3};
        checkPack(cnt);
    }

    SECTION("PodUnorderedSet") {
        std::unordered_set<int> cnt = {1, 2, 3, 4};
        checkPack(cnt);
    }

    SECTION("PodList") {
        std::list<int> cnt = {1, 2, 3};
        checkPack(cnt);
    }

    SECTION("PodFlatMap") {
        FlatMap<int, int> cnt = {{1, 2}, {3, 4}};
        checkPack(cnt);
        checkPack(cnt.container);
    }

    SECTION("PodFlatSet") {
        FlatSet<int> cnt = {1, 2, 3};
        checkPack(cnt);
        checkPack(cnt.container);
    }

    SECTION("PodMap") {
        std::map<int, int> cnt = {{1, 2}, {3, 4}};
        checkPack(cnt);
    }

    SECTION("PodUnorderedMap") {
        std::unordered_map<int, int> cnt = {{1, 2}, {3, 4}};
        checkPack(cnt);
    }

#if 0
	// Pack tags have changed and we haven't re-built on linux in a while so disable these for now
	SECTION("VectorFromFile - Linux") {
		auto path = testPath("linvector_1000_incrementing_ints.dat");
		auto cnt = *file::fetchFromData<std::vector<int>>(path);
		REQUIRE(cnt.size() == 1'000);
		for (auto i = 0; i < 1'000; i++)
			REQUIRE(cnt[i] == i);
	}

	SECTION("VectorFromFile - Windows") {
		auto path = testPath("winvector_1000_incrementing_ints.dat");
		auto cnt = *file::fetchFromData<std::vector<int>>(path);
		REQUIRE(cnt.size() == 1'000);
		for (auto i = 0; i < 1'000; i++)
			REQUIRE(cnt[i] == i);
	}
#endif
}
