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

namespace {
//---------------------------------------------------------------------
// We store the path and function from the last exception we
// received. The location information uses string views so they must
// be "constant"
//---------------------------------------------------------------------
std::string excPath = {};
std::string excFunction = {};
int excLineno = 0;

}  // namespace

//-------------------------------------------------------------------------
/// @details
///		This is the same as ap::error::callChk except it also handles
///		python errors. We cannot include the python handling in the
///		ap namespace since python/pybind11 is not included there
///
///		Blocks an exception from being raised and returns a
///		Error if one was caught, otherwise it returns the
///		original return value from the callback called
//-------------------------------------------------------------------------
template <typename Call, typename... Args>
inline auto __call(Location location, Call &&call, Args &&...args) noexcept {
    auto processResult = [&](auto ccode) noexcept {
        if constexpr (std::is_void_v<
                          typename std::invoke_result_t<Call, Args...>>)
            return ErrorOr<void>{_mv(ccode)};
        else if constexpr (::ap::traits::IsSameTypeV<
                               typename std::invoke_result_t<Call, Args...>,
                               Error>)
            return ErrorOr<void>{_mv(ccode)};
        else
            return ErrorOr<typename std::invoke_result_t<Call, Args...>>{
                _mv(ccode)};
    };

    try {
        if constexpr (std::is_void_v<
                          typename std::invoke_result_t<Call, Args...>>) {
            std::invoke(std::forward<Call>(call), std::forward<Args>(args)...);
            return ErrorOr<void>{};
        } else if constexpr (::ap::traits::IsSameTypeV<
                                 typename std::invoke_result_t<Call, Args...>,
                                 Error>)
            return ErrorOr<void>{std::invoke(std::forward<Call>(call),
                                             std::forward<Args>(args)...)};
        else
            return ErrorOr<typename std::invoke_result_t<Call, Args...>>{
                std::invoke(std::forward<Call>(call),
                            std::forward<Args>(args)...)};
    } catch (const Error &e) {
        // Create the error and return it
        return processResult(e);
    } catch (const py::error_already_set &e) {
        std::string errorMessage;
        Ec errorCode = Ec::NoErr;

        // Get the stack trace
        auto trace = e.trace();

        // Get the exception type
        std::string exception_type =
            py::hasattr(e.type(), "__name__")
                ? std::string(py::str(e.type().attr("__name__")))
                : "<Unknown>";

        // Has it already been formatted?
        if (py::hasattr(e.value(), "__formatted")) {
            // If we have already formatted it, get its values
            errorCode = (Ec)py::cast<int>(e.value().attr("code"));
            errorMessage = py::cast<std::string>(e.value().attr("message"));
            excPath = py::cast<std::string>(e.value().attr("filename"));
            excFunction = py::cast<std::string>(e.value().attr("function"));
            excLineno = py::cast<int>(e.value().attr("line"));
        } else {
            // If this is our custom APERR exception
            if (exception_type == "APERR") {
                if (py::hasattr(e.value(), "ec")) {
                    py::object ec_obj = e.value().attr("ec");
                    errorCode = static_cast<Ec>(
                        py::cast<int>(ec_obj));  // Assuming `ec` is an integer
                } else {
                    errorCode = Ec::Exception;
                }

                if (py::hasattr(e.value(), "msg")) {
                    errorMessage = std::string(py::str(e.value().attr("msg")));
                } else {
                    errorMessage = "Unknown APERR exception";
                }
            } else {
                // Use the exception Ec
                errorCode = Ec::Exception;

                // Get the actual error message
                errorMessage = std::string(py::str(e.value()));
            }

            // Store the error exception info
            excPath = "<Unknown>";
            excFunction = "<Unknown>";
            excLineno = -1;

            // IF we have trace info
            if (trace) {
                // This may actually fail horribly so we just output unknown if
                // it does
                try {
                    // Get the traceback module
                    auto traceback_module = py::module::import("traceback");

                    // Get the list of stack frames
                    py::list traceback_list =
                        traceback_module.attr("extract_tb")(trace);

                    // Try to get the last valid one
                    for (auto traceback_item : traceback_list) {
                        // Grab the filename, line and function from the top
                        // frame
                        auto filename = traceback_item.attr("__getitem__")(0);
                        auto lineno = traceback_item.attr("__getitem__")(1);
                        auto function = traceback_item.attr("__getitem__")(2);

                        // Store the error exception info
                        excPath = py::str(filename);
                        excFunction = py::str(function);
                        excLineno = py::int_(lineno);
                    }
                } catch (...) {
                    // Error getting trace - just use unknown
                }
            }
        }

        // Create a new location indicator pointing to the python code and using
        // the full path
        Location pyloc{excPath, excLineno, excFunction, true};

        // Create the error and return it
        auto result = Error{errorCode, pyloc, errorMessage};
        return processResult(result);
    } catch (const std::exception &e) {
        // Create the error and return it
        auto result = Error{Ec::Exception, location, e};
        return processResult(result);
    }
}

template <typename Call, typename... Args>
inline Error __callPython(Location location, Call &&cb,
                          Args &&...args) noexcept {
    // Lock the python code
    LockPython lock;

    // Setup our thread debug if needed
    engine::python::setupDebug();

    // Call it
    if (auto res = engine::python::__call(location, std::forward<Call>(cb),
                                          std::forward<Args>(args)...);
        res.hasCcode())
        return _mv(res).ccode();
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Check if we have to skip a call to parent (the default is to call
///     the parent class method)
//-------------------------------------------------------------------------
inline bool __checkCallParent(Error &ccode) noexcept {
    // If this is a prevent default behavior, reset the code
    // to no error, but do not call the parent class
    if (ccode.code() == Ec::PreventDefault) {
        ccode.reset();
        return false;
    }

    // If there as any code of failure, do not call the parent
    // and return the failure code
    if (ccode.code()) return false;

    // Call the parent class
    return true;
}

#define callPython(...) engine::python::__callPython(_location, __VA_ARGS__)
#define checkCallParent(ccode) engine::python::__checkCallParent(ccode)

}  // namespace engine::python
