// =============================================================================
// MIT License
//
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

namespace engine::store {
namespace {
//---------------------------------------------------------------------
/// @details
///		Decrypts the secrets within the service parameters and
///     populates the parameters with the hidden token values
///	@param[inout] service
///		Service to decrypt
//---------------------------------------------------------------------
Error decryptParameters(json::Value &service) noexcept {
    // Ge the service configuration information
    auto serviceInfo = IServices::getServiceDefinitionFromService(service);
    if (!serviceInfo) return serviceInfo.ccode();

    // Get the parameters section
    if (!service.isMember("parameters")) return {};
    auto &parameters = service["parameters"];

    // If it doesn't have secure parameters, we are done
    if (!parameters.isMember("secureParameters")) return {};
    auto &secureSection = parameters["secureParameters"];

    // Find the token
    Text token;
    if (auto ccode = secureSection.lookupAssign("token", token)) return ccode;
    if (!token) return {};

    // Decode the token
    auto decoded = crypto::base64Decode(token);
    if (!decoded) return decoded.ccode();

    // Decrypt the token
    auto plaintext = crypto::engineDecrypt(*decoded);
    if (!plaintext) return plaintext.ccode();

    // Parse the JSON
    auto res = json::parse(plaintext->toTextView());
    if (!res) return res.ccode();
    auto secureValues = *res;

    // Extract each from the config
    for (auto &param : (*serviceInfo)->secureParameters) {
        // Get the key and flags from the parameter specs
        const auto keyName = param.first;
        const auto type = param.second;

        // Based on the type
        switch (type) {
            case PARAM_TYPE::SECURE: {
                // If this is already defined, we can skip it. This
                // allows us to update passwords, etc
                if (parameters.isMember(keyName)) continue;

                // If it not here either, skip it
                if (!secureValues.isMember(keyName)) continue;

                // Get the value
                auto value = secureValues[keyName];

                // Save it into the parameters
                parameters[keyName] = value;
                break;
            }
            default:
                // For other types, ignore it
                continue;
        }
    }

    // Remove the secure section now
    parameters.removeMember("secureParameters");
    return {};
}

//---------------------------------------------------------------------
/// @details
///		Encrypts the secrets within the service parameters. For secure
///		parameters, it places the values int the secure section with the
///		name and removes it from the parameters list. For readonly parameters
///		it leaves the value in the parameters, but copies it into secure
///		so we can ensure it is not overwritten
///	@param[in]	configParam
///		Parameter configuration info
///	@param[inout] target
///		Parameters set to encrypt
//---------------------------------------------------------------------
Error encryptParameters(IServiceConfig &config, json::Value &service) noexcept {
    json::Value secureNames(json::arrayValue);
    json::Value readonlyNames(json::arrayValue);
    json::Value secretValues;

    // Ge the service configuration information
    auto serviceInfo =
        IServices::getServiceDefinitionFromService(config.serviceConfig);
    if (!serviceInfo) return serviceInfo.ccode();

    // Make sure we have parameters
    if (!config.serviceConfig.isMember("parameters")) return {};

    // Make a copy of them to return
    service["parameters"] = config.serviceConfig["parameters"];

    // Get a references to the parameters we are going to return
    auto &parameters = service["parameters"];

    // Extract each from the config
    for (auto &param : (*serviceInfo)->secureParameters) {
        // Get the key and flags from the parameter specs
        const auto keyName = param.first;
        const auto type = param.second;

        // If we do not have a value on the input, skip this
        if (!parameters.isMember(keyName)) continue;

        // Get the value
        auto value = parameters[keyName];

        // Based on the type
        switch (type) {
            case PARAM_TYPE::SECURE:
                // Remove it from the parameters
                parameters.removeMember(keyName);

                // And add it to the secret names for the UI
                secureNames.append(keyName);
                break;

            default:
                // For other types, ignore it
                continue;
        }

        // Copy it over regard
        secretValues[keyName] = value;
    }

    // Encrypt secrets
    auto ciphertext = crypto::engineEncrypt(secretValues.stringify());
    if (!ciphertext) return ciphertext.ccode();

    // Convert into a string
    auto token = crypto::base64Encode(*ciphertext);

    // Create secureSection object
    json::Value secureSection;
    secureSection["readonly"] = readonlyNames;
    secureSection["secure"] = secureNames;
    secureSection["token"] = token;

    // Save it into the parameters
    parameters["secureParameters"] = secureSection;
    return {};
}

}  // namespace

//------------------------------------------------------------------
/// @details
///		Sets up the configuration of the endpoint
///	@param[in]	jobConfig
///		The overall job information - the complete parsed json file
///	@param[in]	taskConfig
///		The task configuration - the config section of the job
///	@param[in]	serviceConfig
///		The service configuration for the endpoint
//------------------------------------------------------------------
Error IServiceEndpoint::setConfig(const json::Value &_jobConfig,
                                  const json::Value &_taskConfig,
                                  const json::Value &_serviceConfig) noexcept {
    Error ccode;

    // Save these first
    config.jobConfig = _jobConfig;
    config.taskConfig = _taskConfig;
    config.serviceConfig = _serviceConfig;

    // Make a copy of it
    config.originalServiceConfig = _serviceConfig;

    // Clear the level - this is setup by the bind
    config.level = 0;

    // Lookup the path that we are supposed to strip off before
    // from the source path before sending it to the target
    config.taskConfig.lookupAssign("commonTargetPath", config.commonTargetPath);
    config.taskConfig.lookupAssign("flatten", config.flatten);

    // Read the common settings from the service itself
    if ((ccode = config.serviceConfig.lookupAssign("name", config.name) ||
                 config.serviceConfig.lookupAssign("key", config.key)))
        return ccode;

    // Get the logical type
    auto logicalType = IServiceEndpoint::getLogicalType(config.serviceConfig);
    if (!logicalType) return logicalType.ccode();
    config.logicalType = *logicalType;

    // Get the logical type
    auto physicalType = IServiceEndpoint::getPhysicalType(config.serviceConfig);
    if (!physicalType) return physicalType.ccode();
    config.physicalType = *physicalType;

    // Set the protocol
    config.protocol = config.logicalType + "://";

    // Based on the mode requested
    Text mode = config.serviceConfig.lookup<Text>("mode").lowerCase();
    if (mode == "source")
        config.serviceMode = SERVICE_MODE::SOURCE;
    else if (mode == "target")
        config.serviceMode = SERVICE_MODE::TARGET;
    else
        return APERR(Ec::InvalidParam, "Invalid service mode", mode,
                     "specified");

    // Decrypt our copy of the parameters
    if (ccode = decryptParameters(config.serviceConfig)) return ccode;

    // Save the decrypted parameters
    if (auto ccode =
            config.serviceConfig.lookupAssign("parameters", config.parameters))
        return ccode;

    // Validate the pipeline configuration if it is
    if (config.serviceConfig.isMember("pipeline")) {
        config.pipeline.setRoot(config.serviceConfig);
        if (auto ccode = config.pipeline.validate()) return ccode;
    }

    // Read other common settings from the parameters
    config.parameters.lookupAssign<Dword>("segmentSize", config.segmentSize);

    // Older UIs sent where we are storingdata as basePath
    // not storePath, so, if they did, look for the
    // storePath in the basePath value
    config.parameters.lookupAssign("storePath", config.storePath);
    if (!config.storePath)
        config.parameters.lookupAssign("basePath", config.storePath);

    // Lookup the export update behavior
    config.taskConfig.lookupAssign("update", config.exportUpdateBehaviorName);
    config.exportUpdateBehaviorName.lowerCase();

    // Get the format type
    if (config.exportUpdateBehaviorName == "skip"_tv)
        config.exportUpdateBehavior = EXPORT_UPDATE_BEHAVIOR::SKIP;
    else if (config.exportUpdateBehaviorName == "update"_tv)
        config.exportUpdateBehavior = EXPORT_UPDATE_BEHAVIOR::UPDATE;
    else
        config.exportUpdateBehavior = EXPORT_UPDATE_BEHAVIOR::UNKNOWN;

    // Lookup the pipeline trace level
    Text traceLevelStr;
    config.taskConfig.lookupAssign("pipelineTraceLevel", traceLevelStr);
    if (traceLevelStr == "metadata"_tv)
        config.pipelineTraceLevel = PIPELINE_TRACE_LEVEL::METADATA;
    else if (traceLevelStr == "summary"_tv)
        config.pipelineTraceLevel = PIPELINE_TRACE_LEVEL::SUMMARY;
    else if (traceLevelStr == "full"_tv)
        config.pipelineTraceLevel = PIPELINE_TRACE_LEVEL::FULL;

    // Done
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Given a service configuration, encoded or not, this function will
///		encode it and return a json structure that can be returned to
///		the UI
///	@param[out]	serviceConfig
///		Recieves the encoded values to be returned to UI
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::getConfig(json::Value &_serviceConfig) noexcept {
    using namespace ap::url;

    Error ccode;
    // Get the actual unique key from the unencoded parameters
    Text subkey;
    if (auto ccode = getConfigSubKey(subkey)) return ccode;
    if (!subkey) subkey = "*";

    // Build the url
    Url key = builder() << protocol(config.protocol) << component(subkey);

    // Get the original values
    _serviceConfig = config.originalServiceConfig;

    // Update the settings we need
    _serviceConfig["name"] = config.name;
    _serviceConfig["type"] = config.logicalType;
    _serviceConfig["key"] = (TextView)key;

    // Make a copy of the parameters
    json::Value params = config.parameters;

    // Encrypt the parameters that matter
    if ((ccode = encryptParameters(config, _serviceConfig))) return ccode;

    return {};
}

}  // namespace engine::store
