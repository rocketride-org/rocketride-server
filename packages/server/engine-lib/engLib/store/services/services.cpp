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
//			"param": true is the one flag the parser itself acts on: the
//			property becomes a pipeline parameter (a caller may override
//			its value per call), it is described in the resolved schema's
//			"params" list, and the flag is stripped. It is legal on a plain
//			field or an enum selector at the top level, inside a plain
//			group, or hoisted above a selector (see "path" below). It is a
//			load error inside an enum branch or an array item - such a
//			property resolves branch- or item-dependently - and on a
//			"constant", "oauth2" or "upload" property or one flagged
//			"secret" or "env": a parameter is never credential-shaped.
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
//		- {"base": "name", ...overrides}: same, with the listed members
//		  merged/overridden on top of the referenced definition.
//		- a fully inline object carrying its own "name".
//
//	Resolved schema
//	-----------------------------------
//	Every service's "properties" are expanded into a resolved schema
//	(IServices::buildSchema) that carries what the raw file does not:
//
//		"path" on every leaf:
//			The dotted key the leaf's value is stored under in a node's
//			config. For each level's properties (root path = empty) a
//			plain leaf is at parent + leaf; a grouped subsection's
//			children are at parent + group + leaf; a selector (an enum
//			with property sets) is itself a leaf at parent + selector,
//			and each branch's properties resolve at parent + branch -
//			EXCEPT a property referenced by the IDENTICAL specifier in
//			EVERY branch, which is HOISTED to parent (shared across the
//			branches). A nested selector is just a leaf of its level, so
//			the same two rules apply recursively. Hoisting is by
//			specifier identity: one definition referenced in every
//			branch is shared; per-branch definitions (qdrant.cloud.host
//			vs qdrant.local.host, both shortened to "host") are
//			branch-specific. Branch names and leaf names share one
//			namespace per level. An array item resolves per element, so
//			its paths are relative to "<array path>[]".
//
//		"params":
//			The flat, self-contained descriptors of the "param"-flagged
//			properties - {field, type, title, description, default} plus
//			"enum"/"minimum"/"maximum" when the leaf has them - copied
//			from the resolved leaf so a consumer validates a parameter
//			value from the descriptor alone, never re-walking the schema.
//			"field" is the leaf's "path".
//
//		"capabilities":
//			The node's PROTOCOL_CAPS bitmask - the same value the service
//			summary carries - so a consumer of the resolved schema (the
//			config resolver) applies the "multitenant" rule without a
//			second lookup.
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
//			"multitenant"
//				The node is certified reentrant-safe across callers, so a
//				pipe built only from such nodes may share one engine
//				between users (PROTOCOL_CAPS::MULTITENANT)
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
//		"prefix": (optional)
//			Defines the prefix that will be added to a path when creating
//			a url, or removed from a url when creating a path. This can
//			have multiple components like "File System/Fixed Disks" for
//			example. Legacy source-mode services only; omitted, the url/path
//			conversion is an identity.
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
///		Joins a path prefix and a leaf name into the dotted "path" the
///		leaf's value is stored under in a node's config
///	@param[in] prefix
///		The path segments of the level the leaf belongs to
///	@param[in] leaf
///		The leaf's (short) name
//-------------------------------------------------------------------------
static Text joinPath(const std::vector<Text> &prefix, TextView leaf) noexcept {
    Text path;
    for (const auto &segment : prefix) path = _ts(path, segment, ".");
    return _ts(path, leaf);
}

//-------------------------------------------------------------------------
/// @details
///		Expands one level's property specifiers - the root "properties",
///		a grouped subsection's "properties" - into the resolved array,
///		requiring the names of the level to be unique. A selector in the
///		level registers its branch names and its hoisted leaves into the
///		same namespace (through context.levelNames)
///	@param[in] context
///		The context we are working in
///	@param[in] specifiers
///		The "properties" array of the level
//-------------------------------------------------------------------------
ErrorOr<json::Value> IServices::expandProperties(
    ServiceContext &context, json::Value &specifiers) noexcept {
    json::Value children(json::arrayValue);
    std::vector<Text> seen;

    // This level's namespace - restored once the level is done
    auto *outerNames = context.levelNames;
    context.levelNames = &seen;

    for (auto &specifier : specifiers) {
        auto res = expandProperty(context, specifier);
        if (!res) return res.ccode();

        if (auto ccode =
                requireUniqueName(seen, res->lookup<Text>("name"), context))
            return ccode;

        children.append(*res);
    }

    context.levelNames = outerNames;
    return children;
}

//-------------------------------------------------------------------------
/// @details
///		Expands the per-value property sets of a selector (an enum field
///		whose "enum" is an object keyed by value). Hoisting is by
///		specifier identity: a specifier listed (JSON-equal) in EVERY
///		branch is branch-invariant, so it is expanded ONCE at the parent
///		path, outside any branch, and that expansion is placed into each
///		branch. Every other specifier resolves at parent + branch, inside
///		the branch. Branch names and hoisted leaves share the parent
///		level's namespace with its sibling leaves
///	@param[in] context
///		The context we are working in
///	@param[in] branches
///		The selector's "enum" object (taken by value, mutated and
///		returned)
//-------------------------------------------------------------------------
ErrorOr<json::Value> IServices::expandBranches(ServiceContext &context,
                                               json::Value branches) noexcept {
    const auto branchNames = branches.getMemberNames();

    // Branch names become path segments at the parent level, so they
    // share its namespace
    for (const auto &branchName : branchNames)
        if (auto ccode = requireUniqueName(*context.levelNames,
                                           Text{branchName}, context))
            return ccode;

    // Intersect the branches' specifier lists - a branch with no
    // properties references nothing, so nothing hoists past it
    std::vector<json::Value> hoisted;
    bool firstBranch = true;
    for (const auto &branchName : branchNames) {
        const auto &branch = branches[branchName];

        std::vector<json::Value> listed;
        if (branch.isMember("properties") && branch["properties"].isArray())
            for (const auto &specifier : branch["properties"])
                listed.push_back(specifier);

        if (firstBranch) {
            hoisted = _mv(listed);
            firstBranch = false;
            continue;
        }

        std::vector<json::Value> kept;
        for (auto &candidate : hoisted)
            for (const auto &specifier : listed)
                if (candidate == specifier) {
                    kept.push_back(candidate);
                    break;
                }
        hoisted = _mv(kept);
    }

    // Expand each hoisted specifier once, at the parent path and outside
    // any branch (so it stays param-eligible); its name joins the parent
    // level's namespace
    std::vector<json::Value> hoistedExpanded;
    for (auto &specifier : hoisted) {
        auto res = expandProperty(context, specifier);
        if (!res) return res.ccode();

        if (auto ccode = requireUniqueName(*context.levelNames,
                                           res->lookup<Text>("name"), context))
            return ccode;

        hoistedExpanded.push_back(*res);
    }

    // Expand every branch
    for (const auto &branchName : branchNames) {
        auto &branch = branches[branchName];
        if (!branch.isMember("properties") || !branch["properties"].isArray())
            continue;

        json::Value children(json::arrayValue);
        std::vector<Text> seen;
        for (auto &specifier : branch["properties"]) {
            // A hoisted specifier reuses its expansion
            size_t index = 0;
            while (index < hoisted.size() && !(hoisted[index] == specifier))
                ++index;

            json::Value child;
            if (index < hoisted.size()) {
                child = hoistedExpanded[index];
            } else {
                // Everything else resolves at parent + branch, inside the
                // branch. A nested selector's branch names and hoists join
                // this branch's namespace
                const auto outerNestedIn = context.nestedIn;
                auto *outerNames = context.levelNames;
                context.pathPrefix.push_back(Text{branchName});
                context.nestedIn = "an enum branch";
                context.levelNames = &seen;

                auto res = expandProperty(context, specifier);

                context.levelNames = outerNames;
                context.nestedIn = outerNestedIn;
                context.pathPrefix.pop_back();
                if (!res) return res.ccode();

                child = _mv(*res);
            }

            if (auto ccode = requireUniqueName(
                    seen, child.lookup<Text>("name"), context))
                return ccode;

            children.append(child);
        }
        branch["properties"] = _mv(children);
    }

    return branches;
}

//-------------------------------------------------------------------------
/// @details
///		Expands the structural members of an already-resolved property -
///		a grouped subsection's "properties", an array field's "item", or
///		an enum field's per-value "properties" - by recursively expanding
///		every property specifier they contain, each at its own path.
///		Properties with none of these members (plain leaf fields) are
///		returned unchanged.
///	@param[in] context
///		The context we are working in
///	@param[in] property
///		The resolved property definition (taken by value, mutated and
///		returned)
//-------------------------------------------------------------------------
ErrorOr<json::Value> IServices::expandChildren(ServiceContext &context,
                                               json::Value property) noexcept {
    // A grouped subsection - its children resolve under the group's name
    if (property.isMember("properties") && property["properties"].isArray()) {
        context.pathPrefix.push_back(property.lookup<Text>("name"));
        auto res = expandProperties(context, property["properties"]);
        context.pathPrefix.pop_back();
        if (!res) return res.ccode();

        property["properties"] = _mv(*res);
    }

    // An array field - expand its single item specifier. "type": "array"
    // is required so an array field is unambiguous from a plain field that
    // happens to carry an "item" member. Items resolve per element, so the
    // item's paths are relative to "<array path>[]" and it counts as
    // nested for "param"
    if (property.isMember("item")) {
        if (property.lookup<Text>("type") != "array")
            return APERR(Ec::InvalidParam,
                         "Array field", property.lookup<Text>("name"),
                         "must declare \"type\": \"array\" in",
                         context.def.definitionPath);

        const auto outerPrefix = context.pathPrefix;
        const auto outerNestedIn = context.nestedIn;
        context.pathPrefix = {_ts(property.lookup<Text>("path"), "[]")};
        context.nestedIn = "an array item";

        auto res = expandProperty(context, property["item"]);

        context.pathPrefix = outerPrefix;
        context.nestedIn = outerNestedIn;
        if (!res) return res.ccode();

        property["item"] = *res;
    }

    // An enum field with per-value property sets
    if (property.isMember("enum") && property["enum"].isObject()) {
        auto res = expandBranches(context, property["enum"]);
        if (!res) return res.ccode();

        property["enum"] = _mv(*res);
    }

    return property;
}

//-------------------------------------------------------------------------
/// @details
///		Acts on a resolved property's "param" flag: validates that the
///		property may be a pipeline parameter, records its flat descriptor
///		in context.params, and strips the flag from the schema. Called
///		with the FINAL field - name shortened, every {base, ...} override
///		merged in - so a reference that adds "secret" or "env" is seen
///	@param[in] context
///		The context we are working in
///	@param[in,out] field
///		The resolved property carrying "param"
//-------------------------------------------------------------------------
Error IServices::applyParam(ServiceContext &context,
                            json::Value &field) noexcept {
    const auto name = field.lookup<Text>("name");

    // The flag itself is never part of the schema
    const auto flag = field["param"];
    field.removeMember("param");

    if (!flag.isBool())
        return APERR(Ec::InvalidParam, "\"param\" on property", name, "in",
                     context.def.definitionPath, "must be a boolean");
    if (!flag.asBool()) return {};

    // A parameter resolves context-free: never branch- or item-dependent
    if (context.nestedIn)
        return APERR(Ec::InvalidParam, "\"param\" on property", name, "in",
                     context.def.definitionPath, "is not allowed inside",
                     context.nestedIn);

    // ... and is a scalar: a plain field or an enum selector
    const auto type = field.lookup<Text>("type");
    if ((field.isMember("properties") && !field.isMember("enum")) ||
        type == "array")
        return APERR(Ec::InvalidParam, "\"param\" on property", name, "in",
                     context.def.definitionPath,
                     "is only allowed on a plain field or an enum selector");

    // ... and is never fixed or credential-shaped
    if (type == "constant" || type == "oauth2" || type == "upload")
        return APERR(Ec::InvalidParam, "\"param\" on property", name, "in",
                     context.def.definitionPath, "is not allowed on a", type,
                     "property");
    if (field.isMember("secret") && field["secret"].isBool() &&
        field["secret"].asBool())
        return APERR(Ec::InvalidParam, "\"param\" on property", name, "in",
                     context.def.definitionPath,
                     "is not allowed on a secret property");
    if (field.isMember("env"))
        return APERR(Ec::InvalidParam, "\"param\" on property", name, "in",
                     context.def.definitionPath,
                     "is not allowed on an env-backed property");

    // The self-contained descriptor: copied from the resolved leaf so a
    // consumer validates a value from it alone
    json::Value descriptor;
    descriptor["field"] = field["path"];
    for (const auto *member : {"type", "title", "description", "default"})
        descriptor[member] =
            field.isMember(member) ? field[member] : json::Value{};
    for (const auto *member : {"minimum", "maximum"})
        if (field.isMember(member)) descriptor[member] = field[member];

    // The enum's values - [["value", "Label"], ...] / ["value", ...] /
    // {"value": {...}} all reduce to the list of values
    if (field.isMember("enum")) {
        json::Value values(json::arrayValue);
        const auto &options = field["enum"];
        if (options.isObject()) {
            for (const auto &value : options.getMemberNames())
                values.append(value);
        } else {
            for (const auto &option : options)
                values.append(option.isArray() ? option[0] : option);
        }
        descriptor["enum"] = _mv(values);
    }

    context.params.append(descriptor);
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		Resolves a single property specifier - a bare string reference, a
///		{"base": name, ...overrides} reference, or an already-inline
///		definition - into its fully expanded final form. Referenced
///		definitions are recursively expanded via expandChildren, so a
///		reference to a grouped subsection, array, or enum field resolves
///		completely. Every leaf gets its "path"; a "param" flag is acted
///		on and stripped.
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
    // A {"base": name, ...overrides} reference
    else if (property.isMember("base")) {
        originalId = property.lookup<Text>("base");

        auto resolved = lookupField(context, originalId);
        if (!resolved) return resolved.ccode();

        field = *resolved;

        // Overlay the overrides (everything but "base") on top - the
        // overrides win over the referenced definition
        auto overrides = property;
        overrides.removeMember("base");
        field.merge(overrides);
    }
    // Already an inline definition
    else {
        field = property;
    }

    // A propertyDefinitions entry may itself be defined as an alias -
    // {"base": name, ...overrides} - of another property (typically to
    // give a global definition a locally-unique name, e.g.
    // "qdrant.cloud.host": {"base": "vector.host", ...}). Keep following
    // "base" until we reach a real definition; each layer's own overrides
    // win over the definition it points to. An alias that leads back to
    // one already followed (itself, or a longer cycle) is a load error
    std::vector<Text> followed;
    if (originalId) followed.push_back(originalId);
    while (field.isMember("base")) {
        auto aliasId = field.lookup<Text>("base");

        for (const auto &earlier : followed)
            if (earlier == aliasId)
                return APERR(Ec::InvalidParam, "Property alias", aliasId,
                             "refers back to itself in",
                             context.def.definitionPath);
        followed.push_back(aliasId);

        auto resolved = lookupField(context, aliasId);
        if (!resolved) return resolved.ccode();

        auto base = *resolved;

        auto overrides = field;
        overrides.removeMember("base");
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

    // The field is final from here on - every override merged, the name
    // shortened. A leaf (anything but a grouped subsection) is addressed
    // by its "path"; a group's children carry the dotted path instead
    const bool isGroup = field.isMember("properties") &&
                         field["properties"].isArray() &&
                         !field.isMember("enum");
    if (!isGroup && field.isMember("name"))
        field["path"] = joinPath(context.pathPrefix, field.lookup<Text>("name"));

    // A "secret" or "readonly" leaf is registered by its path, so the
    // stored config's encrypt/decrypt (endpoint.config.cpp) knows which
    // values to protect. A hoisted leaf is expanded once, so it lands once
    // at its hoisted path; "secret" wins when both flags are set
    if (field.isMember("path")) {
        const auto isFlagged = [&field](const char *flag) noexcept {
            return field.isMember(flag) && field[flag].isBool() &&
                   field[flag].asBool();
        };
        const auto path = field.lookup<Text>("path");
        if (isFlagged("readonly"))
            context.def.secureParameters[path] = PARAM_TYPE::READONLY;
        if (isFlagged("secret"))
            context.def.secureParameters[path] = PARAM_TYPE::SECURE;
    }

    // "param" is read, acted on and stripped
    if (field.isMember("param"))
        if (auto ccode = applyParam(context, field)) return ccode;

    return expandChildren(context, _mv(field));
}

//-------------------------------------------------------------------------
/// @details
///		Expands one service definition's "properties" into its resolved
///		schema - see "Resolved schema" at the top of this file
///	@param[in,out] def
///		The service definition; serviceSchema is written
//-------------------------------------------------------------------------
Error IServices::buildSchema(ServiceDefinition &def) noexcept {
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

    // Expand the root level
    auto expanded =
        expandProperties(context, def.serviceDefinition["properties"]);
    if (!expanded) return expanded.ccode();

    // Save the schema
    json::Value schema;
    schema["properties"] = _mv(*expanded);
    schema["params"] = _mv(context.params);

    // The capabilities bitmask - the one carrier of the node's
    // capabilities, so the resolved schema is self-contained for the
    // config resolver (the multitenant rule reads it here)
    schema["capabilities"] = def.capabilities;

    def.serviceSchema = _mv(schema);

    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This function will walk through all the declared services and
///		expand their "properties" into the final, fully-resolved schema
//-------------------------------------------------------------------------
Error IServices::updateDefinitions() noexcept {
    // For each service
    for (auto &item : m_services)
        if (auto ccode = buildSchema(item.second)) return ccode;

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
///		Declares the C++ node a service is implemented by, so the factory
///		maps its library the first time one of its factories is looked up
///	@param[in]	def
///		The service definition carrying "node": "cpp"
//-------------------------------------------------------------------------
Error IServices::declareNode(const ServiceDefinition &def) noexcept {
    // The library base name is required - without it there is nothing to load
    if (!def.nodePath)
        return APERR(Ec::InvalidParam,
                     "A cpp node requires a path to its shared library in",
                     def.definitionPath);

    // The node directory is the one holding the definition we just read.
    // Kept as a named local rather than chaining .fileName() off the
    // parent() temporary directly.
    const auto nodeParent = def.definitionPath.parent();
    const auto nodeDir = nodeParent.fileName();

    // Compose the platform's library file name from the base name
#if ROCKETRIDE_PLAT_WIN
    const auto libName = _ts(def.nodePath, ".dll");
#elif ROCKETRIDE_PLAT_MAC
    const auto libName = _ts("lib", def.nodePath, ".dylib");
#else
    const auto libName = _ts("lib", def.nodePath, ".so");
#endif

    // Nodes are always resolved against the executable. In a repo build the
    // definitions come from nodes/src/nodes while the libraries are built
    // into dist/server/nodes - the two halves of a node do not share a
    // directory, which is why this is not relative to definitionPath.
    const auto libPath = application::execDir() / "nodes" / nodeDir / libName;

    LOG(Services, "    Node library  :", libPath);

    // Declared under the logical type its factories register with
    return Factory::registerNode(def.logicalType, libPath);
}

//-------------------------------------------------------------------------
/// @details
///		Rejects a parsed services.*json that is still in the old format.
///		A property definition file declares "propertyDefinitions" (the old
///		format used "fields"); a service definition declares "properties"
///		(the old format used "shape"). Either omission is a hard load
///		error naming the file - there is no runtime acceptance of the old
///		format
///	@param[in] serviceInfo
///		The parsed file
///	@param[in] definitionPath
///		The file's path, for the error
//-------------------------------------------------------------------------
Error IServices::requireNewFormat(const json::Value &serviceInfo,
                                  const Path &definitionPath) noexcept {
    // No protocol: a property definition file
    if (!serviceInfo.lookup<iText>("protocol")) {
        if (!serviceInfo.isMember("propertyDefinitions"))
            return APERR(Ec::InvalidJson,
                         "Old-format property definitions (\"fields\") are "
                         "not supported - declare \"propertyDefinitions\" in",
                         definitionPath);
        return {};
    }

    // A service definition
    if (!serviceInfo.isMember("properties"))
        return APERR(Ec::InvalidJson,
                     "Old-format service definition (\"shape\") is not "
                     "supported - declare \"properties\" in",
                     definitionPath);

    return {};
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

            // requireNewFormat() makes an old-format file a hard load error.
            // It is wired in here as the LAST act of the node conversion
            // (plan Step 2 item 5): until every services.json in the tree
            // is converted the engine must still start on the mixed tree.

            // Get the type
            iText protocol = serviceInfo.lookup<iText>("protocol");
            if (!protocol) {
                LOG(Services, "    Define global fields");

                // This is not a specific service, so load any
                // global fields it defines
                loadGlobalFields(serviceInfo);
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

            // A C++ node names no factory - it registers its own under the
            // logical type, so that is the physical type too
            const bool isCppNode = def.physicalType == "cpp";
            if (!def.physicalType || isCppNode)
                def.physicalType = def.logicalType;

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

            // Get the optional url prefix
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
                else if (cap == "multitenant")
                    def.capabilities |=
                        url::UrlConfig::PROTOCOL_CAPS::MULTITENANT;
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

            // A C++ node brings its own factories, so it is only declared
            // here - the "register" field does not apply
            if (isCppNode) {
                if (auto ccode = declareNode(m_services[logicalType]))
                    return ccode;
                continue;
            }

            // Register the factories if needed
            if (registerType == "filter") {
                LOG(Services, "    Register      : Filter");
                auto factoryGlobal = Factory::makeFactory<
                    engine::store::filter::python::IFilterGlobal,
                    engine::store::pythonBase::IPythonGlobalBase>(
                    m_services[logicalType].logicalType);

                Factory::registerFactory(factoryGlobal);

                auto factoryInstance = Factory::makeFactory<
                    engine::store::filter::python::IFilterInstance,
                    engine::store::pythonBase::IPythonInstanceBase>(
                    m_services[logicalType].logicalType);

                Factory::registerFactory(factoryInstance);
            }

            if (registerType == "endpoint") {
                LOG(Services, "    Register      : Endpoint");
                auto factoryEndpoint = Factory::makeFactory<
                    engine::store::filter::python::IFilterEndpoint,
                    engine::store::pythonBase::IPythonEndpointBase>(
                    m_services[logicalType].logicalType);

                Factory::registerFactory(factoryEndpoint);

                auto factoryGlobal = Factory::makeFactory<
                    engine::store::filter::python::IFilterGlobal,
                    engine::store::pythonBase::IPythonGlobalBase>(
                    m_services[logicalType].logicalType);

                Factory::registerFactory(factoryGlobal);

                auto factoryInstance = Factory::makeFactory<
                    engine::store::filter::python::IFilterInstance,
                    engine::store::pythonBase::IPythonInstanceBase>(
                    m_services[logicalType].logicalType);

                Factory::registerFactory(factoryInstance);
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
Error IServices::deinit() noexcept {
    // Let every C++ node pull its factories back out of the registry, while
    // the node modules are still mapped
    Factory::unloadNodes();

    return {};
}

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
        // Always emitted: the client contract types these as required
        // (prefix "" / plans null when the node declares neither)
        schemas[logicalType]["prefix"] = def.prefix;
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
