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

import { RJSFSchema, UiSchema } from '@rjsf/utils';
import { ValidationData } from '@rjsf/utils';
import { getDefaultFormState as RJSFGetDefaultFormState } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';
import { traverseObject } from './traverse-object';

/**
 * Get default form state for a schema, handling complex oneOf dependencies
 * @param schema - schema to generate defaults for
 * @returns default form data with all required fields populated
 */
export function getDefaultFormState(schema: RJSFSchema): Record<string, unknown> {
	// try the built-in RJSF method with hints for oneOf resolution
	const profileProp = schema.properties?.profile;
	// Extract the profile default if present; used as a seed to help RJSF resolve the correct oneOf branch
	const profileDefault = (typeof profileProp !== 'boolean' && profileProp) ? profileProp.default : undefined;
	// Seed with profile default so oneOf-dependent defaults are computed from the correct branch
	const seed = profileDefault ? { profile: profileDefault } : {};

	return RJSFGetDefaultFormState(
		validator,
		schema,
		seed,
		schema,
		true // include undefined values
	);
}

/**
 * Validate formData against schema
 * @param schema - schema to validate against
 * @param formData - form data to validate
 * @returns validation result with any errors
 */
export function validateFormData<T = Record<string, unknown>>(
	schema: RJSFSchema,
	formData: Record<string, unknown> = {}
): ValidationData<T> {
	return validator.validateFormData(formData, schema);
}

/**
 * Traverses a RJSF UI schema and collects the names of all fields marked with
 * `ui:secure`. These fields typically contain sensitive credentials that need
 * special handling (masking, omission from exports, etc.).
 *
 * @param uiSchema - The RJSF UI schema to inspect.
 * @returns A `Set` of field names that are flagged as secure.
 */
export function getSecuredFields(uiSchema: UiSchema = {}): Set<string> {
	const secured = new Set<string>();

	// Walk every node in the UI schema tree; collect field names that have ui:secure set
	traverseObject(uiSchema, (node, key) => {
		if (node['ui:secure']) secured.add(key ?? '');
	});

	return secured;
}

/**
 * Traverses a RJSF UI schema and collects the names of all fields that use
 * the `password` widget. Used to identify fields that should be masked in the UI
 * or excluded from plain-text exports.
 *
 * @param uiSchema - The RJSF UI schema to inspect.
 * @returns A `Set` of field names with the password widget.
 */
export function getPasswordFields(uiSchema: UiSchema = {}): Set<string> {
	const secured = new Set<string>();

	// Walk every node in the UI schema tree; collect field names rendered with the password widget
	traverseObject(uiSchema, (node, key) => {
		if (node['ui:widget'] === 'password') secured.add(key ?? '');
	});

	return secured;
}

/**
 * Searches a RJSF schema (or UI schema) for field names that contain any of the
 * provided substrings (case-insensitive). Useful for finding fields by naming
 * convention, e.g., all fields containing "token" or "secret".
 *
 * @param schema - The RJSF schema or UI schema to search.
 * @param fields - An array of lowercase substrings to match against field names.
 * @returns A `Set` of matching field names.
 */
export function getFieldsLike(schema: RJSFSchema | UiSchema = {}, fields: string[]): Set<string> {
	const secured = new Set<string>();

	traverseObject(schema, (node, key) => {
		// Check each substring against the current field name (case-insensitive)
		for (const part of fields) {
			if (key?.toLowerCase().includes(part)) secured.add(key);
		}
	});

	return secured;
}

/**
 * Deep-clones the form data and removes all properties whose keys appear in
 * the provided `fields` set. Used to strip sensitive values (passwords, tokens)
 * from form data before exporting or logging.
 *
 * @param formData - The original form data object.
 * @param fields - A `Set` of field names to remove.
 * @returns A new object with the specified fields deleted.
 */
export function removeFieldValues(
	formData: Record<string, unknown>,
	fields: Set<string>
): Record<string, unknown> {
	// Deep clone via JSON round-trip so we never mutate the original form data
	const _formData = JSON.parse(JSON.stringify(formData));

	traverseObject(_formData, (node) => {
		// At each node, delete any property whose key is in the restricted set
		for (const key of Object.keys(node)) {
			if (fields.has(key) && key in node) {
				delete node[key];
			}
		}
	});

	return _formData;
}

/**
 * Traverses form data to find all `secureParameters` entries and extracts the
 * object paths and secure key names. This information is used downstream to
 * apply special UI schema properties (e.g., masking) to secured fields.
 *
 * @param formData - The form data to inspect.
 * @returns An array of tuples where each tuple is `[path, keys]`:
 *   - `path`: the object path leading to the secure parameters container.
 *   - `keys`: the individual secure field names within that container.
 */
export function getSecuredFormData(formData: Record<string, unknown> = {}): [
	string[], // Path of the formData
	string[], // Key of the formData item
][] {
	const secured: [string[], string[]][] = [];

	traverseObject(formData, (node, key, path) => {
		// Only process nodes named "secureParameters"
		if (key === 'secureParameters') {
			const keys: string[] = [];

			// Remove "secureParameters" itself from the path so it points to the parent container
			path.pop();

			// Collect the individual secure field names listed in the "secure" array
			for (const secureKey of (node['secure'] as string[]) ?? []) keys.push(secureKey);

			secured.push([path, keys]);
		}
	});

	return secured;
}

/**
 * Deep-clones a RJSF UI schema and sets the given data properties on specific
 * fields identified by their path and key. Used to dynamically annotate secured
 * fields in the UI schema with runtime properties (e.g., `ui:secure` flags).
 *
 * @param uiSchema - The base UI schema to modify.
 * @param items - An array of `[path, keys]` tuples identifying which fields to update.
 * @param data - A key-value map of properties to set on each matching field.
 * @returns A new UI schema with the specified properties applied.
 */
export function setUiSchemaProperty(
	uiSchema: UiSchema = {},
	items: [string[], string[]][],
	data: Record<string, unknown>
) {
	// Deep clone so we never mutate the caller's UI schema
	const _uiSchema = JSON.parse(JSON.stringify(uiSchema));

	for (const [path, keys] of items) {
		// Start at root and walk down to the target node
		let temp: Record<string, unknown> = _uiSchema;

		// Clone the path array so shifting doesn't affect the caller's data
		const _path = [...path];

		// Traverse the nested schema object following the path segments
		while (_path.length) {
			const curr = _path.shift();
			if (curr && curr in temp) temp = temp[curr] as Record<string, unknown>;
		}

		// For each target field at this path, merge in the provided data properties
		for (const key of keys)
			if (key in temp)
				for (const [dataKey, dataValue] of Object.entries(data))
					(temp[key] as Record<string, unknown>)[dataKey] = dataValue;
	}

	return _uiSchema;
}

/**
 * Deep-clones a RJSF schema and removes the specified field names from
 * the `required` arrays at given paths. Used to make secured fields optional
 * when their values are pre-filled or managed externally.
 *
 * @param schema - The RJSF schema to modify.
 * @param items - An array of `[path, keys]` tuples, where `keys` are the field
 *   names to remove from the `required` array at the given `path`.
 * @returns A new schema with the specified required constraints removed.
 */
export function removeRequired(schema: RJSFSchema = {}, items: [string[], string[]][]) {
	// Deep clone so we never mutate the caller's schema
	const _schema = JSON.parse(JSON.stringify(schema));

	for (const [path, keys] of items) {
		// Start traversal at schema.properties (the root of field definitions)
		let temp: Record<string, unknown> = _schema?.properties ?? {};

		// Clone the path array to avoid mutating the caller's data
		const _path = [...path];

		// Walk down to the target sub-schema following the path segments
		while (_path.length) {
			const curr = _path.shift();
			if (curr && curr in temp) temp = temp[curr] as Record<string, unknown>;
		}

		// Filter the required array to exclude the specified keys, making those fields optional
		const requiredArray = temp.required as string[] | undefined;
		if (requiredArray) {
			temp.required = requiredArray.filter((s: string) => !keys.includes(s));
		}
	}

	return _schema;
}
