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
//-----------------------------------------------------------------
/// @details
///		Scan objects
/// @param[in] path
///		The path to scan
///	@param[in] callback
///		The callback to call on each object
//-----------------------------------------------------------------
Error IPythonEndpointBase::scanObjects(Path &path,
                                       const ScanAddObject &callback) noexcept {
    // Call python scan
    const auto python = localfcn()->Error {
        // Get the path as a string
        auto strPath = (std::string)path;

        // Any pending error
        Error pendingError;

        // Generate a python callback
        const py::cpp_function pythonCallback = localfcn(py::dict & obj)->int {
            if (ap::async::cancelled()) {
                pendingError = APERR(Ec::Cancelled, "Scan cancelled");
                return -1;
            }

            engine::python::pyjson dict{obj};

            // Create an entry to pass to the scan callback
            Entry entry;
            if (dict.isMember("operation"))
                entry.operation(dict.asText("operation"));
            if (dict.isMember("isContainer"))
                entry.isContainer(dict.asBool("isContainer"));
            if (dict.isMember("name")) entry.name(dict.asText("name"));
            if (dict.isMember("objectTags"))
                entry.objectTags(dict.asJson("objectTags"));
            if (entry.isObject()) {
                if (dict.isMember("attrib"))
                    entry.attrib(_cast<int32_t>(dict.asInt64("attrib")));
                if (dict.isMember("accessTime"))
                    entry.accessTime(_cast<time_t>(dict.asInt64("accessTime")));
                if (dict.isMember("createTime"))
                    entry.createTime(_cast<time_t>(dict.asInt64("createTime")));
                if (dict.isMember("changeTime"))
                    entry.changeTime(_cast<time_t>(dict.asInt64("changeTime")));
                if (dict.isMember("modifyTime"))
                    entry.modifyTime(_cast<time_t>(dict.asInt64("modifyTime")));
                if (dict.isMember("size")) entry.size(dict.asInt64("size"));
                if (dict.isMember("storeSize"))
                    entry.storeSize(dict.asInt64("storeSize"));
                else if (dict.isMember("size"))
                    entry.storeSize(dict.asInt64("size"));
            }

            if (isSyncEndpoint()) {
                if (dict.isMember("operation"))
                    entry.operation(dict.asText("operation"));
                if (dict.isMember("syncScanType"))
                    entry.syncScanType(
                        _fs<Entry::SyncScanType>(dict.asText("syncScanType")));
                if (dict.isMember("changeKey"))
                    entry.changeKey(dict.asText("changeKey"));
                if (dict.isMember("uniqueName"))
                    entry.uniqueName(dict.asText("uniqueName"));
                if (dict.isMember("parentUniqueName"))
                    entry.parentUniqueName(dict.asText("parentUniqueName"));
            }

            // unlock the GIL
            engine::python::UnlockPython unlock;
            // Call our scan object callback
            if (pendingError = callback(entry))
                return -1;
            else
                return 0;
        };

        // Check first to make sure it's there
        if (!py::hasattr(m_pyEndpoint, "scanObjects"))
            return APERR(Ec::InvalidModule,
                         "Class IEndpoint is missing scanObjects");

        // And call it
        m_pyEndpoint.attr("scanObjects")(strPath, pythonCallback);
        return pendingError;
    };

    // Call the python code
    return callPython(python);
}

}  // namespace engine::store::pythonBase
