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

#include <engLib/eng.h>

namespace engine::stream {
//-------------------------------------------------------------------------
/// @details
///		Open a local stream on disk
/// @param[in]	path
///		Path represents either a local path
///	@param[in]	mode
///		The open mode
//-------------------------------------------------------------------------
ErrorOr<StreamPtr> makeStream(const Url &url) noexcept {
    // Create the stream
    auto stream = Factory::make<iStream>(_location, url);
    if (!stream) return stream.ccode();

    // Convert to a shared ptr
    StreamPtr shared = _mv(*stream);

    // And return it
    return shared;
}

//-------------------------------------------------------------------------
/// @details
///		Open a url based stream - could be datafile or datanet
/// @param[in]	url
///		The full url to open
///	@param[in]	mode
///		The open mode
//-------------------------------------------------------------------------
ErrorOr<StreamPtr> openStream(const Url &url, stream::Mode mode) noexcept {
    auto openStream = localfcn()->ErrorOr<StreamPtr> {
        const auto stream = makeStream(url);
        if (!stream) return stream.ccode();

        if (auto ccode = stream->open(url, mode)) return ccode;

        return stream;
    };

    // This has a propensity to throw...
    ErrorOr<StreamPtr> res = _call(openStream);

    return res;
}

//-------------------------------------------------------------------------
/// @details
///		Open a url based buffered stream - could be datafile or datanet
/// @param[in]	url
///		The full url to open
///	@param[in]	mode
///		The open mode
//-------------------------------------------------------------------------
ErrorOr<StreamPtr> openBufferedStream(const Url &url,
                                      stream::Mode mode) noexcept {
    // Create the rawStream
    const auto rawStream = makeStream(url);
    if (!rawStream) return rawStream.ccode();

    // Get the stream ptr for it
    StreamPtr rawStreamPtr = _mv(*rawStream);

    // Attempt the open first
    if (auto ccode = rawStreamPtr->open(url, mode)) return ccode;

    // Wrap the stream in a buffered stream
    auto stream = makeShared<stream::BufferedStream>(
        rawStreamPtr,
        BufferedStream::Options{.bufferSize = 10_mb, .maxIoSize = 5_mb});

    // And return it
    return stream;
}
}  // namespace engine::stream
