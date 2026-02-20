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

#pragma once

namespace engine::python {
namespace py = pybind11;

//-------------------------------------------------------------------------
/// @details
///		Get the root directory where the python files are located
//-------------------------------------------------------------------------
inline file::Path rootDir() noexcept { return application::execDir(); }

//-------------------------------------------------------------------------
/// @details
///		Internal call mechanism
//-------------------------------------------------------------------------
template <typename Call, typename... Args>
inline auto __call(Location location, Call &&call, Args &&...args) noexcept;

//-------------------------------------------------------------------------
/// @details
///		When python calls the processComandLine function (usually by dbgconn)
///		it can't pass through the full error code so store it away here
//-------------------------------------------------------------------------
void setProcessCommandLineResults(Error &ccode) noexcept;

//-------------------------------------------------------------------------
/// @details
///		External declarations for starting/stopping the python engine
//-------------------------------------------------------------------------
void setupDebug() noexcept;
bool isPython() noexcept;
Error init() noexcept;
Error execPython() noexcept;
Error deinit() noexcept;
Error executePythonArguments(py::object &argv);
std::vector<Text> filterEngineOptions(const std::vector<Text> &args);

ErrorOr<py::object> loadModule(const Text &module,
                               bool configureModule = false) noexcept;
}  // namespace engine::python
