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

#include <pybind11/embed.h>  // everything needed for embedding
#include <pybind11/numpy.h>

#include <iostream>
#include <string>

#include "test.h"

// Now gvFunc is a Python module which can be imported via
// pybind11::module_::import("gvFunc") also gvFunc module has function
// get_value(x)
PYBIND11_EMBEDDED_MODULE(gvFunc, m) {
    // `m` is a `py::module_` which is used to bind functions and classes
    m.def("get_value", [](std::string x) {
        std::cout << x << std::endl;
        return x;
    });
}

TEST_CASE("python::pybind") {
    MONITOR(status, "All outputs from Python interpreter\n");

    namespace py = pybind11;
    using namespace pybind11::literals;

    // Python code to execute
    const auto python = localfcn()->Error {
        py::print(
            "                    Hello World from Python!");  // use the Python
                                                              // API

        // These are automatically built in modules
        REQUIRE_NOTHROW(py::module_::import("sys"));
        REQUIRE_NOTHROW(py::module_::import("errno"));

        // Equivalent to "from decimal import Decimal"
        // This will throw if the math module is not built in
        REQUIRE_NOTHROW(py::module_::import("decimal"));
        py::object Decimal = py::module_::import("decimal").attr("Decimal");

        // Construct a Python object of class Decimal
        py::object pi = Decimal("3.14159");

        // Calculate pow(e, pi) in decimal
        py::object exp_pi = pi.attr("exp")();
        py::print("                   ", py::str(exp_pi));

        // print current dir using Py
        REQUIRE_NOTHROW(py::module_::import("os.path"));
        py::module_ path =
            py::module_::import("os.path");  // like 'import os.path as path'
        py::str curdir_abs = path.attr("abspath")(path.attr("curdir"));
        py::print("                   ",
                  py::str("Current directory: ") + curdir_abs);

        // execute Python code
        py::exec(R"(
			kwargs = dict(name="World", number=42)
			message = "Hello, {name}! The answer is {number}".format(**kwargs)
			print("                   ", message)
		)");

        // Import and call function from Python molude
        std::string traveler("                    I`m going to Python...");
        py::module_ gvFunc = py::module_::import(
            "gvFunc");  // import previously defined module gvFunc
        py::object result = gvFunc.attr("get_value")(
            traveler);  // call function get_value from gvFunc module
        std::string n = result.cast<std::string>();  // cast result to string
        REQUIRE(n == traveler);
        return {};
    };

    if (auto ccode = callPython(python)) throw ccode;
}
