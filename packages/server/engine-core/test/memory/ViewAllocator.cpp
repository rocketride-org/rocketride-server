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

template <typename T>
using Allocator = memory::ViewAllocator<T>;

template <typename T>
using Arena = typename memory::ViewAllocatorArena;

TEST_CASE("memory::ViewAllocator") {
    SECTION("Basic") {
        std::array<char, 256> buff = {};
        Arena<char> arena{memory::viewCast(buff)};
        string::Str<char, string::Case<char>, Allocator<char>> str(arena);

        str = "1234567689abcdefjhijklmnop";

        REQUIRE(_searchIn(buff, str) != buff.end());

        // Now re-hydrate
        auto readOnlyData = memory::viewCast<const uint8_t>(buff);

        // Arena will be in read only mode, and re-hydration is implied
        Arena<char> readOnlyArena{readOnlyData};

        string::Str<char, string::Case<char>, Allocator<char>> str2(
            readOnlyArena);
        str2.resize(str.size());

        REQUIRE(str2 == str);
    }

    SECTION("FileStream - vector") {
        auto root = testPath();
        auto backingFile = root / "allocator.dat";

        auto arenaSize = 1_mb;
        auto elementCount = 64;
        using AllocatorType = Allocator<char>;
        using ArenaType = typename AllocatorType::ArenaType;

        size_t finalSize = {};

        {
            file::FileStream strm(backingFile, file::Mode::WRITE);

            auto data = *strm.mapOutputRange(0, arenaSize);
            ArenaType arena{data};

            std::vector<char, AllocatorType> vec{arena};

            vec.resize(elementCount);
            auto chr = 'a';
            for (auto i = 0; i < vec.size(); i++) vec[i] = chr++;

            finalSize = arena.used();

            LOG(Test, "Created memory backed vector of size {,c}", vec.size());
        }

        {
            file::FileStream strm(backingFile, file::Mode::READ);
            auto data = *strm.mapInputRange(0, arenaSize);

            ArenaType arena{data};
            std::vector<char, AllocatorType> vec{arena};
            vec.resize(elementCount);

            LOG(Test, "Loaded memory backed vector:", vec);

            auto chr = 'a';
            for (auto i = 0; i < vec.size(); i++) REQUIRE(vec[i] == chr++);
        }
    }

    SECTION("FileStream - FlatMap") {
        auto root = testPath();
        auto backingFile = root / "allocator.dat";

        auto arenaSize = 10_mb;

        struct Entry {
            std::array<char, 128> name = {};
        };

        using Key = size_t;

        using EntryType = Pair<Key, Entry>;

        using AllocatorType = Allocator<EntryType>;
        using ArenaType = typename AllocatorType::ArenaType;
        using BackingType = std::vector<EntryType, AllocatorType>;

        size_t finalSize = {};

        for (auto i = 0; i < 2; i++) {
            {
                file::FileStream strm(backingFile, file::Mode::WRITE);
                auto data = *strm.mapOutputRange(0, arenaSize);

                ArenaType arena{data};

                FlatMap<Key, Entry, std::less<void>, AllocatorType> set(
                    fc::container_construct_t{}, arena);

                util::Throughput rate;
                for (auto i = 0; i < 1000; i++) {
                    auto str = _ts("Index #", i);
                    _copyTo(set[i].name, str, str.size());
                    rate.report();
                }

                LOG(Test, "Created memory backed flat set with {,c} entries",
                    set.size(), rate.stats());
                finalSize = arena.used();
            }

            {
                file::FileStream strm(backingFile, file::Mode::READ);
                auto data = *strm.mapInputRange(0, arenaSize);
                ArenaType arena{data};

                FlatMap<Key, Entry, std::less<void>, AllocatorType> set(
                    fc::container_construct_t{}, AllocatorType{arena});

                set.container.resize(1000);

                util::Throughput rate;
                auto i = 0;
                for (auto& [k, s] : set) {
                    auto str = _ts("Index #", i++);
                    _equalTo(s.name, str, str.size());
                    rate.report();
                }

                rate.stop();

                LOG(Test, "Loaded memory backed flat set with {,c} entries",
                    set.size(), rate.stats());
            }
        }
    }
}
