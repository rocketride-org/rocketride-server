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
#include <filesystem>
#ifdef _WIN32
#include <fcntl.h>  // for _O_RDONLY
#include <io.h>     // for _dup, _dup2, _open, _close, _fileno
#endif

namespace {
namespace py = pybind11;

//-------------------------------------------------------------------------
/// @details
///		Option to force into python mode
//-------------------------------------------------------------------------
static application::Opt ExecPython{"--python"};

//-------------------------------------------------------------------------
/// @details
///		This holds the generated configuration which will be active while
///		the python interpreter is active
//-------------------------------------------------------------------------
::PyConfig g_config;

//-------------------------------------------------------------------------
/// @details
///		This is saved away by the python executeArguments function
///		It is exclusvely used when executing in debug mode and dbgconn.py
///		calls executeArguments. Unfortunately, we cannot pack a detailed
///		error message engine => python => engine => so we save it away
///		eror
///------------------------------------------------------------------------
Error g_processCommandLineResults = {};

//-------------------------------------------------------------------------
/// @details
///		Stores the thread state between init/deinit
///------------------------------------------------------------------------
PyThreadState *g_threadState;

//-------------------------------------------------------------------------
/// @details
///		Have we completed initialization
//-------------------------------------------------------------------------
bool g_initialized = false;

//-------------------------------------------------------------------------
/// @details
///		Checks if an exception was raised on creates a ccode out it
//-------------------------------------------------------------------------
bool g_setupThreadDebugMessage = false;

//-------------------------------------------------------------------------
/// @details
///		Checks if an exception was raised on creates a ccode out it
///------------------------------------------------------------------------
Error checkStatus(::PyStatus status) {
    if (::PyStatus_Exception(status)) {
        LOG(Python, status.err_msg);
        return APERR(Ec::Python, status.err_msg);
    }
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		After python has been initialized, add our search paths to the
///     beginning of the path list
///------------------------------------------------------------------------
Error setPaths() {
    // Setup our paths
    auto python = localfcn()->Error {
        // Get our root directory to the python files1
        const auto root = engine::python::rootDir();

        // Create our array of paths
        //
        // We are removing the direct search into the ai and nodes
        // paths since we really want to force full path resolution. If
        // we leave these, it will allow a module to be loaded as
        //
        //		from ai.common.schema import ...
        //		from common.schema import ...
        //
        // This causes real problems in python since they will be loaded
        // as two distinct modules, when they actually should be the
        // same module
        std::vector<Text> paths;

        for (auto devRoot : {"../..", "../../.."}) {
            auto pkgRoot = (root / devRoot / "packages").resolve();
            for (auto pkgPath : {"server/engine-lib/rocketlib-python/lib",
                                 "client-python/src", "ai/src"})
                paths.push_back((pkgRoot / pkgPath).resolve().str());

            paths.push_back((root / devRoot / "nodes/src").resolve().str());

            if (_allOf(paths, file::exists)) {
                // We found all the paths, we are in dev mode
                LOG(Python, "Python development paths:", pkgRoot);
                break;
            }

            // Clear out the paths since we didn't find them all
            paths.clear();
        }

        // Let's add the production path only if we are not in dev mode
        if (paths.empty()) {
            LOG(Python, "Python production paths:", root);
            paths.push_back(root.str());
        }

        // Access Python's sys.path
        py::object sys = py::module_::import("sys");
        py::list sys_path = sys.attr("path");

        // Import the pathlib module
        py::object pathlib = py::module_::import("pathlib");
        py::object createPath = pathlib.attr("Path");

        // Iterate over paths in reverse order to maintain order at the
        // beginning of the list
        for (auto it = paths.rbegin(); it != paths.rend(); ++it) {
            try {
                // Convert the path to a string
                const std::string path = *it;

                // Create a python path string
                const auto path_python_string = py::str(path);

                // Convert the resolved path back to a string
                py::object path_python = createPath(path_python_string);

                // Get the resolved path
                py::object resolved_path = path_python.attr("resolve")();

                // Check if the path exists as a std::filesystem::path
                std::filesystem::path std_path =
                    resolved_path.attr("as_posix")().cast<std::string>();
                if (std::filesystem::exists(std_path)) {
                    // Insert the resolved path at the beginning of sys.path
                    sys_path.insert(0, py::str(resolved_path));
                }
            } catch (std::exception &e) {
                LOG(Python, "Warning: Could not add path", *it, e);
            }
        }

        return {};
    };

    // Call it
    return callPython(python);
}

//---------------------------------------------------------------------
/// @details
///		Store this away so we don't lose it
//---------------------------------------------------------------------
void setProcessCommandLineResults(Error &ccode) noexcept {
    LOG(Python, "Setting command line results=", ccode);
    g_processCommandLineResults = ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Setup the python configuration for our embedded environment
///------------------------------------------------------------------------
Error setConfig(int argc, wchar_t **argv) {
    Text path;

    // Get our root directory to the python files
    const auto root = engine::python::rootDir();

    // Initialize the isolated config
    ::PyConfig_InitIsolatedConfig(&g_config);

    // Parse the argv we set
    g_config.parse_argv = 1;

    // Disable Python stdio buffering so print() output reaches piped
    // stdout immediately (e.g. when spawned by VS Code with stdio: 'pipe')
    g_config.buffered_stdio = 0;

    // Setup the arguments
    if (auto ccode = checkStatus(::PyConfig_SetArgv(&g_config, argc, argv)))
        return ccode;

    // Setup our home dir before processing arguments
    path = _cast<Text>(root.plat(false));
    if (auto ccode = checkStatus(::PyConfig_SetString(
            &g_config, &g_config.home, _cast<const wchar_t *>(path))))
        return ccode;

    // Process the arguments
    if (auto ccode = checkStatus(::PyConfig_Read(&g_config))) return ccode;

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Release the config as we are done with it
///------------------------------------------------------------------------
Error clearConfig() {
    ::PyConfig_Clear(&g_config);
    return {};
}
}  // namespace

namespace engine::python {
namespace py = pybind11;
using namespace pybind11::literals;

// This is used by the GIL locking mechanism
thread_local bool tls_thread_state_ref;

// These are debugger support variables
thread_local bool tls_debug_attached = false;
thread_local int tls_debug_processed = 0;
thread_local bool tls_thread_named = false;

//---------------------------------------------------------------------
/// @details
///		Force a garbage collect
//---------------------------------------------------------------------
void collect() {
    // Ensure the Python interpreter is initialized
    engine::python::LockPython lock;

    // Import the gc module and run a manual garbage collection
    py::module gc = py::module::import("gc");

    // Force garbage collection
    gc.attr("collect")();
}

//---------------------------------------------------------------------
/// @details
///		Store this away so we don't lose it
//---------------------------------------------------------------------
void setProcessCommandLineResults(Error &ccode) noexcept {
    LOG(Python, "Setting command line results=", ccode);
    g_processCommandLineResults = ccode;
}

//---------------------------------------------------------------------
/// @details
///		Sets up the calling thread for debugging if python debug is
///		enabled. This MUST by called while the GIL is locked
///--------------------------------------------------------------------
void setupDebug() noexcept {
    // If the debugger is not attached
    if (!tls_debug_attached) {
        // If we have already tried to setup at least 5 times, done. This occurs
        // since we need to call into python a few times before debugpy is
        // actually loaded
        if (tls_debug_processed < 5) {
            // One more attempt
            tls_debug_processed++;

            // Check what debugging modules are available
            auto sys_modules = py::module_::import("sys").attr("modules");

            try {
                // If debugpy is loaded, we can attach to it
                if (sys_modules.contains("debugpy")) {
                    // Get the module
                    auto debugPy = py::module_::import("debugpy");

                    // Get the attach function and call it
                    auto attach = debugPy.attr("debug_this_thread")();

                    // Say we are now attached
                    tls_debug_attached = true;
                    LOG(Python, "Debugger attached to debugpy");
                }
            } catch (const py::error_already_set &e) {
                LOG(Python,
                    "Debugging not available or is not yet attached: {}",
                    e.what());
            } catch (...) {
                LOG(Python, "Error setting attaching to debugpy");
            }
        }
    }

    // If we have not named the thread for python yet, we will do so now.
    if (!tls_thread_named) {
        try {
            // Get the name of this thread
            std::string name = std::string(ap::async::getCurrentThreadName());

            // Output a message
            LOG(Python, "Updating thread name to", name);

            // Get the threading module
            py::module threading = py::module::import("threading");

            // Get the callers thread in python
            py::object currentThread = threading.attr("current_thread")();

            // Set the name
            currentThread.attr("name") = name;
        } catch (const py::error_already_set &e) {
            LOG(Python, "Python error during debug set thread name {}",
                e.what());
        } catch (...) {
            LOG(Python, "Error setting up thread name");
        }

        // Only attempt this once
        tls_thread_named = true;
    }
}

//---------------------------------------------------------------------
/// @details
///		This function will determine if the command line given is
///		directed to python or not. To do this, we look at all the
///		parameters up until the, optional, -- argument, which is
///		used to pass additional options to the engine
//---------------------------------------------------------------------
bool isPython() noexcept {
    // If --python was specified, forces into python mode
    if (ExecPython) return true;

    // Get the  arguments
    auto args = application::args();

    // Output the command arguments
    LOG(Python, args);

    // Loop through the arguments, the first being the program name
    // which can be ignored
    for (auto index = 1; index < args.size(); index++) {
        // Get the argument
        auto &arg = args[index];

        // Stop on --
        if (arg == "--") break;

        // It is not an option, check if it is a .py, it is a module
        // specifier, or we are running python code directly, we have python!
        if (arg.endsWith(".py")) {
            LOG(Python, "Python program recognized, starting as python");
            return true;
        }

        // It is not an option, check if it is a .py, it is a module
        // specifier, or we are running python code directly, we have python!
        if (arg == "-c") {
            LOG(Python, "Python string recognized, starting as python");
            return true;
        }

        // It is not an option, check if it is a .py, it is a module
        // specifier, or we are running python code directly, we have python!
        if (arg == "-m" || arg == "-Im") {
            LOG(Python, "Python module recognized, starting as python");
            return true;
        }

        // Lets see if it is a module
        file::Path argpath{arg};

        // Remove any /./ or /../ sequences
        file::Path module = argpath.resolve();

        // If it has an __init__.py, it is a module, hence python!
        if (file::exists(module / "__init__.py")) {
            LOG(Python, "Python module specified, starting as python");
            return true;
        }
    }

    // We didn't recognize this as a python command line
    LOG(Python, "Python startup not recognized");
    return false;
}

//---------------------------------------------------------------------
/// @details
///		Init method for initializing the RocketRide Python subsystem
///--------------------------------------------------------------------
Error init() noexcept {
    // Initialize the JVM
    LOG(Python, "Python init");

    // Get the original arguments
    auto args = application::args();

    // Wide characters we pass over to Py_Main
    wchar_t **argv = new wchar_t *[application::argc()];
    int argc = 0;

    // If we are actually running a python script, then send all the parameters
    // to python. Otherwise, only send the executable name
    if (isPython()) {
        // Loop through all the arguments that are left
        for (auto index = 0; index < args.size(); index++) {
            // Get the arg
            auto arg = args[index];

            // Convert the argument
            argv[argc] = ::Py_DecodeLocale(arg, nullptr);
            if (argv[argc] == nullptr)
                return APERRL(Python, Ec::Python, "Unable to convert argument");

            // One more argument
            argc++;
        }
    } else {
        // Get the executable name and save it
        argv[0] = ::Py_DecodeLocale(args[0], nullptr);
        if (argv[argc] == nullptr)
            return APERRL(Python, Ec::Python, "Unable to convert argument");

        // One more argument
        argc++;
    }

    // Setup the sys.path
    LOG(Python, "Python setting configuration");
    if (auto ccode = setConfig(argc, argv)) return ccode;

    // Initialize python
    if (auto ccode = checkStatus(::Py_InitializeFromConfig(&g_config)))
        return ccode;

    // Release the GIL
    g_threadState = ::PyEval_SaveThread();

    // Setup the paths
    setPaths();

    // Say we are initialized
    g_initialized = true;

#if ROCKETRIDE_PLAT_WIN
    // Re-install the console control handler so that we get
    // console signals (e.g. Ctrl + C) instead of Python
    ::SetConsoleCtrlHandler(plat::consoleEventHandler, TRUE);
#endif

    LOG(Python, "Python initialization complete");
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Release the intepreter
///------------------------------------------------------------------------
Error deinit() noexcept {
    // Initialize the python
    LOG(Python, "Python deinit");

    // If we completed initialization
    if (g_initialized) {
        // Ensure the GIL is acquired for the Python interpreter
        ::PyEval_RestoreThread(g_threadState);

        // Release the config
        clearConfig();

        // Deinit
        auto status = ::Py_FinalizeEx();
        if (status < 0)
            LOG(Python, "Warning: Problem shutting down python", status);

        // No longer initialized
        g_initialized = false;
    }

    return {};
}

//---------------------------------------------------------------------
/// @details
///		We recognized this as a python execution, from above, and
///		now, we need to execute it
//---------------------------------------------------------------------
Error execPython() noexcept {
    Error ccode;

    // Acquire the GIL - even though we grab the GIL here, we don't
    // ever release it since Py_RunMain destroys the python instance
    // See below...
    ::PyEval_RestoreThread(g_threadState);

    // Execute python
    LOG(Python, "Python starting python main");
    auto exitCode = ::Py_RunMain();

    // If error, then log it
    if (exitCode) {
        ccode = APERR(Ec::Python, "Python error", exitCode);
        LOG(Python, "Python completed python main with error", ccode);
    }

    // This will be empty (no-eror) if executeArguments was not
    // called by dbgconn. If it was called, it represents any error that
    // we may have gotten
    if (g_processCommandLineResults) {
        ccode = g_processCommandLineResults;
        LOG(Python, "Python completed executeTasks with error", ccode);
    }

    // It's a pity, but Py_RunMain issues a finalize and there is no other
    // function to do similar command line parsing. So we need to say we
    // are longer initialized
    //
    //  See it for yourself at
    //      https://github.com/python/cpython/blob/main/Modules/main.c
    //      line 777
    g_initialized = false;

    // Clear the config info
    clearConfig();

    return ccode;
}

//---------------------------------------------------------------------
/// @details
///		Called by the C++ binding to execute the given arguments
//---------------------------------------------------------------------
Error executePythonArguments(py::object &argv) {
    Error ccode;

    // Do this while we have the GIL
    std::vector<Text> args;

    // Check if argv is a sequence (list or tuple)
    if (!py::isinstance<py::sequence>(argv)) {
        throw APERR(Ec::InvalidCommand,
                    "Invalid argument types in executeArguments");
    }

    // Convert the Python object to a sequence
    py::sequence seq(argv);  // This will work for both lists and tuples

    // Copy the arguments over from Python to C++
    for (size_t i = 0; i < len(seq); ++i) {
        std::string str = py::cast<std::string>(seq[i]);
        args.push_back(str);
    }

    // Debug: Log in Python (still within GIL)
    LOG(Python, "Python starting command line processing");

    // Unlock python - since we are being called by python, the GIL
    // is locked on entry to this function. So, in order to process
    // all of our pipes and complete our tasks, unlock it. It will
    // be locked again if we call back into python
    _block() {
        // Run this within a scope
        py::gil_scoped_release release;

        // Run the tasks specified on the command line
        ccode = engine::task::executeArguments(args);
    }

    // Save off any completion code
    engine::python::setProcessCommandLineResults(ccode);

    // Log the final output in Python (after re-acquiring the GIL)
    LOG(Python, "Python completed command line processing with", ccode);
    return ccode;
}
}  // namespace engine::python

namespace engine::python::test {
const ::PyConfig &config() noexcept { return g_config; }
}  // namespace engine::python::test
