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
Array<uint64_t, 2> hash(const T &item) noexcept {
    auto data = memory::viewCast(item);
    Array<uint64_t, 2> hashValue;
    MurmurHash3_x64_128(data, _nc<int>(data.size()), 0, hashValue.data());
    return hashValue;
}

uint64_t nthHash(uint8_t n, uint64_t hashA, uint64_t hashB,
                 uint64_t filterSize) noexcept {
    return (hashA + n * hashB) % filterSize;
}

struct BloomFilter {
    BloomFilter(uint64_t size, uint8_t numHashes) noexcept
        : m_bits(size), m_numHashes(numHashes) {}

    template <typename T>
    void add(const T &item) noexcept {
        auto data = memory::viewCast(item);
        auto hashValues = hash(data);

        for (uint8_t n = 0; n < m_numHashes; n++) {
            m_bits[nthHash(n, hashValues[0], hashValues[1], m_bits.size())] =
                true;
        }
    }

    template <typename T>
    bool possiblyContains(const T &item) const noexcept {
        auto data = memory::viewCast(item);
        auto hashValues = hash(data);

        for (uint8_t n = 0; n < m_numHashes; n++) {
            if (!m_bits[nthHash(n, hashValues[0], hashValues[1],
                                m_bits.size())]) {
                return false;
            }
        }

        return true;
    }

private:
    uint8_t m_numHashes;
    std::vector<bool> m_bits;
};

TEST_CASE("util::BloomFilter") {
    BloomFilter filter(1'000, 13);

    // Add every even number
    auto added = 0;
    for (auto i = 0; i < 1'000; i++) {
        if (!(i % 2)) {
            filter.add(i);
            added++;
        }
    }

    // Verify now that all the events possibly exist and all the ods definitely
    // don't exist
    auto possible = 0, notPossible = 0, errors = 0;
    for (auto i = 0; i < 1'000; i++) {
        auto possiblyContains = false;
        if (!(i % 2))
            possiblyContains = filter.possiblyContains(i);
        else
            possiblyContains = filter.possiblyContains(i);
        if (possiblyContains)
            possible++;
        else {
            notPossible++;
            if (!(i % 2)) {
                LOG(Test, "Filter incorrectly says {} is not possible...", i);
                errors++;
            }
        }
    }

    LOG(Test, "Possible: {,c} Not possible: {,c} Added: {,c} Errors: {,c}",
        possible, notPossible, added, errors);
}
