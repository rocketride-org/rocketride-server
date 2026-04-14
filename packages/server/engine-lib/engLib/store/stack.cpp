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
Error IServiceEndpoint::buildBreakpoints() noexcept {
    // Get the pipeline information
    const auto &pipeline = config.pipeline.root();

    // Determine if we have breakpoints specified
    if (!pipeline.isMember("breakpoints")) return {};

    // If there are no breakpoints, return empty
    const auto &breakpoints = pipeline["breakpoints"];
    if (!breakpoints.isArray()) return {};

    // Add all the breakpoints
    std::string any = "*";

    for (const auto &bp : breakpoints) {
        // Make sure it is valid
        if (!bp.isMember("from") || !bp["from"].isString())
            continue;  // skip invalid entries

        // Get the breakpoint
        std::string from = bp["from"].asString();
        std::string to = bp.isMember("to") && bp["to"].isString()
                             ? bp["to"].asString()
                             : any;
        std::string lane = bp.isMember("lane") && bp["lane"].isString()
                               ? bp["lane"].asString()
                               : any;

        // Put it into the breakpoint list
        debugger.taskBreakpointAdd(from, to, lane);
    }

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Determines the pipe filters to create. This uses the
///		config.serviceConfig.filters to grab parameters for each layer
///     in the stack. Override this function so the endpoint can add its
///     configuration and pipe filters at the end of the stack. Make sure
///     the parent is also called if you override so all components have
///     the opportunity to add filters as necessary.
///	@param[out] filters
///		Receives the vector of filters to create
//-------------------------------------------------------------------------
Error IServiceEndpoint::getPipeFilters(IPipeFilters &filters) noexcept {
    // If its there, then add all the filters in the array. They can
    // be either strings, or an object with config info
    if (config.serviceConfig.isMember("filters")) {
        for (const auto &configFilter : config.serviceConfig["filters"]) {
            if (configFilter.isString())
                filters.push_back(configFilter.asString());
            else
                filters.push_back(configFilter);
        }
    }
    return {};
}

//-------------------------------------------------------------------------
/// @brief Creates a connection table mapping indices of components in the list
/// to their
///        dependencies and associated lanes.
///
/// This function processes the connections array, looks up the "from" and "to"
/// IDs in the components list to determine their indices, and stores a mapping
/// of these indices along with the connection lane. It enables quick access to
/// dependency relationships.
///
/// std::vector<std::tuple<int, int, std::string>> A vector of tuples, where
/// each tuple
///         contains:
///         - The index of the "from" component in the components list.
///         - The index of the "to" component in the components list.
///         - The lane associated with the connection.
//-------------------------------------------------------------------------
Error IServiceEndpoint::buildConnections() noexcept {
    const auto COMPONENT_SOURCE = -1;
    const auto COMPONENT_NOT_FOUND = -2;

    // If we are not in pipeline mode, done
    if (!isPipeline()) return {};

    // Reset our connections list
    connections.clear();

    // If no connections are provided, return early
    auto &components = config.pipeline.components();
    auto sourceId =
        config.pipeline.source().lookup<std::string>("id", "source");

    // Get the ids of the pipestack components regardless of whether
    // or not they are used
    std::map<std::string, int> pipeId;
    for (auto index = 0; index < pipeStack.size(); ++index) {
        // Get the ID
        std::string id = pipeStack[index].id;

        // Check for uniqueness
        if (pipeId.find(id) != pipeId.end())
            return APERR(Ec::InvalidParam, "Duplicate id found: ", id);

        // Add the ID mapping
        pipeId.insert({id, index});
    }

    // Get the component id of a loaded component in the stack. This
    // does not consider the source
    auto findComponentId = localfcn(std::string & id)->int {
        // If this one was not included, return -1
        if (pipeId.find(id) == pipeId.end()) return COMPONENT_NOT_FOUND;

        // Return the pipe id
        return pipeId[id];
    };

    // Get the component id of a loaded component, or -1 for
    // the source
    auto getComponentId = localfcn(std::string & id)->int {
        if (id == sourceId) return COMPONENT_SOURCE;

        // If this one was not included, return -1
        if (pipeId.find(id) == pipeId.end()) return COMPONENT_NOT_FOUND;

        // Return the pipe id
        return pipeId[id];
    };

    // Now, for each of its connections
    for (const auto &component : components) {
        // Get this components id
        auto compId = component["id"].asString();

        // If we didn't make the cut, we were not included,
        // nobody referenced us
        auto toId = findComponentId(compId);
        if (toId < 0) continue;

        // Check to we need input from someone else
        if (component.isMember("input")) {
            auto &input = component["input"];

            // Walk through the components we need to get data from
            for (const auto &comp : input) {
                // Get the lane and the connect to target
                auto from = comp["from"].asString();
                auto lane = comp["lane"].asString();

                // Pipelines store conditional branch targets as the real data lane
                // (text / questions / answers) plus ``branch``: 0 or 1. The binder
                // applies branch filtering when instances are bound via the
                // meta-lanes ``then`` (0) or ``else`` (1) and tags them in
                // ``m_branchMap`` (see Binder::bind).
                if (comp.isMember("branch") && comp["branch"].isIntegral()) {
                    const int branch = comp["branch"].asInt();
                    Text fromProvider;
                    for (const auto &c : components) {
                        if (c["id"].asString() == from) {
                            fromProvider = c["provider"].asString();
                            break;
                        }
                    }
                    if (fromProvider == "conditional_text" ||
                        fromProvider == "conditional_questions" ||
                        fromProvider == "conditional_answers") {
                        if (branch == 0)
                            lane = "then";
                        else if (branch == 1)
                            lane = "else";
                    }
                }

                // Get the component id. If it is not found, it is not
                // included or it is not the source, so skip it
                auto fromId = getComponentId(from);
                if (fromId == COMPONENT_NOT_FOUND) continue;

                // See if it is already there
                auto connTuple = std::make_tuple(fromId, toId, lane);
                if (std::find(connections.begin(), connections.end(),
                              connTuple) != connections.end())
                    continue;

                // Nope, add it
                connections.emplace_back(connTuple);
            }
        }

        // Check to we need control/invoke from someone else
        if (component.isMember("control")) {
            auto &components = component["control"];

            // Walk through the components we need to get data from
            for (const auto &comp : components) {
                // Get the lane and the connect to target
                auto from = comp["from"].asString();
                auto classType = comp["classType"].asString();

                // Get the component id. If it is not found, it is not
                // included or it is not the source, so skip it
                auto fromId = getComponentId(from);
                if (fromId == COMPONENT_NOT_FOUND) continue;

                // See if it is already there
                auto ctrlTuple = std::make_tuple(fromId, toId, classType);
                if (std::find(controls.begin(), controls.end(), ctrlTuple) !=
                    controls.end())
                    continue;

                // Nope, add it
                controls.emplace_back(ctrlTuple);
            }
        }
    }

    // And done
    return {};
}

//-----------------------------------------------------------------------------
/// @brief Builds the pipeline stack for the service endpoint.
///
/// @details
/// This function processes the pipeline configuration from the task
/// configuration, validates the components, and constructs the necessary
/// dependencies and connections to execute the pipeline. It ensures all
/// components are correctly linked and detects issues such as missing or
/// duplicate components.
///
/// The function performs the following steps:
/// - Retrieves pipeline information from the task configuration.
/// - Validates the structure and uniqueness of components.
/// - Identifies and links dependent components.
/// - Detects circular dependencies.
/// - Constructs a list of components and their connections.
///
/// @return
/// - `Error{}` on success.
/// - `APERR(Ec::InvalidParam, ...)` if an invalid pipeline configuration is
/// detected.
//-----------------------------------------------------------------------------
Error IServiceEndpoint::generatePipelineStack() noexcept {
    Error ccode;

    // Forward declarations
    std::function<Error(std::string & sourceId)> walkComponents;
    std::function<Error(const json::Value &dependent)> addComponent;

    // Get the components
    auto &components = config.pipeline.components();

    // Determins if this component is already loaded
    auto isComponentLoaded = localfcn(std::string & id) {
        for (const auto pipe : pipeStack) {
            if (pipe.id == id) return true;
        }
        // Return the pipe id
        return false;
    };

    // Add the component to the stack
    addComponent = localfcn(const json::Value &dependent)->Error {
        // Get its id
        auto id = dependent["id"].asString();

        // If we already loaded this, done
        if (isComponentLoaded(id)) return {};

        // Get the name of the provider
        auto filterName = dependent["provider"].asString();

        // If not specified, error out
        if (filterName.empty())
            return APERR(Ec::InvalidParam, "The component", id,
                         "does not have a provider");

        // Get a default value in case a config section is not present
        json::Value def = json::objectValue;

        // Get the configuration section
        json::Value connConfig;

        // The UI and services say to put the config section under the provider
        // name
        if (dependent.isMember(id)) {
            // It is under the provider name
            connConfig = dependent[filterName];
        } else if (dependent.isMember("config")) {
            // It is under the config key
            connConfig = dependent["config"];
        } else {
            // Default value
            connConfig = json::Value(json::objectValue);
        }

        // Find the service
        auto serviceInfo = IServices::getServiceDefinition(filterName);
        if (!serviceInfo) return serviceInfo.ccode();

        // Get the capabilities of the service
        auto capabilities = (*serviceInfo)->capabilities;

        // Add it
        pipeStack.push_back(
            {id, capabilities, filterName, filterName, connConfig});
        return {};
    };

    // Given a component, this will go through all components and add
    // components to the stack that are dependent on the given component
    std::unordered_set<std::string> loadedIds;
    walkComponents = localfcn(std::string & sourceId)->Error {
        // If we loaded this already, skip it
        if (loadedIds.find(sourceId) != loadedIds.end()) return {};

        // Say we loaded this
        loadedIds.insert(sourceId);

        // Now, for each of its connections
        for (const auto &component : components) {
            // Get this nodes id
            std::string componentId = component["id"].asString();
            if (componentId.empty()) continue;

            // Check to see if this has input
            if (!component.isMember("input")) continue;

            // Get the input
            auto &input = component["input"];

            // Walk through all of the components inputs
            for (const auto &input : input) {
                // Get the lane and the connect to target
                std::string fromId = input["from"].asString();

                // If the from is not connected to us, skip it
                if (fromId.empty() || fromId != sourceId) continue;

                // Add all the components that depend on this one
                if (auto ccode = addComponent(component)) return ccode;

                // Walk into this as well
                if (auto ccode = walkComponents(componentId)) return ccode;
            }
        }

        // And done now
        return {};
    };

    // Walk through all the components and find those the have a control
    // (invoke) interface. If it does, and one of the from ids is included in
    // the pipe stack, we need to add this to the stack as well
    const auto walkControl = localfcn(const json::Value &components)->Error {
        bool bAdded = true;

        // While we have added components...
        while (bAdded) {
            // We need to restart every time we add a components since it may
            // in fact have invokes itself
            bAdded = false;

            // Now, for each of its connections
            for (const auto &component : components) {
                // If this component does not have a control member, it is not
                // referenced as invokable, so, skip it
                if (!component.isMember("control")) continue;

                // Check if this is already loaded
                auto compId = component["id"].asString();
                if (isComponentLoaded(compId)) continue;

                // Get the input
                auto &controls = component["control"];

                // For each of the bound controls
                for (auto &controlObject : controls) {
                    // Get the control id to which are being invoked from
                    auto classType = controlObject["classType"].asString();
                    auto invokeFrom = controlObject["from"].asString();

                    // If this is not part of our pipe stack, skip it
                    if (!isComponentLoaded(invokeFrom)) continue;

                    // Add this component, someone is invoking it
                    if (auto ccode = addComponent(component)) return ccode;

                    // We added it, so start over again
                    bAdded = true;
                    break;
                }
            }
        }
        return {};
    };

    // Get the source pipeline we need to execute
    auto sourceId =
        config.pipeline.source().lookup<std::string>("id", "source");

    // Walk them
    if (ccode = walkComponents(sourceId)) return ccode;

    // Walk the controls and add the components which are going to be
    // controlled (invoked)
    if (ccode = walkControl(components)) return ccode;

    // And done
    return {};
}

//-----------------------------------------------------------------------------
/// @brief Builds the pipeline stack for the service endpoint.
///
/// @details
/// This function constructs the pipeline stack by determining the appropriate
/// filters based on the current `openMode` and `serviceMode`. It ensures the
/// correct filters are added, validates configurations, and sets up the filter
/// stack.
///
/// The function performs the following steps:
/// - Retrieves filter configurations via `getPipeFilters()`.
/// - Determines logical and physical endpoint types.
/// - Defines helper functions to push filters (`pushAbsolute`, `pushFull`,
/// `pushString`).
/// - Checks if indexing, vectorization, or OCR is enabled.
/// - Based on `openMode`, it selects the appropriate pipeline processing mode:
///   - **TARGET mode** ensures the service is a valid target.
///   - **SOURCE mode** validates source-specific processing.
///   - **PIPELINE mode** enables a defined pipeline.
/// - Adds additional filters from `filterStack` if provided.
/// - Ensures the endpoint filter is at the bottom of the stack.
///
/// @return
/// - `Error{}` on success.
/// - `APERR(Ec::InvalidParam, ...)` if pipeline validation fails.
/// - `APERR(Ec::InvalidCommand, ...)` if an invalid open mode is encountered.
///
/// @note
/// - This function is responsible for configuring the filter stack that defines
///   how data is processed through the pipeline.
/// - The function ensures that pipeline configurations are correctly
/// structured,
///   preventing misconfigured components from being added.
/// - Filters are automatically appended in the correct order to maintain
/// consistency.
///
//-----------------------------------------------------------------------------
Error IServiceEndpoint::buildPipeStack() noexcept {
    Error ccode = {};

    // Ask the endpoint if it wants to add any filters at the bottom
    IPipeFilters filterStack;
    if (auto ccode = getPipeFilters(filterStack)) return ccode;

    // Grab the logical endpoint type
    Text logicalEndpoint;
    if (auto res = getLogicalType(config.serviceConfig))
        logicalEndpoint = _mv(*res);
    else
        return res.ccode();

    // Grab the physical endpoint type
    Text physicalEndpoint;
    if (auto res = getPhysicalType(config.serviceConfig))
        physicalEndpoint = _mv(*res);
    else
        return res.ccode();

    // We use these a couple of times
    Text filterPipe = engine::store::filter::pipe::Type;
    Text filterBottom = engine::store::filter::bottom::Type;

    // Add the filter
    const auto pushAbsolute =
        localfcn(Text id, uint32_t capabilities, Text logicalType,
                 Text physicalType, json::Value connConfig = json::Value{})
            ->Error {
        // Save it
        pipeStack.push_back(
            {id, capabilities, logicalType, physicalType, connConfig});
        return {};
    };

    // Add the filter supressing the pipe and bottom filters if they
    // were specified
    const auto pushFull =
        localfcn(Text id, int32_t capabilities, Text logicalType,
                 Text physicalType, json::Value connConfig = json::Value{})
            ->Error {
        // Specifically ignore these, they absolutely have to be at the top
        // and bottom regardless of what is requested
        if (logicalType == filterPipe || logicalType == filterBottom) return {};

        // By default, the physical type is the same as the logical type
        if (!physicalType) physicalType = logicalType;

        // Save it
        return pushAbsolute(id, capabilities, logicalType, physicalType,
                            connConfig);
    };

    // Add the filter supressing the pipe and bottom filters if they
    // were specified
    const auto pushString =
        localfcn(Text logicalType, Text physicalType = {})->Error {
        // Specifically ignore these, they absolutely have to be at the top
        // and bottom regardless of what is requested
        if (logicalType == filterPipe || logicalType == filterBottom) return {};

        // By default, the physical type is the same as the logical type
        if (!physicalType) physicalType = logicalType;

        // Save it
        return pushAbsolute(logicalType, 0, logicalType, physicalType);
    };

    // Put our pipe source at the top
    pushAbsolute(filterPipe, 0, filterPipe, filterPipe);

    // Based on the mode
    switch (config.openMode) {
        case OPEN_MODE::TARGET:
        case OPEN_MODE::STAT:
        case OPEN_MODE::REMOVE: {
            break;
        }

        case OPEN_MODE::CONFIG: {
            // Config can occur in either mode
            break;
        }

        case OPEN_MODE::SOURCE:
        case OPEN_MODE::SCAN: {
            // These require a source endpoint
            if (config.serviceMode != SERVICE_MODE::SOURCE)
                return APERR(Ec::InvalidParam,
                             "The service is not a source service");

            // All these just require the endpoint
            break;
        }

        case OPEN_MODE::INDEX:
        case OPEN_MODE::SOURCE_INDEX: {
            // These require a source endpoint
            if (config.serviceMode != SERVICE_MODE::SOURCE)
                return APERR(Ec::InvalidParam,
                             "The service is not a source service");

            // Autopipe will figure out what to do here.. Essnetially, it
            // will add the index and vecorizer to enumerate the documents
            // from the wordDB, the vectorDB, endpoint or just the endpoint
            // if in SOURCE_INDEX mode
            pushString("autopipe");
            break;
        }

        case OPEN_MODE::CLASSIFY: {
            // These require a target endpoint
            if (config.serviceMode != SERVICE_MODE::TARGET)
                return APERR(Ec::InvalidParam,
                             "The service is not a target service");

            // This is primarily used as a target to receives text
            // on the writeText interface and classify the incoming
            // documents classification
            pushString(filter::classify::Type);
            break;
        }

        case OPEN_MODE::INSTANCE: {
            // These require a target endpoint
            if (config.serviceMode != SERVICE_MODE::TARGET)
                return APERR(Ec::InvalidParam,
                             "The service is not a target service");

            // Add the hash driver in case one of the paths asked for signing
            pushString(filter::hash::Type);

            // Add autopipe to figure out what to do, what to remote or not
            // This will typically add the parser, optional ocr, indexer if
            // any of the paths have index selected, vectorizer if any of
            // the paths have vectorize set. The configuration should be
            // in config.autopipe
            pushString("autopipe");

            // We can classify at the same time if desired
            if (config.taskConfig.lookup<bool>("enableClassification"))
                pushString(filter::classify::Type);
            break;
        }

        case OPEN_MODE::CLASSIFY_FILE: {
            // These require a target endpoint
            if (config.serviceMode != SERVICE_MODE::TARGET)
                return APERR(Ec::InvalidParam,
                             "The service is not a target service");

            // We are classifying a single file
            pushString(filter::parse::Type);
            // pushString(filter::tokenize::Type);
            pushString(filter::classify::Type);
            break;
        }

        case OPEN_MODE::HASH: {
            // These require a target endpoint
            if (config.serviceMode != SERVICE_MODE::TARGET)
                return APERR(Ec::InvalidParam,
                             "The service is not a target service");

            // Don't need much, just the hasher
            pushString(filter::hash::Type);
            break;
        }

        case OPEN_MODE::TRANSFORM: {
            // These require a target endpoint
            if (config.serviceMode != SERVICE_MODE::TARGET)
                return APERR(Ec::InvalidParam,
                             "The service is not a target service");

            // The endpoint was asked (via getPipeFilters) the additional
            // filters to add. Relativity added some, and transform targets like
            // qdrant added autopipe. The configuration for autopipe should be
            // in parameters.autopipe
            break;
        }

        case OPEN_MODE::PIPELINE:
        case OPEN_MODE::PIPELINE_CONFIG: {
            // Say we have a defined pipeline
            m_isPipeline = true;

            // Generate the pipeline stack
            if (ccode = generatePipelineStack()) return ccode;
            break;
        }

        default:
            // Error out
            return APERR(Ec::InvalidCommand,
                         "Invalid open mode getting pipe stack");
    }

    // Then add the default filters - these are returned from overriding the
    // getPipeFilters on the endpoint. It may not have any if the endpoint
    // doesn't have any filter to add...
    for (size_t i = 0; i < filterStack.size(); ++i) {
        const auto &filter = filterStack[i];
        Error ccode;
        Text filterName;
        Text id;

        // If this is a string
        if (std::holds_alternative<Text>(filter)) {
            // Note on string --- if this is a pipeline task, it won't have
            // any connections specified so it will not be linked up to anything

            // If this is a string
            const Text &logicalType = std::get<Text>(filter);

            // Save it with default config
            if (ccode = pushString(logicalType)) return ccode;

            // If this holds an object
        } else if (std::holds_alternative<json::Value>(filter)) {
            // If this is a json value
            const json::Value &value = std::get<json::Value>(filter);

            // Get the id
            id = value.lookup<Text>("id", "");

            // Get the filterName
            filterName = value.lookup<Text>("provider", "");

            // If not specified, error out
            if (!filterName)
                return APERR(Ec::InvalidParam,
                             "The pipeline entry did not have a provider");

            // Get the configuration section
            json::Value connConfig = json::Value(json::objectValue);

            // The UI and services say to put the config section under the
            // provider name
            if (value.isMember(filterName)) {
                // It is under the provider name
                connConfig = value[filterName];
            } else if (value.isMember("config")) {
                // It is under the config key
                connConfig = value["config"];
            } else {
                // Default value
                connConfig = json::objectValue;
            }

            // Find the service
            auto serviceInfo = IServices::getServiceDefinition(filterName);
            if (!serviceInfo) return serviceInfo.ccode();

            // Get the capabilities of the service
            auto filterCapabilities = (*serviceInfo)->capabilities;

            // Pass over the string and config
            if (ccode = pushFull(id, filterCapabilities, filterName, filterName,
                                 connConfig))
                return ccode;
        } else {
            // Not the required type type
            return APERR(Ec::InvalidParam,
                         "getPipeFilter must specify an object with provider "
                         "key or a string");
        }
    }

    // Always add the endpoint filter at the end
    pushString(logicalEndpoint, physicalEndpoint);

    // Put this at the bottom
    pushAbsolute(filterBottom, 0, filterBottom, filterBottom);

    // Save the number of filters in the stack
    m_numberFilters = pipeStack.size();

    // And done
    return {};
}
}  // namespace engine::store
