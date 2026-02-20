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

#include <engLib/eng.h>

namespace engine::store::pythonBase {
using engine::python::IJson;

//-------------------------------------------------------------------------
/// @details
///		Notify the filter of incoming text, can be multiple on the document
///	@param[in] text
///		The text we parsed (usually from Tika)
//-------------------------------------------------------------------------
Error IPythonInstanceBase::writeText(const Utf16View &text) noexcept {
    Error ccode;

    LOGPIPE();

    // If TEXT API is not implemented, push it down
    if (!(m_pyMethods & PythonMethod::WriteText))
        return Parent::writeText(text);

    // Convert utf16 to utf8
    Utf8 textU8;
    utf8::unchecked::utf16to8(text.begin(), text.end(),
                              std::back_inserter(textU8));

    // Define the Python lambda that needs to be called
    auto python = localfcn()->Error {
        // Get the input text as a Python string
        auto pyText = py::str(textU8);

        // Call the Python function
        m_pyInstance.attr("writeText")(pyText);
        return {};
    };

    // Call the Python lambda
    ccode = callPython(python);

    // If we are supposed to call the parent
    if (checkCallParent(ccode)) return Parent::writeText(text);

    // And return any thrown error
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Notify the filter of incoming table, can be multiple on the document
///	@param[in] text
///		The text we parsed (usually from Tika)
//-------------------------------------------------------------------------
Error IPythonInstanceBase::writeTable(const Utf16View &text) noexcept {
    Error ccode;

    LOGPIPE();

    // If TEXT API is not implemented, push it down
    if (!(m_pyMethods & PythonMethod::WriteTable))
        return Parent::writeTable(text);

    // Convert utf16 to utf8
    Utf8 textU8;
    utf8::unchecked::utf16to8(text.begin(), text.end(),
                              std::back_inserter(textU8));

    // Define the Python lambda that needs to be called
    auto python = localfcn()->Error {
        // Get the input text as a Python string
        auto pyText = py::str(textU8);

        // Call the Python function
        m_pyInstance.attr("writeTable")(pyText);
        return {};
    };

    // Call the Python lambda
    ccode = callPython(python);

    // If we are supposed to call the parent
    if (checkCallParent(ccode)) return Parent::writeTable(text);

    // And return any thrown error
    return ccode;
}

}  // namespace engine::store::pythonBase
