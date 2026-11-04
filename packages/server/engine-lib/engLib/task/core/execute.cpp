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

namespace engine::task {
//-------------------------------------------------------------------------
/// @details
///		Define the command line options
//-------------------------------------------------------------------------
static application::Opt PathsBase{"--paths.base"};
static application::Opt PathsData{"--paths.data"};
static application::Opt PathsControl{"--paths.control"};
static application::Opt PathsCache{"--paths.cache"};
static application::Opt PathsLog{"--paths.log"};
static application::Opt OutputArgs{"--args"};

//-------------------------------------------------------------------------
/// @details
///		Given a json job configuration, execute it
///	@param[in]	value
///		Complete json task configuration
//-------------------------------------------------------------------------
Error executeTask(const file::Path &path, json::Value &value) noexcept {
    // Expand any macros
    value.expandTree(config::vars());

    // At this point we need setup some global state from the top level options
    if (auto paths = value.lookup<config::Paths>("paths"))
        config::paths() = _mv(paths);

    // Allow paths to be overridden from the command line
    if (PathsBase) config::paths() = _cast<file::Path>(*PathsBase);
    if (PathsData) config::paths().data = _cast<file::Path>(*PathsData);
    if (PathsControl)
        config::paths().control = _cast<file::Path>(*PathsControl);
    if (PathsCache) config::paths().cache = _cast<file::Path>(*PathsCache);
    if (PathsLog) config::paths().log = _cast<file::Path>(*PathsLog);

    // Emit crash dumps to the log path
    if (config::paths()) {
        config::vars().add("PathData", config::paths().data.gen());
        config::vars().add("PathControl", config::paths().control.gen());
        config::vars().add("PathCache", config::paths().cache.gen());
        config::vars().add("PathLog", config::paths().log.gen());
        ap::dev::crashDumpLocation(config::paths().log.gen());
    }

    // Make sure the paths exist
    if (auto ccode = config::paths().makePaths()) return ccode;

    // Enable traces that we specified - there is an ambiguity here. It
    // appears that the app is putting this in the config section for .json
    // and in the task section for .task. Since we used to look for it in
    // the task section, lets look in there at first.
    auto levels = value.lookup<Text>("trace");

    // And look in the config section if not defined in the task section
    if (!levels) levels = value["config"].lookup<Text>("trace");
    // Set the traces flags if defined
    if (levels) log::enableLevel(levels);

    if (auto id = value.lookup<Text>("nodeId")) config::nodeId(false) = _mv(id);

    // In case we crash, add the node and task ids to the dump prefix
    if (auto taskId = value.lookup<Text>("taskId"))
        dev::crashDumpPrefix() = _mv(taskId);

    // Register the global nodeid variable too if set
    if (config::nodeId(false)) config::vars().add("NodeId", config::nodeId());

    // Exeute it
    auto executeJob = [&](const auto &jobObj) -> Error {
        // Construct the job
        auto job = Factory::make<engine::task::ITask>(_location, path, jobObj);

        // If we couldn't monitor the error and return it
        if (!job) {
            auto ccode = job.ccode();
            MONITOR(status, "Failed: " + ccode.message());
            return MONCCODE(error, ccode);
        }

        if (auto ccode = job->execute()) {
            MONITOR(status, "Failed: " + ccode.message());
            return MONCCODE(error, ccode);
        }
        return {};
    };

    // Now walk the jobs key and execute each, two layouts are
    // supported, one with an inner jobs array that will cause
    // jobs to get executed in order, the other is no jobs
    // array with the entire job described in the top level object
    auto jobsArray = value.lookup("jobs");
    if (jobsArray) {
        if (!jobsArray.isArray())
            return APERRL(Always, Ec::InvalidJson,
                          "Commands key should be array", jobsArray.type());
        auto jobs = _fjc<std::vector<json::Value>>(jobsArray);
        if (!jobs) return APERRL(Always, jobs.ccode(), "Failed to parse jobs");
        if (jobs->empty())
            return APERRL(Job, Ec::InvalidParam, "No jobs specified");

        for (auto &&jobObj : *jobs) {
            if (auto ccode = executeJob(jobObj)) return ccode;
        }
        return {};
    }

    return executeJob(value);
}

//-------------------------------------------------------------------------
/// @details
///		Given a text configuration for a task, execute it
///	@param[in]	config
///		Complete task configuration
//-------------------------------------------------------------------------
Error executeTaskString(TextView config) noexcept {
    const file::Path path;

    auto taskObject = json::parse(config);
    if (!taskObject)
        return APERRL(Job, taskObject.ccode(), "Failed to parse job config",
                      config);

    // Execute the task - no task file
    return executeTask(path, *taskObject);
}

//-------------------------------------------------------------------------
/// @details
///		Given a file path to a .task manifest file, load the content,
///		parse it and execute the task
///	@param[in]	path
///		Path to *.task file execute
//-------------------------------------------------------------------------
Error executeTaskManifestFile(const file::Path &path) noexcept {
    // Load it, parse it
    auto contents = file::fetchString(path);
    if (!contents)
        return APERRL(Job, contents.ccode(), "Failed to load job file", path);
    LOG(Job, "Task manifest:\n", contents);

    // Parse it into json
    auto manifestObject = json::parse(*contents);
    if (!manifestObject)
        return APERRL(Job, manifestObject.ccode(), "Failed to load job file",
                      path);

    // Grab the task options from the manifest
    auto taskOptions = (*manifestObject)["taskOptions"];
    auto taskConfig = taskOptions["config"];
    auto nodeName = (*manifestObject)["taskWorkerNodeName"].asString();
    auto nodeId = (*manifestObject)["taskWorkerNodeId"].asString();

    // Now, build a proper .json file from the manifest
    json::Value taskObject;
    taskObject["nodeName"] = taskOptions["targetNodeName"];
    taskObject["nodeId"] = taskOptions["targetNodeId"];
    taskObject["type"] = taskOptions["taskType"];
    taskObject["config"] = taskConfig;

    // The app may put the traces flags in the taskOptions section.
    // Copy the traces flags from the taskOptions to the task section in this
    // case.
    if (auto levels = taskOptions.lookup<Text>("trace");
        levels && !taskObject.lookup<Text>("trace"))
        taskObject["trace"] = levels;

    // Execute the job
    return executeTask(path, taskObject);
}

//-------------------------------------------------------------------------
/// @details
///		Given a file path to a .json file, load the content, parse it
///		and execute the task
///	@param[in]	path
///		Path to *.json file execute
//-------------------------------------------------------------------------
Error executeTaskConfigFile(const file::Path &path) noexcept {
    // Load it, parse it
    auto contents = file::fetchString(path);
    if (!contents)
        return APERRL(Job, contents.ccode(), "Failed to load job file", path);
    LOG(Job, "Job config:\n", contents);

    // Parse it into json
    auto taskObject = json::parse(*contents);
    if (!taskObject)
        return APERRL(Job, taskObject.ccode(), "Failed to load job file", path);

    // Execute the job
    return executeTask(path, *taskObject);
}

//-------------------------------------------------------------------------
/// @details
///		Given a path, bootstraps the job interface, sets the appropriate
///		configs and executes the jobs present in the json
///
///		We support the following cases
///		1.	If an absolute file is specified, then execute it
///		2.	If a directory is specified, load all the tasks in the
///			directory and execute them
///		3.	If a wildcard is specified, then find all files matching
///			and execute them
///
///	@param[in]	path
///		Path to *.json file execute
//-------------------------------------------------------------------------
Error executeArgument(file::Path &path) noexcept {
    // Resolve any /../ or /./ in the name
    // path = path.resolve();

    // Get the generic string path
    auto cmdPath = path.gen();
    std::vector<file::Path> cmdFiles;

    // Add all the files we find to the cmdfiles list
    const std::function<Error(file::Path &, Text wildcard)> scanFiles =
        localfcn(file::Path & parentPath, Text wildcard)->Error {
        // Get the search mask
        Path scanPath = parentPath / wildcard;
        using namespace ap::file;
        // Get the scanner
        FileScanner scanner(scanPath);

        if (auto ccode = scanner.open(); ccode)
            return APERRL(Job, Ec::InvalidParam,
                          "Invalid argument, could not find", parentPath,
                          ccode);

        _forever() {
            // Get the next file
            auto entry = scanner.next();
            if (!entry) return {};

            // If this is a directory, walk into it
            if (entry->second.isDir) {
                auto newPath = parentPath / entry->first;
                if (auto ccode = scanFiles(newPath, "*")) return ccode;
                continue;
            }

            // Save it
            cmdFiles.push_back(parentPath / entry->first);
        }

        return {};
    };

    // Do we have a wildcard path specified?
    if (cmdPath.find('*') != string::npos ||
        cmdPath.find('?') != string::npos) {
        // Get the parent path
        file::Path parent = path.parent();

        // This has a wildcard in it, find all the files
        if (auto ccode = scanFiles(parent, path.fileName())) return ccode;
    } else if (cmdPath[0] == '~' && (cmdPath[1] == '/' || cmdPath[1] == '\\')) {
        if (plat::IsWindows) {
            // Get the users profile directory - where the vscode extensions
            // live
            auto profile = ap::plat::env("USERPROFILE");

            // Set it
            file::Path dir = profile;

            // Add the reset of the path
            dir /= path.subpth(1);

            // Save it
            cmdFiles.push_back(dir);
        } else {
            // This comes in from the vscode python debugger - means local user
            cmdFiles.push_back(path);
        }
    } else {
        // Stat thefile
        ErrorOr<file::StatInfo> fsInfo = file::stat(path);
        if (fsInfo.check())
            return APERRL(Job, Ec::InvalidParam,
                          "Invalid argument, could not find file", path);

        // If this is a directory
        if (fsInfo->isDir) {
            // Since this had no wildcards in it, a directory is
            // specified, so it is the parent
            file::Path parent = path;

            // This has a wildcard in it, find all the files
            if (auto ccode = scanFiles(parent, "*")) return ccode;
        } else {
            // Not a directory, not has wildcards, it is a file
            cmdFiles.push_back(path);
        }
    }

    // Make sure we've got something
    if (!cmdFiles.size())
        return APERRL(Job, Ec::InvalidParam,
                      "Invalid argument, could not find any tasks to execute");

    // Sorts the given paths - this way we can run the, in a deterministic
    // sequence
    std::sort(cmdFiles.begin(), cmdFiles.end(),
              [&](const file::Path &lhs, const file::Path &rhs) {
                  return lhs < rhs;
              });

    // Execute all the files specified
    file::Path jobFile;
    for (auto jobFile : cmdFiles) {
        if (cmdFiles.size() > 1)
            LOG(Always, "Processing", jobFile);
        else
            LOG(Job, "Processing", jobFile);

        // If its a .py file, ignore it. This has already been processed
        // by the isPython. Since we got a py, it was recognized as a
        // python process and we are probably being execute by dbgconn.py
        if (jobFile.fileExt().equals("py", false)) continue;

        // If its a .task file, execute it
        if (jobFile.fileExt().equals("task", false)) {
            // Default path base to its parent for ease of general use
            config::paths() = jobFile.parent();

            // Execute the task
            if (auto ccode = executeTaskManifestFile(jobFile)) return ccode;

            continue;
        }

        // If its a .json file, execute it
        if (jobFile.fileExt().equals("json", false)) {
            // Default path base to its parent for ease of general use
            config::paths() = jobFile.parent();

            // Execute the task
            if (auto ccode = executeTaskConfigFile(jobFile)) return ccode;

            continue;
        }

        // Error out
        return APERRL(Job, Ec::InvalidParam,
                      "Invalid argument, extension not .json or .task",
                      jobFile);
    }
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This is call by Main, or, if we are performing python or java
///		debugging, it will be called be the dbconn.py call
///
///		Note: args[0] is assumed to be the program name!
//-------------------------------------------------------------------------
Error executeArguments(std::vector<Text> args) noexcept {
    Error ccode;

    // If we are in streaming mode
    if (Stream) {
        // Execute the task
        ccode = executeTaskString(StreamCommand);
        return ccode;
    }

    // Run jobs
    for (auto i = 1; i < args.size(); i++) {
        // Get the cmnd
        auto arg = args[i];

        // Expand any macros (like %testdata%)
        arg = config::vars().expand(arg);

        // A command line option here will be ignored
        if (arg.starts_with("-")) continue;

        // Get the file path
        file::Path cmdPath(arg);

        // Execute the file(s) specified
        if (ccode = executeArgument(cmdPath)) break;
    }

    // And done
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Main driver for executing tasks. Examines the command line and
///		executes a task file, manifest file, a stream command, etc
///
//-------------------------------------------------------------------------
Error Main() noexcept {
    Error ccode;

    // Get the command line
    auto &cmds = application::cmdline();

    // If we need to output the arguments
    if (OutputArgs) {
        auto args = cmds.args_original();
        LOG(Always, "Main arguments");

        // Output the arguments
        for (auto i = 0; i < args.size(); i++) {
            // Get the cmnd
            auto command = args[i];
            LOG(Always, "    Argument: ", command);
        }
    }

#if ROCKETRIDE_PLAT_WIN
    // Block the system from sleeping while the engine is running
    if (!::SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_CONTINUOUS))
        LOG(Always,
            APERR(::GetLastError(),
                  "Failed to block hibernation while engine is running"));
#endif

    // If this is a python command line
    if (engine::python::isPython()) {
        // Execute the python script
        ccode = engine::python::execPython();

        // If we got an error
        if (ccode) LOG(Python, "Python process failed", ccode);
        return ccode;
    }

    // If this is a java command line
    if (engine::java::isJava()) {
        // Execute the python script
        ccode = engine::java::execJava();

        // If we got an error
        if (ccode) LOG(Java, "Java process failed", ccode);
        return ccode;
    }

    // Process all task type arguments
    return executeArguments(cmds.args());
}
}  // namespace engine::task