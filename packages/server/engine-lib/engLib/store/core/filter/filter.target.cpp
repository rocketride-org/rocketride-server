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

namespace engine::store {
//-------------------------------------------------------------------------
// These methods are used for sending data to the target. They can only
// be used by an pipe where the endpoint is in source mode
//-------------------------------------------------------------------------

//-------------------------------------------------------------------------
/// @details
///		This will track when an object is opened. It becomes available
///		via the entry member
///	@param[in]	entry
///		Reference to the object to open
//-------------------------------------------------------------------------
Error IServiceFilterInstance::open(Entry &entry) noexcept {
    // Save the enty
    currentEntry = &entry;

    // Call down, if it fails, clear it
    if (auto ccode = binder.open(entry)) {
        currentEntry = nullptr;
        return ccode;
    }

    // Done - success
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This function will easily determine if this stream represents a
///		primary data stream. If the stream is named, or if is not
///		stream data, returns false
//-------------------------------------------------------------------------
Error IServiceFilterInstance::close() noexcept {
    // Call down
    auto ccode = binder.close();

    // Clear it and return
    currentEntry = nullptr;

    return ccode;
}

}  // namespace engine::store
