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

namespace engine::store {
//-------------------------------------------------------------------------
/// @details
///		Destructor - ends the endpoint
//-------------------------------------------------------------------------
IServiceEndpoint::~IServiceEndpoint() {
    LOGPIPE();

    // Remove it if we are registered
    Debugger::deregisterDebugger(taskId);

    // Stop
    endEndpoint();
};

//-------------------------------------------------------------------------
/// @details
///		Sets up the endpoint
///	@param[in]	openMode
///		The open mode. Will be either READ or WRITE
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::beginEndpoint(OPEN_MODE _openMode) noexcept {
    Error ccode;

    LOGPIPE();

    // Should not be opened
    if (config.openMode != OPEN_MODE::NONE)
        return APERR(Ec::InvalidCommand, "Endpoint already open");

    // Set/reset open mode
    util::Guard pipes{[&] { config.openMode = _openMode; },
                      [&] {
                          if (ccode) config.openMode = OPEN_MODE::NONE;
                      }};

    // Get the pipe stack to create
    if (ccode = buildPipeStack()) return ccode;

    // If we are actually starting the endpoint, we need to build
    // the global pipe and the connectoions
    if (!this->m_stackOnly) {
        // Build the global pipe
        if (ccode = buildGlobalPipe()) return ccode;

        // We have now finalized all of our stack components, so we
        // can build the connection list
        if (ccode = buildConnections()) return ccode;

        // Build the breakpoint list
        if (ccode = buildBreakpoints()) return ccode;
    }

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Sets up the endpoint
///	@param[in]	openMode
///		The open mode. Will be either READ or WRITE
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::signal(const Text &signal,
                               json::Value &param) noexcept {
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Destructs or ends the endpoint access
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::endEndpoint() noexcept {
    Error ccode;

    LOGPIPE();

    // Clear our selection info
    deinitSelections();

    // Clear the target (if any)
    target = {};

    // Destroy all the instance pipes and their filters we created,
    // even if we are not open
    while (!m_instanceStacks.empty()) {
        // Get the last stack
        auto instanceStack = _mv(m_instanceStacks.back());
        m_instanceStacks.pop_back();

        // For each filter in this instance stack
        while (!instanceStack.empty()) {
            // Get the last filter
            auto filter = _mv(instanceStack.back());
            instanceStack.pop_back();

            // Tell the filter to end
            ccode = filter->endFilterInstance() || ccode;
        }
    }

    // Destroy all the globals, even if we are not open
    while (!m_globalStack.empty()) {
        // Get the last filter
        auto filter = _mv(m_globalStack.back());
        m_globalStack.pop_back();

        // Close it if we are not in config mode
        if (config.openMode != OPEN_MODE::CONFIG &&
            config.openMode != OPEN_MODE::PIPELINE_CONFIG) {
            ccode = filter->endFilterGlobal() || ccode;
        }
    }

    // End it
    config.openMode = OPEN_MODE::NONE;
    return ccode;
}

//-------------------------------------------------------------------------
/// @details
///		Static function to easily get the major type of the endpoint
///	@param[in]	serviceSection
///		The service section
///	@returns
///		Error
//-------------------------------------------------------------------------
ErrorOr<Text> IServiceEndpoint::getLogicalType(
    const json::Value &serviceConfig) noexcept {
    // Look up the type
    Text type = serviceConfig.lookup<iText>("type").lowerCase();

    // Split off the :// if it is there
    const auto parsed = type.split(':');

    // Prevent a crash
    if (parsed.size() < 1)
        return APERR(Ec::InvalidCommand, "Endpoint type not specified");

    // Return the type without the ://
    return parsed[0];
}

//-------------------------------------------------------------------------
/// @details
///		Gets the physical node type. For example, given ms-ondrive,
///		this returns python, or given filesys, it will return filesys
///	@param[in]	serviceConfig
///		The service section
//-------------------------------------------------------------------------
ErrorOr<Text> IServiceEndpoint::getPhysicalType(
    const json::Value &serviceConfig) noexcept {
    // Get the type specified
    auto type = IServiceEndpoint::getLogicalType(serviceConfig);
    if (!type) return type.ccode();

    // Get our service definition if we have one, if we don't just
    // return the logical type
    auto service = IServices::getServiceDefinition(*type);
    if (!service) return service.ccode();

    // Return the physical type
    return (*service)->physicalType;
}

//-------------------------------------------------------------------------
/// @details
///		Static function to easily create an endpoint
/// @param[in]	endpointMode
///		The mode of the endpoint
///	@param[in]	param
///		The parameters for the endpoint
//-------------------------------------------------------------------------
ErrorOr<ServiceEndpoint> IServiceEndpoint::getEndpoint(
    ENDPOINT_MODE endpointMode, ENDPOINT_PARAM &param) noexcept {
    // If there is no service config
    auto defaultServiceConfig = json::Value();

    // Based on the mode
    switch (endpointMode) {
        case ENDPOINT_MODE::SOURCE: {
            // We need a source endpoint - generate it
            defaultServiceConfig = R"(
                        {
                            "key": "null://*",
                            "name": "Null endpoint",
                            "type": "null",
                            "mode": "source",
                            "parameters": {}
                        }
                    )"_json;
            break;
        }

        case ENDPOINT_MODE::TARGET: {
            // We need a target endpoint - generate it
            defaultServiceConfig = R"(
                        {
                            "key": "null://*",
                            "name": "Null endpoint",
                            "type": "null",
                            "mode": "target",
                            "parameters": {}
                        }
                    )"_json;
        }
    }

    // Check the job config
    if (!param.jobConfig.has_value() || param.jobConfig.value().get().isNull())
        return APERR(Ec::InvalidCommand, "Job configuration is required");

    // Get the job config
    auto jobConfig = param.jobConfig.value().get();
    if (!jobConfig.isObject() || !jobConfig.isMember("taskId") ||
        !jobConfig["taskId"].isString())
        return APERR(Ec::InvalidCommand,
                     "taskId is required in your job configuration");

    // Get the task id
    auto taskId = jobConfig["taskId"].asString();

    // If there is no service config, use the null endpoint
    // Null is also a value, check for null explicitly
    if (!param.serviceConfig.has_value() ||
        param.serviceConfig.value().get().isNull())
        param.serviceConfig = defaultServiceConfig;

    // Get the type specified
    auto logicalType = IServiceEndpoint::getLogicalType(*param.serviceConfig);
    if (!logicalType) return logicalType.ccode();

    // Get the type specified
    auto physicalType = IServiceEndpoint::getPhysicalType(*param.serviceConfig);
    if (!physicalType) return physicalType.ccode();

    // Setup the pipe info
    IPipeType pipe{*logicalType, *logicalType, *physicalType};

    // Make the endpoint
    auto result = Factory::make<IServiceEndpoint>(_location, pipe);
    if (!result) return result.ccode();

    // Move it to a shared ptr
    ServiceEndpoint endpoint = _mv(*result);

    // Set the taskId
    endpoint->taskId = taskId;

    // Set the self referential weak ptr
    endpoint->endpoint = endpoint;

    // Save the endpoint mode
    endpoint->config.endpointMode = endpointMode;

    // Get our service definition if we have one, if we don't just
    // return the logical type
    auto service = IServices::getServiceDefinition(*logicalType);
    if (!service) return service.ccode();

    // Save the capabilities
    endpoint->capabilities = (*service)->capabilities;

    // Decode everything
    if (auto ccode = endpoint->setConfig(*param.jobConfig, *param.taskConfig,
                                         *param.serviceConfig))
        return ccode;

    // Save the request to the get pipe stack only - not begin it
    endpoint->m_stackOnly = param.stackOnly;

    // If we are in debug mode, bind the debugger
    if (param.debug) {
        // Bind it to this endpoint
        Debugger::registerDebugger(endpoint);
    }

    // If an open mode was specified, open it
    if (param.openMode != OPEN_MODE::NONE) {
        // Begin operations
        if (auto ccode = endpoint->beginEndpoint(param.openMode)) return ccode;

        // If we are a sync style driver, open the key value store
        if (endpoint->capabilities & Url::PROTOCOL_CAPS::SYNC) {
            // Key-Value storage
            if (auto ccode = endpoint->openKeyValueStorage()) return ccode;
        }
    }

    // And return the new endpoint
    return endpoint;
}

//-------------------------------------------------------------------------
/// @details
///		Static function to easily create an endpoint
///	@param[in]	param
///		The parameters for the endpoint
//-------------------------------------------------------------------------
ErrorOr<ServiceEndpoint> IServiceEndpoint::getSourceEndpoint(
    ENDPOINT_PARAM &&param) noexcept {
    return getEndpoint(ENDPOINT_MODE::SOURCE, param);
}

//-------------------------------------------------------------------------
/// @details
///		Static function to easily create an endpoint
///	@param[in]	param
///		The parameters for the endpoint
//-------------------------------------------------------------------------
ErrorOr<ServiceEndpoint> IServiceEndpoint::getTargetEndpoint(
    ENDPOINT_PARAM &&param) noexcept {
    return getEndpoint(ENDPOINT_MODE::TARGET, param);
}

//-------------------------------------------------------------------------
/// @details
///		Inserts a filter into the pipe. This is only valid during
///     beginGlobal
///	@param[in]	filter
///		Name of filter to instantiate
/// @param[in]  config
///     Configuration of the filter
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::insertFilter(const Text &filterName,
                                     const json::Value &filterConfig) {
    // Check to make sure this is a valid op
    if (pipeStackIndex < 0)
        throw APERR(Ec::InvalidCommand, "Only available during beginGlobal");

    // Create the filter object
    IPipeType filter;
    filter.id = filterName;
    filter.logicalType = filterName;
    filter.physicalType = filterName;
    filter.connConfig = filterConfig;

    // Ensure pipeStack is valid and insert the filter at the specified index
    if (pipeStackIndex < 0 || _cast<size_t>(pipeStackIndex) > pipeStack.size())
        throw APERR(Ec::OutOfRange, "Invalid pipe stack index");

    // Insert the filter at the current index
    pipeStack.insert(pipeStack.begin() + pipeStackIndex + 1, _mv(filter));

    // Increment the index after the insertion
    pipeStackIndex++;
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Open the endpoints key value store
///	@returns
///		Error
//-------------------------------------------------------------------------
Error IServiceEndpoint::openKeyValueStorage() noexcept {
    // get keystore parameter
    Text keyStoreUrlText;
    if (auto ccode =
            config.taskConfig.lookupAssign("keystore", keyStoreUrlText))
        return ccode;
    if (keyStoreUrlText.empty()) return {};

    // open keystore
    Url keyStoreUrl{keyStoreUrlText};
    Text subKey;
    if (auto ccode = getConfigSubKey(subKey)) return ccode;
    if (!subKey)
        return APERR(Ec::InvalidCommand,
                     "Configuration subkey is required to open key store");
    // Key format would consists from
    //  - the physical type of the endpoint
    //  - the logical type of the endpoint
    //  - the config subkey for the endpoint
    // For example, `python_ms-sharepoint_` where
    //  - `python` is the physical type of the endpoint
    //  - `ms-sharepoint` is the logical type of the endpoint
    //  - `` (empty string) is the config subkey for the endpoint (empty in case
    //  of SharePoint online)
    Text serviceKey =
        _ts(config.physicalType, "_", config.logicalType, "_", subKey);
    LOGT("Opening keystore with key", serviceKey);
    if (auto ccode = keystore::open(keyStoreUrl, serviceKey); ccode.hasCcode())
        return ccode.ccode();
    else
        m_keyStore = _mv(*ccode);

    return {};
}

}  // namespace engine::store