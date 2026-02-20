// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

import {
	IDynamicForm,
	IDynamicForms,
	DynamicFormsCapabilities,
} from './types';
import { getDefaultFormState } from '../../utils/rjsf';
import { getIconPath } from '../../utils/get-icon-path';

/**
 * Resolves the default form data for a service by generating RJSF defaults
 * from its JSON Schema. Used when creating a new node on the canvas to
 * populate form fields with their initial/default values.
 *
 * @param id - The service identifier (currently unused but reserved for future overrides).
 * @param schema - The JSON Schema to generate defaults from.
 * @returns The default form data object with all required fields populated.
 */
export const resolveDefaultFormData = (id: string, schema: Record<string, unknown>) => {
	// Delegate to RJSF's default-state generator, which recursively walks the schema
	// and fills in "default" values for every property. The `id` parameter is reserved
	// for future per-service overrides but currently unused.
	return getDefaultFormState(schema);
};

/**
 * Builds the node inventory from raw dynamic form definitions. Groups services
 * by their `classType` (e.g., source, llm, database) into categorized buckets,
 * resolves icon paths, applies capability filters (excluding NoSaas services),
 * and marks focused services. The resulting inventory powers the "Add Node" panel
 * on the project canvas.
 *
 * @param forms - The raw dynamic forms dictionary from the services API.
 * @returns A categorized inventory object keyed by class type, each containing
 *          a dictionary of services with resolved icons and focus flags.
 */
export const buildInventory = (forms: IDynamicForms = {}) => {
	// Initialize empty buckets for every known class type category.
	// Services that don't match a known category will go into "other".
	const _inventory: { [key: string]: IDynamicForms } = {
		source: {},
		embedding: {},
		llm: {},
		database: {},
		filter: {},
		image: {},
		preprocessor: {},
		store: {},
		other: {},
	};

	for (const [key, value] of Object.entries(forms) as [string, IDynamicForm][]) {
		// Skip entries that aren't valid pipeline services (must have a Pipe definition and classType)
		if (!value.Pipe || !value.classType?.length) continue;

		// Use bitwise AND to check the NoSaas capability flag; these services
		// are excluded from the SaaS UI and should not appear in the node panel.
		const isNoSaas =
			value.capabilities &&
			(DynamicFormsCapabilities.NoSaas & value.capabilities) ===
				DynamicFormsCapabilities.NoSaas;

		if (isNoSaas) continue;

		// Check whether this service has the Focus capability (highlighted/promoted in the UI)
		const isFocus =
			value.capabilities &&
			(DynamicFormsCapabilities.Focus & value.capabilities) ===
				DynamicFormsCapabilities.Focus;

		// A service can belong to multiple class types (e.g., both "llm" and "embedding"),
		// so normalize to an array and register under each category.
		const classTypes = Array.isArray(value.classType) ? value.classType : [value.classType];

		for (const classType of classTypes) {
			// Get the existing bucket for this category, or start a new one if it's a custom type
			const services = classType in _inventory ? _inventory[classType] : {};

			// Resolve the icon path from the CDN/asset URL pattern
			const icon = getIconPath(value?.icon || '');
			const _value = {
				...value,
				focus: isFocus,
				icon,
			};

			services[key] = _value;

			_inventory[classType] = services;
		}
	}

	return _inventory;
};
