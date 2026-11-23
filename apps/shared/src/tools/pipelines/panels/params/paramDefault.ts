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
 * @param text - What was typed, as typed.
 * @param descriptor - The field's descriptor.
 * @returns `{ value }`, or `{ problem }` saying what the field accepts.
 */
export function parseDefault(text: string, descriptor: ServiceParamDescriptor): { value: unknown } | { problem: string } {
	// A string is taken as typed, its spaces included; every other type reads the text without them
	const trimmed = text.trim();
	/** The bounds, for a number however it was reached (typed, or one of the allowed values). */
	const bounded = (value: number): { value: unknown } | { problem: string } => {
		if (descriptor.minimum !== undefined && value < descriptor.minimum) return { problem: `At least ${descriptor.minimum}` };
		if (descriptor.maximum !== undefined && value > descriptor.maximum) return { problem: `At most ${descriptor.maximum}` };
		return { value };
	};
	// An enum takes one of its values, matched as text so `8` finds the number 8
	if (descriptor.enum?.length) {
		const match = descriptor.enum.find((option) => String(option) === text) ?? descriptor.enum.find((option) => String(option) === trimmed);
		if (match === undefined) return { problem: `One of: ${descriptor.enum.map(String).join(', ')}` };
		return typeof match === 'number' ? bounded(match) : { value: match };
	}
	if (descriptor.type === 'boolean') {
		if (trimmed === 'true' || trimmed === 'false') return { value: trimmed === 'true' };
		return { problem: 'true or false' };
	}
	if (descriptor.type === 'integer' || descriptor.type === 'number') {
		const value = Number(trimmed);
		if (trimmed === '' || !Number.isFinite(value)) return { problem: 'A number' };
		if (descriptor.type === 'integer' && !Number.isInteger(value)) return { problem: 'A whole number' };
		return bounded(value);
	}
	if (descriptor.type === 'array' || descriptor.type === 'object') {
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			return { problem: 'Valid JSON' };
		}
		// The JSON must be the container the field declares: 42 is no list, [] and null are no object
		if (descriptor.type === 'array') return Array.isArray(value) ? { value } : { problem: 'A JSON list, such as ["a", "b"]' };
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? { value } : { problem: 'A JSON object, such as {"key": "value"}' };
	}
	return { value: text };
}
