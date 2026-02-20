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

#pragma once

namespace ap::crypto {

// Creates the random generator, this is a separate template so we only
// instantiate it once per thread (not once per thread, per integer type), as
// the construction costs of these is high, and they consume ~5KB on the stack.
inline auto& randomGenerator() noexcept {
    _thread_local async::Tls<std::mt19937> g(_location, std::random_device{}());
    return *g;
}

// Generate a random number from min to max
// used mainly for testing
template <typename IntegerType = uint32_t>
inline IntegerType randomNumber(
    IntegerType start = MinValue<IntegerType>,
    IntegerType end = MaxValue<IntegerType>) noexcept {
    if constexpr (sizeof(IntegerType) == sizeof(uint8_t)) {
        std::uniform_int_distribution<int16_t> d(start, end);
        return _cast<IntegerType>(d(randomGenerator()));
    } else {
        std::uniform_int_distribution<IntegerType> d(start, end);
        return d(randomGenerator());
    }
}

// Generate given number of random bytes using OpenSSL
inline ErrorOr<Buffer> randomBytes(size_t length) noexcept {
    Buffer bytes(length);
    if (!RAND_bytes(bytes, _nc<int>(length)))
        return APERRL(Crypto, Ec::Cipher, "Unable to generate random bytes",
                      ERR_reason_error_string(ERR_get_error()));
    return bytes;
}

}  // namespace ap::crypto
