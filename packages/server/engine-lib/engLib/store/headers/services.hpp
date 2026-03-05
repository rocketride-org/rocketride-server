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
    _const int VERSION = 1;

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

        //---------------------------------------------------------
        ///	@details
        ///		Has this driver been resolved?
        //---------------------------------------------------------
        bool isResolved = false;
    };
    using ServiceDefinitionPtr = ServiceDefinition *;
    using ServiceDefinitions = std::map<iText, ServiceDefinition>;

public:
    //-----------------------------------------------------------------
    ///	Public API
    //-----------------------------------------------------------------
    static Error init() noexcept;
    static Error deinit() noexcept;
    static ErrorOr<IServices::ServiceDefinitionPtr> getServiceDefinition(
        const Text &type) noexcept;
    static ErrorOr<IServices::ServiceDefinitionPtr>
    getServiceDefinitionFromService(const json::Value &service) noexcept;
    static ErrorOr<json::Value> getServiceSchemas() noexcept;

private:
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
    };

    //-------------------------------------------------------------
    // This is used when recursing the defintion tree
    //-------------------------------------------------------------
    struct ServiceSchema;
    struct ServiceSchemaConditional {
        json::Value value;
        std::vector<ServiceSchema> fields;
    };

    //-------------------------------------------------------------
    // This is used when recursing the defintion tree
    //-------------------------------------------------------------
    struct ServiceSchema {
        ServiceSchema(TextView name) : name(name) {}
        const Text name;
        bool isRequired = false;
        bool isReadonly = false;
        bool isSecured = false;
        bool isSection = false;
        bool isArray = false;
        bool isCombo = false;
        bool isResolved = true;
        json::Value field;
        json::Value ui;
        std::vector<ServiceSchema> children;
        std::vector<ServiceSchema> arrayItem;
        std::vector<ServiceSchemaConditional> conditionals;
    };

    //-------------------------------------------------------------
    // Private API
    //-------------------------------------------------------------
    static Error declareDefaultUrlMappers() noexcept;
    static Error loadGlobalFields(json::Value &definition) noexcept;
    static Text getFieldName(TextView fieldName) noexcept;
    static ErrorOr<json::Value> lookupField(ServiceContext &context,
                                            TextView fieldId) noexcept;
    static ErrorOr<IServices::ServiceSchema> getField(
        ServiceContext &context, TextView fieldName,
        json::Value &field) noexcept;
    static ErrorOr<IServices::ServiceSchema> getFields(
        ServiceContext &context, json::Value &section) noexcept;
    static Error updateDefinitions() noexcept;
    static void resolveString(json::Value &value) noexcept;
    static void resolveDescriptions(json::Value &value) noexcept;
    static std::list<Text> getFieldNames(const ServiceSchema &schema) noexcept;
    static json::Value getChildConditionalUIElements(
        const ServiceSchema &schema) noexcept;

    //-----------------------------------------------------------------
    /// @details
    ///		Our list of services
    //-----------------------------------------------------------------
    inline static ServiceDefinitions m_services{};

    //-----------------------------------------------------------------
    ///	@details
    ///		Define the dynamic factories we registered
    //-----------------------------------------------------------------
    inline static std::vector<FACTORY> m_dynamicFactories;

    //-----------------------------------------------------------------
    /// @details
    ///		Our list of global field defintions
    //-----------------------------------------------------------------
    inline static ServiceFields m_fields{};
};
}  // namespace engine::store
