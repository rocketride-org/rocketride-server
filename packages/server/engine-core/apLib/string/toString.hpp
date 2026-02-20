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

namespace ap::string {

namespace {

template <typename BufferType, typename... Args>
inline auto pack(BufferType& buffer, FormatOptions opts,
                 Args&&... args) noexcept
    -> traits::IfPackAdapter<BufferType, Error> {
    Error ccode;

    // If its empty and we're not allowed to resize it, we're done
    if (buffer.empty() && !buffer.IsResizeable) {
        ccode = {Ec::ResultBufferTooSmall, _location,
                 "Non resizeable empty buffer passed to toString"};
    } else {
        auto formatArg = [&](size_t index, const auto& arg) noexcept {
            // Render it to our result
            if ((index || opts.lead()) && opts.delimiter()) {
                // Don't append the delimiter if the last character is
                // some kind of control character (e.g. \n) or if its already
                // a delimiter, or color
                if (buffer.empty()) {
                    if (opts.lead()) buffer << opts.delimiter();
                } else if (!string::endsWithControlOrColor(buffer.toString()) &&
                           !string::isControl(arg) &&
                           (opts.doubleDelimOk() ||
                            buffer.back() != opts.delimiter()))
                    buffer << opts.delimiter();
            }

            ccode = internal::packSelector(arg, opts, buffer) || ccode;
        };

        size_t index = 0;
        (formatArg(index++, std::forward<Args>(args)), ...);

        if (index && opts.trail() && !buffer.empty() &&
            (opts.doubleDelimOk() || buffer.back() != opts.delimiter()) &&
            !string::endsWithControlOrColor(buffer.toString()))
            buffer << opts.delimiter();
    }

    // If the buffer capped the write, adjust the ccode to indicate it
    if (buffer.writeCapped() && !ccode && !opts.capOk())
        ccode = {
            Ec::ResultBufferTooSmall, _location,
            "Ran out of room writing to buffer of size:", Size(buffer.size())};

    // If we failed and nofail flag set, abort
    if (ccode && opts.noFail())
        ASSERTD_MSG(!ccode, "Failed to render with toString:", ccode);

    // Resize down if resize supported
    if (buffer.IsResizeable) buffer.resize(buffer.currentPos());

    return ccode;
}

template <typename BufferType, typename... Args>
inline auto pack(BufferType& _buffer, FormatOptions opts,
                 Args&&... args) noexcept
    -> traits::IfNotPackAdapter<BufferType, Error> {
    // Wrap the callers data buffer into an adapter
    auto startPos = CurOrBegPos;
    if (opts.append()) startPos = EndPos;

    auto buffer = PackAdapter{_buffer, startPos};
    return pack(buffer, opts, std::forward<Args>(args)...);
}

}  // namespace

// The primary gateway to all conversions to a string. This api
// dispatches its arguments to the string pack api that converts
// each type to a string.
template <typename BufferType, typename... Args>
inline Error toStringEx(BufferType& buffer, FormatOptions opts,
                        Args&&... args) noexcept {
    return pack(buffer, opts, std::forward<Args>(args)...);
}

}  // namespace ap::string
