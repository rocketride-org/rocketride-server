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

namespace engine::store::pipeline {

ErrorOr<json::Value> validatePipeline(json::Value root) noexcept;
ErrorOr<json::Value> validateComponent(json::Value root) noexcept;

#define MONITOR_COLLECT_ERRORS(id)                       \
    do {                                                 \
        for (auto &error : MONITOR(errors))              \
            PipelineConfig::addError(root, error, id);   \
        for (auto &warning : MONITOR(warnings))          \
            PipelineConfig::addError(root, warning, id); \
    } while (false)

/**
 * @brief Validates and encrypts a pipeline or component configuration.
 *
 * @details This function can validate either an entire pipeline
 * or a single component configuration. Validation includes the following steps:
 * 1. Validation of the pipeline or component configuration structure.
 * 2. Decryption of secure values if present.
 * 3. If the configuration structure is valid, the source endpoint and
 *    the global filters are created and validated using self-implemented
 *    validateConfig methods.
 * 4. Encryption of secure values back into the configuration.
 *
 * @param root The root JSON value of the pipeline or component configuration.
 * @example Pipeline configuration
 * ```json
 * {
 *   "pipeline": {
 *     "source": "source_1",
 *     "components": [
 *       {
 *         "id": "source_1",
 *         "provider": "aws",
 *         "config": {
 *           ...
 *         },
 *         ...
 *       },
 *       {
 *         "id": "chat_t",
 *         "provider": "llm_openai",
 *         "config": {
 *           ...
 *         },
 *         ...
 *        },
 *        ...
 *     ]
 *   }
 * }
 * ```
 * @example Component configuration
 * ```json
 * {
 *   "component": {
 *     {
 *       "id": "chat_t",
 *       "provider": "llm_openai",
 *       "config": {
 *         ...
 *       },
 *       ...
 *     }
 *   }
 * }
 * ```
 * @return ErrorOr<json::Value>
 */
ErrorOr<json::Value> validatePipelineOrComponent(json::Value root) noexcept {
    return root.isMember("component") ? validateComponent(_mv(root))
                                      : validatePipeline(_mv(root));
}

/**
 * @brief Validates a pipeline configuration.
 *
 * @param root
 * @return ErrorOr<json::Value>
 */
ErrorOr<json::Value> validatePipeline(json::Value root) noexcept {
    // Wrap the root JSON in a PipelineConfig object
    store::pipeline::PipelineConfig pipeline(_mv(root));

    // Validate pipeline configuration, collect the error if any
    if (auto ccode = pipeline.validate(false)) pipeline.addError(ccode);

    // Decrypt the pipeline configuration, collect the error if any
    if (auto ccode = pipeline.decrypt()) pipeline.addError(ccode);

    // Encrypt the pipeline configuration, collect the error if any
    if (auto ccode = pipeline.encrypt()) pipeline.addError(ccode);

    // Return the root JSON of the pipeline configuration
    // with encrypted secure values
    return pipeline.root();
}

/**
 * @brief Validates a single component configuration.
 *
 * @param root
 * @return ErrorOr<json::Value>
 */
ErrorOr<json::Value> validateComponent(json::Value root) noexcept {
    // Get the component from the root JSON
    auto &component = root["component"];
    if (!component.isObject())
        return APERR(Ec::InvalidParam, "Component must be an object");

    // Validate and decrypt the component configuration, collect the errors
    if (auto ccode = PipelineConfig::validateComponent(component))
        PipelineConfig::addError(root, ccode);
    if (auto ccode = PipelineConfig::decryptComponent(component))
        PipelineConfig::addError(root, ccode);

    // If there are errors, we cannot continue
    if (root.isMember("errors")) {
        // Encrypt everything possible and return the configuration
        if (auto ccode = PipelineConfig::encryptComponent(component))
            PipelineConfig::addError(root, ccode);
        return root;
    }

    // Get the component info
    auto id = component["id"].asString();
    auto provider = component["provider"].asString();
    auto &config = component["config"];
    auto defVal = IServices::getServiceDefinition(provider);
    // If the definition is failed, we cannot continue
    if (!defVal) return defVal.ccode();
    auto &def = *defVal.value();

    // This stub config is still needed to enpoint creation
    json::Value jobConfig = R"({
        "type": "pipeline",
        "nodeId": "d24eca5f-apag-4029-aa90-75fd61fd856e",
        "config": {
            "keystore": "kvsfile://data/keystore.json",
            "service": {}
        }
    })"_json;

    // Task id is required, assign a new random one
    jobConfig["taskId"] = _ts(Uuid::create());

    // Reset errors and warnings from the monitor
    MONITOR(reset);

    // Check if the component is a source endpoint
    if (config.lookup<Text>("mode").lowerCase() == "source" ||
        def.classType.isArray() && _anyOf(def.classType, "source")) {
        // Sometimes these are missing if the user didn't configure the source
        if (!config.isMember("mode")) config["mode"] = "Source";
        if (!config.isMember("type")) config["type"] = provider;

        // Create and open in the config mode the source endpoint
        auto endpoint = IServiceEndpoint::getSourceEndpoint(
            {.jobConfig = jobConfig,
             .taskConfig = jobConfig["config"],
             .serviceConfig = config,
             .openMode = OPEN_MODE::CONFIG,
             .stackOnly = true});
        // If it fails, we cannot continue
        if (!endpoint) return endpoint.ccode();

        // Validate the source endpoint configuration and collect the error
        if (auto ccode = endpoint->validateConfig(false))
            PipelineConfig::addError(root, ccode, id);

    } else {
        // Gather all the context info to the factory arguments
        auto pipeType =
            IPipeType{id, def.capabilities, provider, provider, config};

        auto nullConfig = R"({
            "key": "null://Null",
            "name": "Null endpoint",
            "type": "null",
            "mode": "target",
            "parameters": {}
        })"_json;

        // Create and open in the config mode the target endpoint
        auto endpoint = IServiceEndpoint::getTargetEndpoint(
            {.jobConfig = jobConfig,
             .taskConfig = jobConfig["config"],
             .serviceConfig = nullConfig,
             .openMode = OPEN_MODE::CONFIG,
             .stackOnly = true});
        // If it fails, we cannot continue
        if (!endpoint) return endpoint.ccode();

        // Create a global filter for the component
        auto global =
            Factory::make<IServiceFilterGlobal>(_location, pipeType, *endpoint);
        if (!global) return global.ccode();

        // Validate the component configuration and collect the error
        if (auto ccode = (*global)->validateConfig())
            PipelineConfig::addError(root, ccode, id);
    }

    // Collect errors and warnings sent to the monitor during the validation
    MONITOR_COLLECT_ERRORS(id);

    // Finally, encrypt the component configuration
    if (auto ccode = PipelineConfig::encryptComponent(component))
        PipelineConfig::addError(root, ccode, id);

    return root;
}

}  // namespace engine::store::pipeline
