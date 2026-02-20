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

namespace ap::flags {
//------------------------------------------------------------------------
/// @details
///		Define the flags for objects - these flags are also
///		passed directly into the java tika engine. See
///		TikaApi.java if these are changed!
///
///		These are declared here since they are shared amongst
///		the Selection class, then Entry class and tika
//-------------------------------------------------------------------------
class ENTRY_FLAGS {
public:
    _const uint32_t NONE = 0;
    _const uint32_t INDEX = BIT(0);
    _const uint32_t CLASSIFY = BIT(1);
    _const uint32_t OCR = BIT(2);
    _const uint32_t MAGICK = BIT(3);
    // From TikaApi, following 2 flags are reserved
    // public static final int IMGREC = 1 << 4; // Use Object recognition within
    // an image public static final int AUDTTS = 1 << 5; // Use text to speech
    // on audio/video formats
    _const uint32_t SIGNING = BIT(6);
    _const uint32_t OCR_DONE = BIT(7);
    _const uint32_t PERMISSIONS = BIT(8);
    _const uint32_t VECTORIZE = BIT(9);
};

class ENTRY_IFLAGS {
public:
    _const uint32_t NONE = 0;
    _const uint32_t DELETED = BIT(0);
    _const uint32_t SCANNED = BIT(1);
};
}  // namespace ap::flags
