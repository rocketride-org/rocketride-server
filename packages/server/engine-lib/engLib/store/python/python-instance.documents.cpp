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
Error IPythonInstanceBase::writeDocuments(
    const pybind11::object &documents) noexcept {
    py::object result;
    Error ccode;

    LOGPIPE();

    // If TEXT API is not implemented, push it down
    if (!(m_pyMethods & PythonMethod::WriteDocuments))
        return Parent::writeDocuments(documents);

    // Define the Python lambda that needs to be called
    auto python = localfcn()->Error {
        // Call it
        m_pyInstance.attr("writeDocuments")(documents);
        return {};
    };

    // Call the Python lambda
    ccode = callPython(python);

    // If we are supposed to call the parent
    if (checkCallParent(ccode)) return Parent::writeDocuments(documents);

    // And return any thrown error
    return ccode;
}
}  // namespace engine::store::pythonBase
