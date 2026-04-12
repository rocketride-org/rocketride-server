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

/**
 * Shared helper functions for the flow canvas.
 *
 * Contains lane manipulation, HTML sanitisation, and display utilities
 * used across multiple node sub-components.
 */

import { ReactNode } from 'react';
import DOMPurify from 'dompurify';
import parse, { DOMNode, Element as DOMElement, domToReact, HTMLReactParserOptions } from 'html-react-parser';
import { ILaneObject, IService, IServiceCapabilities, IServiceLane } from '../types';
import { getDefaultFormState } from './rjsf';
import { getIconPath } from './get-icon-path';

// =============================================================================
// Lane Utilities
// =============================================================================

/**
 * Sorts an array of output lanes alphabetically by their type string.
 *
 * Used to render lane handles in a deterministic order on each node.
 * Does not mutate the original array.
 *
 * @param lanes - The unsorted lane array.
 * @returns A new sorted array.
 */
export const sortOutputLanes = (lanes: IServiceLane): IServiceLane => {
	return [...lanes].sort((a, b) => {
		// Normalise: plain strings use themselves as the sort key; objects use .type
		const aValue = typeof a === 'string' ? a : a.type;
		const bValue = typeof b === 'string' ? b : b.type;
		if (aValue < bValue) return -1;
		if (aValue > bValue) return 1;
		return 0;
	});
};

/**
 * Extracts display values for a single output lane entry.
 *
 * Handles both plain string lanes and structured {@link ILaneObject}
 * entries, returning a uniform shape for the lane renderer.
 *
 * @param outputLane - A lane entry from the service definition.
 * @returns An object with type, required flag, source handle ID, and display label.
 */
export const getOutputLaneDisplayValues = (outputLane: string | ILaneObject) => {
	let type = '';
	let required = false;
	let sourceId = '';
	let label = '';

	if (typeof outputLane === 'string') {
		// Simple string lane: derive display label from the lane name
		type = outputLane;
		sourceId = `source-${type}`;
		label = renameLanes(type);
	} else {
		// Structured lane object: extract type and check min connection requirement
		type = outputLane.type;
		required = outputLane.min ? outputLane.min >= 1 : false;
		sourceId = `source-${type}`;
		label = renameLanes(type);
	}

	return { type, required, sourceId, label };
};

/**
 * Maps internal lane identifiers to user-friendly localised labels.
 *
 * @param originalLaneName - The raw lane type string from the service definition.
 * @returns The display label for the lane.
 */
export const renameLanes = (originalLaneName = ''): string => {
	switch (originalLaneName) {
		case 'tags':
			return 'Data';
		default:
			return originalLaneName;
	}
};

/**
 * Maps internal invoke type keys to user-friendly display labels.
 * Add new entries here as new invoke types are introduced.
 */
const INVOKE_TYPE_LABELS: Record<string, string> = {
	llm: 'LLM',
	crewai: 'CrewAI',
};

/**
 * @param invokeType - The raw invoke type key from the service definition (e.g. "llm", "crewai").
 * @returns The display label for the invoke type.
 */
export const renameInvokeType = (invokeType = ''): string => INVOKE_TYPE_LABELS[invokeType] ?? invokeType.charAt(0).toUpperCase() + invokeType.slice(1);

// =============================================================================
// HTML Sanitisation
// =============================================================================

/**
 * Sanitises an HTML string and parses it into a React node tree.
 *
 * If the input string contains no HTML tags, it is returned as-is.
 * When HTML is detected, it is sanitised with DOMPurify to prevent XSS
 * and then parsed into React elements. All `<a>` tags are rewritten to
 * open in a new tab with safe `rel` attributes.
 *
 * @param text - The raw string that may contain HTML markup.
 * @returns A plain string or a ReactNode tree.
 */
// =============================================================================
// Form / Inventory Utilities
// =============================================================================

/**
 * Resolves the default form data for a service by generating RJSF defaults
 * from its JSON Schema. Used when creating a new node on the canvas to
 * populate form fields with their initial/default values.
 *
 * @param id - The service identifier (currently unused but reserved for future overrides).
 * @param schema - The JSON Schema to generate defaults from.
 * @returns The default form data object with all required fields populated.
 */
export const resolveDefaultFormData = (_id: string, schema: Record<string, unknown>) => {
	return getDefaultFormState(schema);
};

/**
 * Builds the node inventory from the service catalog. Groups services
 * by their `classType` (e.g., source, llm, database) into categorized buckets,
 * resolves icon paths, applies capability filters (excluding NoSaas services),
 * and marks focused services. The resulting inventory powers the "Add Node" panel
 * on the project canvas.
 *
 * @param forms - The service catalog dictionary.
 * @returns A categorized inventory object keyed by class type, each containing
 *          a dictionary of services with resolved icons and focus flags.
 */
export const buildInventory = (forms: Record<string, IService> = {}) => {
	const _inventory: Record<string, Record<string, IService>> = {
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

	for (const [key, value] of Object.entries(forms)) {
		// Skip entries that aren't valid pipeline services (must have a Pipe definition and classType)
		if (!value.Pipe || !value.classType?.length) continue;

		// Use bitwise AND to check the NoSaas capability flag; these services
		// are excluded from the SaaS UI and should not appear in the node panel.
		const isNoSaas = value.capabilities && (IServiceCapabilities.NoSaas & value.capabilities) === IServiceCapabilities.NoSaas;

		if (isNoSaas) continue;

		// Check whether this service has the Focus capability (highlighted/promoted in the UI)
		const isFocus = value.capabilities && (IServiceCapabilities.Focus & value.capabilities) === IServiceCapabilities.Focus;

		// A service can belong to multiple class types (e.g., both "llm" and "embedding"),
		// so normalize to an array and register under each category.
		const classTypes = Array.isArray(value.classType) ? value.classType : [value.classType];

		for (const classType of classTypes) {
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

// =============================================================================
// HTML Sanitisation
// =============================================================================

export const sanitizeAndParseHtmlToReact = (text?: string): string | ReactNode => {
	if (!text) return text;

	let result: string | ReactNode = text;

	// Only run the expensive sanitize+parse path when the string actually contains HTML tags
	if (/<\/?[a-z][\s\S]*>/i.test(result as string)) {
		// Sanitize HTML to prevent XSS while preserving target/rel for external links
		const sanitized = DOMPurify.sanitize(result as string, {
			ADD_ATTR: ['target', 'rel'],
		});

		// Replace <a> tags so they always open in a new tab with safe rel attributes
		const options: HTMLReactParserOptions = {
			replace: (domNode: DOMNode) => {
				const el = domNode as DOMElement;
				if (el.name === 'a' && el.attribs?.href) {
					const { href, ...rest } = el.attribs;
					return (
						<a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
							{el.children ? parse(domToReact(el.children as DOMNode[]) as string) : null}
						</a>
					);
				}
			},
		};

		result = parse(sanitized, options);
	}

	return result;
};
