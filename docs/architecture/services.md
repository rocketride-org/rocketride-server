# Service Definitions

Service definition json files are used to dynamically describe to the engine, the application and the UI the shape and capabilities of a service endpoint. Capability flags, along with the shape (schema) of the parameters used to configure the service are defined.

> From the UI perspective, the service definition file offers dynamic configuration using a form generator like [react-jsonschema](https://react-jsonschema-form.readthedocs.io/en/latest/). Both the schema and ui keys are present to fully describe the form and pass directly to the form manager.

The format for the service entries is pretty complex, but easy once you understand it. Each service .json file, located in the services directories are one of two types. A field definition file or a service defintion file.

> Currently, the engine is not using the schema to validate the incoming service configuration when running a task. This will be added.

## Field definition file

A field definition files does not define a service itself, but rather defines common fields that can be used in the defintion of other fields and services. The only key in this file is the fields key:

	{
		"fields": {
			"aws.bucket": {...}
		}
	}

Field defitions may be one of three types:

### Section field

A section field, expands the field to additional fields. Using this field, you may create subforms within the form. A section field has the {"section": "name",...} member. A section should have a title but is required to have a properties: [] member as well which enumerates the fields to place in the section.

### Array field

An array field is similar to a section field but requires the "items: {...}" member to define the type of item for each member of the array. Each member of the array can be
a simple type (like "items": { "type": "string"}), or it can be a complex type ("items": { "type": "object", "properties": []}) In the case of a complex type, fields can be reference just as within a section field

### Standard field

A standard field definition describes the field. It will not be exanded or traversed any further. Additional properties, above those included in the json schema/react-jsonschema-form specifications are: 
"ui": {...}
When specified, the content of the object will be placed into the UISchema defition to customize the presentation of the field

## Service definition file

The service definition file is central to configuration and managing an endpoint type. It defines key information about the endpoint and contains the following attributes

| Key         		| Value										|
|-------------------|-------------------------------------------|
| protocol			| The protocol of the service. The protocol is specified in its full for ("protocol://") |
| capabilities		| The capabilities is an array of strings that are  used to customize the behavior of the endpoint. See below for capabilities flags |
| prefix			| Defines the prefix that will be added to a path when creating a url, or removed from a url when creating a path. This can have multiple components like "File System/Fixed Disks" for example
| config			| Defines the readonly/secure fields in the parameters section of the service definition. This provides a method to obscure the sensitive fields and ensure non-changeable fields are maintained accross service configurations. See below for an example |
| fields			| Defines fields used locally only to this service definition. The same rules apply as above |
| shape				| The shape section declares the "shape" of the service will be used to generate the service schema and uiSchema |


	"config": {
		"container": "readonly",
		"accountName": "readonly",
		"endpointSuffix": "readonly",
		"accountKey": "secure"
	} 


| Capability		| Value										|
|-------------------|-------------------------------------------|
|security			| When this cap is specified, the endpoint supports reading OS permissions in the permissions filter. Only filsystem type endpoints should use this, but is provided to disable them in smb type endpoints if needed |
|filesystem			| This is a filesystem type driver which uses local open/close/read/write semantics. Note that endpoints like OneDrive should not have this set |
|substream			| The endpoint supports substreams within the target. The only endpoint that currently requires this is the zip:// endpoint, which has substreams within the main stream |
| network			| The endpoint requires network access |
| datanet			| The endpoint requires datanet protocol access |
