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

#include <tuple>

#include "../store.h"

namespace py = pybind11;
using namespace engine::store::pythonBase;

//-----------------------------------------------------------------------------
// One node, one IGlobal per CONTROL (plan 4.1 rule 1, C.22). The node under
// test is a Python package injected into sys.modules and registered for the
// test thread as a custom service with its filter factories, so nothing in
// nodes/ is touched. Its IGlobal records every beginGlobal / endGlobal with
// the control id and the label it read from glb.connConfig; its IInstance
// records which control's global it was handed.
//-----------------------------------------------------------------------------
namespace {

constexpr const char *kNodeType = "ctl_node";
constexpr const char *kNodePackage = "ctltest";

// The test node. Run again for every section: fresh records each time
constexpr const char *kNodeSource = R"PY(
import importlib.machinery
import sys
import time
import types

from rocketlib import IGlobalBase, IInstanceBase, IJson

log = []              # ('begin' | 'end', controlId, label), in order
seen = []             # (IGlobal.glb.controlId, IGlobal.label, _caller controlId)
raise_on_end = set()  # control ids whose endGlobal raises
state = {'begin_delay': 0.0}  # seconds beginGlobal sleeps: widens the build window


class IGlobal(IGlobalBase):
    label = None

    def beginGlobal(self):
        self.label = IJson.toDict(self.glb.connConfig).get('label')
        if state['begin_delay']:
            time.sleep(state['begin_delay'])
        log.append(('begin', self.glb.controlId, self.label))

    def endGlobal(self):
        log.append(('end', self.glb.controlId, self.label))
        if self.glb.controlId in raise_on_end:
            raise RuntimeError('endGlobal failed for ' + self.glb.controlId)


class IInstance(IInstanceBase):
    def beginInstance(self):
        caller = self._caller or {}
        seen.append((self.IGlobal.glb.controlId, self.IGlobal.label, caller.get('controlId')))


def _module(name, **attrs):
    module = types.ModuleType(name)
    module.__spec__ = importlib.machinery.ModuleSpec(name, None)
    module.__dict__.update(attrs)
    sys.modules[name] = module
    return module


package = _module('ctltest', log=log, seen=seen, raise_on_end=raise_on_end, state=state)
package.__path__ = []
_module('ctltest.IGlobal', IGlobal=IGlobal)
_module('ctltest.IInstance', IInstance=IInstance)
)PY";

// The node's service definition: a python filter whose package is ctltest
json::Value nodeDefinition() {
    json::Value def = R"({
        "register": "filter", "node": "python", "classType": ["text"],
        "capabilities": [], "lanes": {"text": ["text"]},
        "propertyDefinitions": {
            "ctl_node.label": {"type": "string", "title": "Label"}
        },
        "properties": ["ctl_node.label"],
        "icon": "data:image/svg+xml;base64,PHN2Zy8+"
    })"_json;
    def["title"] = kNodeType;
    def["protocol"] = _ts(kNodeType, "://");
    def["path"] = kNodePackage;
    def["prefix"] = kNodeType;

    json::Value list = json::arrayValue;
    list.append(def);
    return list;
}

// Installs the python package
void installNode() {
    engine::python::LockPython lock;
    py::exec(kNodeSource);
}

// One record of the node's log or seen list
using Record = std::tuple<std::string, std::string, std::string>;

std::vector<Record> records(const char *name) {
    engine::python::LockPython lock;
    std::vector<Record> out;
    for (auto item : py::module_::import(kNodePackage).attr(name)) {
        auto fields = item.cast<py::tuple>();
        auto field = [&](size_t i) {
            return fields[i].is_none() ? std::string()
                                       : py::cast<std::string>(fields[i]);
        };
        out.emplace_back(field(0), field(1), field(2));
    }
    return out;
}

std::vector<Record> entries(const char *kind) {
    std::vector<Record> out;
    for (auto &record : records("log"))
        if (std::get<0>(record) == kind) out.push_back(record);
    return out;
}

void setBeginDelay(double seconds) {
    engine::python::LockPython lock;
    py::module_::import(kNodePackage).attr("state")["begin_delay"] = seconds;
}

void raiseOnEnd(const char *controlId) {
    engine::python::LockPython lock;
    py::module_::import(kNodePackage).attr("raise_on_end").attr("add")(controlId);
}

// A binding under test: the pipe and the entry it has open
struct Binding {
    ServicePipe pipe;
    Entry entry;
};

// The node's position in the endpoint stack - the index the open's config
// list is addressed by
size_t nodeIndex(ServiceEndpoint &endpoint) {
    for (size_t i = 0; i < endpoint->pipeStack.size(); ++i)
        if (endpoint->pipeStack[i].id == kNodeType) return i;
    FAIL("the node is not on the stack");
    return 0;
}

// Takes a pipe, stamps the caller the server would (none when controlId is
// empty and no config is given) and opens an entry: the first touch of the
// node under that control. A null config is an open without one; otherwise
// it is this node's entry of the open's config list, as stored
Error openUnderConfig(IFilterTest &test, ServiceEndpoint &endpoint,
                      Binding &binding, const std::string &controlId,
                      const json::Value *nodeConfig, const char *name) {
    auto pipe = endpoint->getPipe(PIPELINE_TRACE_LEVEL::NONE);
    if (!pipe) return pipe.ccode();
    binding.pipe = *pipe;

    if (!controlId.empty() || nodeConfig) {
        engine::python::LockPython lock;
        py::dict caller;
        caller["controlId"] = controlId;
        if (nodeConfig) {
            py::list config;
            for (size_t i = 0; i < endpoint->pipeStack.size(); ++i)
                config.append(py::dict());
            config[nodeIndex(endpoint)] =
                engine::python::pyjson::jsonToDict(*nodeConfig);
            caller["config"] = config;
        }
        binding.pipe->caller = caller;
    }

    binding.entry = test.getDummyEntry(name);
    return binding.pipe->open(binding.entry);
}

// The common case: a config holding one plain label. A null label is an
// open without config
Error openUnder(IFilterTest &test, ServiceEndpoint &endpoint, Binding &binding,
                const std::string &controlId, const char *label,
                const char *name = "object.txt") {
    if (!label) return openUnderConfig(test, endpoint, binding, controlId, nullptr, name);

    json::Value mine = json::objectValue;
    mine["label"] = label;
    return openUnderConfig(test, endpoint, binding, controlId, &mine, name);
}

// Sets the deployment secret for the life of the scope, then restores it
class ControlSecretScope {
public:
    explicit ControlSecretScope(TextView value) noexcept
        : m_saved(plat::env(crypto::ParamTokenSecretEnv)) {
        plat::setEnv(crypto::ParamTokenSecretEnv, value);
    }
    ~ControlSecretScope() { plat::setEnv(crypto::ParamTokenSecretEnv, m_saved); }

private:
    Text m_saved;
};

// A node config whose label is stored encrypted: no plaintext, the value
// rides the secureParameters token keyed by the leaf path
json::Value encryptedLabel(const char *label, TextView secret) {
    json::Value values = json::objectValue;
    values["label"] = label;

    json::Value config = json::objectValue;
    config["secureParameters"]["secure"].append("label");
    config["secureParameters"]["token"] = crypto::base64Encode(
        *crypto::paramTokenEncrypt(values.stringify(), secret));
    return config;
}

// Closes the entry and returns the pipe: the binding ends
Error closeUnder(ServiceEndpoint &endpoint, Binding &binding) {
    auto closed = binding.pipe->close();
    auto put = endpoint->putPipe(binding.pipe);
    return closed || put;
}

// The node's global on the endpoint: the pipe head's next filter
std::shared_ptr<IPythonGlobalBase> nodeGlobal(ServicePipe &pipe) {
    return std::dynamic_pointer_cast<IPythonGlobalBase>(pipe->pDown->global);
}

// A sweep that treats everything not held as idle
void sweepNow() {
    async::sleep(5ms);
    IPythonGlobalBase::sweepIdleGlobals(std::chrono::seconds(0));
}

}  // namespace

TEST_CASE("store::controls") {
    // The node: its package, its definition for this thread, its factories
    installNode();
    auto scope = IServices::withCustomServices(nodeDefinition());
    REQUIRE_NO_ERROR(scope);

    auto factoryGlobal =
        Factory::makeFactory<engine::store::filter::python::IFilterGlobal,
                             IPythonGlobalBase>("ctl_node"_itv);
    auto factoryInstance =
        Factory::makeFactory<engine::store::filter::python::IFilterInstance,
                             IPythonInstanceBase>("ctl_node"_itv);
    REQUIRE_NO_ERROR(Factory::registerFactory(factoryGlobal, factoryInstance));
    util::Guard deregister{[] {}, [&] {
                               Factory::deregisterFactory(factoryGlobal,
                                                          factoryInstance);
                           }};

    IFilterTest test({"pipe", kNodeType, "bottom"});
    REQUIRE_NO_ERROR(test.connect());

    // Nothing per control is built with the endpoint
    REQUIRE(entries("begin").empty());

    // Reach the endpoint and the node's global
    auto first = test.getPipe();
    REQUIRE_NO_ERROR(first);
    auto endpoint = (*first)->endpoint;
    auto global = nodeGlobal(*first);
    REQUIRE(global);
    REQUIRE_NO_ERROR(test.putPipe(*first));
    REQUIRE(entries("begin").empty());

    SECTION("two controls on one node: two IGlobals, each begun with its own config") {
        Binding a, b;
        REQUIRE_NO_ERROR(openUnder(test, endpoint, a, "control-a", "a-cfg", "a.txt"));
        REQUIRE_NO_ERROR(openUnder(test, endpoint, b, "control-b", "b-cfg", "b.txt"));

        auto begins = entries("begin");
        REQUIRE(begins.size() == 2);
        REQUIRE(begins[0] == Record{"begin", "control-a", "a-cfg"});
        REQUIRE(begins[1] == Record{"begin", "control-b", "b-cfg"});

        // Each binding's instance sees its own control's global
        auto seen = records("seen");
        REQUIRE(seen.size() == 2);
        REQUIRE(seen[0] == Record{"control-a", "a-cfg", "control-a"});
        REQUIRE(seen[1] == Record{"control-b", "b-cfg", "control-b"});

        auto ids = global->controlIds();
        REQUIRE(ids.size() == 2);

        REQUIRE_NO_ERROR(closeUnder(endpoint, a));
        REQUIRE_NO_ERROR(closeUnder(endpoint, b));

        // Ending the binding does not end the control's global
        REQUIRE(entries("end").empty());
        REQUIRE(global->controlIds().size() == 2);
    }

    SECTION("the same control twice: one IGlobal, begun once") {
        Binding a1, a2;
        REQUIRE_NO_ERROR(openUnder(test, endpoint, a1, "control-a", "a-cfg", "a1.txt"));
        REQUIRE_NO_ERROR(closeUnder(endpoint, a1));
        REQUIRE_NO_ERROR(openUnder(test, endpoint, a2, "control-a", "a-cfg", "a2.txt"));
        REQUIRE_NO_ERROR(closeUnder(endpoint, a2));

        REQUIRE(entries("begin").size() == 1);
        auto seen = records("seen");
        REQUIRE(seen.size() == 2);
        REQUIRE(std::get<0>(seen[0]) == "control-a");
        REQUIRE(std::get<0>(seen[1]) == "control-a");
        REQUIRE(global->controlIds().size() == 1);
    }

    SECTION("a write under a control whose open never reached the engine is refused") {
        Binding a;
        REQUIRE_ERROR(openUnder(test, endpoint, a, "control-x", nullptr),
                      Ec::InvalidCommand, "did not reach this engine");
        REQUIRE(entries("begin").empty());
        REQUIRE(global->controlIds().empty());
        REQUIRE_NO_ERROR(endpoint->putPipe(a.pipe));

        // The next open with its config builds it
        Binding again;
        REQUIRE_NO_ERROR(openUnder(test, endpoint, again, "control-x", "x-cfg"));
        REQUIRE(entries("begin").size() == 1);
        REQUIRE_NO_ERROR(closeUnder(endpoint, again));
    }

    SECTION("a secret leaf stored encrypted reaches IGlobal.config decrypted on the build") {
        ControlSecretScope secret{"example-control-token-secret"};
        auto config = encryptedLabel("s3cret-label", "example-control-token-secret");

        Binding a;
        REQUIRE_NO_ERROR(openUnderConfig(test, endpoint, a, "control-a", &config, "a.txt"));
        auto begins = entries("begin");
        REQUIRE(begins.size() == 1);
        REQUIRE(begins[0] == Record{"begin", "control-a", "s3cret-label"});
        REQUIRE_NO_ERROR(closeUnder(endpoint, a));
    }

    SECTION("a token the deployment secret cannot open fails the build, as the launch did") {
        ControlSecretScope secret{"the-engine-secret"};
        auto config = encryptedLabel("s3cret-label", "another-secret");

        Binding a;
        REQUIRE(openUnderConfig(test, endpoint, a, "control-a", &config, "a.txt"));
        REQUIRE(entries("begin").empty());
        REQUIRE(global->controlIds().empty());
        REQUIRE_NO_ERROR(endpoint->putPipe(a.pipe));
    }

    SECTION("a binding without a caller binds the default slot on the task's config") {
        Binding none;
        REQUIRE_NO_ERROR(openUnder(test, endpoint, none, "", nullptr));
        auto begins = entries("begin");
        REQUIRE(begins.size() == 1);
        REQUIRE(std::get<1>(begins[0]).empty());
        REQUIRE(std::get<2>(begins[0]).empty());
        REQUIRE_NO_ERROR(closeUnder(endpoint, none));
    }

    SECTION("the sweep ends an idle control once and the next open rebuilds it") {
        Binding a;
        REQUIRE_NO_ERROR(openUnder(test, endpoint, a, "control-a", "a-cfg"));
        REQUIRE_NO_ERROR(closeUnder(endpoint, a));

        sweepNow();
        auto ends = entries("end");
        REQUIRE(ends.size() == 1);
        REQUIRE(ends[0] == Record{"end", "control-a", "a-cfg"});
        REQUIRE(global->controlIds().empty());

        // A second sweep has nothing to end
        sweepNow();
        REQUIRE(entries("end").size() == 1);

        // The next open rebuilds it from THAT open's config
        Binding again;
        REQUIRE_NO_ERROR(openUnder(test, endpoint, again, "control-a", "a-cfg-2"));
        auto begins = entries("begin");
        REQUIRE(begins.size() == 2);
        REQUIRE(begins[1] == Record{"begin", "control-a", "a-cfg-2"});
        REQUIRE_NO_ERROR(closeUnder(endpoint, again));
    }

    SECTION("a control with an open binding is never swept") {
        Binding a;
        REQUIRE_NO_ERROR(openUnder(test, endpoint, a, "control-a", "a-cfg"));

        sweepNow();
        REQUIRE(entries("end").empty());
        REQUIRE(global->controlIds().size() == 1);

        REQUIRE_NO_ERROR(closeUnder(endpoint, a));
        sweepNow();
        REQUIRE(entries("end").size() == 1);
    }

    SECTION("an endGlobal that raises is logged to ops and the slot is erased anyway") {
        Binding a;
        REQUIRE_NO_ERROR(openUnder(test, endpoint, a, "control-a", "a-cfg"));
        REQUIRE_NO_ERROR(closeUnder(endpoint, a));
        raiseOnEnd("control-a");

        auto &monitor = ::engine::config::monitor();
        const auto errorsBefore = monitor->errors().size();

        sweepNow();
        REQUIRE(entries("end").size() == 1);
        REQUIRE(monitor->errors().size() == errorsBefore + 1);
        REQUIRE(Text{monitor->errors().back().message()}.contains(
            "endGlobal failed for control-a"));
        REQUIRE(global->controlIds().empty());

        // The next open rebuilds it
        Binding again;
        REQUIRE_NO_ERROR(openUnder(test, endpoint, again, "control-a", "a-cfg"));
        REQUIRE(entries("begin").size() == 2);
        REQUIRE_NO_ERROR(closeUnder(endpoint, again));
    }

    SECTION("concurrent bindings of one control build its IGlobal once") {
        // A slow beginGlobal keeps the build window open while the second
        // binding arrives; it must wait on the slot, not build a second one
        setBeginDelay(0.3);

        std::mutex resultsLock;
        std::vector<Error> results;
        auto worker = [&](const char *name) {
            Binding binding;
            auto ccode = openUnder(test, endpoint, binding, "control-a", "a-cfg", name);
            if (!ccode) ccode = closeUnder(endpoint, binding);
            std::lock_guard<std::mutex> guard(resultsLock);
            results.push_back(ccode);
        };

        async::Thread one{_location, "ctl-one", worker, "one.txt"};
        async::Thread two{_location, "ctl-two", worker, "two.txt"};
        REQUIRE_NO_ERROR(one.start());
        REQUIRE_NO_ERROR(two.start());
        REQUIRE_NO_ERROR(one.join());
        REQUIRE_NO_ERROR(two.join());

        REQUIRE(results.size() == 2);
        for (auto &result : results) REQUIRE_NO_ERROR(result);

        REQUIRE(entries("begin").size() == 1);
        auto seen = records("seen");
        REQUIRE(seen.size() == 2);
        REQUIRE(std::get<0>(seen[0]) == "control-a");
        REQUIRE(std::get<0>(seen[1]) == "control-a");
        REQUIRE(global->controlIds().size() == 1);
    }

    SECTION("ending the endpoint ends every control's IGlobal") {
        Binding a, b;
        REQUIRE_NO_ERROR(openUnder(test, endpoint, a, "control-a", "a-cfg", "a.txt"));
        REQUIRE_NO_ERROR(openUnder(test, endpoint, b, "control-b", "b-cfg", "b.txt"));
        REQUIRE_NO_ERROR(closeUnder(endpoint, a));
        REQUIRE_NO_ERROR(closeUnder(endpoint, b));

        REQUIRE_NO_ERROR(test.disconnect());
        auto ends = entries("end");
        REQUIRE(ends.size() == 2);
    }

    // The global outlives the endpoint in a section that did not disconnect
    global.reset();
}
