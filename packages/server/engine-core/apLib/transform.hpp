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

//
//	RocketRide transformation api implementation
//
#pragma once

namespace ap {

// Transform uses an ADL (argument dependent lookup) to allow for
// global __transform methods to be defined and called for
// arbitrary type conversions
template <typename TargetType, typename SourceType, typename... Args>
inline TargetType transform(SourceType &&source, Args &&...args) noexcept {
    static_assert(std::is_default_constructible_v<std::decay_t<TargetType>>,
                  "Targets for transformations must be default constructible");

    try {
        TargetType target;

        if constexpr (traits::IsSameTypeV<TargetType, SourceType>)
            target = std::forward<SourceType>(source);
        else if constexpr (sizeof...(args) > 0)
            __transform(target, std::forward<SourceType>(source),
                        std::forward<Args>(args)...);
        else
            __transform(std::forward<SourceType>(source), target);
        return target;
    } catch (const std::exception &e) {
        dev::fatality(_location, "Failed to transform",
                      _tso(Format::RTTIOK, args...), "to",
                      util::typeName(source), e);
    }
}

}  // namespace ap
