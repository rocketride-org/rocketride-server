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


#include <pybind11/embed.h>

#include "../store.h"

namespace py = pybind11;

//-----------------------------------------------------------------------------
// registerServices adds definitions that never came from a scan and resolves
// them together; registering a logical type again replaces it.
//-----------------------------------------------------------------------------
TEST_CASE("store::registerServices") {
    const auto registerRail = [](const char *titleA) {
        const auto python = localfcn()->Error {
            py::exec(R"(
import engLib, tempfile
base = {'register': 'filter', 'node': 'python', 'classType': ['text'],
        'capabilities': [], 'lanes': {'text': ['text']}, 'fields': {},
        'shape': []}
def node(name, title):
    return dict(base, title=title, protocol=name + '://',
                path='nodes.' + name, prefix=name)
)");
            py::module_::import("__main__").attr("titleA") = titleA;
            py::exec(R"(
engLib.registerServices([(node('rail_a', titleA), tempfile.mkdtemp() + '/services.json'),
                         (node('rail_b', 'Rail B'), tempfile.mkdtemp() + '/services.json')])
)");
            return {};
        };
        REQUIRE_NO_ERROR(callPython(python));
    };

    registerRail("Rail A");
    for (auto name : {"rail_a", "rail_b"}) {
        auto def = IServices::getServiceDefinition(name);
        REQUIRE_NO_ERROR(def);
        REQUIRE((*def)->isResolved);
    }

    registerRail("Rail A, again");
    auto def = IServices::getServiceDefinition("rail_a");
    REQUIRE_NO_ERROR(def);
    REQUIRE((*def)->title == "Rail A, again");
}
