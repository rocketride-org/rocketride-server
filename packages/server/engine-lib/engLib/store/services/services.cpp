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
//
//	The format for the service entries is pretty complex, but easy
//	once you understand it. Each service .json file, located in the
//	services directories are one of types. A field definition file
//	or a service defintion file.
//
//	Field definitions
//	-----------------
//	Field defitions may be one of three types:
//
//		Section field:
//			A section field, expands the field to additional fields. Using
//			this field, you may create subforms within the form. A section
//			field has the {"section": "name",...} member. A section
//			should have a title but is required to have a properties: []
//			member as well which enumerates the fields to place in the
//			section. The top level of each endpoint service definition
//			must contain either a "Source" or "Target" section.
//
//			{
//				"section": "Source",
//				"title": "One Drive Source",
//				"properties": [
//					[field specifiers]
//				]
//			}
//
//		Array field:
//			An array field is similar to a section field but requires
//			the "items: {...}" member to define the type of item for
//			each member of the array. Each member of the array can be
//			a simple type (like "items": { "type": "string"}), or it can
//			be a complex type ("items": { "type": "object", "properties": []})
//			In the case of a complex type, fields can be reference just
//			as within a section field
//
//			"include": {
//				"title": "Include paths",
//				"type": "array",
//				"minItems": 1,
//				"items": {
//					"type": "object",
//					"properties": [
//						"include.path",
//						"include.index",
//						"include.classify",
//						"include.ocr"
//					]
//				}
//			}
//
//		Standard field:
//			A standard field definition describes the field. It will not
//			be exanded or traversed any further. Additional properties,
//			above those included in the json schema/react-jsonschema-form
//			specifications are:
//
//			"ui": {...}
//				When specified, the content of the object will be placed
//				into the UISchema defition to customize the presentation
//				of the field
//
//			"include.ocr": {
//				"title": "Enable OCR",
//				"type": "boolean",
//				"default": false,
//				"ui": {
//					"ui:widget": "hidden"
//				}
//			}
//
//		Enum field:
//			An enum field allows selections from a list. You
//			must define the "enum": [] property, and optionally,
//			the "enumNames": [] property which is used for displaying
//			user friendly text for each option in the "enum" list.
//			You may optionally define a "conditional":[] property which
//			adds additional subfields when one of the values is
//			selected.
//
//		 	"ms.auth": {
//				"type": "string",
//				"title": "Authentication Type",
//				"default": "password",
//				"enum": [
//					"password",
//					"security"
//				],
//				"enumNames": [
//					"Username/Password",
//					"Secure Web-Web Access"
//				],
//				"conditional": [
//					{
//						"value": "security",
//						"properties": [
//							"ms.tenant",
//							"ms.clientId",
//							"ms.clientSecret"
//						]
//					},
//					{
//						"value": "password",
//						"properties": [
//							"ms.accountName",
//							"ms.accountPassword"
//						]
//					}
//				]
//			}
//
//
//	Field definition file
//	-----------------------------------
//	A field definition files does not define a service itself, but
//	rather defines fields that can be used in the definition of
//	other fields and services. The only key in this file is the
//	fields key:
//
//		{
//			"fields": {
//				"aws.bucket": {...}
//			}
//		}
//
//	Service defintion file
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
//		"config":
//			Defines the readonly/secure fields in the parameters section of
//			the service definition. This provides a method to obscure the
//			sensitive fields and ensure non-changeable fields are maintained
//			accross service configurations. For example:
//				"config": {
//					"container": "readonly",
//					"accountName": "readonly",
//					"endpointSuffix": "readonly",
//					"accountKey": "secure"
//				}
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
//      "render":
//          Array of strings that define the fields within the configuration
//          information which should be rendered to a summmary title. They
//          are complex strings like "parameters.collection" which means in
//          the parameters object, display the collection key
//
//      "preconfig":
//          "default": { default configuration }
//          "profiles": { "profile1": {}, "profile2": {}}
//
//		"fields":
//			Defines fields used locally only to this service definition. The
//			same rules apply as above.
//
//		"shape":
//			The shape section declares the "shape" of the service
//			will be used to generate the service schema and uiSchema
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
///		For a field definition json, load all the fields specified into
///		the global field name space
///	@param[in] definition
///		The full parsed json definition
//-------------------------------------------------------------------------
Error IServices::loadGlobalFields(json::Value &definition) noexcept {
    // Get the fields subkey
    json::Value &definitionFields = definition["fields"];
    if (definitionFields.type() != json::ValueType::objectValue) return {};

    // Get the field member names
    auto members = definitionFields.getMemberNames();

    for (auto &field : members) {
        // Get the field
        json::Value &fieldValue = definitionFields[field];

        // Add the name member if it is not specified
        // if (!fieldValue.isMember("name"))
        //     fieldValue["name"] = getFieldName(field);

        // Save it into the fields list
        m_fields[field] = fieldValue;
    }
    return {};
}

//-------------------------------------------------------------------------
/// @details
///		This function will return the last component of a field name
///		or, if no periods, the field name itself
///		their field settings
///	@param[in] fieldName
///		The field name
//-------------------------------------------------------------------------
Text IServices::getFieldName(TextView fieldName) noexcept {
    // If it doesn't contain a ., use as is
    if (!fieldName.contains(".")) return fieldName;

    // Return after the last period
    auto index = fieldName.find_last_of(".");

    // Get the portion of it
    auto name = fieldName.substr(index + 1);
    return _mv(name);
}

//-------------------------------------------------------------------------
/// @details
///		This function will lookup the field in the private field definitions
///		or, if not found there, the global field defintions
///	@param[in] definitionPath
///		The path of the definition file being processed - used to output
///		in error messages
///	@param[in] privateFields
///		The private fields defined in the definition file
///	@param[in] fieldName
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
        // then merge them
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
///		Recursively parse a field
///	@param[in] context
///		The context we are working in
///	@param[in] value
///		Has either a string, or an object
//-------------------------------------------------------------------------
ErrorOr<IServices::ServiceSchema> IServices::getField(
    ServiceContext &context, TextView fieldName, json::Value &field) noexcept {
    // Determines if this field is actually a reference to
    // a field in the private/global field list
    const auto isReference = localfcn(json::Value & fieldInfo)->bool {
        return fieldInfo.isString();
    };

    // Determines if this is a combo field. This is when the
    // object contains the "combo" member
    const auto isCombo = localfcn(json::Value & fieldInfo)->bool {
        return fieldInfo.isMember("combo");
    };

    // Determines if this is a subsection field. This is when the
    // object contains the "section" member
    const auto isSubsection = localfcn(json::Value & fieldInfo)->bool {
        return fieldInfo.isMember("section") || fieldInfo.isMember("object");
    };

    // Determines if this is a subsection field. This is when the
    // object contains the "section" member
    const auto isArray = localfcn(json::Value & fieldInfo)->bool {
        if (fieldInfo.lookup<Text>("type") != "array") return false;
        return fieldInfo.isMember("items");
    };

    // Get the flag setting
    const auto getFlag =
        localfcn(json::Value & fieldInfo, TextView name, bool &flag) {
        // If the flag setting is present
        if (fieldInfo.isMember(name)) {
            // If it is, set it
            flag = fieldInfo.lookup<bool>(name);

            // Revert optional flag to required flag
            if (name == "optional") flag = !flag;

            // Remove the flag field
            fieldInfo.removeMember(name);

        } else if (name == "optional") {
            // Optional not specified, it is required
            flag = true;
        }
    };

    // Process the flag settings
    const auto processFlags = localfcn(IServices::ServiceSchema & info) {
        getFlag(info.field, "optional", info.isRequired);
        getFlag(info.field, "readonly", info.isReadonly);
        getFlag(info.field, "secure", info.isSecured);

        if (info.isReadonly) {
            context.def.secureParameters[info.name] = PARAM_TYPE::READONLY;
            info.ui["ui:readonlyOnEdit"] = true;
        }

        if (info.isSecured) {
            context.def.secureParameters[info.name] = PARAM_TYPE::SECURE;
            info.ui["ui:secure"] = true;
        }
    };

    // Reads all the ui specifiers and puts them into the info.ui
    const auto processUI =
        localfcn(IServices::ServiceSchema & info, json::Value & fieldInfo) {
        json::Value ui = json::objectValue;
        bool nonNestedDisplay = false;
        bool hidden = false;

        // Setup the ui field
        info.ui = json::Value(json::objectValue);

        // If this is a const, default to being hidden
        if (fieldInfo.isMember("const")) hidden = true;

        // If this is an object, default to being nonNested
        if (fieldInfo.isMember("object")) nonNestedDisplay = true;

        // For each key in the field
        for (const auto &member : fieldInfo.getMemberNames()) {
            // Process hidden option
            if (member == "hidden") {
                hidden = fieldInfo["hidden"].asBool();
                fieldInfo.removeMember(member);
                continue;
            }

            // Handle
            //	field: {
            //		"ui": {
            //			"ui:options": {
            //				"label": false
            //			},
            //			"ui:widget": "hidden"
            //		}
            //	}
            if (member == "ui") {
                // Walk each member of ui
                for (const auto &uiMember :
                     fieldInfo[member].getMemberNames()) {
                    // Get the value
                    auto value = fieldInfo[member][uiMember];

                    // If this an object, enumerate the keys
                    if (value.isObject()) {
                        // Create it if we need to
                        if (!ui.isMember(uiMember))
                            ui[uiMember] = json::Value(json::objectValue);

                        // Add all the values
                        for (auto &valueMember : value.getMemberNames()) {
                            ui[uiMember][valueMember] = value[valueMember];
                        }
                    } else {
                        // Just copy it over
                        ui[uiMember] = value;
                    }
                }
                fieldInfo.removeMember(member);
                continue;
            }

            // Handle
            //	field: {
            //		"ui:options:label": any
            //	}
            if (member.startsWith("ui:options:")) {
                // Split it up on the :
                auto key = member.substr(11);

                // Make sure it exists
                if (!ui.isMember("ui:options"))
                    ui["ui:options"] = json::Value(json::objectValue);

                // Put it in the ui:options
                ui["ui:options"][key] = fieldInfo[member];
                fieldInfo.removeMember(member);
                continue;
            }

            // Handle
            //	field: {
            //		"ui:..." : any"
            //	}
            if (member.startsWith("ui:")) {
                ui[member] = fieldInfo[member];
                fieldInfo.removeMember(member);
            }
        }

        // If not title, say no label
        if (!fieldInfo.isMember("title")) {
            // Make sure it exists
            if (!ui.isMember("ui:options"))
                ui["ui:options"] = json::Value(json::objectValue);

            // Save it
            ui["ui:options"]["label"] = false;
        }

        // If auto non nested display (using type=object)
        if (nonNestedDisplay) {
            if (!ui.isMember("ui:options"))
                ui["ui:options"] = json::Value(json::objectValue);
            ui["ui:options"]["nonNestedDisplay"] = true;
        }

        // If hidden, override any width specified
        if (hidden) ui["ui:widget"] = "hidden";

        // If we have any ui specifiers, save them
        if (ui.size()) info.ui = ui;
    };

    // Process a reference
    const auto processReference =
        localfcn(json::Value & fieldInfo)->ErrorOr<IServices::ServiceSchema> {
        // Get the fieldId
        auto fieldId = fieldInfo.asString();

        // The name of this field is the end of the reference
        // everything after the last .
        auto fieldName = getFieldName(fieldId);

        // Get the field def from the global/private field list
        auto refField = lookupField(context, fieldId);
        if (!refField) return refField.ccode();

        // Parse it and process the field
        auto info = getField(context, fieldName, *refField);
        if (!info) return info.ccode();

        // The name of this field is the end of the reference
        // everything after the last .
        if (info->name != fieldName) _constCast<Text &>(info->name) = fieldName;

        return *info;
    };

    // Process a subsection
    const auto processSubsection =
        localfcn(json::Value & fieldInfo)->ErrorOr<IServices::ServiceSchema> {
        auto fieldName = fieldInfo.lookup<Text>(
            fieldInfo.isMember("section") ? "section" : "object");

        IServices::ServiceSchema info{fieldName};

        // This is a normal field definition
        // Remove the ui customization field if present
        // This is a normal field definition, process any ui specifiers
        processUI(info, fieldInfo);

        // Setup the subsection name
        info.isSection = true;

        // This is a normal field definition, process any ui specifiers
        processUI(info, fieldInfo);

        info.field = fieldInfo;
        info.field["type"] = "object";

        // Get the properties - which defines fields within the section
        auto &props = fieldInfo["properties"];

        // Say this field is resolved
        info.isResolved = true;

        // For each field
        for (auto &field : props) {
            // Get the field info (or subfields, etc)
            auto subfield = getField(context, "", field);
            if (!subfield) return subfield.ccode();

            // If we couldn't resolve this child, we can't resolve the section
            if (!subfield->isResolved) info.isResolved = false;

            // Save this childs field info
            info.children.push_back(_mv(subfield));
        }

        // Remove what we have parsed
        info.field.removeMember("section");
        info.field.removeMember("properties");

        // And return the info we built
        return info;
    };

    // Process an normal field
    const auto processField =
        localfcn(json::Value & fieldInfo)->ErrorOr<IServices::ServiceSchema> {
        IServices::ServiceSchema info{fieldName};

        // Determine if a field has a conditional with the given value
        const auto hasConditional = localfcn(const json::Value &value) {
            for (const auto &cond : info.conditionals) {
                if (cond.value == value) return true;
            }
            return false;
        };

        // This is a normal field definition
        // Remove the ui customization field if present
        // This is a normal field definition, process any ui specifiers
        processUI(info, fieldInfo);

        // Get the conditional dependencies, they need to be
        // combined at the end
        if (fieldInfo.isMember("conditional")) {
            // Get the conditional fields
            auto &conds = fieldInfo["conditional"];

            // Get the conditional controlling field name
            Text condName;
            if (fieldInfo.isMember("field")) {
                condName = fieldInfo.lookup<Text>("field");
                fieldInfo.removeMember("field");
            }

            // For each of the condtional set
            if (conds.size()) {
                // Add them...
                for (int index = 0; index < (int)conds.size(); index++) {
                    ServiceSchemaConditional condSet;

                    // Get the condition field
                    auto &cond = conds[index];

                    // Get the conditional controlling value and name
                    condSet.value = cond["value"];

                    // Get the field specifier key
                    auto &props = cond["properties"];

                    // For each field
                    for (auto &field : props) {
                        // Get the field info (or subfields, etc)
                        auto subfield = getField(context, "", field);
                        if (!subfield) return subfield.ccode();

                        // Save this subfield
                        condSet.fields.push_back(_mv(subfield));
                    }

                    // Save it as one of the conditions
                    info.conditionals.push_back(_mv(condSet));
                }
            }

            // Remove the conditional - it is not passed through
            fieldInfo.removeMember("conditional");
        }

        // If this field has an enum member
        if (fieldInfo.isMember("enum")) {
            // Determines if enum names are specified
            const auto hasEnumNames = fieldInfo.isMember("enumNames");

            // Declare our enum values and names arrays
            json::Value enumValues(json::arrayValue);
            json::Value enumNames(json::arrayValue);

            // Grab our input arrays
            const auto &inputValues = fieldInfo["enum"];
            const auto &inputNames =
                hasEnumNames ? fieldInfo["enumNames"] : json::nullValue;

            // For each item
            for (json::Value::ArrayIndex index = 0; index < inputValues.size();
                 index++) {
                // Get our item
                const auto &item = inputValues.get(index, json::nullValue);

                // If it is one or two strings, use the first as the value
                // and the second (if specified) as the name
                if (item.isArray()) {
                    enumValues.append(item[0]);
                    if (item.size() > 1)
                        enumNames.append(item[1]);
                    else
                        enumNames.append(item[0]);
                    continue;
                }

                // Get the item text
                const Text &itemText = (Text)item.asString();

                // If it is a normal item, just append it and continue
                if (!itemText.startsWith("*>")) {
                    // Append the value
                    enumValues.append(itemText);

                    // If we have names, add it, otherwise, just use the value
                    if (hasEnumNames)
                        enumNames.append(inputNames.get(index, itemText));
                    else
                        enumNames.append(itemText);
                    continue;
                }

                // Determine if it is of the form object.*.title
                auto titlePos = itemText.find(".*.");
                auto hasTitle = titlePos == std::string::npos ? false : true;

                // Create the reference path from either the while string
                // or if there is a .*., then everything up to that
                auto path = itemText.substrView(
                    2, hasTitle ? titlePos - 2 : std::string::npos);

                // Get the key within the object if it has the form or .*. or
                // a blank
                auto title =
                    hasTitle ? itemText.substrView(titlePos + 3) : ""_tv;

                // Find the path to it
                const auto &obj = context.def.serviceDefinition.lookup(path);

                // Now, enumerate them
                for (auto &itemValue : obj.getMemberNames()) {
                    enumValues.append(itemValue);
                    if (hasTitle)
                        enumNames.append(obj[itemValue][title]);
                    else
                        enumNames.append(itemValue);
                }
            }

            // If there are any conditions on the enum, we need to make sure
            // that there is a condition for every possible enum value
            if (!info.conditionals.empty()) {
                // Find all of our empty conditionals
                json::Value emptyConditionals = json::Value(json::arrayValue);
                for (const auto &enumValue : enumValues) {
                    if (!hasConditional(enumValue))
                        emptyConditionals.append(enumValue);
                }

                // If we have some conditionals that were not specified...
                if (!emptyConditionals.empty()) {
                    // Create a conditional that encompasses all the unspecified
                    // conditions
                    ServiceSchemaConditional condSet;

                    // Set it up to be empty
                    condSet.value = emptyConditionals;

                    // Add it
                    info.conditionals.push_back(_mv(condSet));
                }
            }

            // Save the transform values into the field
            fieldInfo["enum"] = enumValues;

            // Add the enum names
            info.ui["ui:enumNames"] = enumNames;

            // Remove it from the field info - it is obsolete here
            fieldInfo.removeMember("enumNames");
        }

        info.field = fieldInfo;

        // Process the flags
        processFlags(info);

        // And return the inf we built
        return info;
    };

    // Process an array field
    const auto processArray =
        localfcn(json::Value & fieldInfo)->ErrorOr<IServices::ServiceSchema> {
        IServices::ServiceSchema info{fieldName};

        // Remove the ui customization field if present
        // This is a normal field definition, process any ui specifiers
        processUI(info, fieldInfo);

        // Setup the subsection name
        info.isArray = true;
        info.field = fieldInfo;
        info.field["type"] = "array";

        // Get the properties - which defines fields within the section
        auto &items = fieldInfo["items"];

        // If this is an object - compound fields
        if (items["type"] == "object") {
            IServices::ServiceSchema itemSection{"items"};

            // Set it up
            itemSection.field = items;
            itemSection.isSection = true;

            // Get the properties - which defines fields within the section
            auto &props = items["properties"];

            // For each field
            for (auto &field : props) {
                // Get the field info (or subfields, etc)
                auto subfield = getField(context, "", field);
                if (!subfield) return subfield.ccode();

                // Save this childs field info
                itemSection.children.push_back(_mv(subfield));
            }

            // We don't return this directly
            itemSection.field.removeMember("properties");

            // Save it
            info.children.push_back(_mv(itemSection));
        } else {
            // Get the field info (or subfields, etc)
            auto subfield = getField(context, "items", items);
            if (!subfield) return subfield.ccode();

            // Get the single field
            info.arrayItem.push_back(_mv(subfield));
        }

        // Process the flags
        processFlags(info);

        // Remove what we have parsed
        info.field.removeMember("items");

        // And return the info we built
        return info;
    };

    // Process a combo field - a combo field is specified in the defintion as
    //  {
    //      title: '...'
    //      combo: '...',
    //		section: '...',
    //      ui: {...}
    //  }
    //  Where combo is a string which is used to match all drivers of
    //  classType=type. This is used to create a super type across multiple
    //  drivers. This will create a drop down list (using enums) of the drivers,
    //  and then add the configuration forms for each driver as a conditional of
    //  the given driver. This, for example, allows us to create a filter called
    //  embeddings, which knows about all defined embeddings. Note that is only
    //  includes drivers with the capability flag of "hidden" so it won't return
    //  duplicates
    //
    const auto processCombo =
        localfcn(json::Value & fieldInfo)->ErrorOr<IServices::ServiceSchema> {
        IServices::ServiceSchema info{
            fieldInfo.isMember("section")
                ? _cast<TextView>(fieldInfo.lookup<Text>("section"))
                : fieldName};

        // Setup the subsection name
        info.isCombo = true;

        // Grab any UI parameters
        processUI(info, fieldInfo);

        // Get the enum array
        json::Value enumValues(json::arrayValue);
        json::Value enumNames(json::arrayValue);

        // Build the basic structure
        json::Value field(json::objectValue);
        field["title"] = fieldInfo["title"];
        field["type"] = "object";
        field["properties"]["provider"]["type"] = "string";
        field["properties"]["provider"]["title"] =
            fieldInfo.lookup<Text>("providerTitle", "Provider");
        field["dependencies"]["provider"]["oneOf"] =
            json::Value(json::arrayValue);
        field["required"] = json::Value(json::arrayValue);
        field["required"].append("provider");

        // Add the provider as the first entry
        info.ui["ui:order"] = json::Value(json::arrayValue);
        info.ui["ui:order"].append("provider");

        // Get the service types we are looking for and to include
        const Text classType = fieldInfo.lookup<Text>("combo");

        // Get the section we are talking about
        const Text section = fieldInfo.lookup<Text>("section", "Pipe");

        // Define the default provider - the 1st one
        Text defaultProvider;

        // Go through all the services looking for services matching
        // the class type and section given
        for (auto &service : m_services) {
            // Get its definition
            auto &def = service.second;

            // Make sure it is an array
            if (!def.classType.isArray()) continue;

            // See if this type is in the classType:[]
            bool hasClassType = false;
            for (const auto &item : def.classType) {
                if (item.isString() && item.asString() == classType) {
                    hasClassType = true;
                    break;
                }
            }

            // If it is not the correct class type, skip it
            if (!hasClassType) continue;

            // Make sure this
            auto &serviceSchema = def.serviceSchema;

            // If the field we may be dependent on is not resolved, we
            // can be resolved yet
            if (!def.isResolved) {
                info.isResolved = false;
                continue;
            }

            // See if this has a section for this type that we
            // are working on.. (Pipe, Transform, Source, etc)
            if (!serviceSchema.isMember(section)) continue;

            // Get a copy of this schema and ui
            auto subformSchema = serviceSchema[section]["schema"];
            auto subformUI = serviceSchema[section]["ui"];

            // Get the logical type
            const Text logicalType = (Text)def.logicalType;

            // Save the default provider for the first one
            if (!defaultProvider) defaultProvider = logicalType;

            // Add the logical type to the enum values
            enumValues.append(logicalType);

            // Add the title to the enum names
            enumNames.append(
                subformSchema.lookup<Text>("title", (Text)def.title));

            // Supress the title on the subform
            subformSchema["title"] = "";

            // Wrap it into an object
            json::Value subform;
            subform["type"] = "object";
            subform["properties"]["provider"]["const"] = logicalType;
            subform["properties"][logicalType] = subformSchema;

            // And add it to the oneOf conditions
            field["dependencies"]["provider"]["oneOf"].append(subform);

            // Make sure it's subform is not nested
            subformUI["ui:options"]["nonNestedDisplay"] = true;

            // Save the UI info
            info.ui[logicalType] = subformUI;

            // Add the section to the main order list
            info.ui["ui:order"].append(logicalType);
        }

        // Setup the default
        field["properties"]["provider"]["default"] = defaultProvider;

        // Set the enum values
        field["properties"]["provider"]["enum"] = enumValues;

        // Set the ui names and the order
        info.ui["provider"]["ui:enumNames"] = enumNames;

        // Save the results
        info.field = field;

        // And return the info we built
        return info;
    };

    // If reference...
    if (isReference(field)) return processReference(field);

    // If an array...
    if (isArray(field)) return processArray(field);

    // If a combo...
    if (isCombo(field)) return processCombo(field);

    // If a section...
    if (isSubsection(field)) return processSubsection(field);

    // Normal field
    return processField(field);
}

//
// Get the names of the elements recursively
//
// This will walk through the given schema recursively and produce the
// names from it for `ui:order`.
//
std::list<Text> IServices::getFieldNames(const ServiceSchema &schema) noexcept {
    std::list<Text> fieldsNames;
    // If this also has conditionals
    for (auto &cond : schema.conditionals) {
        // For each of the conditional fields
        for (auto &condField : cond.fields) {
            // Get it's UI fields
            auto childFieldsNames = getFieldNames(condField);

            // Save any UI options under this key
            fieldsNames.push_back(condField.name);
            if (!childFieldsNames.empty()) fieldsNames.merge(childFieldsNames);
        }
    }
    return fieldsNames;
}

//
// Get the child conditional UI elements recursively
//
// This will walk through the given schema recursively and produce the
// child conditional UI elements.
//
json::Value IServices::getChildConditionalUIElements(
    const ServiceSchema &schema) noexcept {
    json::Value uiElements;
    for (auto &cond : schema.conditionals) {
        // For each of the conditional fields
        for (auto &condField : cond.fields) {
            // Get it's Childs UI fields
            auto childFieldsNames = getChildConditionalUIElements(condField);
            if (!childFieldsNames.empty()) {
                uiElements.merge(childFieldsNames);
            }
            if (!condField.ui.isNull()) {
                uiElements[condField.name] = condField.ui;
            }
        }
    }
    return uiElements;
}

//-------------------------------------------------------------------------
/// @details
///		This function will walk through all the declared services and
///		update their field settings
//-------------------------------------------------------------------------
Error IServices::updateDefinitions() noexcept {
    // forward declaration
    std::function<json::Value(ServiceSchema &, ServiceDefinition &)>
        traverseSchema;

    //
    // Produce the json schema dependencies recursively
    //
    // This will walk through the given schema recursively and produce the
    // dependencies json schema from it. This json schema describes all the
    // field validators for the service and can be passed to
    // react-jsonschema-form to present the UI
    //
    std::function<json::Value(ServiceSchema &, ServiceDefinition &)>
        getDependencies =
            localfcn(ServiceSchema & field, ServiceDefinition & def) {
        json::Value oneOf;
        json::Value dependencies;
        Text condName = field.name;

        // For each conditional specified
        for (auto conditional : field.conditionals) {
            // Add all the conditional fields to this properties and childrens
            json::Value props;
            json::Value childProps;

            for (auto condfield : conditional.fields) {
                // Get the field info
                auto fieldInfo = traverseSchema(condfield, def);

                // Save it
                props[condfield.name] = fieldInfo;

                // Get the Child info
                if (condfield.conditionals.size()) {
                    childProps = getDependencies(condfield, def);
                    if (childProps) {
                        dependencies.merge(childProps);
                    }
                }
            }

            // Construct the value into an array if not already one
            json::Value condvalue;
            if (conditional.value.isArray())
                condvalue = conditional.value;
            else
                condvalue.append(conditional.value);

            // Construct the enum
            json::Value condenum;
            condenum["enum"] = condvalue;

            // Save the controlling enum
            props[condName] = condenum;

            json::Value propobj;
            propobj["properties"] = props;

            // Add it to our one of list
            oneOf.append(propobj);
        }

        // Create the dependency
        json::Value dependency;
        dependency["oneOf"] = oneOf;

        // Save it in the dependency object
        dependencies[condName] = dependency;
        return dependencies;
    };

    //
    // Produce the json schema recursively
    //
    // This will walk through the given schema recursively and produce the
    // json schema from it. This json schema describes all the field validators
    // for the service and can be passed to react-jsonschema-form to present
    // the UI
    //
    traverseSchema = localfcn(ServiceSchema & schema, ServiceDefinition & def) {
        // Use whatever we put in the field
        json::Value value = schema.field;
        json::Value required;

        // Determine the type - if it is a section, it is an object
        auto type = value["type"];
        if (schema.isSection) type = "object";

        // If we have a component array item list
        if (schema.isArray) {
            // Temp
            if (schema.children.size()) {
                // Get the first child - it will be the "items"
                auto itemList = schema.children[0];

                // Save it
                value["items"] = traverseSchema(itemList, def);
            } else {
                // Get the one and only field
                auto field = schema.arrayItem[0];

                // A single field as an array
                value["items"] = traverseSchema(field, def);
            }
        } else {
            // If we have children
            if (schema.children.size()) {
                // Add all the fields
                json::Value obj;
                for (auto &field : schema.children) {
                    // Append to required if needed
                    if (field.isRequired) required.append(field.name);

                    obj[field.name] = traverseSchema(field, def);
                }

                // Save the properties
                value["properties"] = obj;

                // If any field has a conditional
                json::Value dependencies;
                for (auto &field : schema.children) {
                    // If we do not have conditional fields, skip it
                    if (!field.conditionals.size()) continue;

                    // get dependencies
                    json::Value dependency = getDependencies(field, def);
                    dependencies.merge(dependency);
                }

                // If we have conditionals, save them
                if (dependencies) value["dependencies"] = dependencies;
            }
        }

        // Add the required fields if needed
        if (required) {
            value["required"] = required;
        }

        // Return the value
        return _mv(value);
    };

    //
    // Produce the json ui recursively
    //
    // This will walk through the given schema recursively and produce the
    // json UI options from it. These are optional UI customizations used
    // by react-jsonschema-form to perform all the nicities of a UI, for
    // example, ordering, formatting, etc
    //
    std::function<json::Value(const ServiceSchema &, const ServiceDefinition &)>
        traverseUI = localfcn(const ServiceSchema &schema,
                              const ServiceDefinition &serviceDefinition) {
        // Setup the default
        json::Value value = schema.ui;

        // For each field in this schema
        for (auto &field : schema.children) {
            // If it has a name, add it to the order list and check for secure
            // parameters
            if (field.name) {
                value["ui:order"].append(field.name);
                // Check if it is an action
                // if actions, add the UI fields
                if (field.name == "actions") {
                    if (!(serviceDefinition.supportedActions &
                          SUPPORTED_ACTIONS::DELETION)) {
                        value[field.name]["ui:delete:disable"] = true;
                    }
                    if (!(serviceDefinition.supportedActions &
                          SUPPORTED_ACTIONS::EXPORT)) {
                        value[field.name]["ui:export:disable"] = true;
                    }
                    if (!(serviceDefinition.supportedActions &
                          SUPPORTED_ACTIONS::DOWNLOAD)) {
                        value[field.name]["ui:download:disable"] = true;
                    }
                }
            }

            // Get its UI fields
            auto childUI = traverseUI(field, serviceDefinition);

            // If it has them, then add it
            if (childUI) value[field.name].merge(childUI);

            // If this also has conditionals
            for (auto &cond : field.conditionals) {
                // For each of the conditional fields
                for (auto &condField : cond.fields) {
                    // Get it's UI fields
                    auto childUI = traverseUI(condField, serviceDefinition);
                    std::list<Text> fieldNames = getFieldNames(condField);

                    // Remove the field if it is already appended to "ui:order"
                    // for avoiding field duplication
                    for (json::Value::ArrayIndex i = 0;
                         i != value["ui:order"].size(); i++)
                        if (condField.name == value["ui:order"][i].asString()) {
                            value["ui:order"].removeIndex(i);
                            break;
                        }

                    if (condField.name)
                        value["ui:order"].append(condField.name);

                    for (auto fieldName : fieldNames) {
                        // Remove the field if it is already appended to
                        // "ui:order" for avoiding field duplication
                        for (json::Value::ArrayIndex j = 0;
                             j != value["ui:order"].size(); ++j) {
                            if (fieldName == value["ui:order"][j].asString()) {
                                value["ui:order"].removeIndex(j);
                                break;
                            }
                        }
                        value["ui:order"].append(fieldName);
                    }

                    // Save any UI options under this key
                    if (childUI) value[condField.name].merge(childUI);

                    auto childCondUi = getChildConditionalUIElements(condField);
                    if (childCondUi) value.merge(childCondUi);
                }
            }
        }

        // And return it
        return _mv(value);
    };

    //
    // Generate the serviceSchema for the given service definition
    //
    const auto processService = localfcn(ServiceDefinition & def)->Error {
        // Create the context we pass around
        ServiceContext context(def);

        // Default to resolved
        def.isResolved = true;

        // Get the private fields
        auto fields = def.serviceDefinition["fields"];
        if (fields.type() == json::ValueType::objectValue) {
            // Get the field member names
            auto members = fields.getMemberNames();

            // For each field definition, add it to the private fields
            for (auto field : members) {
                json::Value &fieldValue = fields[field];
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

        // Build up the "type" field so it can be referenced. We put
        // it in the local fields in case someone actually defined
        // a global "type" field - which would be bad

        // Setup a ui widget to hide it
        json::Value ui;
        ui["ui:widget"] = "hidden";

        // Add the "type" field
        json::Value typeField;
        typeField["type"] = "string";

        // Setup the default to be our protocol
        typeField["default"] = url.protocol();

        // Create a ui section for the type
        typeField["ui"] = ui;

        // And add it into our private field definitions so we use it
        context.privateFields["type"] = typeField;

        // Get the raw shape section
        auto &shape = def.serviceDefinition["shape"];

        // Create the schema
        json::Value schema;

        // For each type in the shape
        for (auto &section : shape) {
            // Transform it
            auto res = getField(context, "", section);
            if (!res) return res.ccode();

            // Pull the the info
            auto info = *res;

            auto sectionSchema = traverseSchema(info, def);
            auto sectionUI = traverseUI(info, def);

            // If we need another pass at resolution due to the fact
            // that some fields could not be resolved, mark it
            if (!info.isResolved) def.isResolved = false;

            // Create the item and add our two sections
            json::Value sectionShape;
            sectionShape["schema"] = sectionSchema;
            sectionShape["ui"] = sectionUI;

            // Save it in the schema
            schema[info.name] = sectionShape;
        }

        // Save the schema
        def.serviceSchema = _mv(schema);
        return {};
    };

    // For each service non-combine driver
    for (auto attempts = 0; attempts < 16; attempts++) {
        bool resolved = true;

        // Loop through the services
        for (auto &item : m_services) {
            // Get the logical type
            auto type = item.first;

            // Get the definition
            auto &def = item.second;

            // If we have already resolved this, skip it
            if (def.isResolved) continue;

            // Process this one
            if (auto ccode = processService(def)) return ccode;

            // If we could not entirely resolve this yet, try again
            if (!def.isResolved) resolved = false;
        }

        if (resolved) break;
    }

    // Output any that couldn't be resolved
    for (auto &item : m_services) {
        // Get the logical type
        auto type = item.first;

        // Get the definition
        auto &def = item.second;

        // If we have already resolved this, skip it
        if (def.isResolved) continue;

        // Output it
        LOG(Services, "Could not resolve", def.logicalType,
            " -- circular reference");
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
                if (!concatenatedString.empty()) {
                    concatenatedString += "\n";
                }
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
                LOG(Services, "    Define global fields");

                // This is not a specific service, so load any
                // global fields it defines
                loadGlobalFields(serviceInfo);
                continue;
            }

            // Resolve all the descriptions fields
            resolveDescriptions(serviceInfo);

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
