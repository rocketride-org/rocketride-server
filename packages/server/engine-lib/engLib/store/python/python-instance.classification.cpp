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
//-------------------------------------------------------------------------
/// @details
///		Notify the filter to process the classification rules
//-------------------------------------------------------------------------
Error IPythonInstanceBase::writeClassifications(
    const json::Value &classifications, const json::Value &classificationPolicy,
    const json::Value &classificationRules) noexcept {
    Error ccode;

    LOGPIPE();

    // If the method is not supported, push it down
    if (!(m_pyMethods & PythonMethod::WriteClassifications))
        return Parent::writeClassifications(
            classifications, classificationPolicy, classificationRules);

    auto python = localfcn()->Error {
        auto pyClassifications =
            engine::python::pyjson::jsonToDict(classifications);
        auto pyClassificationsPolicy =
            engine::python::pyjson::jsonToDict(classificationPolicy);
        auto pyClassificationsRules =
            engine::python::pyjson::jsonToDict(classificationRules);

        // Call it
        m_pyInstance.attr("writeClassifications")(
            pyClassifications, pyClassificationsPolicy, pyClassificationsRules);
        return {};
    };

    ccode = callPython(python);

    if (checkCallParent(ccode))
        return Parent::writeClassifications(
            classifications, classificationPolicy, classificationRules);

    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Notify the filter to process the classification context
//-------------------------------------------------------------------------
Error IPythonInstanceBase::writeClassificationContext(
    const json::Value &classifications) noexcept {
    Error ccode;

    LOGPIPE();

    // If the method is not supported, push it down
    if (!(m_pyMethods & PythonMethod::WriteClassificationContext))
        return Parent::writeClassificationContext(classifications);

    auto python = localfcn()->Error {
        auto pyClassifications =
            engine::python::pyjson::jsonToDict(classifications);

        // Call it
        m_pyInstance.attr("writeClassificationContext")(pyClassifications);
        return {};
    };

    ccode = callPython(python);

    if (checkCallParent(ccode))
        return Parent::writeClassificationContext(classifications);

    return ccode;
}
}  // namespace engine::store::pythonBase
