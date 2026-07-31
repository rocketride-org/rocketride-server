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
///		Option to force into python mode
//-------------------------------------------------------------------------
static application::Opt ServiceName{"--serviceName"};
static application::Opt ServiceCat{"--serviceCategory"};

//-------------------------------------------------------------------------
/// @details
///		Optional directory that holds a `local_nodes` folder, scanned in
///		addition to the built-in nodes, e.g. --node_path=/work
//-------------------------------------------------------------------------
static application::Opt NodePath{"--node_path"};

//-------------------------------------------------------------------------
//
//	Each service .json file, located under the services directories, is
//	one of two kinds: a property definition file, or a service definition
//	file.
//
//	Property definitions
//	-----------------------------------
//	A property definition describes a single configuration field. It is
//	stored under a "propertyDefinitions" map, keyed by the property's
//	name (the name is the map key, not a member of the value):
//
//		{
//			"propertyDefinitions": {
//				"aws.bucket": {
//					"type": "string",
//					"title": "Bucket"
//				}
//			}
//		}
//
//	A property definition may describe:
//
//		A plain field:
//			Any simple leaf value. Common members: "type", "title",
//			"description", "default". Flags such as "hidden", "secret",
//			"readonly" and "required" may also be present and are passed
//			through to the final schema as-is - the UI decides how to
//			render them.
//
//		An enum field:
//			{
//				"type": "string",
//				"enum": [["value", "Label"], ...]
//			}
//			or, when different values should expose different sets of
//			sub-properties, an object keyed by value instead of an array:
//			{
//				"type": "string",
//				"enum": {
//					"value": {
//						"title": "Label",
//						"properties": [ [property specifiers] ]
//					}
//				}
//			}
//
//		A grouped subsection:
//			{
//				"name": "parameters",
//				"properties": [ [property specifiers] ]
//			}
//
//		An array field:
//			{
//				"name": "include",
//				"type": "array",
//				"item": [a property specifier for a single array item]
//			}
//
//	A property specifier (used within any "properties" array, or as the
//	"item" of an array field) is one of:
//		- a bare string: a reference to a property definition (local
//		  propertyDefinitions take precedence over global ones on a name
//		  collision).
//		- {"use": "name", ...overrides}: same, with the listed members
//		  merged/overridden on top of the referenced definition.
//		- a fully inline object carrying its own "name".
//
//	Property definition file
//	-----------------------------------
//	A property definition file does not define a service itself; it only
//	contributes propertyDefinitions available to every service:
//
//		{
//			"propertyDefinitions": {
//				"aws.bucket": {...}
//			}
//		}
//
//	Service definition file
//	-----------------------------------
//	The service definition file is central to configuration and managing
//	an endpoint type. It defines key information about the endpoint and
//	contains the following attributes:
//
//		"protocol":
//			The protocol of the service. The protocol is specified in
//			its full form ("protocol://")
//
//		"capabilities":
//			The capabilities is an array of strings that are used to
//			customize the behavior of the endpoint
//			"security":
//				When this cap is specified, the endpoint supports
//				reading OS permissions in the permissions filter. Only
//				filsystem type endpoints should use this, but is provided
//				to disable them in smb type endpoints if needed
//			"filesystem"
//				This is a filesystem type driver which uses local
//				open/close/read/write semantics. Note that endpoints
//				like OneDrive should not have this set
//			"substream"
//				The endpoint supports substreams within the target. The
//				only endpoint that currently requires this is the zip://
//				endpoint, which has substreams within the main stream
//			"network"
//				The endpoint requires network access
//			"datanet"
//				The endpoint requires datanet protocol access
//
//      "classType":
//          The type of the node. The following types are currently
//          supported:
//              "embedding"     This is an embedding node
//              "preprocessor"  This is a preprocessing node
//              "store"         This is a store (vector) node
//              "..."           Others as we go along
//
//          This is mainly used by the UI to determine which kinds
//          of nodes can be included. However, we do internally
//          use these on creating configurations and for hiding
//          nodes from the services.json
//
//      "register": empty | "filter" | "endpoint"
//          Used to automatically register a python filter or endpoint. If
//          set, registration of the appropriate Factories will be called.
//          This is done so we do not need to recompile and create C++
//          wrappers for new python nodes
//
//		"prefix":
//			Defines the prefix that will be added to a path when creating
//			a url, or removed from a url when creating a path. This can
//			have multiple components like "File System/Fixed Disks" for
//			example.
//
//      "lanes":
//          An indication for the UI what pipes can be connected to what
//          other pipes. For example:
//              "lanes": {
//                  "object": ["tags"],
//                  "tags": ["text"]
//              }
//
//          In this case, given a source (this is a special type from scan
//          jobs), the driver will produce tags. When the driver recieves
//          tags, it produces text
//
//          Only types the driver actually produces itself should be declared.
//          If it is only passing through data on other lanes, it should
//          not be included.
//
//		"propertyDefinitions":
//			Defines property definitions used locally only to this service
//			definition. The same rules apply as above; on a name collision
//			with a global propertyDefinitions entry, the local one wins.
//
//		"properties":
//			The ordered list of property specifiers shown in the node's
//			config panel. Every reference within it is fully expanded
//			(recursively) into the final schema returned to the caller.
//
//-------------------------------------------------------------------------

//-------------------------------------------------------------------------
/// @details
///		For all the services we loaded, create/update url mappers
///		for each service in the UrlConfig
//-------------------------------------------------------------------------
Error IServices::declareDefaultUrlMappers() noexcept {
    // For each service
    for (auto const &item : m_services) {
        // Get the logical type
        auto type = item.first;

        // Get the definition
        auto &def = item.second;

        // Create a default mapper
        url::UrlConfig::Mapper defaultMapper = {
            .capabilities = def.capabilities,
            .protocol = def.logicalType,
            .toUrl = [](const iTextView fromProtocol,
                        const file::Path &fromPath, Url &toUrl) -> Error {
                using namespace ap::url;

                // Get our service definition based on the protocol (logical
                // type)
                auto res = IServices::getServiceDefinition(fromProtocol);
                if (!res) return res.ccode();

                // Build it
                toUrl = builder() << protocol(fromProtocol)
                                  << component((*res)->prefix) << fromPath;
                return {};
            },
            .toPath = [](const Url &fromUrl, file::Path &toPath) -> Error {
                // Get our service definition based on the protocol (logical
                // type)
                auto res = IServices::getServiceDefinition(fromUrl.protocol());
                if (!res) return res.ccode();

                // Trim off protocol and File System
                toPath = fromUrl.fullpath().subpth((*res)->prefixComponents);
                return {};
            }};

        // Attempt to get the url mapper. If it is there, we
        // don't need to add a default, but we will update
        // what may be missing
        auto urlMapper = url::UrlConfig::getMapper(type);
        if (urlMapper) {
            // Update the capabilities flags in the url mapper
            (*urlMapper)->capabilities = def.capabilities;

            // If this didn't define a toPath, set it
            if (!(*urlMapper)->toPath)
                (*urlMapper)->toPath = _mv(defaultMapper.toPath);

            // If this didn't define a toUrl, set it
            if (!(*urlMapper)->toUrl)
                (*urlMapper)->toUrl = _mv(defaultMapper.toUrl);
        } else {
            // We will use the entire set we just built
            url::UrlConfig::registerMapper(defaultMapper);
        }
    }

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		For a property definition json, load all the properties specified
///		into the global property name space
///	@param[in] definition
///		The full parsed json definition
//-------------------------------------------------------------------------
Error IServices::loadGlobalFields(json::Value &definition) noexcept {
    // Get the propertyDefinitions subkey
    json::Value &definitionFields = definition["propertyDefinitions"];
    if (definitionFields.type() != json::ValueType::objectValue) return {};

    // Get the property member names
    auto members = definitionFields.getMemberNames();

    for (auto &field : members) {
        // Get the property definition and save it into the global list
        m_fields[field] = definitionFields[field];
    }
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This function will lookup the field in the private field definitions
///		or, if not found there, the global field defintions
///	@param[in] context
///		The context we are working in - holds the private (local)
///		propertyDefinitions of the service being processed
///	@param[in] fieldId
///		The field name
//-------------------------------------------------------------------------
ErrorOr<json::Value> IServices::lookupField(ServiceContext &context,
                                            TextView fieldId) noexcept {
    // Find the private field
    auto privateField = context.privateFields.find(fieldId);

    // Find the global field
    auto globalField = m_fields.find(fieldId);

    if (privateField != context.privateFields.end()) {
        // If both the private and the global fields found
        // then merge them - the private (local) definition wins
        if (globalField != m_fields.end()) {
            auto mergedField = globalField->second;
            mergedField.merge(privateField->second);
            return mergedField;
        }
        // If only private field found
        else {
            return privateField->second;
        }
    }
    // If only global field found
    else if (globalField != m_fields.end()) {
        return globalField->second;
    }

    // Neither the private nor the global field found
    return APERR(Ec::InvalidName, "Field name", fieldId, "was not found in",
                 context.def.definitionPath);
}

//-------------------------------------------------------------------------
/// @details
///		Returns the last dot-separated component of a property reference,
///		or the reference itself if it has no dot. This becomes the
///		property's name in the final schema - the dotted prefix
///		("vector.", "google.", ...) exists only to keep propertyDefinitions
///		keys globally unique, and is not part of the final property name.
///	@param[in] fieldId
///		The property reference to shorten
//-------------------------------------------------------------------------
static Text getShortName(TextView fieldId) noexcept {
    if (!fieldId.contains(".")) return fieldId;
    auto index = fieldId.find_last_of(".");
    return fieldId.substr(index + 1);
}

//-------------------------------------------------------------------------
/// @details
///		Records name as seen within a single "properties" array, failing
///		if it collides with a sibling already recorded - siblings must be
///		unique once their reference prefixes have been stripped down to
///		the short name
///	@param[in,out] seen
///		The names already recorded for this "properties" array
///	@param[in] name
///		The name to record
///	@param[in] context
///		The context we are working in - used for the error message
//-------------------------------------------------------------------------
Error IServices::requireUniqueName(std::vector<Text> &seen, const Text &name,
                                   ServiceContext &context) noexcept {
    for (const auto &existing : seen) {
        if (existing == name)
            return APERR(Ec::InvalidParam, "Duplicate property name", name,
                         "in", context.def.definitionPath);
    }
    seen.push_back(name);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Expands the structural members of an already-resolved property -
///		a grouped subsection's "properties", an array field's "item", or
///		an enum field's per-value "properties" - by recursively expanding
///		every property specifier they contain. Properties with none of
///		these members (plain leaf fields) are returned unchanged.
///	@param[in] context
///		The context we are working in
///	@param[in] property
///		The resolved property definition (taken by value, mutated and
///		returned)
//-------------------------------------------------------------------------
ErrorOr<json::Value> IServices::expandChildren(ServiceContext &context,
                                               json::Value property) noexcept {
    // A grouped subsection - expand every property it lists
    if (property.isMember("properties") && property["properties"].isArray()) {
        json::Value children(json::arrayValue);
        std::vector<Text> seen;
        for (auto &child : property["properties"]) {
            auto res = expandProperty(context, child);
            if (!res) return res.ccode();

            if (auto ccode = requireUniqueName(seen, res->lookup<Text>("name"),
                                               context))
                return ccode;

            children.append(*res);
        }
        property["properties"] = _mv(children);
    }

    // An array field - expand its single item specifier. "type": "array"
    // is required so an array field is unambiguous from a plain field that
    // happens to carry an "item" member.
    if (property.isMember("item")) {
        if (property.lookup<Text>("type") != "array")
            return APERR(Ec::InvalidParam,
                         "Array field", property.lookup<Text>("name"),
                         "must declare \"type\": \"array\" in",
                         context.def.definitionPath);

        auto res = expandProperty(context, property["item"]);
        if (!res) return res.ccode();
        property["item"] = *res;
    }

    // An enum field with per-value property sets
    if (property.isMember("enum") && property["enum"].isObject()) {
        for (const auto &branchName : property["enum"].getMemberNames()) {
            auto &branch = property["enum"][branchName];
            if (!branch.isMember("properties") || !branch["properties"].isArray())
                continue;

            json::Value children(json::arrayValue);
            std::vector<Text> seen;
            for (auto &child : branch["properties"]) {
                auto res = expandProperty(context, child);
                if (!res) return res.ccode();

                if (auto ccode = requireUniqueName(
                        seen, res->lookup<Text>("name"), context))
                    return ccode;

                children.append(*res);
            }
            branch["properties"] = _mv(children);
        }
    }

    return property;
}

//-------------------------------------------------------------------------
/// @details
///		Resolves a single property specifier - a bare string reference, a
///		{"use": name, ...overrides} reference, or an already-inline
///		definition - into its fully expanded final form. Referenced
///		definitions are recursively expanded via expandChildren, so a
///		reference to a grouped subsection, array, or enum field resolves
///		completely.
///	@param[in] context
///		The context we are working in
///	@param[in] property
///		The property specifier to expand
//-------------------------------------------------------------------------
ErrorOr<json::Value> IServices::expandProperty(ServiceContext &context,
                                               json::Value &property) noexcept {
    json::Value field;
    Text originalId;

    // A bare string is a reference to a property definition
    if (property.isString()) {
        originalId = property.asString();

        auto resolved = lookupField(context, originalId);
        if (!resolved) return resolved.ccode();

        field = *resolved;
    }
    // A {"use": name, ...overrides} reference
    else if (property.isMember("use")) {
        originalId = property.lookup<Text>("use");

        auto resolved = lookupField(context, originalId);
        if (!resolved) return resolved.ccode();

        field = *resolved;

        // Overlay the overrides (everything but "use") on top - the
        // overrides win over the referenced definition
        auto overrides = property;
        overrides.removeMember("use");
        field.merge(overrides);
    }
    // Already an inline definition
    else {
        field = property;
    }

    // A propertyDefinitions entry may itself be defined as an alias -
    // {"use": name, ...overrides} - of another property (typically to
    // give a global definition a locally-unique name, e.g.
    // "qdrant.cloud.host": {"use": "vector.host", ...}). Keep following
    // "use" until we reach a real definition; each layer's own overrides
    // win over the definition it points to.
    while (field.isMember("use")) {
        auto aliasId = field.lookup<Text>("use");

        auto resolved = lookupField(context, aliasId);
        if (!resolved) return resolved.ccode();

        auto base = *resolved;

        auto overrides = field;
        overrides.removeMember("use");
        base.merge(overrides);

        field = _mv(base);
    }

    // Default the name from whichever reference we resolved, unless a
    // "name" was already set explicitly somewhere along the chain
    if (!field.isMember("name") && originalId) field["name"] = originalId;

    // The dotted reference prefix ("vector.", "google.", ...) exists only
    // to keep propertyDefinitions keys globally unique - shorten it down
    // to the last component for the final schema's property name,
    // regardless of whether "name" came from a reference or was authored
    // inline
    if (field.isMember("name"))
        field["name"] = getShortName(field.lookup<Text>("name"));

    // "description" may be authored as an array of strings for
    // readability - join it into a single string for the final schema.
    // Done here (rather than relying solely on the whole-file
    // resolveDescriptions() pass in init()) so it also applies to
    // descriptions coming from global propertyDefinitions files, which
    // are never run through that pass.
    if (field.isMember("description")) resolveString(field["description"]);

    return expandChildren(context, _mv(field));
}

//-------------------------------------------------------------------------
/// @details
///		This function will walk through all the declared services and
///		expand their "properties" into the final, fully-resolved schema
//-------------------------------------------------------------------------
Error IServices::updateDefinitions() noexcept {
    // For each service
    for (auto &item : m_services) {
        // Get the definition
        auto &def = item.second;

        // Create the context we pass around
        ServiceContext context(def);

        // Get the local propertyDefinitions
        auto localDefs = def.serviceDefinition["propertyDefinitions"];
        if (localDefs.type() == json::ValueType::objectValue) {
            // Get the member names
            auto members = localDefs.getMemberNames();

            // For each property definition, add it to the private fields
            for (auto &field : members) {
                json::Value &fieldValue = localDefs[field];
                context.privateFields[field] = fieldValue;
            }
        }

        // Make a protocol out of it
        Text protocol = def.serviceDefinition.lookup<Text>("protocol");
        Url url = Url{protocol};

        // Make sure we recognized it
        if (!url.protocol())
            return APERR(Ec::InvalidJson, "Protocol missing or invalid in",
                         def.definitionPath);

        // Build up the "type" field so it can be referenced. We put it in
        // the local fields in case someone actually defined a global
        // "type" field - which would be bad
        json::Value typeField;
        typeField["type"] = "constant";
        typeField["default"] = url.protocol();

        // And add it into our private field definitions so we can use it
        context.privateFields["type"] = typeField;

        // Get the raw properties list
        auto &properties = def.serviceDefinition["properties"];

        // Expand every property specifier
        json::Value expanded(json::arrayValue);
        std::vector<Text> seen;
        for (auto &property : properties) {
            auto res = expandProperty(context, property);
            if (!res) return res.ccode();

            if (auto ccode =
                    requireUniqueName(seen, res->lookup<Text>("name"), context))
                return ccode;

            expanded.append(*res);
        }

        // Save the schema
        json::Value schema;
        schema["properties"] = _mv(expanded);
        def.serviceSchema = _mv(schema);
    }

    // And done
    return {};
}

//-------------------------------------------------------------------------
/// @details
/// This function will convert an array of strings to a single string
/// by concatenating them. If the input is already a string, it will return
/// the string as-is. This is mainly used so descriptions can be set up
/// as an array of strings or as a single string.
///
/// @param[in/out] json::Value &value
/// 		The JSON value to resolve
///
//-------------------------------------------------------------------------
void IServices::resolveString(json::Value &value) noexcept {
    if (value.isArray()) {
        std::string concatenatedString;
        for (const auto &item : value) {
            if (item.isString()) {
                concatenatedString += item.asString();
            }
        }
        value = json::Value(concatenatedString);  // Mutate the original value
    }

    // Just leave it alone
    return;
}

//-------------------------------------------------------------------------
/// @brief
///     Resolves all "description" fields within a known fixed schema by
///     converting array values into a single newline-separated string.
///     This mutates the JSON structure directly.
///
/// @details
///     Specifically, it looks for:
///     - `input[i].description`
///     - `input[i].output[j].description`
///
///     If any of those fields are arrays of strings, they are concatenated
///     into a single string with newline (`\n`) separators.
///     If the value is already a string, it is left unchanged.
///
/// @param[in,out] root
///     The root JSON object containing the "input" array to process.
///     This object is modified in place.
///-------------------------------------------------------------------------
void IServices::resolveDescriptions(json::Value &node) noexcept {
    if (node.isObject()) {
        for (auto &key : node.getMemberNames()) {
            json::Value &value = node[key];

            // If this is a "description" field, resolve it
            if (key == "description")
                resolveString(value);
            else
                resolveDescriptions(value);  // recurse
        }
    } else if (node.isArray()) {
        for (auto &item : node) resolveDescriptions(item);  // recurse
    }
}

//-------------------------------------------------------------------------
/// @details
///		Loads all the service definitions
//-------------------------------------------------------------------------
Error IServices::init() noexcept {
    // Lambda to walk the paths
    const std::function<Error(const Path &, const Text &)> loadServices =
        localfcn(const Path &path, const Text &mask)->Error {
        // Get the scanner
        file::FileScanner scanner(path / mask);

        // Start the scan - if nothing found, it's okay
        if (auto ccode = scanner.open()) return {};

        // While we have entries
        _forever() {
            // Get the next file
            auto entry = scanner.next();
            if (!entry) return {};

            // If this is a directory, walk into it
            if (entry->second.isDir) {
                auto newPath = path / entry->first;
                if (auto ccode = loadServices(newPath, (Text) "services.*json"))
                    return ccode;
                continue;
            }

            // If this is not a services file, skip it
            if (!entry->first.startsWith("services.")) continue;

            // If this is not a json file, skip it
            if (!entry->first.endsWith(".json")) continue;

            // Get the path
            const auto definitionPath = path / entry->first;

            LOG(Services, "Loading", definitionPath);

            // Get the service info
            auto contents = file::fetch<TextChr>(definitionPath);
            if (!contents) continue;

            // Parse it into json
            auto serviceJson = json::parse(*contents);
            if (!serviceJson)
                return APERR(Ec::InvalidJson, serviceJson.ccode().message(),
                             " in", definitionPath);

            // Get
            auto serviceInfo = *serviceJson;

            // Get the type
            iText protocol = serviceInfo.lookup<iText>("protocol");
            if (!protocol) {
                // Old-format global field files declare "fields" instead of
                // "propertyDefinitions" - skip them, they are not supported
                if (!serviceInfo.isMember("propertyDefinitions")) {
                    LOG(Services, "    Skip global fields in old format");
                    continue;
                }

                LOG(Services, "    Define global fields");

                // This is not a specific service, so load any
                // global fields it defines
                loadGlobalFields(serviceInfo);
                continue;
            }

            // Old-format service definitions declare "shape" instead of
            // "properties" - skip them, they are not supported
            if (!serviceInfo.isMember("properties")) {
                LOG(Services, "    Skip service config in old format");
                continue;
            }

            // Resolve all the descriptions fields
            resolveDescriptions(serviceInfo);

            // Resolve the icon reference to its absolute file location.
            // The icon field in a services.json is relative to the file's
            // own directory, and only the loader knows where that is. The
            // resolved path is consumed SERVER-SIDE (the Python service
            // catalog reads the file to inline its content) and must never
            // be returned to clients.
            if (auto iconName = serviceInfo.lookup<Text>("icon")) {
                const auto iconPath = (path / iconName).resolve();
                if (!file::exists(iconPath))
                    LOG(Services, "    Icon          : **** MISSING",
                        iconPath, "****");
                serviceInfo["icon"] = static_cast<const Utf8Chr *>(iconPath);
            }

            // Declare our definition
            IServices::ServiceDefinition def;

            // Show the title
            def.title = serviceInfo.lookup<iText>("title", def.logicalType);
            LOG(Services, "    Title         :", def.title);

            // Parse off the ://
            iTextVector parsed = protocol.split(':');

            // Save the bare logical type (filesys, ms-onedrive, etc)
            def.logicalType = _mv(parsed[0]);
            LOG(Services, "    Logical type  :", def.logicalType);

            // Get the physical type (filesys, python, etc)
            def.physicalType = serviceInfo.lookup<iText>("node");
            if (!def.physicalType) def.physicalType = def.logicalType;

            LOG(Services, "    Pyhsical type :", def.physicalType);

            // Output description
            if (serviceInfo.isMember("description")) {
                auto msg = serviceInfo["description"].asString();
                if (msg.size() > 60) msg = msg.substr(0, 57) + "...";

                LOG(Services, "    Description   :", msg);
            } else {
                LOG(Services,
                    "    Description   : **** MISSING description ****");
            }

            def.classType = serviceInfo.lookup("classType");
            if (!def.classType) def.classType = json::arrayValue;

            // Get the optional node path
            def.nodePath = serviceInfo.lookup<Text>("path");
            if (def.nodePath) {
                LOG(Services, "    node path:", def.nodePath);
            }

            // Save the service definition path to the file
            def.definitionPath = _mv(definitionPath);

            // Get the optional node path
            def.prefix = serviceInfo.lookup<Text>("prefix");

            // Get the required plans
            if (serviceInfo.isMember("plans")) {
                auto plans = serviceInfo["plans"];
                if (plans.isArray()) def.plans = plans;
            }

            // Get the node type field - used to figure out factory registration
            const auto registerType = serviceInfo.lookup<iText>("register");

            // Build a path on the prefix so we can count the number of
            // components
            Path prefixPath{def.prefix};
            def.prefixComponents = prefixPath.count();

            // Get the capabilities flags
            iTextVector caps = serviceInfo.lookup<iTextVector>("capabilities");

            bool debugMode = false;

            // We now default to remoting enabled. It is cleared by specifying
            // noremote in the capabilities list
            def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::REMOTING;

            // Parse the capabilities
            for (auto &cap : caps) {
                if (cap == "security")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::SECURITY;
                else if (cap == "filesystem")
                    def.capabilities |=
                        url::UrlConfig::PROTOCOL_CAPS::FILESYSTEM;
                else if (cap == "substream")
                    def.capabilities |=
                        url::UrlConfig::PROTOCOL_CAPS::SUBSTREAM;
                else if (cap == "network")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::NETWORK;
                else if (cap == "datanet")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::DATANET;
                else if (cap == "sync")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::SYNC;
                else if (cap == "internal")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::INTERNAL;
                else if (cap == "catalog")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::CATALOG;
                else if (cap == "nomonitor")
                    def.capabilities |=
                        url::UrlConfig::PROTOCOL_CAPS::NOMONITOR;
                else if (cap == "noinclude")
                    def.capabilities |=
                        url::UrlConfig::PROTOCOL_CAPS::NOINCLUDE;
                else if (cap == "invoke")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::INVOKE;
                else if (cap == "gpu")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::GPU;
                else if (cap == "nosaas")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::NOSAAS;
                else if (cap == "focus")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::FOCUS;
                else if (cap == "debug")
                    debugMode = true;
                else if (cap == "noremote")
                    def.capabilities &=
                        ~url::UrlConfig::PROTOCOL_CAPS::REMOTING;
                else if (cap == "deprecated")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::DEPRECATED;
                else if (cap == "experimental")
                    def.capabilities |= url::UrlConfig::PROTOCOL_CAPS::EXPERIMENTAL;
                else
                    return APERR(Ec::InvalidParam, "Invalid cap setting", cap,
                                 "in", definitionPath);
            }

            if (debugMode) {
#ifdef NDEBUG
                continue;
#endif  // NDEBUG
            }

            // Get the capabilities flags
            iTextVector actions = serviceInfo.lookup<iTextVector>("actions");

            // Parse the supported actions
            for (auto &action : actions) {
                if (action == "delete") {
                    LOG(Services, "    Action        : Delete");
                    def.supportedActions |= SUPPORTED_ACTIONS::DELETION;
                } else if (action == "export") {
                    LOG(Services, "    Action        : Export");
                    def.supportedActions |= SUPPORTED_ACTIONS::EXPORT;
                } else if (action == "download") {
                    LOG(Services, "    Action        : Download");
                    def.supportedActions |= SUPPORTED_ACTIONS::DOWNLOAD;
                } else
                    return APERR(Ec::InvalidParam, "Invalid action setting",
                                 action, "in", definitionPath);
            }

            if (serviceInfo.isMember("config"))
                return APERR(Ec::InvalidParam, "Unexpected config section in",
                             definitionPath);

            // Output the lane info
            if (serviceInfo.isMember("lanes")) {
                // Get the lanes array
                const auto &lanes = serviceInfo["lanes"];

                // Iterate through each lane
                for (const auto &laneId : lanes.getMemberNames()) {
                    // Get the lane
                    auto lane = lanes[laneId];

                    // Get the lane's source
                    std::string fmt = "";
                    for (const auto &dst : lane) {
                        if (!fmt.empty()) fmt += ", ";
                        fmt += dst.asString();
                    }

                    fmt = "[" + fmt + "]";

                    // Output the lane and its targets
                    LOG(Services, "    Lane          :", laneId, " -> ", fmt);
                }
            }

            // Output the lane info
            if (serviceInfo.isMember("input")) {
                // Get the lanes array
                const auto &inputs = serviceInfo["input"];

                // Iterate through each lane
                for (const auto &input : inputs) {
                    // Get the laneId and what it outputs
                    auto inputLaneId = input["lane"].asString();
                    auto outputs = input["output"];

                    // If no description, flag it
                    if (!input.isMember("description"))
                        inputLaneId += " (no description)";

                    // Get the lane's source
                    std::string fmt = "";
                    for (const auto &output : outputs) {
                        auto outputLaneIds = output["lane"].asString();

                        // If no description, flag it
                        if (!output.isMember("description"))
                            outputLaneIds += " (no description)";

                        if (!fmt.empty()) fmt += ", ";

                        fmt += outputLaneIds;
                    }

                    fmt = "[" + fmt + "]";

                    // Output the lane and its targets
                    LOG(Services, "    Input         :", inputLaneId, " -> ",
                        fmt);
                }
            } else {
                LOG(Services, "    Input param   : **** MISSING input ****");
            }

            // Output the tile info
            if (serviceInfo.isMember("tile")) {
                const auto &params = serviceInfo["tile"];

                // Show all parameters
                for (const auto &param : params) {
                    // Output the lane and its targets
                    LOG(Services, "    Tile param    :", param.asString());
                }
            } else {
                LOG(Services, "    Tile param    : **** MISSING tile  ****");
            }

            // Output the icon info
            if (serviceInfo.isMember("icon")) {
                const auto &params = serviceInfo["icon"];

                // Show all parameters
                for (const auto &param : params) {
                    // Output the icon and its path
                    LOG(Services, "    Icon param    :", param.asString());
                }
            } else {
                LOG(Services, "    Icon param    : **** MISSING icon ****");
            }

            // Save our service definition info
            def.serviceDefinition = _mv(serviceInfo);

            // Get the logical type
            auto logicalType = def.logicalType;

            // Save it
            m_services[logicalType] = _mv(def);

            // Register the factories if needed
            if (registerType == "filter") {
                LOG(Services, "    Register      : Filter");
                auto factoryGlobal = Factory::makeFactory<
                    engine::store::filter::python::IFilterGlobal,
                    engine::store::pythonBase::IPythonGlobalBase>(
                    m_services[logicalType].logicalType);

                Factory::registerFactory(factoryGlobal);
                m_dynamicFactories.push_back(_mv(factoryGlobal));

                auto factoryInstance = Factory::makeFactory<
                    engine::store::filter::python::IFilterInstance,
                    engine::store::pythonBase::IPythonInstanceBase>(
                    m_services[logicalType].logicalType);

                Factory::registerFactory(factoryInstance);
                m_dynamicFactories.push_back(_mv(factoryInstance));
            }

            if (registerType == "endpoint") {
                LOG(Services, "    Register      : Endpoint");
                auto factoryEndpoint = Factory::makeFactory<
                    engine::store::filter::python::IFilterEndpoint,
                    engine::store::pythonBase::IPythonEndpointBase>(
                    m_services[logicalType].logicalType);

                Factory::registerFactory(factoryEndpoint);
                m_dynamicFactories.push_back(_mv(factoryEndpoint));

                auto factoryGlobal = Factory::makeFactory<
                    engine::store::filter::python::IFilterGlobal,
                    engine::store::pythonBase::IPythonGlobalBase>(
                    m_services[logicalType].logicalType);

                Factory::registerFactory(factoryGlobal);
                m_dynamicFactories.push_back(_mv(factoryGlobal));

                auto factoryInstance = Factory::makeFactory<
                    engine::store::filter::python::IFilterInstance,
                    engine::store::pythonBase::IPythonInstanceBase>(
                    m_services[logicalType].logicalType);

                Factory::registerFactory(factoryInstance);
                m_dynamicFactories.push_back(_mv(factoryInstance));
            }
        }

        return {};
    };

    // The sources path if the engine/engtest is running in the dev mode
    auto rootPath = application::projectDir() ? application::projectDir() / "nodes/src/nodes" : "";
    if (!rootPath || !file::exists(rootPath) || !file::isDir(rootPath))
        // The exec path if the engine is running in the prod mode
        rootPath = application::execDir() / "nodes";
    if (!file::exists(rootPath) || !file::isDir(rootPath)) {
        LOG(Services, "Loading skipped: the nodes directory not found");
        return {};
    }

    // Start at the root
    if (auto ccode = loadServices(rootPath, (Text) "*")) return ccode;

    // Also scan a `local_nodes` folder under --node_path=<dir>, if given. The
    // fixed name keeps these imported as local_nodes.<node>, never clashing
    // with the built-in `nodes` package. setPaths() puts <dir> on sys.path.
    if (NodePath) {
        auto localRoot = _cast<file::Path>(*NodePath) / "local_nodes";
        if (file::exists(localRoot) && file::isDir(localRoot)) {
            LOG(Services, "Loading workspace-local nodes from", localRoot);
            if (auto ccode = loadServices(localRoot, (Text) "*")) return ccode;
        } else {
            LOG(Services, "No local_nodes directory under --node_path:",
                _cast<file::Path>(*NodePath));
        }
    }

    // Update all the fields
    if (auto ccode = updateDefinitions()) return ccode;

    // Declare any mappers that we not specifically registered
    // with the physical endpoint driver
    if (auto ccode = declareDefaultUrlMappers()) return ccode;

    // And done

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Deinits the service definitions
//-------------------------------------------------------------------------
Error IServices::deinit() noexcept { return {}; }

//-------------------------------------------------------------------------
/// @details
///		Returns a ptr to the service configuration
/// @param[in] logicalType
///		The protocol type to find
//-------------------------------------------------------------------------
ErrorOr<IServices::ServiceDefinitionPtr> IServices::getServiceDefinition(
    const Text &logicalType) noexcept {
    // Find the mapper
    auto def = m_services.find((iTextView)logicalType);

    // If we couldn't find it
    if (def == m_services.end())
        return APERR(Ec::InvalidSchema, "The service", logicalType,
                     "was not found");

    // Return it
    return &def->second;
}

//-------------------------------------------------------------------------
/// @details
///		Returns a ptr to the service configuration
/// @param[in] logicalType
///		The protocol type to find
//-------------------------------------------------------------------------
ErrorOr<IServices::ServiceDefinitionPtr>
IServices::getServiceDefinitionFromService(
    const json::Value &service) noexcept {
    // Look up the logical type of the service
    ErrorOr<Text> type = IServiceEndpoint::getLogicalType(service);
    if (!type) return type.ccode();

    // And now, lookup the definition
    return getServiceDefinition(*type);
}

//-------------------------------------------------------------------------
/// @details
///		Returns all the service schemas. This is usually called to return
///		to the UI
/// @param[in] logicalType
///		The protocol type to find
//-------------------------------------------------------------------------
ErrorOr<json::Value> IServices::getServiceSchemas() noexcept {
    json::Value schemas;

    // For each service
    for (auto &item : m_services) {
        // Get the schema
        auto &def = item.second;

        // Get the logical type
        auto logicalType = def.logicalType;

        // If looking for a specific service, skip the rest
        if (ServiceName && ServiceName.val() != logicalType) continue;

        // If this is marked as internal, skip it
        if (def.capabilities & url::UrlConfig::PROTOCOL_CAPS::INTERNAL)
            continue;

        // Does the caller wants the whole thing
        if (ServiceCat) {
            // Just a list of the services available, return the sections
            schemas[logicalType]["sections"] = json::arrayValue;
            for (const auto &member : def.serviceSchema.getMemberNames())
                schemas[logicalType]["sections"].append(member);
        } else {
            // Wants the whole thing
            schemas[logicalType] = def.serviceSchema;
        }

        // Save some additional info
        schemas[logicalType]["title"] =
            def.serviceDefinition["title"].asString();
        schemas[logicalType]["protocol"] =
            def.serviceDefinition["protocol"].asString();
        schemas[logicalType]["prefix"] =
            def.serviceDefinition["prefix"].asString();
        schemas[logicalType]["plans"] = def.plans;
        schemas[logicalType]["capabilities"] = def.capabilities;
        schemas[logicalType]["classType"] = def.classType;
        schemas[logicalType]["actions"] = def.supportedActions;

        // Copy over the lane info
        if (def.serviceDefinition.isMember("description"))
            schemas[logicalType]["description"] =
                def.serviceDefinition["description"];

        // Copy over the lane info
        if (def.serviceDefinition.isMember("lanes"))
            schemas[logicalType]["lanes"] = def.serviceDefinition["lanes"];

        // Copy over the input info (replaces lanes)
        if (def.serviceDefinition.isMember("input"))
            schemas[logicalType]["input"] = def.serviceDefinition["input"];

        // Copy over the invoke info
        if (def.serviceDefinition.isMember("invoke"))
            schemas[logicalType]["invoke"] = def.serviceDefinition["invoke"];

        // Copy over the render info
        if (def.serviceDefinition.isMember("tile"))
            schemas[logicalType]["tile"] = def.serviceDefinition["tile"];

        // Copy over the render info
        if (def.serviceDefinition.isMember("icon"))
            schemas[logicalType]["icon"] = def.serviceDefinition["icon"];

        // Copy over the render info
        if (def.serviceDefinition.isMember("documentation"))
            schemas[logicalType]["documentation"] =
                def.serviceDefinition["documentation"];
    }

    // Clear all the comments
    schemas.clearComments();

    json::Value res;
    res["services"] = _mv(schemas);
    res["version"] = VERSION;

    // Return the schemas of the services
    return _mv(res);
}

}  // namespace engine::store
