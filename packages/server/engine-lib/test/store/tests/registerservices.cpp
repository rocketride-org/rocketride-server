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

namespace {
// Whether a factory of this type is registered under this name
bool hasFactory(const char *type, const char *name) {
    const auto names = Factory::getFactories(type);
    return std::find(names.begin(), names.end(), iTextView{name}) !=
           names.end();
}
}  // namespace

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
        REQUIRE(hasFactory("iFilterGlobal", name));
    }

    registerRail("Rail A, again");
    auto def = IServices::getServiceDefinition("rail_a");
    REQUIRE_NO_ERROR(def);
    REQUIRE((*def)->title == "Rail A, again");
}

TEST_CASE("store::registerServices registers a batch all or none") {
    const auto setUp = localfcn()->Error {
        py::exec(R"(
import engLib, tempfile
def node(name):
    return {'register': 'filter', 'node': 'python', 'classType': ['text'], 'capabilities': [],
            'lanes': {'text': ['text']}, 'fields': {}, 'shape': [], 'title': name,
            'protocol': name + '://', 'path': 'nodes.' + name, 'prefix': name}
def refused(batch):
    try:
        engLib.registerServices(batch)
    except Exception:
        return True
    return False
def at(definition):
    return (definition, tempfile.mkdtemp() + '/services.json')
engLib.registerServices([at(dict(node('rail_g'), title='Rail G'))])
)");
        return {};
    };
    REQUIRE_NO_ERROR(callPython(setUp));

    // A definition the engine holds, referenced by address as pipes do
    auto held = IServices::getServiceDefinition("rail_g");
    REQUIRE_NO_ERROR(held);
    const auto *heldDefinition = *held;
    // A factory is named by a view into its definition: counted, not looked up
    const auto factories = Factory::getFactories("iFilterGlobal").size();

    const auto python = localfcn()->Error {
        py::exec(R"(
# A replacement that changes the kind of node keeps the factories it would need
assert refused([at(dict(node('rail_g'), register='endpoint'))])
# A C++ node without a library, refused before it is registered
assert refused([at(node('rail_m')), at(dict(node('rail_n'), node='cpp', path=''))])
# Refused while registering: nothing of the batch stays, not even what came before
assert refused([at(node('rail_c')), at(dict(node('rail_d'), capabilities=['nonsense']))])
# Refused while resolving: a protocol that is not a URL; a definition it replaced is back
assert refused([at(dict(node('rail_g'), title='Rail G, again')), at(dict(node('rail_h'), protocol='rail_h'))])
# Malformed: nothing of the batch is registered
assert refused([at(node('rail_e')), (node('rail_f'), None)])
)");
        return {};
    };
    REQUIRE_NO_ERROR(callPython(python));

    for (auto name : {"rail_c", "rail_d", "rail_e", "rail_h", "rail_m", "rail_n"}) {
        REQUIRE_FALSE(IServices::getServiceDefinition(name));
        REQUIRE_FALSE(hasFactory("iFilterGlobal", name));
    }
    REQUIRE(Factory::getFactories("iFilterGlobal").size() == factories);
    REQUIRE(hasFactory("iFilterGlobal", "rail_g"));

    // Put back in place: the definition held by address is still rail_g's, unchanged
    REQUIRE(heldDefinition->logicalType == "rail_g");
    REQUIRE(heldDefinition->title == "Rail G");
    REQUIRE(heldDefinition->serviceDefinition.lookup<iText>("register") == "filter");
}
