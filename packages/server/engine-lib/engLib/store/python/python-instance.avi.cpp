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

namespace engine::store::pythonBase {
using engine::python::IJson;

//-------------------------------------------------------------------------
/// @details
///		Notify the filter of incoming audio data
//-------------------------------------------------------------------------
Error IPythonInstanceBase::writeAudio(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept {
    Error ccode;

    LOGPIPE();

    // If it is not implemented, push it down
    if (!(m_pyMethods & PythonMethod::WriteAudio))
        return Parent::writeAudio(action, mimeType, streamData);

    // Define the Python lambda that needs to be called
    auto python = localfcn()->Error {
        m_pyInstance.attr("writeAudio")(action, mimeType, streamData);
        return {};
    };

    // Call the Python lambda
    ccode = callPython(python);

    // If we are supposed to call the parent
    if (checkCallParent(ccode))
        return Parent::writeAudio(action, mimeType, streamData);

    // And return any thrown error
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Notify the filter of incoming video data
//-------------------------------------------------------------------------
Error IPythonInstanceBase::writeVideo(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept {
    Error ccode;

    LOGPIPE();

    // If it is not implemented, push it down
    if (!(m_pyMethods & PythonMethod::WriteVideo))
        return Parent::writeAudio(action, mimeType, streamData);

    // Define the Python lambda that needs to be called
    auto python = localfcn()->Error {
        m_pyInstance.attr("writeVideo")(action, mimeType, streamData);
        return {};
    };

    // Call the Python lambda
    ccode = callPython(python);

    // If we are supposed to call the parent
    if (checkCallParent(ccode))
        return Parent::writeVideo(action, mimeType, streamData);

    // And return any thrown error
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Notify the filter of incoming image data
//-------------------------------------------------------------------------
Error IPythonInstanceBase::writeImage(
    const AVI_ACTION action, Text &mimeType,
    const pybind11::bytes &streamData) noexcept {
    Error ccode;

    LOGPIPE();

    // If it is not implemented, push it down
    if (!(m_pyMethods & PythonMethod::WriteImage))
        return Parent::writeImage(action, mimeType, streamData);

    // Define the Python lambda that needs to be called
    auto python = localfcn()->Error {
        // Call it
        m_pyInstance.attr("writeImage")(action, mimeType, streamData);
        return {};
    };

    // Call the Python lambda
    ccode = callPython(python);

    // If we are supposed to call the parent
    if (checkCallParent(ccode))
        return Parent::writeImage(action, mimeType, streamData);

    // And return any thrown error
    return ccode;
}
}  // namespace engine::store::pythonBase
