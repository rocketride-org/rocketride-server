// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PARAM DEFAULT — a Default typed on the API Params page, as a config value
// =============================================================================
//
// The Default of a parameter is the target component's config value, the one
// its config panel on DESIGN edits. The page takes it as text; this module
// says what value that text is for the field, or what the field accepts.
// Pure: tested without React.

import type { ServiceParamDescriptor } from 'rocketride';

/**
 * A typed Default as the value the config stores, or why it cannot be one.
 *
 * @param text - What was typed (trimmed by the caller).
 * @param descriptor - The field's descriptor.
 * @returns `{ value }`, or `{ problem }` saying what the field accepts.
 */
export function parseDefault(text: string, descriptor: ServiceParamDescriptor): { value: unknown } | { problem: string } {
	// An enum takes one of its values, matched as text so `8` finds the number 8
	if (descriptor.enum?.length) {
		const match = descriptor.enum.find((option) => String(option) === text);
		return match === undefined ? { problem: `One of: ${descriptor.enum.map(String).join(', ')}` } : { value: match };
	}
	if (descriptor.type === 'boolean') {
		if (text === 'true' || text === 'false') return { value: text === 'true' };
		return { problem: 'true or false' };
	}
	if (descriptor.type === 'integer' || descriptor.type === 'number') {
		const value = Number(text);
		if (text === '' || !Number.isFinite(value)) return { problem: 'A number' };
		if (descriptor.type === 'integer' && !Number.isInteger(value)) return { problem: 'A whole number' };
		if (descriptor.minimum !== undefined && value < descriptor.minimum) return { problem: `At least ${descriptor.minimum}` };
		if (descriptor.maximum !== undefined && value > descriptor.maximum) return { problem: `At most ${descriptor.maximum}` };
		return { value };
	}
	if (descriptor.type === 'array' || descriptor.type === 'object') {
		try {
			return { value: JSON.parse(text) };
		} catch {
			return { problem: 'Valid JSON' };
		}
	}
	return { value: text };
}
