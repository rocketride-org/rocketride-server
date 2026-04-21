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

//=============================================================================
// This bindings module defines the interface agreement the engine and
// the python code. It is specific to the needs of a python driver and defines
// the following:
//
//	engLib module
//		This module is used by the python code to access many functions
//      and to properly type the IEndpoint, IGobal and IInstance classes
//
//	_IFilterEndpoint
//		The C++ part of the the class
//  IFilterEndpoint
//		Adds python endpoint specifics
//
//	_IFilterGlobal
//		The C++ part of the the class
//  IFilterGlobal
//		Adds python global specifics
//
//	_IFilterInstance
//		The C++ part of the the class
//  IFilterInstance
//		Ads python instance specifics
//	I
//=============================================================================

#include <engLib/eng.h>
#include <optional>

//-----------------------------------------------------------------------------
// These are generic definition helps that help in writing declarations.
// They support auto mappings for members within a class, and for custom
// getter/setter lambdas. Also, function method support. These are generic
// enough to be used with any class
//-----------------------------------------------------------------------------
#define PYINIT def

#if ROCKETRIDE_PLAT_WIN
#define PYBIND(name, value, ...) def(#name, value, __VA_ARGS__)
#define PYBIND_READONLY(name, value, ...) \
    def_readonly(#name, value, __VA_ARGS__)
#define PYBIND_READWRITE(name, value) def_readwrite(#name, value, __VA_ARGS__)
#else
#define PYBIND(name, value, ...) def(#name, value __VA_OPT__(, ) __VA_ARGS__)
#define PYBIND_READONLY(name, value, ...) \
    def_readonly(#name, value __VA_OPT__(, ) __VA_ARGS__)
#define PYBIND_READWRITE(name, value, ...) \
    def_readwrite(#name, value __VA_OPT__(, ) __VA_ARGS__)
#endif

//-----------------------------------------------------------------------------
//	PYBIND_PROP_READONLY(cls, type, memberName, valueName)
//		Binds a value that can only be read
//	PYBIND_PROP_READWRITE(cls, type, memberName, valueName)
//		Binds a value that can be read or written
//
//		cls:		The class that is being accessed
//		type:		The type of the variable to be accessed
//		memberName:	Name as it is to appear in the python class
//		valueName:	Name of the value member within the C++ class
//
//-----------------------------------------------------------------------------
#define PYBIND_PROP_READONLY(cls, type, memberName, valueName)      \
    def_property_readonly(#memberName, [](const cls &obj) -> type { \
        return (type)obj.valueName;                                 \
    })

#define PYBIND_PROP_READWRITE(cls, type, memberName, valueName)     \
    def_property(                                                   \
        #memberName,                                                \
        [](const cls &obj) -> type { return (type)obj.valueName; }, \
        [](const cls &obj, const type value) -> void {              \
            obj.valueName = value;                                  \
        })

//-----------------------------------------------------------------------------
//	PYBIND_PROP_READONLY_CUSTOM(memberName, lambdaRead)
//		This is a getter for a value
//	PYBIND_PROP_READWRITE_CUSTOM(memberName, lambdaRead, lambdaWrite)
//		This is a getter/setter for a value
//
//		memberName:	Name as it is to appear within the python class
//		lambdaRead:	Called when python reads the value
//		lambdaWrite:Called when python is setting the value
//-----------------------------------------------------------------------------
#define PYBIND_PROP_READONLY_CUSTOM(memberName, lambdaRead) \
    def_property_readonly(#memberName, lambdaRead)

#define PYBIND_PROP_READWRITE_CUSTOM(memberName, lambdaRead, lambdaWrite) \
    def_property(#memberName, lambdaRead, lambdaWrite)

//-----------------------------------------------------------------------------
//	PYBIND_PROP_READONLY_STATIC(memberName, value)
//		This is a getter for a static value
//
//		memberName:	Name as it is to appear within the python class
//		value:	    The value of the static property in python
//-----------------------------------------------------------------------------
#define PYBIND_PROP_READONLY_STATIC(memberName, value) \
    def_property_readonly_static(#memberName,          \
                                 [](py::object /*self*/) { return (value); })

//-----------------------------------------------------------------------------
//	PYBIND_FUNCTION, PYBIND_FUNCTION_STATIC
//		Binds a callable python function. This can be declared inside a
//		class or a module
//
//		memberName:	Name as it is to appear within python
//		lambda:		Function to bind
//-----------------------------------------------------------------------------
#if ROCKETRIDE_PLAT_WIN
#define PYBIND_FUNCTION(memberName, lambda, ...) \
    def(#memberName, lambda, __VA_ARGS__)
#define PYBIND_FUNCTION_STATIC(memberName, lambda, ...) \
    def_static(#memberName, lambda, __VA_ARGS__)
#else
#define PYBIND_FUNCTION(memberName, lambda, ...) \
    def(#memberName, lambda __VA_OPT__(, ) __VA_ARGS__)
#define PYBIND_FUNCTION_STATIC(memberName, lambda, ...) \
    def_static(#memberName, lambda __VA_OPT__(, ) __VA_ARGS__)
#endif

//-----------------------------------------------------------------------------
// Generate a function to get a reference to the value
//-----------------------------------------------------------------------------
#define PYBIND_ENTRY_PROP_READONLY_EX(type, memberName, checkName, hasName) \
    PYBIND_PROP_READONLY_CUSTOM(memberName, [](const Entry &obj) -> type {  \
        return (type)obj.memberName();                                      \
    }).PYBIND_PROP_READONLY_CUSTOM(hasName, [](const Entry &obj) -> bool {  \
        return obj.checkName;                                               \
    })

#define PYBIND_ENTRY_PROP_READONLY(type, memberName, hasName) \
    PYBIND_ENTRY_PROP_READONLY_EX(type, memberName, memberName, hasName)

#define PYBIND_ENTRY_PROP_READWRITE_EX(type, memberName, checkName, hasName) \
    PYBIND_PROP_READWRITE_CUSTOM(                                            \
        memberName,                                                          \
        [](const Entry &obj) -> type { return (type)obj.memberName(); },     \
        [](Entry &obj, const type value) -> void { obj.memberName(value); }) \
        .PYBIND_PROP_READONLY_CUSTOM(                                        \
            hasName, [](const Entry &obj) -> bool { return obj.checkName; })

#define PYBIND_ENTRY_PROP_READWRITE(type, memberName, hasName) \
    PYBIND_ENTRY_PROP_READWRITE_EX(type, memberName, memberName, hasName)

//-----------------------------------------------------------------------------
// Assists in defining an enum value
//-----------------------------------------------------------------------------
#define PYENUM(name, enumValue) value(#name, enumValue)

namespace engine::store::pythonBase {
//-----------------------------------------------------------------------------
/// @details
///		Declare our engine interfaces
///----------------------------------------------------------------------------
PYBIND11_EMBEDDED_MODULE(engLib, engLib) {
    namespace py = pybind11;
    using namespace pybind11::literals;
    using namespace engine::python;

    //-------------------------------------------------------------
    /// @details
    ///		Register a function to that taks an Error and
    ///		converts it into an Exception. We add some fields
    ///		here so the we don't double up on the messages and
    ///		can provide tracing information from the C++ side of
    ///		code in case it raises an exception.
    ///------------------------------------------------------------
    py::register_exception_translator([](std::exception_ptr p) {
        try {
            if (p) std::rethrow_exception(p);
        } catch (const Error &ccode) {
            // Get the python Exception class
            py::object exc_type =
                py::module_::import("builtins").attr("Exception");

            // Create the exeception message
            auto msg = ccode.code().message() + ": " +
                       std::string(ccode.message()) + " at (" +
                       ccode.location().fileName() + ":" +
                       std::to_string(ccode.location().line()) + ")";

            // Now, create the exception
            py::object exc_instance = exc_type(msg);

            // Add some attributes
            exc_instance.attr("__formatted") = true;
            exc_instance.attr("code") = ccode.code().value();
            exc_instance.attr("message") = std::string(ccode.message());
            exc_instance.attr("filename") = ccode.location().fileName();
            exc_instance.attr("function") = ccode.location().function();
            exc_instance.attr("line") = ccode.location().line();

            // Set the Python error
            PyErr_SetObject(exc_type.ptr(), exc_instance.ptr());
        }
    });

    //-------------------------------------------------------------
    /// @details
    ///		Return Engine version information.
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(getVersion, []() {
        using namespace application;
        py::dict versionInfo;
        versionInfo["version"] =
            py::str(projectVersion().data(), projectVersion().size());
        versionInfo["hash"] = py::str(buildHash().data(), buildHash().size());
        versionInfo["stamp"] =
            py::str(buildStamp().data(), buildStamp().size());
        return versionInfo;
    });

    //-------------------------------------------------------------
    /// @details
    ///		This is called to get the original, non-modified
    ///		version of the arguments
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(args, []() -> pybind11::list {
        // Get the cmd line
        auto &cmds = application::cmdline();

        // Return the original arguments as a list
        pybind11::list result;
        for (const auto &s : cmds.args_original()) result.append(s);
        return result;
    });

    //-------------------------------------------------------------
    /// @details
    ///		This is called by dbconn.py to process the task
    ///		provided as arguments. When we are debugging in
    ///		python mode, the debug target will be dbgconn.py. This
    ///		will cause the engine to run this as a normal debug
    ///		program. However, we want the engine to actually
    ///		execute tasks, so here it is...
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(processArguments, [](py::object &argv) {
        // Call the working function
        engine::python::executePythonArguments(argv);
    });

    //-------------------------------------------------------------
    /// @details
    ///		Declares a debug output function which can accept
    ///		multiple arguments. All arguments MUST be convertable
    ///		to python strings. This is for nodes to output
    ///		under the DebugOut level
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(monitorStatus, [](py::args args) {
        // Create a single concatenated string from all arguments
        std::ostringstream oss;
        for (const auto &arg : args) {
            oss << std::string(py::str(arg)) << " ";
        }

        // Trim trailing space (optional)
        std::string combinedStatus = oss.str();
        if (!combinedStatus.empty() && combinedStatus.back() == ' ')
            combinedStatus.pop_back();

        // Call the MONITOR macro with the combined string
        MONITOR(status, combinedStatus.c_str());
    });

    //-------------------------------------------------------------
    /// @details
    ///   Declares a monitor function to emit structured download
    ///   status from Python into the C++ monitor system.
    ///   Expects a Python dictionary (converted to JSON).
    //------------------------------------------------------------
    engLib.PYBIND_FUNCTION(monitorDependencyDownload, [](py::dict data) {
        // Transform status json from depends to Monitor
        auto json = engine::python::pyjson::dictToJson(data);
        MONITOR(dependencyDownload, json);
    });

    //-------------------------------------------------------------
    /// @details
    ///		Declares a debug output function which can accept
    ///		multiple arguments. All arguments MUST be convertable
    ///		to python strings. This is for nodes to output
    ///		under the DebugOut level
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(monitorMetrics, [](py::dict metrics) {
        // Call the MONITOR macro with the combined string
        auto json = engine::python::pyjson::dictToJson(metrics);

        // Call the MONITOR macro with the combined string
        MONITOR(metrics, json);
    });

    //-------------------------------------------------------------
    /// @details
    ///		Declares a debug output function which can accept
    ///		multiple arguments. All arguments MUST be convertable
    ///		to python strings and will be separated by spaces.
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(monitorOther, [](py::args args) {
        if (args.size() < 2) {
            throw std::runtime_error(
                "monitorOther requires at least 2 arguments: key and message "
                "parts");
        }

        // First argument is the key, convert to uppercase
        std::string key = std::string(py::str(args[0]));
        std::transform(key.begin(), key.end(), key.begin(),
                       string::toUpper<char>);

        // Combine the remaining arguments into a single string
        std::ostringstream oss;
        for (size_t i = 1; i < args.size(); ++i) {
            oss << std::string(py::str(args[i])) << " ";
        }

        // Trim trailing *
        std::string combined = oss.str();
        if (!combined.empty() && combined.back() == ' ') combined.pop_back();

        // Call the MONITOR macro with other, key, and combined message
        MONITOR(other, key.c_str(), combined.c_str());
    });

    //-------------------------------------------------------------
    /// @details
    ///		Declares a monitor function to record completed operations.
    ///		Accepts a size parameter to track the amount of data processed.
    ///		This increments the completed operation counter and adds to
    ///		the total completed data size.
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(monitorCompleted,
                           [](int size) { MONITOR(addCompleted, 1, size); });

    //-------------------------------------------------------------
    /// @details
    ///		Declares a monitor function to record failed operations.
    ///		Accepts a size parameter to track the amount of data that
    ///		failed to process. This increments the failed operation
    ///		counter and adds to the total failed data size.
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(monitorFailed,
                           [](int size) { MONITOR(addFailed, 1, size); });

    //-------------------------------------------------------------
    /// @details
    ///		Declares a function which will read from stdin,
    ///		return a single line with \n at the end. It blocks
    ///		until a line is read
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(readLine, []() -> std::string {
        // Unlock python and sent it along
        _block() {
            // Release the GIL so we can read from the console
            engine::python::UnlockPython unlock;

            // Read a line from the console (usually pipe)
            auto result = ap::application::readLine();

            // If we got an error, throw it
            if (!result) throw result.ccode();

            // Return the string
            return *result;
        }
    });

    //-------------------------------------------------------------
    /// @details
    ///		Checks to see if all of the levels specified are enabled.
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(
        isLevelEnabled, [](Lvl level) { return log::isLevelEnabled(level); });

    //-------------------------------------------------------------
    /// @details
    ///		Checks to see if all of the levels specified are enabled.
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(isAppMonitor, []() {
        return ::engine::config::monitor()->isAppMonitor();
    });

    //-------------------------------------------------------------
    /// @details
    ///		Declares a debug output function which can accept
    ///		multiple arguments. All arguments MUST be convertable
    ///		to python strings. This is for nodes to output
    ///		under the DebugOut level
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(debug, [](py::args &args) {
        Lvl logLevel = Lvl::DebugOut;
        py::size_t i = 0;

        // Check if the first param is a log level
        if (args.size() > 0 && py::isinstance<Lvl>(args[0])) {
            logLevel = py::cast<Lvl>(args[0]);
            i = 1;
        }

        // Check if the log level enabled
        if (!log::isLevelEnabled(logLevel)) return;

        // Create a text vector
        TextVector params;

        // Get error code and message from params
        for (; i < args.size(); ++i)
            params.emplace_back(std::string(py::str(args[i])));

        // Output it
        LOGX(logLevel, params);
    });

    //-------------------------------------------------------------
    /// @details
    ///		Declares a debug output function which can accept
    ///		multiple arguments. All arguments MUST be convertable
    ///		to python strings. This is for nodes to output
    ///		under the DebugOut level
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(
        getServiceDefinition, [](py::str &logicalType) -> py::object {
            // Get the type as a std::string
            const auto type = logicalType.cast<std::string>();

            // Get the service type
            const auto result = IServices::getServiceDefinition(type);

            // Return none or an object
            if (!result) return py::none();

            // Get a ptr to it
            const auto defPtr = *result;

            // Return it
            return pyjson::jsonToDict(defPtr->serviceDefinition);
        });

    //-------------------------------------------------------------
    /// @details
    ///		Declares a debug output function which can accept
    ///		multiple arguments. All arguments MUST be convertable
    ///		to python strings. This is for nodes to output
    ///		under the DebugOut level
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(getServiceDefinitions, []() -> py::object {
        // Get the service type
        const auto result = IServices::getServiceSchemas();

        // Return none or an object
        if (!result) return py::none();

        // Get a ptr to it
        const auto services = *result;

        // Return it
        return pyjson::jsonToDict(services);
    });

    //-------------------------------------------------------------
    /// @details
    ///     Get Python caller file/line so error/warning report the
    ///     .py file, not bindings.cpp
    ///------------------------------------------------------------
    auto getPythonCallerLocation =
        []() -> std::optional<std::tuple<std::string, int, std::string>> {
        try {
            py::object frame = py::module_::import("sys").attr("_getframe")(0);
            py::str pathStr(frame.attr("f_code").attr("co_filename"));
            py::str funcStr(frame.attr("f_code").attr("co_name"));
            std::string path =
                pathStr.attr("encode")("utf-8").cast<std::string>();
            int line = py::cast<int>(frame.attr("f_lineno"));
            std::string func =
                funcStr.attr("encode")("utf-8").cast<std::string>();
            return std::make_tuple(std::move(path), line, std::move(func));
        } catch (...) {
            return std::nullopt;
        }
    };

    // Report error/warning with Python caller location when available (so UI
    // shows .py file, not bindings.cpp)
    auto reportWithPythonLocation = [getPythonCallerLocation](bool isError,
                                                              py::args &args) {
        TextVector params;
        std::string messageStr;
        auto appendArg = [](const py::handle &arg, std::string &out) {
            if (py::isinstance<py::str>(arg))
                out += py::str(arg).attr("encode")("utf-8").cast<std::string>();
            else
                out += std::string(py::str(arg));
        };
        for (const auto &arg : args) {
            Text s =
                py::isinstance<py::str>(arg)
                    ? py::str(arg).attr("encode")("utf-8").cast<std::string>()
                    : std::string(py::str(arg));
            params.push_back(_mv(s));
            if (!messageStr.empty()) messageStr += ' ';
            appendArg(arg, messageStr);
        }
        Ec ec = isError ? Ec::Error : Ec::Warning;
        auto pyLocOpt = getPythonCallerLocation();
        if (pyLocOpt && ::engine::config::monitor()) {
            auto &[pyPath, pyLine, pyFunc] = *pyLocOpt;
            ::ap::Location pyloc{pyPath, pyLine, pyFunc, true};
            Error ccode = ::ap::error::makeError(ec, pyloc, messageStr);
            if (isError)
                ::engine::config::monitor()->error(std::move(ccode));
            else
                ::engine::config::monitor()->warning(std::move(ccode));
        } else {
            if (isError)
                MONERR(error, Ec::Error, params);
            else
                MONERR(warning, Ec::Warning, params);
        }
    };

    //-------------------------------------------------------------
    /// @details
    ///		Declares an error output function which can accept
    ///		multiple arguments. All arguments MUST be convertable
    ///		to python strings. This is output via the monitors
    ///		>ERR function
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(error,
                           [reportWithPythonLocation](py::args &args) -> void {
                               reportWithPythonLocation(true, args);
                           });

    //-------------------------------------------------------------
    /// @details
    ///		Declares a warning output function which can accept
    ///		multiple arguments. All arguments MUST be convertable
    ///		to python strings. This is output via the monitors
    ///		>WRN function
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(warning,
                           [reportWithPythonLocation](py::args &args) -> void {
                               reportWithPythonLocation(false, args);
                           });

    //-------------------------------------------------------------
    /// @details
    ///		Defines the expansion function which can be called
    ///		by a python to replace parameters within a string
    ///		with definitions contained in the config.var object.
    ///		For example, python passes "%execPath%" this
    ///		function will return the executable path
    ///------------------------------------------------------------
    engLib.PYBIND_FUNCTION(expand, [](py::object obj) -> std::string {
        // Cast it to a string
        auto str = py::cast<std::string>(obj);

        auto value = config::vars().expand(str);
        return (std::string)value;
    });

    ///-------------------------------------------------------------
    /// @details
    ///		Defines the validatePipeline function which can be
    ///		called by a python to validate a pipeline configuration.
    ///-------------------------------------------------------------
    engLib.PYBIND_FUNCTION(validatePipeline, [](py::dict config) -> py::dict {
        auto resConfig = store::pipeline::validatePipelineOrComponent(
            _mv(pyjson::dictToJson(config)));
        resConfig.checkThrow();
        return pyjson::jsonToDict(*resConfig);
    });

    //-------------------------------------------------------------
    /// @details
    ///		Declare the Entry class. This is used to set virtual
    ///		access to the currentEntry object on the endpoint
    ///		instance
    ///------------------------------------------------------------
    py::class_<Entry>(engLib, "Entry")
        .PYINIT(py::init<>())
        .PYINIT(py::init([](const std::string &url) {
            return Entry(_mv(Url(_cast<TextView>(url))));
        }))

        .PYBIND_ENTRY_PROP_READONLY_EX(std::string, fileName, url, hasFileName)
        .PYBIND_ENTRY_PROP_READONLY_EX(std::string, path, url, hasPath)
        .PYBIND_ENTRY_PROP_READONLY_EX(std::string, uniqueName, uniqueUrl,
                                       hasUniqueName)
        .PYBIND_ENTRY_PROP_READONLY_EX(std::string, uniquePath, uniqueUrl,
                                       hasUniquePath)
        .PYBIND_ENTRY_PROP_READONLY(std::string &, changeKey, hasChangeKey)

        .PYBIND_ENTRY_PROP_READONLY(std::string &, url, hasUrl)
        .PYBIND_ENTRY_PROP_READONLY(std::string &, uniqueUrl, hasUniqueUrl)
        .PYBIND_ENTRY_PROP_READWRITE(std::string &, objectId, hasObjectId)
        .PYBIND_ENTRY_PROP_READONLY(uint64_t, instanceId, hasInstanceId)
        .PYBIND_ENTRY_PROP_READONLY(uint32_t, version, hasVersion)
        .PYBIND_ENTRY_PROP_READWRITE(uint32_t, flags, hasFlags)
        .PYBIND_ENTRY_PROP_READWRITE(uint32_t, attrib, hasAttrib)
        .PYBIND_ENTRY_PROP_READWRITE(uint64_t, size, hasSize)
        .PYBIND_ENTRY_PROP_READWRITE(uint64_t, storeSize, hasStoreSize)
        .PYBIND_ENTRY_PROP_READWRITE(uint64_t, wordBatchId, hasWordBatchId)
        .PYBIND_ENTRY_PROP_READWRITE(uint64_t, vectorBatchId, hasVectorBatchId)
        .PYBIND_ENTRY_PROP_READWRITE(uint32_t, serviceId, hasServiceId)
        .PYBIND_ENTRY_PROP_READWRITE(std::string &, keyId, hasKeyId)
        .PYBIND_ENTRY_PROP_READWRITE(time_t, createTime, hasCreateTime)
        .PYBIND_ENTRY_PROP_READWRITE(time_t, changeTime, hasChangeTime)
        .PYBIND_ENTRY_PROP_READWRITE(time_t, modifyTime, hasModifyTime)
        .PYBIND_ENTRY_PROP_READWRITE(time_t, accessTime, hasAccessTime)
        .PYBIND_ENTRY_PROP_READONLY(std::string, componentId, hasComponentId)
        .PYBIND_ENTRY_PROP_READWRITE(int32_t, permissionId, hasPermissionId)
        .PYBIND_ENTRY_PROP_READWRITE(std::string &, name, hasName)

        .PYBIND_ENTRY_PROP_READONLY(IJson, metadata, hasMetadata)
        .PYBIND_ENTRY_PROP_READONLY(IJson, response, hasResponse)

        .PYBIND_PROP_READONLY_CUSTOM(
            objectFailed,
            [](const Entry &obj) -> bool { return obj.objectFailed(); })
        .PYBIND_PROP_READONLY_CUSTOM(
            objectSkipped,
            [](const Entry &obj) -> bool { return obj.objectSkipped(); })

        .PYBIND_ENTRY_PROP_READONLY(IJson, objectTags, hasObjectTags)
        .PYBIND_ENTRY_PROP_READONLY(IJson, instanceTags, hasInstanceTags)

        .PYBIND_FUNCTION(completionCode,
                         [](Entry &entry, const py::args &args) {
                             Ec code = Ec::Failed;
                             Text errmsg;

                             // Get error code and message from params
                             for (py::size_t i = 0; i < args.size(); ++i) {
                                 // Get error code from the first param if
                                 // passed
                                 if (i == 0 && py::isinstance<Ec>(args[i])) {
                                     code = py::cast<Ec>(args[i]);
                                     continue;
                                 }
                                 // Append the next param to error message
                                 Text s = std::string(py::str(args[i]));
                                 if (errmsg) errmsg.append(" ");
                                 errmsg.append(_mv(s));
                             }

                             auto ccode = APERR(code, errmsg);
                             entry.completionCode(ccode);
                         })

        .PYBIND_FUNCTION(markChanged,
                         [](Entry &entry, py::object &msg) {
                             auto changeMsg = py::cast<std::string>(msg);
                             entry.markChanged(changeMsg);
                         })

        .PYBIND_FUNCTION(toDict,
                         [](Entry &entry) -> py::dict {
                             json::Value jval = _tj(entry);
                             return pyjson::jsonToDict(jval);
                         })
        .PYBIND_FUNCTION(fromDict, [](Entry &entry, py::dict dict) {
            json::Value jval = pyjson::dictToJson(dict);
            Entry::__fromJson(entry, jval, true);
        });

    //-------------------------------------------------------------
    /// @details
    ///		Declare the python wrapper for the IPipeType class
    ///------------------------------------------------------------
    py::class_<IPipeType>(engLib, "IPipeType")
        .PYBIND_PROP_READONLY(IPipeType, std::string, id, id)
        .PYBIND_PROP_READONLY(IPipeType, std::string, logicalType, logicalType)
        .PYBIND_PROP_READONLY(IPipeType, std::string, physicalType,
                              physicalType)
        .PYBIND_PROP_READONLY(IPipeType, IJson, connConfig, connConfig);

    //-------------------------------------------------------------
    /// @details
    ///		Declare the debugger class
    ///------------------------------------------------------------
    py::class_<Debugger>(engLib, "Debugger")
        .PYBIND(getTaskId, &Debugger::getTaskId)
        .PYBIND(taskStop, &Debugger::taskStop)
        .PYBIND(taskBreak, &Debugger::taskBreak)
        .PYBIND(taskResume, &Debugger::taskResume)
        .PYBIND(taskStep, &Debugger::taskStep)
        .PYBIND(taskStepOver, &Debugger::taskStepOver)
        .PYBIND(taskStepIn, &Debugger::taskStepIn)
        .PYBIND(taskBreakpointList, &Debugger::taskBreakpointList)
        .PYBIND(taskBreakpointAdd, &Debugger::taskBreakpointAdd,
                py::arg("from_id"), py::arg("to_id") = py::none(),
                py::arg("lane") = py::none())
        .PYBIND(taskBreakpointRemove, &Debugger::taskBreakpointRemove,
                py::arg("from_id"), py::arg("to_id") = py::none(),
                py::arg("lane") = py::none())
        .PYBIND(taskBreakpointEnable, &Debugger::taskBreakpointEnable,
                py::arg("from_id"), py::arg("to_id") = py::none(),
                py::arg("lane") = py::none())
        .PYBIND(taskBreakpointDisable, &Debugger::taskBreakpointDisable,
                py::arg("from_id"), py::arg("to_id") = py::none(),
                py::arg("lane") = py::none())
        .def_static("listDebuggers", &Debugger::listDebuggers)
        .def_static("getDebugger", &Debugger::getDebugger, py::arg("taskId"));

    //-------------------------------------------------------------
    /// @details
    ///		Declare the raw class and its python wrapper
    ///------------------------------------------------------------
    py::class_<IServiceEndpoint>(engLib, "IServiceEndpoint")
        .PYBIND_PROP_READONLY(IServiceEndpoint, OPEN_MODE, openMode,
                              config.openMode)
        .PYBIND_PROP_READONLY(IServiceEndpoint, ENDPOINT_MODE, endpointMode,
                              config.endpointMode)
        .PYBIND_PROP_READONLY(IServiceEndpoint, uint64_t, level, config.level)
        .PYBIND_PROP_READONLY(IServiceEndpoint, std::string, name, config.name)
        .PYBIND_PROP_READONLY(IServiceEndpoint, std::string, key, config.key)
        .PYBIND_PROP_READONLY(IServiceEndpoint, std::string, logicalType,
                              config.logicalType)
        .PYBIND_PROP_READONLY(IServiceEndpoint, std::string, physicalType,
                              config.physicalType)
        .PYBIND_PROP_READONLY(IServiceEndpoint, std::string, protocol,
                              config.protocol)
        .PYBIND_PROP_READONLY(IServiceEndpoint, SERVICE_MODE, serviceMode,
                              config.serviceMode)
        .PYBIND_PROP_READONLY(IServiceEndpoint, uint64_t, segmentSize,
                              config.segmentSize)
        .PYBIND_PROP_READONLY(IServiceEndpoint, std::string, storePath,
                              config.storePath)
        .PYBIND_PROP_READONLY(IServiceEndpoint, std::string, commonTargetPath,
                              config.commonTargetPath)
        .PYBIND_PROP_READONLY(IServiceEndpoint, uint64_t, exportUpdateBehavior,
                              config.exportUpdateBehavior)
        .PYBIND_PROP_READONLY(IServiceEndpoint, std::string,
                              exportUpdateBehaviorName,
                              config.exportUpdateBehaviorName)
        .PYBIND_PROP_READONLY(IServiceEndpoint, IJson, jobConfig,
                              config.jobConfig)
        .PYBIND_PROP_READONLY(IServiceEndpoint, IJson, taskConfig,
                              config.taskConfig)
        .PYBIND_PROP_READONLY(IServiceEndpoint, IJson, serviceConfig,
                              config.serviceConfig)
        .PYBIND_PROP_READONLY(IServiceEndpoint, IJson, parameters,
                              config.parameters)
        .PYBIND_PROP_READONLY(IServiceEndpoint, ServiceEndpoint, target, target)
        .PYBIND_PROP_READONLY(IServiceEndpoint, IDict, bag, bag)

        .PYBIND_FUNCTION(
            getPipe,
            [](IServiceEndpoint &self) -> IServiceFilterInstance & {
                // Allow others to run while we are doing this
                engine::python::UnlockPython unlock;

                // Retrieve the processing pipeline
                auto result = self.getPipe();
                if (!result) throw result.ccode();

                // Get the ServicePipe
                auto pipe = *result;

                // Return a reference to it
                return *pipe;
            },
            py::return_value_policy::reference)

        .PYBIND_FUNCTION(
            putPipe,
            [](IServiceEndpoint &self, IServiceFilterInstance &pipe) -> void {
                // Allow others to run while we are doing this
                engine::python::UnlockPython unlock;

                // Return the pipe to the endpoint for reuse
                self.putPipe(pipe.pipe);
                return;
            })

        .PYBIND(insertFilter, &IServiceEndpoint::insertFilter)

        .PYBIND_PROP_READONLY_CUSTOM(
            keystore,
            [](const IServiceEndpoint &obj) -> keystore::KeyStorePtr {
                if (auto ccode = obj.isKeyStoreInitialized()) throw ccode;
                return obj.getKeyStore();
            })

        .PYBIND_PROP_READONLY_CUSTOM(
            debugger,
            [](engine::store::IServiceEndpoint &self)
                -> engine::store::Debugger & { return self.debugger; })

        .PYBIND_FUNCTION(
            getToken,
            [](IServiceEndpoint &obj, const std::string &key) -> std::string {
                auto value = obj.getSyncToken(key);
                if (value.hasCcode()) throw value.ccode();

                return _mv(std::string(*value));
            })

        .PYBIND_FUNCTION(setToken,
                         [](IServiceEndpoint &obj, const std::string &key,
                            const std::string &value) -> void {
                             if (auto ccode = obj.setSyncToken(key, value))
                                 throw ccode;
                         });

    py::class_<IPythonEndpointBase, IServiceEndpoint>(engLib,
                                                      "IFilterEndpoint");

    //-------------------------------------------------------------
    /// @details
    ///		Declare the IServiceFilterGlobal
    ///------------------------------------------------------------
    py::class_<IServiceFilterGlobal>(engLib, "IServiceFilterGlobal");
    py::class_<IPythonGlobalBase, IServiceFilterGlobal>(engLib, "IFilterGlobal")
        .PYBIND_PROP_READONLY(IServiceFilterGlobal, IJson, connConfig,
                              pipeType.connConfig)
        .PYBIND_PROP_READONLY(IServiceFilterGlobal, std::string, logicalType,
                              pipeType.logicalType)
        .PYBIND_PROP_READONLY(IServiceFilterGlobal, std::string, physicalType,
                              pipeType.physicalType);

    //-------------------------------------------------------------
    /// @details
    ///		Declare the IServiceFilterInstance
    ///------------------------------------------------------------
    py::class_<IServiceFilterInstance>(engLib, "IServiceFilterInstance")
        .PYBIND_PROP_READONLY(IServiceFilterInstance, uint32_t, pipeId, pipeId)
        .PYBIND_PROP_READONLY(IServiceFilterInstance, IServiceFilterInstance *,
                              next, pDown.get())
        .PYBIND_PROP_READONLY(IServiceFilterInstance, const IPipeType &,
                              pipeType, pipeType)

        .PYBIND_PROP_READONLY_CUSTOM(
            pipe,
            [](IServiceFilterInstance &self) -> ServicePipe {
                return self.pipe;
            })

        .PYBIND_PROP_READONLY_CUSTOM(
            pyInstance,
            [](IServiceFilterInstance &self) -> py::object {
                IPythonInstanceBase *pySelf =
                    _dynCast<IPythonInstanceBase *>(&self);
                return pySelf ? pySelf->getPythonInstance() : py::none();
            })

        .PYBIND(sendOpen, &IServiceFilterInstance::cb_sendOpen)
        .PYBIND(sendTagMetadata, &IServiceFilterInstance::cb_sendTagMetadata)
        .PYBIND(sendTagBeginObject,
                &IServiceFilterInstance::cb_sendTagBeginObject)
        .PYBIND(sendTagBeginStream,
                &IServiceFilterInstance::cb_sendTagBeginStream)
        .PYBIND(sendTagData, &IServiceFilterInstance::cb_sendTagData)
        .PYBIND(sendTagEndStream, &IServiceFilterInstance::cb_sendTagEndStream)
        .PYBIND(sendTagEndObject, &IServiceFilterInstance::cb_sendTagEndObject)
        .PYBIND(sendText, &IServiceFilterInstance::cb_sendText)
        .PYBIND(sendTable, &IServiceFilterInstance::cb_sendTable)
        .PYBIND(sendAudio, &IServiceFilterInstance::cb_sendAudio,
                py::arg("action"), py::arg("mimeType"),
                py::arg("streamData") = py::bytes())
        .PYBIND(sendVideo, &IServiceFilterInstance::cb_sendVideo,
                py::arg("action"), py::arg("mimeType"),
                py::arg("streamData") = py::bytes())
        .PYBIND(sendImage, &IServiceFilterInstance::cb_sendImage,
                py::arg("action"), py::arg("mimeType"),
                py::arg("streamData") = py::bytes())
        .PYBIND(sendQuestions, &IServiceFilterInstance::cb_sendQuestions,
                py::arg("questions"))
        .PYBIND(sendAnswers, &IServiceFilterInstance::cb_sendAnswers)
        .PYBIND(sendDocuments, &IServiceFilterInstance::cb_sendDocuments)
        .PYBIND(sendClassifications,
                &IServiceFilterInstance::cb_sendClassifications)
        .PYBIND(sendClassificationContext,
                &IServiceFilterInstance::cb_sendClassificationContext)
        .PYBIND(sendClose, &IServiceFilterInstance::cb_sendClose)

        .PYBIND(addPermissions, &IServiceFilterInstance::cb_addPermissions,
                py::arg("dict"), py::arg("throw_on_error") = false)
        .PYBIND(addUserGroupInfo, &IServiceFilterInstance::cb_addUserGroupInfo)
        .PYBIND(addUserInfo, &IServiceFilterInstance::cb_addUserInfo)
        .PYBIND(addGroupInfo, &IServiceFilterInstance::cb_addGroupInfo,
                py::arg("id"), py::arg("authority"), py::arg("name"),
                py::arg("local"), py::arg("groupMembers") = py::none())

        .PYBIND(hasListener, &IServiceFilterInstance::cb_hasListener)
        .PYBIND(getListeners, &IServiceFilterInstance::cb_getListeners)
        .PYBIND(getControllerNodeIds,
                &IServiceFilterInstance::cb_getControllerNodeIds)
        .PYBIND(control, &IServiceFilterInstance::cb_control,
                py::arg("classType"), py::arg("control"),
                py::arg("nodeId") = "")
        .PYBIND(setTargetFilter, &IServiceFilterInstance::cb_setTargetFilter)
        .PYBIND(open, &IServiceFilterInstance::cb_open)
        .PYBIND(writeTagBeginObject,
                &IServiceFilterInstance::cb_writeTagBeginObject)
        .PYBIND(writeTagBeginStream,
                &IServiceFilterInstance::cb_writeTagBeginStream)
        .PYBIND(writeTagData, &IServiceFilterInstance::cb_writeTagData)
        .PYBIND(writeTag, &IServiceFilterInstance::cb_writeTag)
        .PYBIND(writeText, &IServiceFilterInstance::cb_writeText)
        .PYBIND(writeTable, &IServiceFilterInstance::cb_writeTable)
        .PYBIND(writeAudio, &IServiceFilterInstance::cb_writeAudio,
                py::arg("action"), py::arg("mimeType"),
                py::arg("streamData") = py::bytes())
        .PYBIND(writeVideo, &IServiceFilterInstance::cb_writeVideo,
                py::arg("action"), py::arg("mimeType"),
                py::arg("streamData") = py::bytes())
        .PYBIND(writeImage, &IServiceFilterInstance::cb_writeImage,
                py::arg("action"), py::arg("mimeType"),
                py::arg("streamData") = py::bytes())
        .PYBIND(writeQuestions, &IServiceFilterInstance::cb_writeQuestions,
                py::arg("questions"))
        .PYBIND(writeAnswers, &IServiceFilterInstance::cb_writeAnswers)
        .PYBIND(writeDocuments, &IServiceFilterInstance::cb_writeDocuments)
        .PYBIND(writeClassifications,
                &IServiceFilterInstance::cb_writeClassifications)
        .PYBIND(writeClassificationContext,
                &IServiceFilterInstance::cb_writeClassificationContext)
        .PYBIND(writeTagEndStream,
                &IServiceFilterInstance::cb_writeTagEndStream)
        .PYBIND(writeTagEndObject,
                &IServiceFilterInstance::cb_writeTagEndObject)
        .PYBIND(close, &IServiceFilterInstance::cb_close)
        .PYBIND(closing, &IServiceFilterInstance::cb_close)

        .PYBIND_PROP_READONLY_CUSTOM(
            currentObject, [](IServiceFilterInstance &obj) -> py::object {
                if (obj.currentEntry)
                    // Return a reference
                    return py::cast(obj.currentEntry,
                                    py::return_value_policy::reference);
                else
                    return py::none();
            });

    py::class_<IPythonInstanceBase, IServiceFilterInstance>(engLib,
                                                            "IFilterInstance")
        .PYBIND_PROP_READONLY(IPythonInstanceBase, py::object, pyInstance,
                              getPythonInstance())

        .PYBIND_PROP_READONLY_CUSTOM(
            targetObjectUrl,
            [](IPythonInstanceBase &obj) -> py::object {
                // It is safe to cast this as we provided it
                if (obj.getTargetObjectUrl().fullpath())
                    return py::str(_ts(obj.getTargetObjectUrl()));
                else
                    return py::none();
            })

        .PYBIND_PROP_READONLY_CUSTOM(
            targetObjectPath, [](IPythonInstanceBase &obj) -> py::object {
                if (obj.getTargetObjectPath())
                    return py::str(obj.getTargetObjectPath());
                else
                    return py::none();
            });

    //-------------------------------------------------------------
    /// @details
    ///		Declare the KeyStorePtr
    ///------------------------------------------------------------
    py::class_<keystore::KeyStore, keystore::KeyStorePtr>(engLib, "KeyStore")
        .PYBIND_FUNCTION(getValue,
                         [](keystore::KeyStorePtr &keystore,
                            const std::string &key) -> std::string {
                             auto value = keystore->getValue(key);
                             if (value.hasCcode()) throw value.ccode();

                             return _mv(std::string(*value));
                         })
        .PYBIND_FUNCTION(
            getValue,
            [](keystore::KeyStorePtr &keystore, const std::string &partition,
               const std::string &key) -> std::string {
                auto value = keystore->getValue(partition, key);
                if (value.hasCcode()) throw value.ccode();

                return _mv(std::string(*value));
            })
        .PYBIND_FUNCTION(
            setValue,
            [](keystore::KeyStorePtr &keystore, const std::string &key,
               const std::string &value) -> void {
                if (auto ccode = keystore->setValue(key, value)) throw ccode;
            })
        .PYBIND_FUNCTION(
            setValue,
            [](keystore::KeyStorePtr &keystore, const std::string &partition,
               const std::string &key, const std::string &value) -> void {
                if (auto ccode = keystore->setValue(partition, key, value))
                    throw ccode;
            })
        .PYBIND_FUNCTION(getSecureValue,
                         [](keystore::KeyStorePtr &keystore,
                            const std::string &key) -> std::string {
                             // Get the value from the storage
                             auto value = keystore->getSecureValue(key);
                             if (value.hasCcode()) throw value.ccode();

                             return _mv(std::string(*value));
                         })
        .PYBIND_FUNCTION(
            setSecureValue,
            [](keystore::KeyStorePtr &keystore, const std::string &key,
               const std::string &value) -> void {
                // Set the value to the storage
                if (auto ccode = keystore->setSecureValue(key, value))
                    throw ccode;
            })
        .PYBIND_FUNCTION(deleteAll,
                         [](keystore::KeyStorePtr &keystore) -> void {
                             if (auto ccode = keystore->deleteAll())
                                 throw ccode;
                         })
        .PYBIND_FUNCTION(deleteAll,
                         [](keystore::KeyStorePtr &keystore,
                            const std::string &partition) -> void {
                             if (auto ccode = keystore->deleteAll(partition))
                                 throw ccode;
                         });

    //-------------------------------------------------------------
    // @details
    //		This is the top level class that python will
    //		instantiate to start the loading process.
    //		In python, use it like:
    //			loader = engLib.Loader()
    //			loader.beginLoad()
    //				endpoint = loader.endpoint
    //				pipe = endpoint.getPipe()
    //				pipe.open(...) = ...
    //				pipe.writeTagData(data)
    //				pipe.close(...) = ...
    //				endpoint.putPipe(pipe)
    //			loader.endLoad()
    //-------------------------------------------------------------
    py::class_<IServiceFilterInstancePipe, IServiceFilterInstance>(
        engLib, "IServiceFilterPipe");

    py::class_<ILoader>(engLib, "ILoader")
        .PYINIT(py::init<>())
        .PYBIND(beginLoad, &ILoader::beginLoad, py::arg("pipes") = py::dict())
        .PYBIND_PROP_READONLY_CUSTOM(
            target,
            [](const ILoader &obj) -> py::object {
                return obj.target ? py::cast(obj.target.get(),
                                             py::return_value_policy::reference)
                                  : py::none();
            })
        .PYBIND(endLoad, &ILoader::endLoad)
        .def_static("getPipeStack", &ILoader::getPipeStack,
                    py::arg("pipes") = py::dict());

    //-------------------------------------------------------------
    /// @details
    ///		Declare the IOBuffer interface for target mode
    ///------------------------------------------------------------
    py::class_<IOBuffer>(engLib, "IOBuffer")
        .PYBIND_PROP_READONLY(IOBuffer, std::string, name, name)
        .PYBIND_PROP_READONLY(IOBuffer, uint32_t, segmentId, segmentId)

        .PYBIND_PROP_READWRITE_CUSTOM(
            data,
            [](const IOBuffer &obj) -> py::bytes {
                auto data = _reCast<const char *>(&obj.data[0]);
                auto dataSize = _cast<py::ssize_t>(obj.dataSize);
                return py::bytes(data, dataSize);
            },
            [](IOBuffer &obj, py::bytes bytes) {
                auto info = py::buffer(bytes).request();
                if (info.size * info.itemsize >
                    _cast<py::ssize_t>(obj.dataSize))
                    throw APERR(Ec::OutOfRange, "IOBuffer[", obj.dataSize,
                                "]: writing py::bytes[",
                                info.size * info.itemsize, "]: data to large");
                std::memcpy(_cast<void *>(&obj.data[0]), info.ptr,
                            info.size * info.itemsize);
                obj.dataSize = _cast<Dword>(info.size * info.itemsize);
            });

    //-------------------------------------------------------------
    /// @details
    ///		Declare the paths
    ///------------------------------------------------------------
#pragma push_macro("LOG")
#undef LOG
    py::class_<config::Paths>(engLib, "Paths")
        .PYBIND_PROP_READONLY_STATIC(DATA,
                                     config::paths().data.plat(false).c_str())
        .PYBIND_PROP_READONLY_STATIC(CACHE,
                                     config::paths().cache.plat(false).c_str())
        .PYBIND_PROP_READONLY_STATIC(
            CONTROL, config::paths().control.plat(false).c_str())
        .PYBIND_PROP_READONLY_STATIC(LOG,
                                     config::paths().log.plat(false).c_str());
#pragma pop_macro("LOG")

    //-------------------------------------------------------------
    /// @details
    ///		Declare a IJson handler so our IJson/json::Values
    ///     can be read/written to just like a dict, without
    ///     copying. Also, this supports directly converting
    ///     values on the fly from a dict to a function requiring
    ///     a json::Value
    ///------------------------------------------------------------
    py::class_<IJsonIterator>(engLib, "IJsonIterator")
        .PYBIND(__next__, &IJsonIterator::next);

    py::class_<IJson>(engLib, "IJson")
        .PYINIT(py::init<>())
        .PYINIT(py::init<py::dict>())
        .PYINIT(py::init<py::list>())
        .PYINIT(py::init<IJson>())
        .PYBIND(keys, &IJson::keys)
        .PYBIND(values, &IJson::values)
        .PYBIND(items, &IJson::items)
        .PYBIND(len, &IJson::len)
        .PYBIND(clear, &IJson::clear)
        .PYBIND(append, &IJson::append)
        .PYBIND(insert, &IJson::insert)
        .PYBIND(remove, &IJson::remove)
        .PYBIND(get, &IJson::get, py::arg("key"), py::arg("def") = py::none())
        .PYBIND(toDict, &IJson::toDict)
        .PYBIND(__contains__, &IJson::contains)
        .PYBIND(__iter__, &IJson::iter, py::keep_alive<0, 1>())
        .PYBIND(__dir__, &IJson::dir)
        .PYBIND(__getattr__, &IJson::getattr)
        .PYBIND(__len__, &IJson::len)
        .PYBIND(__str__, &IJson::repr)
        .PYBIND(__repr__, &IJson::repr)
        .PYBIND(__delitem__, &IJson::delitem)
        .PYBIND(__getitem__, &IJson::getitem)
        .PYBIND(__setitem__, &IJson::setitem);

    //-------------------------------------------------------------
    /// @details
    ///		Bind error codes (Ec enum)
    ///------------------------------------------------------------
    py::enum_<AVI_ACTION>(engLib, "AVI_ACTION")
        .PYENUM(BEGIN, AVI_ACTION::BEGIN)
        .PYENUM(WRITE, AVI_ACTION::WRITE)
        .PYENUM(END, AVI_ACTION::END);

    //-------------------------------------------------------------
    /// @details
    ///		Bind log levels (Lvl enum)
    ///------------------------------------------------------------
    py::enum_<Lvl>(engLib, "Lvl")
        .PYENUM(Python, Lvl::Python)
        .PYENUM(Remoting, Lvl::Remoting)
        .PYENUM(DebugOut, Lvl::DebugOut)
        .PYENUM(DebugProtocol, Lvl::DebugProtocol);

    //-------------------------------------------------------------
    /// @details
    ///		Bind error codes (Ec enum)
    ///------------------------------------------------------------
    py::enum_<Ec>(engLib, "Ec")
        .PYENUM(NoErr, Ec::NoErr)
        .PYENUM(AccessDenied, Ec::AccessDenied)
        .PYENUM(AlreadyOpened, Ec::AlreadyOpened)
        .PYENUM(BatchExceeded, Ec::BatchExceeded)
        .PYENUM(BatchThreshold, Ec::BatchThreshold)
        .PYENUM(BlobImmutable, Ec::BlobImmutable)
        .PYENUM(Bug, Ec::Bug)
        .PYENUM(Cancelled, Ec::Cancelled)
        .PYENUM(Cipher, Ec::Cipher)
        .PYENUM(Classify, Ec::Classify)
        .PYENUM(ClassifyContent, Ec::ClassifyContent)
        .PYENUM(CoInit, Ec::CoInit)
        .PYENUM(Completed, Ec::Completed)
        .PYENUM(ElevationRequired, Ec::ElevationRequired)
        .PYENUM(Empty, Ec::Empty)
        .PYENUM(End, Ec::End)
        .PYENUM(Error, Ec::Error)
        .PYENUM(Exception, Ec::Exception)
        .PYENUM(Excluded, Ec::Excluded)
        .PYENUM(Exists, Ec::Exists)
        .PYENUM(ExpiredAuthentication, Ec::ExpiredAuthentication)
        .PYENUM(FactoryNotFound, Ec::FactoryNotFound)
        .PYENUM(Failed, Ec::Failed)
        .PYENUM(Fatality, Ec::Fatality)
        .PYENUM(FileChanged, Ec::FileChanged)
        .PYENUM(FileNotChanged, Ec::FileNotChanged)
        .PYENUM(Fuse, Ec::Fuse)
        .PYENUM(Icu, Ec::Icu)
        .PYENUM(InvalidAuthentication, Ec::InvalidAuthentication)
        .PYENUM(InvalidCipher, Ec::InvalidCipher)
        .PYENUM(InvalidCommand, Ec::InvalidCommand)
        .PYENUM(InvalidDocument, Ec::InvalidDocument)
        .PYENUM(InvalidFormat, Ec::InvalidFormat)
        .PYENUM(InvalidJson, Ec::InvalidJson)
        .PYENUM(InvalidKeyToken, Ec::InvalidKeyToken)
        .PYENUM(InvalidName, Ec::InvalidName)
        .PYENUM(InvalidParam, Ec::InvalidParam)
        .PYENUM(InvalidRpc, Ec::InvalidRpc)
        .PYENUM(InvalidSchema, Ec::InvalidSchema)
        .PYENUM(InvalidSelection, Ec::InvalidSelection)
        .PYENUM(InvalidState, Ec::InvalidState)
        .PYENUM(InvalidSyntax, Ec::InvalidSyntax)
        .PYENUM(InvalidUrl, Ec::InvalidUrl)
        .PYENUM(InvalidXml, Ec::InvalidXml)
        .PYENUM(Java, Ec::Java)
        .PYENUM(Json, Ec::Json)
        .PYENUM(Locked, Ec::Locked)
        .PYENUM(MaxWords, Ec::MaxWords)
        .PYENUM(NoMatch, Ec::NoMatch)
        .PYENUM(NoPermissions, Ec::NoPermissions)
        .PYENUM(NotFound, Ec::NotFound)
        .PYENUM(NotOpen, Ec::NotOpen)
        .PYENUM(NotSupported, Ec::NotSupported)
        .PYENUM(OutOfMemory, Ec::OutOfMemory)
        .PYENUM(OutOfRange, Ec::OutOfRange)
        .PYENUM(Overflow, Ec::Overflow)
        .PYENUM(Read, Ec::Read)
        .PYENUM(Recursion, Ec::Recursion)
        .PYENUM(RemoteException, Ec::RemoteException)
        .PYENUM(RequestFailed, Ec::RequestFailed)
        .PYENUM(ResultBufferTooSmall, Ec::ResultBufferTooSmall)
        .PYENUM(Retry, Ec::Retry)
        .PYENUM(SQLite, Ec::SQLite)
        .PYENUM(ShortRead, Ec::ShortRead)
        .PYENUM(Skipped, Ec::Skipped)
        .PYENUM(PreventDefault, Ec::PreventDefault)
        .PYENUM(StringParse, Ec::StringParse)
        .PYENUM(TestFailure, Ec::TestFailure)
        .PYENUM(Timeout, Ec::Timeout)
        .PYENUM(Unexpected, Ec::Unexpected)
        .PYENUM(Warning, Ec::Warning)
        .PYENUM(Write, Ec::Write)
        .PYENUM(HandleInvalid, Ec::HandleInvalid)
        .PYENUM(HandleInvalidSeq, Ec::HandleInvalidSeq)
        .PYENUM(HandleInvalidState, Ec::HandleInvalidState)
        .PYENUM(HandleOutOfSlots, Ec::HandleOutOfSlots)
        .PYENUM(TagInvalidClass, Ec::TagInvalidClass)
        .PYENUM(TagInvalidFileSig, Ec::TagInvalidFileSig)
        .PYENUM(TagInvalidHdr, Ec::TagInvalidHdr)
        .PYENUM(TagInvalidSig, Ec::TagInvalidSig)
        .PYENUM(TagInvalidSize, Ec::TagInvalidSize)
        .PYENUM(TagInvalidType, Ec::TagInvalidType)
        .PYENUM(PackInvalidSig, Ec::PackInvalidSig)
        .PYENUM(PackInvalid, Ec::PackInvalid)
        .PYENUM(Lz4Inflate, Ec::Lz4Inflate)
        .PYENUM(Lz4Deflate, Ec::Lz4Deflate)
        .PYENUM(LicenseLimit, Ec::LicenseLimit)
        .PYENUM(InvalidFilename, Ec::InvalidFilename);

    //-------------------------------------------------------------
    /// @details
    ///		Define the class with the protocol capatibilities
    ///------------------------------------------------------------
    py::class_<url::UrlConfig::PROTOCOL_CAPS>(engLib, "PROTOCOL_CAPS")
        .PYBIND_PROP_READONLY_STATIC(SECURITY,
                                     url::UrlConfig::PROTOCOL_CAPS::SECURITY)
        .PYBIND_PROP_READONLY_STATIC(FILESYSTEM,
                                     url::UrlConfig::PROTOCOL_CAPS::FILESYSTEM)
        .PYBIND_PROP_READONLY_STATIC(SUBSTREAM,
                                     url::UrlConfig::PROTOCOL_CAPS::SUBSTREAM)
        .PYBIND_PROP_READONLY_STATIC(NETWORK,
                                     url::UrlConfig::PROTOCOL_CAPS::NETWORK)
        .PYBIND_PROP_READONLY_STATIC(DATANET,
                                     url::UrlConfig::PROTOCOL_CAPS::DATANET)
        .PYBIND_PROP_READONLY_STATIC(SYNC, url::UrlConfig::PROTOCOL_CAPS::SYNC)
        .PYBIND_PROP_READONLY_STATIC(INTERNAL,
                                     url::UrlConfig::PROTOCOL_CAPS::INTERNAL)
        .PYBIND_PROP_READONLY_STATIC(CATALOG,
                                     url::UrlConfig::PROTOCOL_CAPS::CATALOG)
        .PYBIND_PROP_READONLY_STATIC(NOMONITOR,
                                     url::UrlConfig::PROTOCOL_CAPS::NOMONITOR)
        .PYBIND_PROP_READONLY_STATIC(NOINCLUDE,
                                     url::UrlConfig::PROTOCOL_CAPS::NOINCLUDE)
        .PYBIND_PROP_READONLY_STATIC(INVOKE,
                                     url::UrlConfig::PROTOCOL_CAPS::INVOKE)
        .PYBIND_PROP_READONLY_STATIC(REMOTING,
                                     url::UrlConfig::PROTOCOL_CAPS::REMOTING)
        .PYBIND_PROP_READONLY_STATIC(GPU, url::UrlConfig::PROTOCOL_CAPS::GPU)
        .PYBIND_PROP_READONLY_STATIC(DEPRECATED, url::UrlConfig::PROTOCOL_CAPS::DEPRECATED)
        .PYBIND_PROP_READONLY_STATIC(EXPERIMENTAL, url::UrlConfig::PROTOCOL_CAPS::EXPERIMENTAL)

        .PYBIND_FUNCTION_STATIC(
            getProtocolCaps, [](const std::string &protocol) -> uint32_t {
                uint32_t caps = 0;
                if (auto ccode = url::UrlConfig::getCaps(protocol, caps))
                    throw ccode;
                return caps;
            });

    //-------------------------------------------------------------
    /// @details
    ///		Define the class with the filter names
    ///------------------------------------------------------------
    class __FiltersStub {};
    py::class_<__FiltersStub>(engLib, "Filters")
        .PYBIND_PROP_READONLY_STATIC(CLASSIFY, filter::classify::Type.data());

    //-------------------------------------------------------------
    /// @details
    ///		Define the FLAGS bitmap class
    ///------------------------------------------------------------
    py::class_<Entry::FLAGS>(engLib, "FLAGS")
        .PYBIND_PROP_READONLY_STATIC(NONE, Entry::FLAGS::NONE)
        .PYBIND_PROP_READONLY_STATIC(INDEX, Entry::FLAGS::INDEX)
        .PYBIND_PROP_READONLY_STATIC(CLASSIFY, Entry::FLAGS::CLASSIFY)
        .PYBIND_PROP_READONLY_STATIC(OCR, Entry::FLAGS::OCR)
        .PYBIND_PROP_READONLY_STATIC(MAGICK, Entry::FLAGS::MAGICK)
        .PYBIND_PROP_READONLY_STATIC(SIGNING, Entry::FLAGS::SIGNING)
        .PYBIND_PROP_READONLY_STATIC(OCR_DONE, Entry::FLAGS::OCR_DONE)
        .PYBIND_PROP_READONLY_STATIC(PERMISSIONS, Entry::FLAGS::PERMISSIONS)
        .PYBIND_PROP_READONLY_STATIC(VECTORIZE, Entry::FLAGS::VECTORIZE);

    //-------------------------------------------------------------
    /// @details
    ///		Define the endpoint open modes
    ///------------------------------------------------------------
    py::enum_<OPEN_MODE>(engLib, "OPEN_MODE")
        .PYENUM(NONE, OPEN_MODE::NONE)
        .PYENUM(TARGET, OPEN_MODE::TARGET)
        .PYENUM(SOURCE, OPEN_MODE::SOURCE)
        .PYENUM(SOURCE_INDEX, OPEN_MODE::SOURCE_INDEX)
        .PYENUM(SCAN, OPEN_MODE::SCAN)
        .PYENUM(CONFIG, OPEN_MODE::CONFIG)
        .PYENUM(INDEX, OPEN_MODE::INDEX)
        .PYENUM(CLASSIFY, OPEN_MODE::CLASSIFY)
        .PYENUM(INSTANCE, OPEN_MODE::INSTANCE)
        .PYENUM(CLASSIFY_FILE, OPEN_MODE::CLASSIFY_FILE)
        .PYENUM(HASH, OPEN_MODE::HASH)
        .PYENUM(STAT, OPEN_MODE::STAT)
        .PYENUM(REMOVE, OPEN_MODE::REMOVE)
        .PYENUM(TRANSFORM, OPEN_MODE::TRANSFORM)
        .PYENUM(PIPELINE, OPEN_MODE::PIPELINE)
        .PYENUM(PIPELINE_CONFIG, OPEN_MODE::PIPELINE_CONFIG);

    //-------------------------------------------------------------
    /// @details
    ///		Define the endpoint modes
    ///------------------------------------------------------------
    py::enum_<ENDPOINT_MODE>(engLib, "ENDPOINT_MODE")
        .PYENUM(NONE, ENDPOINT_MODE::NONE)
        .PYENUM(SOURCE, ENDPOINT_MODE::SOURCE)
        .PYENUM(TARGET, ENDPOINT_MODE::TARGET);

    //-------------------------------------------------------------
    /// @details
    ///		Define the service modes
    ///------------------------------------------------------------
    py::enum_<SERVICE_MODE>(engLib, "SERVICE_MODE")
        .PYENUM(NONE, SERVICE_MODE::NONE)
        .PYENUM(SOURCE, SERVICE_MODE::SOURCE)
        .PYENUM(TARGET, SERVICE_MODE::TARGET)
        .PYENUM(NEITHER, SERVICE_MODE::NEITHER);

    //-------------------------------------------------------------
    /// @details
    ///		Define classes and interfaces for parsing into
    ///		the IOBuffer
    ///------------------------------------------------------------
    py::enum_<TAG_ID>(engLib, "TAG_ID")
        .PYENUM(INVALID, TAG_ID::INVALID)
        .PYENUM(OBEG, TAG_ID::OBEG)
        .PYENUM(OMET, TAG_ID::OMET)
        .PYENUM(OENC, TAG_ID::OENC)
        .PYENUM(SBGN, TAG_ID::SBGN)
        .PYENUM(SDAT, TAG_ID::SDAT)
        .PYENUM(SEND, TAG_ID::SEND)
        .PYENUM(OSIG, TAG_ID::OSIG)
        .PYENUM(OEND, TAG_ID::OEND)
        .PYENUM(ENCK, TAG_ID::ENCK)
        .PYENUM(ENCR, TAG_ID::ENCR)
        .PYENUM(CMPR, TAG_ID::CMPR)
        .PYENUM(HASH, TAG_ID::HASH);

    py::class_<TAG>(engLib, "TAG")
        .PYBIND_PROP_READONLY(TAG, TAG_ID, tagId, tagId)
        .PYBIND_PROP_READONLY_CUSTOM(
            data,
            [](const TAG &tag) -> py::object {
                if (tag.tagId == TAG_ID::SDAT || tag.tagId == TAG_ID::OENC) {
                    auto dataTag = _reCast<const TAG_VALUE_DATA &>(tag);
                    auto data = _reCast<const char *>(dataTag.data.data);
                    auto dataSize = _cast<py::size_t>(dataTag.size);
                    return py::bytes(data, dataSize);
                } else {
                    return py::none();
                }
            })
        .PYBIND_PROP_READONLY_CUSTOM(
            value,
            [](const TAG &tag) -> py::str {
                if (tag.tagId == TAG_ID::OMET) {
                    auto strTag = _reCast<const TAG_VALUE_STRING &>(tag);
                    auto value = _reCast<const char *>(strTag.data.value);
                    auto valueSize = _cast<py::size_t>(strTag.size);
                    return py::str(value, valueSize);
                } else {
                    return py::none();
                }
            })
        .PYBIND_PROP_READONLY_CUSTOM(asBytes,
                                     [](const TAG &tag) -> py::bytes {
                                         return py::bytes(
                                             _reCast<const char *>(&tag),
                                             sizeof(TAG) + tag.size);
                                     })
        .PYBIND_PROP_READONLY(TAG, py::size_t, size, size)
        .PYBIND(__len__, [](const TAG &tag) -> py::size_t {
            return sizeof(TAG) + tag.size;
        });
};
}  // namespace engine::store::pythonBase
