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

namespace engine::store {
//-------------------------------------------------------------------------
///	@details
///		Define the class to handle services
//-------------------------------------------------------------------------
class IServices {
public:
    _const int VERSION = 3;

    //-----------------------------------------------------------------
    /// @details
    ///		Define suported actions by a service for the UI. If you add flags,
    /// you 		should probably add them to the services.cpp as well so
    /// the can be specified in the service definitions
    //-----------------------------------------------------------------
    struct SUPPORTED_ACTIONS {
        _const uint32_t DELETION = BIT(0);  // Supports deletion of an object
        _const uint32_t EXPORT = BIT(1);    // Supports export of an object
        _const uint32_t DOWNLOAD = BIT(2);  // Supports download of an object
    };

    //-----------------------------------------------------------------
    ///	@details
    ///		Define the structures we use to keep track of the service
    ///		definitions
    //-----------------------------------------------------------------
    struct ServiceDefinition {
        //---------------------------------------------------------
        ///	@details
        ///		The title
        //---------------------------------------------------------
        iText title;

        //---------------------------------------------------------
        ///	@details
        ///		The physical type is the actual factory type we need
        ///		to instantiate (filesys, aws, python, etc). This is
        ///		from the "node" field of the definition
        //---------------------------------------------------------
        iText physicalType;

        //---------------------------------------------------------
        ///	@details
        ///		The logical type is the protocol type that can be
        ///		specified (filesys, ms-onedrive, etc). This is from
        ///		the "protocol" fields of the definition
        //---------------------------------------------------------
        iText logicalType;

        //---------------------------------------------------------
        ///	@details
        ///		The class type of the node - what it does
        //---------------------------------------------------------
        json::Value classType;

        //---------------------------------------------------------
        ///	@details
        ///		The prefix used to map Url <-> Path. This is only
        ///		used if we are using the default UrlMapper.
        //---------------------------------------------------------
        Text prefix;

        //---------------------------------------------------------
        ///	@details
        ///		Array of plans this driver is available for. Empty
        ///		if all plans are available
        ///		This is used to register the factory
        //---------------------------------------------------------
        json::Value plans;

        //---------------------------------------------------------
        ///	@details
        ///		The number of components in the prefix - computed
        ///		based on the prefix specified
        //---------------------------------------------------------
        size_t prefixComponents{};

        //---------------------------------------------------------
        ///	@details
        ///		The mapped capabilities flags - actual flags are
        ///		define in Url.hpp
        //---------------------------------------------------------
        uint32_t capabilities{};

        //---------------------------------------------------------
        ///	@details
        ///		The mapped supported actions flags
        //---------------------------------------------------------
        uint32_t supportedActions{};

        //---------------------------------------------------------
        ///	@details
        ///		Path to the defintion file that created this service
        //---------------------------------------------------------
        Path definitionPath;

        //---------------------------------------------------------
        ///	@details
        ///		Optional path used by the node - usually
        ///		points to a script file if specified
        //---------------------------------------------------------
        Path nodePath;

        //---------------------------------------------------------
        ///	@details
        ///		Define the structure we use to keep track of the
        ///		names and dispositions of values within parameters
        ///		of the service.parameters.secureParameters section
        //---------------------------------------------------------
        std::map<Text, PARAM_TYPE> secureParameters;

        //---------------------------------------------------------
        ///	@details
        ///		The json of the service definition
        //---------------------------------------------------------
        json::Value serviceDefinition;

        //---------------------------------------------------------
        ///	@details
        ///		The json of the service shape - this is the
        ///		transformed value of the service definition
        //---------------------------------------------------------
        json::Value serviceSchema;
    };
    using ServiceDefinitionPtr = ServiceDefinition *;
    using ServiceDefinitions = std::map<iText, ServiceDefinition>;

public:
    //-----------------------------------------------------------------
    ///	Public API
    //-----------------------------------------------------------------
    //-----------------------------------------------------------------
    ///	@details
    ///		Holds a call's custom services in front of every lookup the
    ///		calling thread makes (getServiceDefinition,
    ///		getServiceSchemas, isCustomService) until it is destroyed.
    ///		Scopes nest: the inner one hides the outer one's services
    ///		while it lives. Made by withCustomServices
    //-----------------------------------------------------------------
    class CustomServicesScope {
    public:
        CustomServicesScope(CustomServicesScope &&other) noexcept
            : m_services(_mv(other.m_services)), m_outer(other.m_outer) {
            if (m_outer) t_custom = &m_services;
            other.m_outer = std::nullopt;
        }
        CustomServicesScope(const CustomServicesScope &) = delete;
        ~CustomServicesScope() noexcept {
            if (m_outer) t_custom = *m_outer;
        }

    private:
        friend class IServices;

        CustomServicesScope() noexcept = default;

        explicit CustomServicesScope(ServiceDefinitions services) noexcept
            : m_services(_mv(services)), m_outer(t_custom) {
            t_custom = &m_services;
        }

        ServiceDefinitions m_services;
        std::optional<ServiceDefinitions *> m_outer;
    };

    static Error init() noexcept;
    static Error deinit() noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		Walks one directory of service definitions: every
    ///		services.*json under it (recursively) is parsed, refused
    ///		if still in the old format, resolved and registered.
    ///		init() runs it over the nodes tree and --node_path; public
    ///		so a fixture directory can be loaded in a test
    //-----------------------------------------------------------------
    static Error loadServices(const Path &path, const Text &mask) noexcept;

    static ErrorOr<IServices::ServiceDefinitionPtr> getServiceDefinition(
        const Text &type) noexcept;
    static ErrorOr<IServices::ServiceDefinitionPtr>
    getServiceDefinitionFromService(const json::Value &service) noexcept;
    static ErrorOr<json::Value> getServiceSchemas() noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		Is this one of the calling thread's custom services, not a
    ///		registered one? Its code is not on this engine, so it has no
    ///		factory
    //-----------------------------------------------------------------
    static bool isCustomService(const Text &logicalType) noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		Parses a caller's own service definitions (a JSON array of
    ///		services.json objects) through the same parse and property
    ///		expansion the start-up scan uses - an old-format definition
    ///		is refused - and returns the scope that makes them visible
    ///		to the calling thread for one call. Nothing is registered: no
    ///		factory, no url mapper, and the registry is the same before
    ///		and after. A definition whose logical type is registered or
    ///		listed twice is refused, its icon must be inline (a data:
    ///		URL), its JSON and its property expansion nest at most 64
    ///		deep, and the expansion is bounded per definition and per
    ///		call. An empty or null list yields an empty scope
    //-----------------------------------------------------------------
    static ErrorOr<CustomServicesScope> withCustomServices(
        const json::Value &custom) noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		Rejects a parsed services.*json that is still in the old
    ///		format ("fields"/"shape" instead of "propertyDefinitions"/
    ///		"properties"). The error names the file. Public so a
    ///		fixture can be checked without walking the nodes tree
    //-----------------------------------------------------------------
    static Error requireNewFormat(const json::Value &serviceInfo,
                                  const Path &definitionPath);

    //-----------------------------------------------------------------
    ///	@details
    ///		Expands one service definition's "properties" into its
    ///		fully-resolved schema (def.serviceSchema): every leaf
    ///		carries its "path", "params" lists the flat descriptors of
    ///		the "param"-flagged properties, and "capabilities" is the
    ///		node's PROTOCOL_CAPS bitmask. Public so a
    ///		fixture definition can be resolved without being loaded.
    ///		total, when given, accumulates the JSON values expanded by
    ///		every definition of one call (custom services). A
    ///		definition of the wrong JSON shape may throw
    //-----------------------------------------------------------------
    static Error buildSchema(ServiceDefinition &def, size_t *total = nullptr);

private:
    //-----------------------------------------------------------------
    ///	@details
    ///		Declares the C++ node a service is implemented by, so the
    ///		factory maps its library the first time one of the node's
    ///		factories is looked up
    //-----------------------------------------------------------------
    static Error declareNode(const ServiceDefinition &def) noexcept;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define the structures we use to keep track of the field
    ///		definitions
    //-----------------------------------------------------------------
    using ServiceField = json::Value;
    using ServiceFields = std::map<iText, json::Value>;

    //-------------------------------------------------------------
    // This is the context used to pass to the recursive functions
    //-------------------------------------------------------------
    struct ServiceContext {
        ServiceContext(ServiceDefinition &def) : def(def) {}

        ServiceDefinition &def;
        ServiceFields privateFields;

        // The property references being expanded, outermost first: one
        // reached again inside its own expansion would recurse without end
        std::vector<Text> chain;

        // The property expansions nested so far, each a recursion: bounded
        // by MaxDepth
        size_t depth = 0;

        // JSON values expanded so far for this definition, and by every
        // definition of the call (nullptr on the start-up scan)
        size_t expanded = 0;
        size_t *total = nullptr;

        // The flat descriptors of every "param"-flagged property seen so
        // far, in schema order - becomes schema["params"]
        json::Value params{json::arrayValue};

        // The dotted "path" prefix of the level being expanded: a group
        // pushes its name, a selector branch pushes the branch name, a
        // hoisted leaf pushes nothing
        std::vector<Text> pathPrefix;

        // Empty at the top level or inside a plain group. Inside an enum
        // branch or an array item it names that construct ("an enum
        // branch" / "an array item") - "param" is a load error there,
        // because such a property resolves branch- or item-dependently
        Text nestedIn;

        // The names recorded for the level currently being expanded.
        // A selector registers its branch names and its hoisted leaves
        // here, because they share the level's namespace with its
        // sibling leaves
        std::vector<Text> *levelNames{};
    };

    //-------------------------------------------------------------
    // Private API
    //-------------------------------------------------------------
    static Error declareDefaultUrlMappers() noexcept;
    static Error loadGlobalFields(json::Value &definition) noexcept;
    static ErrorOr<json::Value> lookupField(ServiceContext &context,
                                            TextView fieldId);
    static ErrorOr<json::Value> expandProperty(ServiceContext &context,
                                               json::Value &property);
    static ErrorOr<json::Value> expandChildren(ServiceContext &context,
                                               json::Value property);
    static ErrorOr<json::Value> expandProperties(ServiceContext &context,
                                                 json::Value &specifiers);
    static ErrorOr<json::Value> expandBranches(ServiceContext &context,
                                               json::Value branches);
    static Error applyParam(ServiceContext &context, json::Value &field);
    static Error requireUniqueName(std::vector<Text> &seen, const Text &name,
                                   ServiceContext &context) noexcept;
    static Error charge(ServiceContext &context, size_t count) noexcept;
    static Error updateDefinitions(ServiceDefinitions &services,
                                   size_t *total = nullptr);
    static ErrorOr<std::optional<ServiceDefinition>> parseDefinition(
        json::Value serviceInfo, const Path &definitionPath);
    static Error registerFactories(const ServiceDefinition &def) noexcept;
    static void resolveString(json::Value &value) noexcept;
    static void resolveDescriptions(json::Value &value) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Our list of services
    //-----------------------------------------------------------------
    inline static ServiceDefinitions m_services{};

    //-----------------------------------------------------------------
    /// @details
    ///		Our list of global field defintions
    //-----------------------------------------------------------------
    inline static ServiceFields m_fields{};

    //-----------------------------------------------------------------
    /// @details
    ///		The custom services of the call running on this thread, if any
    //-----------------------------------------------------------------
    inline static thread_local ServiceDefinitions *t_custom = nullptr;
};

}  // namespace engine::store
