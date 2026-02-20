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

namespace engine::store {
namespace py = pybind11;

/**
 * @class ILoader
 * @brief Handles loading objects via a pipeline configuration.
 */

//-------------------------------------------------------------------------
/// @details
///		Sets up the endpoint
///	@param[in]	openMode
///		The open mode. Will be either READ or WRITE
///	@returns
///		Error
//-------------------------------------------------------------------------
py::dict ILoader::getPipeStack(const py::dict &pipes = py::dict()) {
    // Convert Python dictionary to JSON format
    auto pipeConfig = engine::python::pyjson::dictToJson(pipes);

    // Define the default task configuration
    ap::json::Value taskConfig = R"({
            "type": "pipeline",
            "nodeId": "d24eca5f-apag-4029-aa90-75fd61fd856e",
            "config": {
                "keystore": "kvsfile://data/keystore.json",
                "service": {
                    "key": "null://Null",
                    "name": "Null endpoint",
                    "type": "null",
                    "mode": "target",
                    "parameters": {}
                }
            }
        })"_json;

    // Merge the provided pipeline configuration into the service section
    taskConfig["config"]["service"]["pipeline"] = pipeConfig["pipeline"];

    // Assign it a task id - we still have to have it
    taskConfig["taskId"] = _ts(Uuid::create());

    // Obtain a service endpoint for the pipeline execution
    auto endpoint = IServiceEndpoint::getTargetEndpoint(
        {.jobConfig = taskConfig,
         .taskConfig = taskConfig["config"],
         .serviceConfig = taskConfig["config"]["service"],
         .openMode = OPEN_MODE::PIPELINE,
         .stackOnly = true});

    // Ensure the endpoint was successfully created
    if (!endpoint) throw endpoint.ccode();

    // We will examine each filter driver
    bool usesGPU = false;

    // Get the component pipe stacks from the endpoint
    auto complist = py::list();
    for (auto &component : endpoint->pipeStack) {
        // Create our component
        py::dict comp;
        comp["id"] = component.id;
        comp["logicalType"] = component.logicalType;
        comp["physicalType"] = component.physicalType;
        comp["connConfig"] = component.connConfig;
        comp["capabilities"] = component.capabilities;

        // We have a GPU driver, so we need to set the flag
        if (component.capabilities & url::UrlConfig::PROTOCOL_CAPS::GPU)
            usesGPU = true;

        // Add it
        complist.append(comp);
    }

    // Create a dict from it
    py::dict dict;
    dict["pipeline"] = complist;
    dict["usesGPU"] = usesGPU;

    // Return the result
    return dict;
}

/**
 * @brief Sets up an endpoint to load objects from a defined pipeline.
 * @param pipes A Python dictionary containing the pipeline configuration.
 */
void ILoader::beginLoad(const py::dict &pipes = py::dict()) {
    // Convert Python dictionary to JSON format
    auto pipeConfig = engine::python::pyjson::dictToJson(pipes);

    // Define the default task configuration
    ap::json::Value taskConfig = R"({
            "type": "pipeline",
            "nodeId": "d24eca5f-apag-4029-aa90-75fd61fd856e",
            "config": {
                "keystore": "kvsfile://data/keystore.json",
                "service": {
                    "key": "null://Null",
                    "name": "Null endpoint",
                    "type": "null",
                    "mode": "target",
                    "parameters": {}
                }
            }
        })"_json;

    // Merge the provided pipeline configuration into the service section
    taskConfig["config"]["service"]["pipeline"] = pipeConfig["pipeline"];

    // Assign it a task id
    taskConfig["taskId"] = _ts(Uuid::create());

    // Obtain a service endpoint for the pipeline execution
    auto endpoint = IServiceEndpoint::getTargetEndpoint(
        {.jobConfig = taskConfig,
         .taskConfig = taskConfig["config"],
         .serviceConfig = taskConfig["config"]["service"],
         .openMode = OPEN_MODE::PIPELINE});

    // Ensure the endpoint was successfully created
    if (!endpoint) throw endpoint.ccode();

    // Store the endpoint instance
    this->target = _mv(*endpoint);
}

/**
 * @brief Cleans up and destroys the pipeline endpoint.
 */
void ILoader::endLoad() {
    // Release the endpoint reference
    this->target = {};
}
}  // namespace engine::store
