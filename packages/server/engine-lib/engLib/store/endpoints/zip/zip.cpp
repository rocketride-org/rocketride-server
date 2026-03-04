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

//-----------------------------------------------------------------------------
//
//	Declares the object for working with Zip DataNet Stream "storage".
//
//-----------------------------------------------------------------------------
#include <engLib/eng.h>

namespace engine::store::filter::zip {
//-------------------------------------------------------------------------
/// @details
///		Begins operations on this filter
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterGlobal::beginFilterGlobal() noexcept {
    // Get the url target
    auto url = endpoint->config.serviceConfig["parameters"].lookup<Text>("url");

    // Build the url
    m_streamUrl = Url{url};

    // Make sure this is a substream driver
    uint32_t caps;
    if (auto ccode = Url::getCaps(m_streamUrl, caps)) return ccode;

    // Make sure it is a substreamable endpoint
    if (!(caps & Url::PROTOCOL_CAPS::SUBSTREAM))
        return APERR(Ec::InvalidParam,
                     "Zip format requires a substream endpoint");

    // Make the stream
    m_stream = stream::makeStream(m_streamUrl);
    if (!m_stream) return m_stream.ccode();

    // Open the stream (connects or opens the file)
    if (auto ccode = m_stream->open(m_streamUrl, stream::Mode::WRITE))
        return ccode;

    // Call our parent
    return Parent::beginFilterGlobal();
}

//-------------------------------------------------------------------------
/// @details
///		Ends operations on this filter
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IFilterGlobal::endFilterGlobal() noexcept {
    // Close the stream if it is open
    if (m_stream) m_stream->close();

    // Call our parent
    return Parent::endFilterGlobal();
}
}  // namespace engine::store::filter::zip