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

PipelineConfig::PipelineConfig(json::Value root) noexcept : m_root(_mv(root)) {}

/**
 * @brief Sets the root JSON value for the pipeline configuration.
 */
void PipelineConfig::setRoot(json::Value root) noexcept {
    m_root = _mv(root);
    m_sourcePos = 0;
    m_targetConfig = {};
}

/**
 * @brief Validates the structure and contents of a pipeline configuration JSON
 * object.
 *
 * This function ensures that a given JSON object describing a pipeline is
 * valid. It performs the following validation rules:
 *
 * Validation Rules:
 *   1. Root must be a JSON object.
 *   2. Must contain a "pipeline" object.
 *   3. "pipeline.source" must be a string.
 *   4. "pipeline.components" must be an array of objects.
 *   5. Each component must have a unique string "id".
 *   6. Each component must have a string "provider".
 *   7. Each component must have an object "config".
 *   8. If a component has a "config.profile", it must be a string, and
 *      the corresponding section under config must exist and be an object.
 *   9. If a component has an "input" array:
 *        - Each entry must be an object.
 *        - Must contain a string "lane".
 *        - Must contain a string "from" that matches a known component id.
 *  10. If a component has a "control" array:
 *        - Each entry must be an object.
 *        - Must contain a string "classType".
 *        - Must contain a string "from".
 *  11. The value of "pipeline.source" must reference a valid component id.
 *  12. The value of each "lane" in component inputs must match one of
 *      engine::store::Binder::MethodNames.
 *  13. Three must be no cycles in the pipeline connections.
 *
 * @return Error
 */
Error PipelineConfig::validate(bool sourceRequired) noexcept {
    // [Rule 1] Check that the root is a JSON object
    if (!m_root.isObject())
        return APERR(Ec::InvalidParam, "Pipeline config must be an object");

    // [Rule 2] Check that there is a 'pipeline' object
    if (!m_root.isMember("pipeline") || !m_root["pipeline"].isObject())
        return APERR(Ec::InvalidParam, "'pipeline' is missing or invalid");

    auto &pipeline = m_root["pipeline"];

    // Get the pipeline version
    int version = 0;
    if (pipeline.isMember("version")) {
        if (!pipeline["version"].isInt())
            return APERR(Ec::InvalidParam,
                         "'pipeline.version' must be a number");

        version = pipeline["version"].asInt();

        if (!(1 <= version && version <= IServices::VERSION))
            return APERR(Ec::InvalidParam, "'pipeline.version' is unsupported");
    }

    // [Rule 4] Ensure 'pipeline.components' is an array of objects
    if (!pipeline.isMember("components") || !pipeline["components"].isArray())
        return APERR(Ec::InvalidParam,
                     "'pipeline.components' must be an array");

    struct CompInfo;
    struct LaneInfo;

    // Component information for validation and graph analysis
    struct CompInfo {
        Text id;
        json::ArrayIndex pos = 0;
        IServices::ServiceDefinitionPtr def = nullptr;
        std::vector<LaneInfo *> inputs, outputs;
        std::vector<CompInfo *> controls;
        bool visited = false;
    };
    std::unordered_map<Text, CompInfo> comps;

    // Lane information for validation and graph analysis
    struct LaneInfo {
        static Text makeKey(TextView lane, TextView from,
                            TextView to) noexcept {
            return _ts(from, "-[", lane, "]->", to);
        }

        Text name;
        CompInfo *from = nullptr, *to = nullptr;
        std::vector<LaneInfo *> outputs;
        bool visited = false;
    };
    std::unordered_map<Text, LaneInfo> lanes;

    // Validate structure of each component
    for (json::Value::ArrayIndex pos = 0; pos < components().size(); ++pos) {
        auto &component = components()[pos];

        // [Rule 5–7] Validate basic structure of each component
        if (auto ccode = validateComponent(component)) return ccode;

        // Upgrade component if needed
        if (auto ccode = upgradeComponent(component, version)) return ccode;

        // [Rule 5] Check that the component's "id" is unique
        Text id = component["id"].asString();

        // Get component info
        Text provider = component["provider"].asString();
        auto def = IServices::getServiceDefinition(provider);
        if (!def) continue;

        // Store extended component information for later validation
        if (!comps.emplace(id, CompInfo{id, pos, *def}).second)
            return APERR(Ec::InvalidParam, "Duplicate component", id);
    }

    // Update the pipeline version to the latest once all components are
    // upgraded
    pipeline["version"] = IServices::VERSION;

    Text sourceId = pipeline.lookup<Text>("source");
    if (sourceRequired || sourceId) {
        // [Rule 3] Ensure 'pipeline.source' exists and is a non-empty string
        if (!hasSource())
            return APERR(Ec::InvalidParam,
                         "'pipeline.source' must be a non-empty string");

        // [Rule 11] Final validation: Ensure pipeline.source references a known
        // component
        if (auto it = comps.find(sourceId); it != comps.end())
            m_sourcePos = it->second.pos;
        else
            return APERR(
                Ec::InvalidParam,
                "'pipeline.source' references unknown component id:", sourceId);
    }

    // [Rule 9–10, 12] Now reprocess components to validate 'input' and
    // 'control' arrays
    for (const auto &component : components()) {
        Text id = component["id"].asString();
        auto &comp = comps[id];

        // [Rule 9] Validate 'input' connections if present
        if (component.isMember("input")) {
            const auto &inputs = component["input"];
            if (!inputs.isArray())
                return APERR(Ec::InvalidParam, "Component", id,
                             "input must be an array");

            for (const auto &input : inputs) {
                if (!input.isObject())
                    return APERR(Ec::InvalidParam, "Component", id,
                                 "input entries must be objects");

                Text lane = input.lookup<Text>("lane");
                if (!input.isMember("lane") || !input["lane"].isString() ||
                    !lane)
                    return APERR(Ec::InvalidParam, "Component", id,
                                 "input 'lane' must be a non-empty string");

                // [Rule 12] Ensure 'lane' is a valid method name
                if (std::find(Binder::MethodNames.begin(),
                              Binder::MethodNames.end(),
                              lane) == Binder::MethodNames.end())
                    return APERR(Ec::InvalidParam, "Component", id,
                                 "input has unknown lane", lane);

                Text from = input.lookup<Text>("from");
                if (!input.isMember("from") || !input["from"].isString() ||
                    !from)
                    return APERR(Ec::InvalidParam, "Component", id,
                                 "input 'from' must be a non-empty string");

                if (!comps.count(from))
                    return APERR(
                        Ec::InvalidParam, "Component", id,
                        "input references unknown component id:", from);

                // Store the lane information for later validation and update
                // appropriate components
                auto &compFrom = comps[from];
                if (auto res = lanes.emplace(LaneInfo::makeKey(lane, from, id),
                                             LaneInfo{lane, &compFrom, &comp});
                    res.second) {
                    compFrom.outputs.push_back(&res.first->second);
                    comp.inputs.push_back(&res.first->second);
                } else {
                    // The issue on UI is that output lanes may be duplicated
                    // return APERR(Ec::InvalidParam, "Duplicate lane", lane,
                    // "from component", from, "to component", id);
                }
            }
        }

        // [Rule 10] Validate 'control' connections if present
        if (component.isMember("control")) {
            const auto &controls = component["control"];
            if (!controls.isArray())
                return APERR(Ec::InvalidParam, "Component", id,
                             "control must be an array");

            for (const auto &control : controls) {
                if (!control.isObject())
                    return APERR(Ec::InvalidParam, "Component", id,
                                 "control entries must be objects");

                if (!control.isMember("classType") ||
                    !control["classType"].isString() ||
                    !control["classType"].asString())
                    return APERR(
                        Ec::InvalidParam, "Component", id,
                        "control 'classType' must be a non-empty string");

                Text from = control.lookup<Text>("from");
                if (!control.isMember("from") || !control["from"].isString() ||
                    !from)
                    return APERR(Ec::InvalidParam, "Component", id,
                                 "control 'from' must be a non-empty string");

                if (!comps.count(from))
                    return APERR(
                        Ec::InvalidParam, "Component", id,
                        "control references unknown component id:", from);

                // Store the component information for later validation
                auto &compFrom = comps[from];
                compFrom.controls.push_back(&comp);
            }
        }
    }

    if (!hasSource()) return {};

    // Sometimes these are missing if the user didn't configure the source
    if (!sourceConfig().isMember("mode")) sourceConfig()["mode"] = "Source";
    if (!sourceConfig().isMember("type"))
        sourceConfig()["type"] = source()["provider"];

    // Link input lanes to output lanes of the components by service definition.
    //
    // @example:
    //     "lanes": {
    //         "tags": [
    //             "text",
    //             "table",
    //             "image",
    //             "video",
    //             "audio"
    //         ]
    //     }
    _block() {
        for (auto &[id, comp] : comps) {
            for (auto &input : comp.inputs) {
                for (auto &output : comp.outputs) {
                    if (!comp.def->serviceDefinition["lanes"].isMember(
                            input->name))
                        return APERR(Ec::InvalidParam, "Component", id,
                                     "input lane", input->name,
                                     "not found in service definition");

                    if (_anyOf(
                            comp.def->serviceDefinition["lanes"][input->name],
                            output->name))
                        input->outputs.push_back(output);
                }
            }
        }
    }

    // [Rule 13] Check for cycles in the pipeline lane connections
    _block() {
        // Define an array to keep track of the current path in the pipeline
        // graph
        std::vector<LaneInfo *> lanePath;

        // Lambda function to detect cycles in the pipeline graph
        std::function<bool(LaneInfo *)> hasCycle;
        hasCycle = [&](LaneInfo *lane) -> bool {
            if (auto it = std::find(lanePath.begin(), lanePath.end(), lane);
                it != lanePath.end()) {
                // Cycle detected, let's leave only the cycle part in the path
                lanePath.erase(lanePath.begin(), it);
                return true;
            }

            if (lane->visited)
                return false;  // Lane already visited, no cycle here

            // Add the lane to the path
            lanePath.push_back(lane);
            // Mark the lane and the target component as visited
            lane->visited = lane->to->visited = true;
            for (auto *controlComp : lane->to->controls)
                controlComp->visited = true;

            // Recursively check all outputs of this lane for cycles
            for (auto *nextLane : lane->outputs) {
                if (hasCycle(nextLane)) return true;
            }

            // If no cycle was found, remove the lane from the stack
            lanePath.pop_back();
            return false;
        };

        // Mark the source component as visited
        for (auto &[_, comp] : comps) {
            if (comp.id == sourceId) {
                comp.visited = true;
                break;
            }
        }

        // Check the source lanes for cycles
        for (auto &[_, lane] : lanes) {
            if (lane.from->id != sourceId) continue;  // Skip non-source lanes

            if (hasCycle(&lane)) {
                // Format the cycle stack into a string for error reporting
                Text pathMsg;
                for (size_t i = 0; i < lanePath.size(); ++i) {
                    auto *lane = lanePath[i];
                    pathMsg += lane->from->id + "-[" + lane->name + "]->";
                    if (i == lanePath.size() - 1) pathMsg += lane->to->id;
                }
                return APERR(Ec::InvalidParam,
                             "Cycle detected in pipeline:", pathMsg);
            }
        }
    }

    // Build the chain of the components linked with the source
    _block() {
        auto &chain = pipeline["chain"] =
            json::Value{json::ValueType::arrayValue};
        for (const auto &[_, comp] : comps)
            if (comp.def && comp.visited) chain.append(comp.id);
    }

    return {};
}

/**
 * @brief Validates the structure and contents of a pipeline component
 *        configuration JSON object.
 *
 * @details This function ensures that a given JSON object describing
 *          a pipeline component is valid. It performs the following validation
 * rules:
 *
 * 1. A component must have a string "id".
 * 2. A component must have a string "provider".
 * 3. A component must have an object "config".
 * 4. If a component has a "config.profile", it must be a string, and
 *    the corresponding section under config must exist and be an object.
 * 5. If a component has a "config.parameters", it must be an object.
 * 6. If a component has a "config.parameters.secureParameters", it must be an
 * object with a "secure" array and a "token" string.
 *
 * @param component a pipeline component configuration JSON object.
 * @return Error
 */
Error PipelineConfig::validateComponent(const json::Value &component) noexcept {
    // [Rule 1–6] Validate basic structure of each component
    if (!component.isObject())
        return APERR(Ec::InvalidParam, "Component must be an object");

    // [Rule 1] Check that the component has a string "id"
    Text id = component.lookup<Text>("id");
    if (!component.isMember("id") || !component["id"].isString() || !id)
        return APERR(Ec::InvalidParam,
                     "Component 'id' must be a non-empty string");

    // [Rule 2] Check for "provider" string
    if (!component.isMember("provider") || !component["provider"].isString() ||
        !component["provider"].asString())
        return APERR(Ec::InvalidParam, "Component", id,
                     "'provider' must be a non-empty string");

    // [Rule 3] Check for "config" object
    if (!component.isMember("config") || !component["config"].isObject())
        return APERR(Ec::InvalidParam, "Component", id,
                     "missing 'config' object");

    const auto &config = component["config"];

    // [Rule 4] If a "profile" is specified, ensure it exists as a subsection
    if (config.isMember("profile")) {
        Text profileName = config.lookup<Text>("profile");
        if (!config["profile"].isString() || !profileName)
            return APERR(Ec::InvalidParam, "Component", id,
                         "config 'profile' must be a non-empty string");

        if (config.isMember(profileName)) {
            if (!config[profileName].isObject())
                return APERR(Ec::InvalidParam, "Component", id,
                             "config missing profile object",
                             _ts("'", profileName, "'"));

            // [Rule 6] Check for "secureParameters" object
            auto &profile = config[profileName];
            if (auto ccode = validateSecureParameters(profile))
                return APERR(ccode, "Component", id, "config profile",
                             _ts("'", profileName, "':"), ccode.message());
        }
    }

    // [Rule 5] Check for "parameters" object
    if (config.isMember("parameters")) {
        const auto &params = config["parameters"];
        if (!params.isObject())
            return APERR(Ec::InvalidParam, "Component", id,
                         "config 'parameters' must be an object");

        // [Rule 6] Check for "secureParameters" object
        if (auto ccode = validateSecureParameters(params))
            return APERR(ccode, "Component", id,
                         "config 'parameters':", ccode.message());
    }

    return {};
}

/**
 * @brief Validates the structure of the secure parameters if the section
 * contains them.
 *
 * @details This function ensures that a given JSON section has the valid secure
 * parameters. It performs the following validation rules:
 *
 * 6. If a section has a "secureParameters", it must be an object
 *    with a "secure" array and a "token" string.
 *
 * @param component a pipeline component section configuration JSON object.
 * @return Error
 */

Error PipelineConfig::validateSecureParameters(
    const json::Value &section) noexcept {
    if (!section.isMember("secureParameters")) return {};

    // [Rule 6] Check for "secureParameters" object
    const auto &secureParams = section["secureParameters"];
    if (!secureParams.isObject())
        return APERR(Ec::InvalidParam, "'secureParameters' must be an object");

    if (!secureParams.isMember("secure") || !secureParams["secure"].isArray())
        return APERR(Ec::InvalidParam,
                     "'secureParameters' must have a 'secure' array");

    if (!secureParams.isMember("token") || !secureParams["token"].isString())
        return APERR(Ec::InvalidParam,
                     "'secureParameters' must have a 'token' string");

    return {};
}

/**
 * @brief Upgrades the component configuration to the latest version if needed.
 *
 * @details This function checks the version of the component configuration
 *          and performs necessary upgrades to ensure compatibility with
 *          the latest expected structure.
 *
 * @param component a pipeline component configuration JSON object.
 * @param version the pipeline services version for upgrade checks.
 * @return Error
 */
Error PipelineConfig::upgradeComponent(json::Value &component,
                                       int version) noexcept {
    Text id = component["id"].asString();
    Text provider = component["provider"].asString();
    auto &config = component["config"];
    const auto *params =
        config.isMember("parameters") ? &config["parameters"] : nullptr;

    // Upgrade the component configuration based on its version
    if (version < 1) {
        if (params &&
            (provider == "gmail" || provider == "google-drive" ||
             provider == "ms-onedrive" || provider == "outlook" ||
             provider == "slack" || provider == "llm_vertex") &&
            params->isMember("authType")) {
            auto authType = params->lookup<Text>("authType");

            if (authType == "service" || authType == "enterprise")
                provider += "-enterprise";
            else if (authType == "user" || authType == "personal")
                provider += "-personal";

            component["provider"] = provider;
            if (config.isMember("type")) config["type"] = provider;
        }
    }

    return {};
}

/**
 * @brief Decrypts secure parameters in the pipeline configuration.
 *
 * This function iterates through all components in the pipeline configuration,
 * decrypts secure parameters if they exist, and restores them into the
 * configuration parameters.
 *
 * @param overwrite If true, existing parameters will be overwritten with
 *                  the decrypted secure values.
 * @return An Error object.
 */
Error PipelineConfig::decrypt(bool overwrite /*= false*/) noexcept {
    for (auto &component : components()) {
        if (auto ccode = decryptComponent(component, overwrite)) return ccode;
    }
    return {};
}

/**
 * @brief Decrypts secure parameters in a specific component of the pipeline
 * configuration.
 *
 * @param component A reference to a JSON object representing the component
 * configuration.
 * @param overwrite If true, existing parameters will be overwritten with
 *                  the decrypted secure values.
 * @return An Error object.
 */
Error PipelineConfig::decryptComponent(json::Value &component,
                                       bool overwrite) noexcept {
    Text id = component["id"].asString();
    auto &config = component["config"];

    Error ccode;

    Text profileName = config.lookup<Text>("profile");
    if (profileName && config.isMember(profileName)) {
        auto &profile = config[profileName];
        if (auto _ccode = decryptSection(profile, overwrite))
            ccode = APERR(_ccode, "Component", id, "config profile",
                          _ts("'", profileName, "':"), _ccode.message()) ||
                    ccode;
    }

    if (config.isMember("parameters")) {
        auto &params = config["parameters"];
        if (auto _ccode = decryptSection(params, overwrite))
            ccode = APERR(_ccode, "Component", id,
                          "config 'parameters':", _ccode.message()) ||
                    ccode;
    }

    return ccode;
}

/**
 * @brief Decrypts secure parameters in a specific component of the pipeline
 * configuration.
 *
 * @param id An identificator of the component whose configuration contains the
 * specified section.
 * @param section A reference to a JSON object representing the section of the
 * component configuration.
 * @param overwrite If true, existing parameters will be overwritten with
 *                  the decrypted secure values.
 * @return An Error object.
 */
Error PipelineConfig::decryptSection(json::Value &section,
                                     bool overwrite) noexcept {
    if (!section.isMember("secureParameters")) return {};

    const auto &secureParams = section["secureParameters"];
    const auto &secureNames = secureParams["secure"];
    Text token = secureParams["token"].asString();

    // Decode and decrypt the secure parameters
    auto encryptedValues = crypto::base64Decode(token);
    if (!encryptedValues) return encryptedValues.ccode();

    auto decryptedValues = crypto::engineDecrypt(*encryptedValues);
    if (!decryptedValues) return decryptedValues.ccode();

    auto secureValues = json::parse(decryptedValues->toTextView());
    if (!secureValues) return secureValues.ccode();

    // Restore secure parameters into the config parameters
    for (const auto &jname : secureNames) {
        // Validate the secure name to be a string and exist in the secure
        // values
        Text name = jname.isString() ? jname.asString() : Text{};
        if (!name)
            return APERR(Ec::InvalidParam,
                         "'secureParameters.secure' array items must be "
                         "non-empty strings");
        if (!secureValues->isMember(name))
            return APERR(Ec::InvalidParam,
                         "'secureParameters.token' object must contain the "
                         "secure value of",
                         _ts("'", name, "'"));

        // Update the parameter with decrypted secure value if necessary
        if (overwrite || !section.isMember(name))
            section[name] = (*secureValues)[name];
    }

    return {};
}

/**
 * @brief Encrypts secure parameters in the pipeline configuration.
 *
 * This function iterates through all components in the pipeline configuration,
 * collects secure parameters, encrypts them, and adds them to the
 * configuration parameters under a "secureParameters" section.
 *
 * @return An Error object.
 */
Error PipelineConfig::encrypt() noexcept {
    for (auto &component : components()) {
        if (auto ccode = encryptComponent(component)) return ccode;
    }
    return {};
}

/**
 * @brief Encrypts secure parameters in a specific component of the pipeline
 * configuration.
 *
 * @param component A reference to a JSON object representing the component
 * configuration.
 * @return An Error object.
 */
Error PipelineConfig::encryptComponent(json::Value &component) noexcept {
    Text id = component["id"].asString();
    auto &config = component["config"];

    // Get the type of the service
    auto type = config["type"].asString();
    // If the type is not specified, try to get it from the provider
    if (!type) type = component["provider"].asString();
    // If neither type nor provider is specified, return an error
    if (!type)
        return APERR(Ec::InvalidParam, "Component", id,
                     "must have a 'type' or 'provider' specified");

    // Get the service definition for the service type
    auto def = IServices::getServiceDefinition(type);
    if (!def) return {};

    Error ccode;

    Text profileName = config.lookup<Text>("profile");
    if (profileName && config.isMember(profileName)) {
        auto &profile = config[profileName];
        ccode = encryptSection(*def, profile) || ccode;
    }

    if (config.isMember("parameters")) {
        auto &params = config["parameters"];
        ccode = encryptSection(*def, params) || ccode;
    }

    return ccode;
}

/**
 * @brief Encrypts secure parameters in a specific section of the component
 * configuration.
 *
 * @param def A pointer to a service definition structure.
 * @param section A reference to a JSON object representing the section of the
 * component configuration.
 * @return An Error object.
 */
Error PipelineConfig::encryptSection(IServices::ServiceDefinitionPtr def,
                                     json::Value &section) noexcept {
    // Collect the secure parameters
    json::Value secureNames(json::arrayValue), secureValues(json::objectValue);

    for (const auto &[name, type] : def->secureParameters) {
        // Skip if the parameter not in the config or not secure
        if (!section.isMember(name) || type != PARAM_TYPE::SECURE) continue;

        // Store the secure parameter name and value
        secureNames.append(name);
        secureValues[name] = section[name];
        // Remove the secure parameter from the parameters
        section.removeMember(name);
    }

    // If we have secure parameters, encrypt them and add to the config
    if (secureNames) {
        // Encrypt the secure values
        auto encryptedValues = crypto::engineEncrypt(secureValues.stringify());
        if (!encryptedValues) return encryptedValues.ccode();

        // Convert the encrypted values to a base64 token
        auto token = crypto::base64Encode(*encryptedValues);

        // Create the secure section with the secure parameters and token
        json::Value secureSection;
        secureSection["secure"] = secureNames;
        secureSection["token"] = token;

        // Add the secure section to the config parameters
        section["secureParameters"] = secureSection;
    }

    return {};
}

/**
 * @brief Whether or not the source of the pipeline specified.
 */
bool PipelineConfig::hasSource() const noexcept {
    return m_root["pipeline"].isMember("source") &&
           m_root["pipeline"]["source"].isString() &&
           m_root["pipeline"]["source"].asString();
}

/**
 * @brief Provides the configuration of the target endpoint for the pipeline.
 */
json::Value &PipelineConfig::targetConfig() noexcept {
    if (m_targetConfig) return m_targetConfig;

    // Set the configuration for a null service
    m_targetConfig = R"(
        {
            "key": "null://*",
            "name": "Null endpoint",
            "type": "null",
            "mode": "target",
            "parameters": {},
            "pipeline": {}
        }
    )"_json;

    // Find the remote
    auto remoteComponent = std::find_if(
        components().begin(), components().end(),
        localfcn(const json::Value &component) {
            return component.lookup<Text>("provider") == "remote";
        });

    if (remoteComponent != components().end()) {
        // Pre-process the pipeline configuration with remote component
        json::Value remotePipeline;

        auto python = localfcn {
            // Get pyhton function that processes the pipeline configuration
            // with the simplified remote pipeline configuration
            // to a full specified pipeline configuration to process by the
            // local and remote hosts.
            py::module remoteModule = py::module::import("nodes.remote.client");
            py::function preparePipeline = remoteModule.attr("preparePipeline");

            py::dict pyPipeline =
                python::pyjson::jsonToDict(root()["pipeline"]);

            // Get a full specified pipeline configuration
            py::dict pyRemotePipeline = preparePipeline(pyPipeline);

            // Put this prepared remoted pipeline configuration into the service
            // entry
            remotePipeline = _mv(python::pyjson::dictToJson(pyRemotePipeline));
        };
        if (auto ccode = callPython(python))
            // Skip error for now
            // return ccode;
            LOG(Always, ccode);

        // Update the pipeline configuration
        m_targetConfig["pipeline"] = remotePipeline;

    } else {
        // Put the pipeline configuration into the service entry
        m_targetConfig["pipeline"] = root()["pipeline"];
    }
    return m_targetConfig;
}

/**
 * @brief Adds the error or the warning to the specified configuration root.
 */
void PipelineConfig::addError(json::Value &root, const Error &ccode,
                              TextView id) noexcept {
    TextView memberName = ccode == Ec::Warning ? "warnings" : "errors";
    if (!root.isMember(memberName))
        root[memberName] = json::Value(json::ValueType::arrayValue);

    json::Value err;
    if (id) err["id"] = id;
    err["ccode"] = ccode.plat();
    err["message"] = ccode.message();

    root[memberName].append(err);
}

/**
 * @brief Adds the error or the warning to the pipeline configuration root.
 */
void PipelineConfig::addError(const Error &ccode, TextView id) noexcept {
    addError(m_root, ccode, id);
}

}  // namespace engine::store::pipeline
