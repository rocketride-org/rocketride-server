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

#pragma once

namespace engine::task::exec {
//-------------------------------------------------------------------------
/// @details
///		Option to use a different pipeline file as the source.json file
//-------------------------------------------------------------------------
static application::Opt Pipeline{"--pipeline"};

//-------------------------------------------------------------------------
/// @details
///		The exec tasks takes a file mask in the exec section of the
///		task file, and for each pipe file found in the control folder,
///		sequentially executes the task on the found pipe.
//-------------------------------------------------------------------------
class Task : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    ///	@details
    ///		The trace flag for this component
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobExec;

    //-----------------------------------------------------------------
    /// @details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, ITask>("exec");

    //-----------------------------------------------------------------
    /// @details
    ///		Override the execution process - we will actually be
    ///		running multiple tasks
    //-----------------------------------------------------------------
    Error exec() noexcept override {
        file::Path savePath;
        bool saveTasks;
        Text pipeline;
        Text inputSet;
        Text outputSet;
        Text type;
        Text action;
        uint32_t batchId;

        // This comes from user.json - if it is not expanded to "1"
        // then we do not have our variables loaded from user.json,
        // probably not found. There is no need to continue as without
        // a user.json file, it is not possible to run the task
        auto value = config::vars().expand("%resolved%");
        if (value != "1") {
            LOGT("user.json is not loaded or \"resolved\" variable is missing");
            return APERR(
                Ec::InvalidJson,
                "user.json not loaded - probably missing or has a JSON error");
        }

        // Update a service key from user.json - this could be under the
        // service, source, target, etc key in the task
        const auto updateService = localfcn(TextView key)->Error {
            LOGT("Updating", key);

            // If the key isn't there, done
            if (!taskConfig().isMember(key)) {
                LOGT("    Not found in config, skipping", key);
                return {};
            }

            // If it isn't a string, done
            if (!taskConfig()[key].isString()) {
                LOGT("    Not a string, skipping", key);
                return {};
            }

            // Get the text from it
            auto type = taskConfig().lookup<Text>(key);

            // Find the services collection in the user.json
            if (!config::user()->isMember("services")) {
                LOGT("    Type not found in user.json:", type);
                return APERR(Ec::InvalidJson,
                             "user.json does not contain services definition");
            }

            // Get the services
            auto services = config::user()->lookup("services");

            // Find it
            if (!services.isMember(type)) {
                LOGT("    Section not found in user.json", type);
                return APERR(
                    Ec::InvalidJson,
                    "user.json does not contain the service definition for",
                    key);
            }

            // Update it
            LOGT("    replaced with", services.lookup(type));
            taskConfig()[key] = services.lookup(type);
            return {};
        };

        // This will update a key in the task if, in the task
        // it is a string and the same key is in user.json
        const auto updateKey = localfcn(TextView key)->Error {
            // If the key isn't there, done
            if (!taskConfig().isMember(key)) {
                LOGT("General key not found", key);
                return {};
            }

            // If it isn't a string, done
            if (!taskConfig()[key].isString()) {
                LOGT("General key is not a string", key);
                return {};
            }

            // If the key isn't there, done
            if (!config::user()->isMember(key)) {
                LOGT("General key is not a replaceable value", key);
                return {};
            }

            // Update the key
            LOGT("General updated key", key, "to", config::user()->lookup(key));
            taskConfig()[key] = config::user()->lookup(key);
            return {};
        };

        // Get the exec section
        json::Value exec = jobConfig()["exec"];

        // Get the transform parameters
        if (auto ccode = exec.lookupAssign("saveTasks", saveTasks) ||
                         exec.lookupAssign("pipeline", pipeline) ||
                         exec.lookupAssign("inputSet", inputSet) ||
                         exec.lookupAssign("outputSet", outputSet) ||
                         exec.lookupAssign("batchId", batchId) ||
                         exec.lookupAssign("type", type) ||
                         exec.lookupAssign("action", action))
            return ccode;

        // Now, see if there is a command line option override
        if (Pipeline) pipeline = *Pipeline;

        // This may need to be expanded since it can also have a
        // reference within it
        pipeline = engine::config::expand(pipeline);

        // Output parameters
        LOGT("Type        : ", type);
        LOGT("Input set   : ", inputSet);
        LOGT("Output set  : ", outputSet);
        LOGT("Batch id    : ", batchId);
        LOGT("Action      : ", action);
        LOGT("Pipeline    : ", pipeline);

        // Remove our exec member now - we got the info
        jobConfig().removeMember("exec");

        // If we are supposed to save the task file, compute its path
        if (saveTasks && taskPath) {
            std::vector<Text> comps;

            // Get all the components of the path
            for (auto comp : taskPath) comps.push_back(comp);

            // Remove all but two components
            while (comps.size() > 2) comps.erase(comps.begin());

            // If it has more than a single component, add it
            Text name;
            for (auto index = 0; index < comps.size(); index++) {
                if (name) name += ".";
                name += comps[index];
            }

            // Get the control path
            auto control = config::paths().control;

            // And the name to it
            savePath = control / name;
        }

        // If we have a pipeline to throw in there
        if (pipeline) {
            // Get the service info
            auto contents = file::fetch<TextChr>(pipeline);
            if (!contents)
                return APERR(Ec::NotFound, "Pipeline file", pipeline,
                             "was not found");

            // Parse it into json
            auto pipelineJson = json::parse(*contents);
            if (!pipelineJson)
                return APERR(Ec::InvalidJson, pipelineJson.ccode().message(),
                             " in", pipeline);

            // Save it in the task
            taskConfig()["pipeline"] = (*pipelineJson)["pipeline"];
        }

        // Keep track of how many iterations we have made
        int iterCount = 0;

        // Do this until we run out of input files
        _forever() {
            // Format it
            Text batchIdString = _tso(Format::HEX | Format::FILL, batchId);

            // Default to type
            Text message = _ts("Executing ", type);

            // Build the input url
            if (inputSet) {
                ErrorOr<Url> input = stream::datafile::DataFile::toUrl(
                    "control",
                    util::Vars::expand(inputSet, "BatchId", batchIdString));
                if (!input) {
                    LOGT("Invalid input set:", inputSet);
                    return input.ccode();
                }

                // Get the os path of the input
                auto osPath = stream::datafile::DataFile::localPath(*input);
                if (!osPath) return osPath.ccode();

                // If we did not find the file, stop
                if (!ap::file::isFile(*osPath)) {
                    // If we found at least one input file, no problem,
                    // we just reached the end of the list
                    if (iterCount > 0) break;

                    // If we did not find the first file, error out
                    LOGT("Input pipe file is not a file or is not found");
                    return APERR(Ec::NotFound, "Input pipe", *osPath,
                                 "not found");
                }

                // Save it in the configuration
                taskConfig()["input"] = (TextView)*input;

                // Override the message
                message =
                    _ts("Executing task on input pipe ", (TextView)*input);
            }

            // Build the input url
            if (outputSet) {
                // Build the output url
                ErrorOr<Url> output = stream::datafile::DataFile::toUrl(
                    "control",
                    util::Vars::expand(outputSet, "BatchId", batchIdString));
                if (!output) return output.ccode();

                // Save it
                taskConfig()["output"] = (TextView)*output;

                // Override the message
                message =
                    _ts("Executing task to output pipe ", (TextView)*output);
            }

            // Output the status message
            MONITOR(status, message);

            // Update the type in the job config
            jobConfig()["type"] = type;

            // If there is a specific type of action, set it
            if (action) taskConfig()["action"] = action;

            // Update the batch id in the job config
            if (taskConfig().isMember("batchId"))
                taskConfig()["batchId"] = batchId;

            // If this has an index setting, set it
            if (taskConfig().isMember("index"))
                taskConfig()["index"]["batchId"] = batchId;

            // Update the possible service keys from user.json
            updateService("service");
            updateService("source");
            updateService("target");
            updateService("autopipe");

            // If this has a batches setting in it (classification)
            if (taskConfig().isMember("batches")) {
                // This is the main entry - emulating the "objects" table
                Text key = _ts(batchId);

                // Get the path to it
                Text path = "datafile://data/output-words-" + key + ".dat";

                // Setup the batches key
                json::Value batches;
                batches[key] = path;

                // Save it
                taskConfig()["batches"] = batches;
            }

            // Go to the next batch id
            batchId++;

            // If we are supposed to save the tasks and we have a path
            if (saveTasks && savePath)
                file::put(savePath, jobConfig().stringify(true));

            // Log it
            LOGT("Execute config", jobConfig());

            // Execute the task
            if (auto ccode = engine::task::executeTask(taskPath, jobConfig()))
                return ccode;

            // If we don't have an input set, there is only one
            if (!inputSet) break;

            // So we can detect if we actually did anything
            iterCount++;
        }

        // And done
        return {};
    }
};
}  // namespace engine::task::exec
