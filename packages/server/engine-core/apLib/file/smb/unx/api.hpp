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

#pragma once

namespace ap::file::smb {

inline Error init(const Text &username, const Text &password) noexcept {
    return client().init(username, password);
}

inline ErrorOr<std::vector<MountCtx>> mount(const Share &share) noexcept {
    if (!share) return APERRL(Smb, Ec::InvalidParam, "Invalid share", share);
    return client().mount(share);
}

inline ErrorOr<std::vector<Text>> enumShares(
    const Share &share, TextView originalShareName) noexcept {
    if (!share) return APERRL(Smb, Ec::InvalidParam, "Invalid share", share);
    return client().enumShares(share, originalShareName);
}

}  // namespace ap::file::smb
