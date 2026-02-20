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

template <typename KeyT>
struct StatefulCollator {
    using KeyType = KeyT;

    StatefulCollator(bool mode) : m_mode(mode) {}

    bool operator()(const KeyType& l, const KeyType& r) const {
        if (m_mode)
            return l < r;
        else
            return l > r;
    }

    bool m_mode;
};

template <typename KeyT>
struct StatelessCollator {
    using KeyType = KeyT;

    bool operator()(const KeyType& l, const KeyType& r) const { return l < r; }
};

TEST_CASE("util::flat") {
    SECTION("FlatMap") {
        SECTION("Stateful Custom Collator") {
            FlatMap<uint32_t, uint32_t, StatefulCollator<uint32_t>> mapFalse(
                false, ::fc::container_construct_t{}),
                mapTrue(true, ::fc::container_construct_t{});

            mapFalse[0] = 1;
            mapFalse[1] = 2;

            mapTrue[0] = 1;
            mapTrue[1] = 2;
        }

        SECTION("Stateless Custom Collator") {
            FlatMap<uint32_t, uint32_t, StatelessCollator<uint32_t>> mapFalse,
                mapTrue;

            mapFalse[0] = 1;
            mapFalse[1] = 2;

            mapTrue[0] = 1;
            mapTrue[1] = 2;
        }
    }

    SECTION("FlatMultiMap") {
        SECTION("NoCase collation") {
            FlatMultiMap<iText, uint32_t> multiMap;

            std::vector<Pair<iText, uint32_t>> expected = {
                {"Hi", 1}, {"HI", 1}, {"hI", 1}, {"hi", 1},
                {"Yo", 2}, {"YO", 2}, {"yO", 2}, {"yo", 2}};

            std::shuffle(expected.begin(), expected.end(),
                         crypto::randomGenerator());

            for (auto& [word, id] : expected) multiMap.emplace(word, id);

            ASSERTD(multiMap.size() == 8);

            auto index = 0;
            for (auto [word, id] : multiMap) {
                if (word == "hi")
                    ASSERTD(id == 1);
                else
                    ASSERTD(word == "yo" && id == 2);
                index++;
            }
            ASSERTD(index == expected.size());

            {
                index = 0;
                auto [start, end] = multiMap.equal_range("hi");
                for (auto iter = start; iter != end; iter++) {
                    ASSERTD(iter->first == "hi");
                    ASSERTD(iter->second == 1);
                    index++;
                }
                ASSERTD(index == 4);
            }

            {
                index = 0;
                auto [start, end] = multiMap.equal_range("yo");
                for (auto iter = start; iter != end; iter++) {
                    ASSERTD(iter->first == "yo");
                    ASSERTD(iter->second == 2);
                    index++;
                }
                ASSERTD(index == 4);
            }
        }
    }
}
