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
// The pipe gate runs inside getPipe(), so it refuses native callers and
// Python callers alike; Python callers get the exception the gate raised.
//-----------------------------------------------------------------------------
TEST_CASE("store::pipeGate") {
    auto task = R"(
        {
            "config": {
                "service": {
                    "filters": ["pipe", "null", "bottom"],
                    "key": "null://Null",
                    "name": "Null endpoint",
                    "type": "null",
                    "mode": "source",
                    "parameters": {}
                }
            },
            "taskId": "6a1e2d4c-1f0b-4c55-9a3e-0b6f2d7c8e91",
            "nodeId": "0c9b7e5a-3d2f-4b1a-8e6c-5f4d3c2b1a09"
        }
    )"_json;

    auto config = task["config"];
    auto service = config["service"];
    auto endpoint = IServiceEndpoint::getTargetEndpoint(
        {.jobConfig = task, .taskConfig = config, .serviceConfig = service});
    REQUIRE_NO_ERROR(endpoint);
    REQUIRE_NO_ERROR(endpoint->beginEndpoint(OPEN_MODE::SCAN));

    util::Guard noGate{[] {}, [] { IServiceEndpoint::pipeGate = nullptr; }};

    SECTION("a refusing gate refuses a native caller") {
        IServiceEndpoint::pipeGate = [] {
            return APERR(Ec::LicenseLimit, "Out of credits");
        };
        REQUIRE_ERROR(endpoint->getPipe(), Ec::LicenseLimit, "Out of credits");
    }

    SECTION("an allowing gate hands out the pipe") {
        IServiceEndpoint::pipeGate = []() -> Error { return {}; };
        auto pipe = endpoint->getPipe();
        REQUIRE_NO_ERROR(pipe);
        REQUIRE_NO_ERROR(endpoint->putPipe(*pipe));
    }

    SECTION("a Python gate refuses with the exception it raised") {
        std::string raisedCode;
        const auto python = localfcn()->Error {
            py::exec(R"(
class Refused(RuntimeError):
    code = 'OUT_OF_CREDITS'

def refuse():
    raise Refused('Out of credits')

import engLib
engLib.setPipeGate(refuse)
)");
            py::object ep =
                py::cast((*endpoint).get(), py::return_value_policy::reference);
            try {
                ep.attr("getPipe")();
            } catch (py::error_already_set &e) {
                raisedCode = py::str(e.value().attr("code"));
            }
            return {};
        };
        REQUIRE_NO_ERROR(callPython(python));
        REQUIRE(raisedCode == "OUT_OF_CREDITS");

        // A native caller gets the refusal as an Error, without the traceback
        auto native = endpoint->getPipe();
        REQUIRE_ERROR(native, Ec::LicenseLimit, "Out of credits");
        REQUIRE(native.ccode().message() == "Out of credits");
    }

    REQUIRE_NO_ERROR(endpoint->endEndpoint());
}
