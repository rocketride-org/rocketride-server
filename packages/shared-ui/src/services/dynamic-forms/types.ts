// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

import UiSchema, { FormProps } from '@rjsf/core';
import { IService } from '../../types/service';

/**
 * Type alias for the JSON Schema used by RJSF form components.
 * Extracted from RJSF's `FormProps` to avoid importing the full component type.
 */
// TODO: Add proper type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FormSchema = FormProps<any>['schema'];

/**
 * Pairs a JSON Schema with its corresponding RJSF UI schema for a single
 * dynamic form section (e.g., Source, Target, Pipe).
 */
export interface ISchema {
	/** The JSON Schema defining the data shape and validation rules. */
	schema: FormSchema;
	/** The RJSF UI schema controlling widget rendering and layout. */
	ui: UiSchema;
}

/**
 * Bitflag enum representing the capabilities of a service/driver.
 * Each flag indicates a protocol or feature the driver supports (e.g., filesystem,
 * network, GPU). Used to filter and categorize services in the canvas inventory.
 *
 * @see https://github.com/rocketride-ai/rocketride-server/blob/develop/apLib/apLib/url/Url.hpp#L18-L33
 */
export enum DynamicFormsCapabilities {
	Security = 1 << 0, // Supports the file permissions interface
	Filesystem = 1 << 1, // Is a filesystem interface
	Substream = 1 << 2, // Supports the substream interface
	Network = 1 << 3, // Uses a network interface
	Datanet = 1 << 4, // Uses datanet or streamnet interfaces
	Sync = 1 << 5, // Uses delta queries to track changes in Microsoft Graph data
	Internal = 1 << 6, // Internal - will not be returned in services.json
	Catalog = 1 << 7, // Supports data catalog operations
	NoMonitor = 1 << 8, // Do not monitor for excessive failures
	NoInclude = 1 << 9, // Source endpoint does not use include, just call scanObjects with an empty path
	Invoke = 1 << 10, // Does this driver support the invoke function?
	Remoting = 1 << 11, // Does this driver support the remoting execution?
	Gpu = 1 << 12, // Does this driver require a GPU?
	NoSaas = 1 << 13, // Driver is not saas compat
	Focus = 1 << 14, // Focus on this the driver
	Deprecated = 1 << 15, // Driver is deprecated
}

/**
 * Represents a single dynamic form definition for a service/connector.
 * Contains the form schemas for each role (Pipe, Source, Target, etc.),
 * display metadata (title, icon, description), capability flags, and
 * classification types used to place the service in the canvas inventory.
 */
export interface IDynamicForm {
	title?: string;
	tile?: string[];
	icon?: string;
	actions?: number;
	capabilities?: DynamicFormsCapabilities;
	classType?: string[];
	lanes?: unknown;
	plans?: string[];
	Pipe?: ISchema;
	Source?: ISchema;
	Target?: ISchema;
	Export?: ISchema;
	Transform?: ISchema;
	'DTC.Transform'?: ISchema;
	invoke?: Record<string, unknown>;
	control?: unknown;
	description?: string;
	documentation?: string;
	type?: string;
	content?: string;
	focus?: boolean;
}

/**
 * Generic form data record type for dynamic form submissions.
 * Intentionally uses `any` to accommodate the wide variety of field types
 * produced by RJSF forms.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IFormData = Record<string, any>;

/**
 * A dictionary of dynamic form definitions keyed by service/connector name.
 * This is the shape returned by the services API and consumed by the canvas
 * to build the node inventory.
 */
export interface IDynamicForms {
	[key: string]: IDynamicForm;
}

/**
 * Response shape from the GET /dynamic-forms API endpoint.
 * Wraps the full services dictionary.
 */
export interface IGetDynamicFormsResponse {
	services: IDynamicForms;
}

/**
 * Response shape from a service validation endpoint.
 * Contains the validated service object along with any errors or warnings
 * encountered during validation.
 */
export interface IValidateResponse {
	service?: IService;
	errors: string[];
	warnings: string[];
}
