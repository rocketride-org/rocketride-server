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

namespace engine::task::configureService {
Error Task::exec() noexcept {
    // Configure service or pipeline based on the task configuration
    if (taskConfig().isMember("pipeline") ||
        taskConfig().isMember("component")) {
        // Make a config that includes only the pipeline or component node that
        // needs to be validated.
        auto config = json::Value{};
        if (taskConfig().isMember("pipeline"))
            config["pipeline"] = taskConfig()["pipeline"];
        else if (taskConfig().isMember("component"))
            config["component"] = taskConfig()["component"];
        else
            return APERR(Ec::InvalidCommand,
                         "No pipeline or component configuration provided");

        // Validate the pipeline or component configuration provided with the
        // task
        auto validatedConfig =
            store::pipeline::validatePipelineOrComponent(config);
        if (!validatedConfig) return validatedConfig.ccode();

        // Notify the monitor and exit
        MONITOR(info, *validatedConfig);
        return {};
    }

    // Format a message to return to the caller
    auto formatMessage = localfcn(Error ccode)->json::Value {
        json::Value obj;
        obj["ccode"] = ccode.plat();
        obj["message"] = ccode.message();
        return obj;
    };

    bool syntaxOnly = taskConfig().lookup<bool>("syntaxOnly");

    // Setup the json to return
    json::Value monitor;

    const auto configure = localfcn()->Error {
        MONITOR(status, "Creating endpoint");

        // Get the service configuration
        auto &serviceConfig = taskConfig()["service"];

        // Get the logical type of the endpoing
        auto type = IServiceEndpoint::getLogicalType(serviceConfig);
        if (!type) return type.ccode();

        // Get the service defintion for it
        auto service = IServices::getServiceDefinition(*type);
        if (!service) return service.ccode();

        // Get a reference to the schema
        auto &serviceSchema = (*service)->serviceSchema;

        // Get the mode
        const auto mode = serviceConfig.lookup<Text>("mode").lowerCase();

        // Check that this mode is supported
        // @@HACK: Get service schema name.
        //         All the target services Target/Export/Transform have the same
        //         mode Target.
        // @@TODO: Resolve ambiguity between Source/Target mode and
        // Source/Target/Export/Transform services
        Text serviceType;
        if (serviceSchema.isMember(mode))
            serviceType = mode;
        else if (mode == "target" && serviceSchema.isMember("export"))
            serviceType = "export";
        else if (mode == "target" && serviceSchema.isMember("transform"))
            serviceType = "transform";
        else
            return APERR(Ec::InvalidCommand, type, "is not supported in", mode,
                         "mode");

        // Get the validaton schema
        const auto &validator = serviceSchema[serviceType];
        validator;

        // Now, once we get rid of jsoncpp, which doesn't have a good json
        // validator, and put in a real one like (nlohmann/json: JSON for Modern
        // C++ - GitHub, https://github.com/nlohmann/json), we can actually do
        // most of the basic validation here (at least that all the fields are
        // there...)

        // Get a source endpoint
        auto endpoint = IServiceEndpoint::getSourceEndpoint(
            {.jobConfig = jobConfig(),
             .taskConfig = taskConfig(),
             .serviceConfig = serviceConfig,
             .openMode = OPEN_MODE::CONFIG});
        if (!endpoint) return endpoint.ccode();

        MONITOR(status, "Validating endpoint");

        // Validate it
        LOGT("Validating endpoint config");
        if (auto ccode = endpoint->validateConfig(syntaxOnly)) return ccode;

        // Generate the config
        LOGT("Generating endpoint config");
        json::Value resultConfig;
        if (auto ccode = endpoint->getConfig(resultConfig)) return ccode;

        // Return the validated config of the service
        monitor["service"] = resultConfig;

        // End the end point, validate will open it again
        // in the modes it needs to
        return endpoint->endEndpoint();
    };

    // Configure service
    if (auto ccode = configure()) MONERR(error, ccode, ccode.message());

    // Collect errors and warnings from the monitor
    json::Value errors = json::ValueType::arrayValue,
                warnings = json::ValueType::arrayValue;
    for (auto &error : MONITOR(errors)) errors.append(formatMessage(error));
    for (auto &warning : MONITOR(warnings))
        warnings.append(formatMessage(warning));
    monitor["errors"] = errors;
    monitor["warnings"] = warnings;

    // Notify the monitor and exit
    MONITOR(info, monitor);
    return {};
}
}  // namespace engine::task::configureService
