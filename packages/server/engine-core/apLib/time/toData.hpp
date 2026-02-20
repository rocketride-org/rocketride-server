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

namespace std::chrono {

// Define the __toData/__fromData hooks in the same namespace as the type
// so adl lookup will work for our system stamp type
template <typename In>
inline void __fromData(time_point<system_clock>& stamp,
                       const In& in) noexcept(false) {
    uint64_t timeT;
    in.read({_reCast<uint8_t*>(&timeT), sizeof(timeT)});
    stamp =
        ::ap::time::fromTimeT<time_point<system_clock>>(_cast<time_t>(timeT));
}

template <typename Out>
inline void __toData(const time_point<system_clock>& stamp,
                     Out& out) noexcept(false) {
    auto timeT = _cast<uint64_t>(::ap::time::toTimeT(stamp));
    out.write({_reCast<const uint8_t*>(&timeT), sizeof(timeT)});
}

}  // namespace std::chrono