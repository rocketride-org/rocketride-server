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

// Context for iteratively decrypting data
class DecryptCtx : public CipherCtx {
public:
    using Parent = CipherCtx;

    DecryptCtx(const Key &key, InputData iv) noexcept(false)
        : Parent(key, iv, false) {}

    Error reset() noexcept override;
    using Parent::update;
    Error update(size_t inlen, const uint8_t *in, size_t *outlen,
                 uint8_t *out) noexcept override;
    using Parent::finalize;
    Error finalize(size_t *outlen, uint8_t *out) noexcept override;

    // Fully decrypt a single buffer; will reset, update, then finalize
    Error decrypt(size_t ulen, const uint8_t *u, size_t *rlen,
                  uint8_t *r) noexcept;
    ErrorOr<OutputData> decrypt(InputData in, OutputData out) noexcept;
    ErrorOr<Buffer> decrypt(InputData in, size_t outLength) noexcept;
};

}  // namespace ap::crypto