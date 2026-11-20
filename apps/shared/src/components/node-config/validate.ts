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

// =============================================================================
// NODE-CONFIG — descriptor validation (the browser half of rocketlib's resolver)
// =============================================================================
//
// `rocketlib.resolveConfig` is the one validator the server runs at validate,
// start and publish. The form runs the SAME rules inline so what the user sees
// is what the server will say: required / type / enum / min / max / minLength /
// maxLength / minItems / maxItems on every REACHABLE leaf, a stale selector
// value is an error, an unknown key is an error, and a key under a branch that
// is not selected is tolerated (kept, not validated).
// =============================================================================

import type { ServiceProperty } from 'rocketride';

import { EDITOR_OWNED_KEYS, ENGINE_OWNED_KEYS, IConfigTree, ILeafEntry, INodeSchema, UNCHECKED_TYPES, arrayItem, dottedNames, effectiveValue, enumValues, flattenLeaves, hasPlaceholder, isFlagged, isGroup, isReachable, isSelector, isStoredSecurely, splitPath } from './model';

// =============================================================================
// Types
// =============================================================================

/** One validation problem, anchored to a leaf path where there is one. */
export interface IConfigProblem {
	/** The leaf path (empty for a problem with no single leaf, e.g. an unknown key's parent). */
	path: string;
	/** The human-readable message, in the server's wording. */
	message: string;
	/** The stored key has no place in the schema at all — the shape a
	 *  pre-format-switch config (plan B20) shows up in, which the editor
	 *  hands to the server's converter (§5.6.8) rather than the author. */
	unknownKey?: true;
}

// =============================================================================
// Leaf validation
// =============================================================================

/**
 * Checks one value against a leaf descriptor — the exact rules of rocketlib's
 * `_validate_value`.
 *
 * Step 1: a required leaf needs a value. Step 2: a placeholder-bearing value
 * is typed only once expanded, so it passes here. Step 3: type, enum, bounds.
 *
 * @param descriptor - The leaf (or param) descriptor.
 * @param value - The effective value (stored ?? default).
 * @returns The problem message, or null when the value fits.
 */
export function validateLeafValue(descriptor: Record<string, unknown>, value: unknown): string | null {
	const kind = typeof descriptor.type === 'string' ? descriptor.type : '';

	if (value === undefined || value === null || value === '') {
		if (isFlagged(descriptor, 'required') && !UNCHECKED_TYPES.has(kind)) return 'is required';
		return null;
	}
	if (UNCHECKED_TYPES.has(kind) || hasPlaceholder(value)) return null;

	const mismatch = typeMismatch(kind, value);
	if (mismatch) return mismatch;

	const allowed = enumValues(descriptor);
	if (allowed !== null && !allowed.includes(value)) return `must be one of ${allowed.map(String).join(', ')}`;

	if (kind === 'number' || kind === 'integer') {
		const numeric = value as number;
		if (typeof descriptor.minimum === 'number' && numeric < descriptor.minimum) return `must be >= ${descriptor.minimum}`;
		if (typeof descriptor.maximum === 'number' && numeric > descriptor.maximum) return `must be <= ${descriptor.maximum}`;
	} else if (kind === 'string') {
		const text = value as string;
		if (typeof descriptor.minLength === 'number' && text.length < descriptor.minLength) return `must be at least ${descriptor.minLength} characters`;
		if (typeof descriptor.maxLength === 'number' && text.length > descriptor.maxLength) return `must be at most ${descriptor.maxLength} characters`;
	} else if (kind === 'array') {
		const list = value as unknown[];
		if (typeof descriptor.minItems === 'number' && list.length < descriptor.minItems) return `must have at least ${descriptor.minItems} items`;
		if (typeof descriptor.maxItems === 'number' && list.length > descriptor.maxItems) return `must have at most ${descriptor.maxItems} items`;
		const item = arrayItem(descriptor as ServiceProperty);
		if (item && typeof item.type === 'string' && item.type !== 'array' && item.type !== 'object') {
			for (let index = 0; index < list.length; index++) {
				const problem = validateLeafValue(item, list[index]);
				if (problem) return `item ${index + 1} ${problem}`;
			}
		}
	}
	return null;
}

/**
 * Type check in the server's terms.
 *
 * @param kind - The declared type.
 * @param value - The value.
 * @returns The mismatch message, or null.
 */
function typeMismatch(kind: string, value: unknown): string | null {
	const checks: Record<string, (candidate: unknown) => boolean> = {
		string: (candidate) => typeof candidate === 'string',
		boolean: (candidate) => typeof candidate === 'boolean',
		integer: (candidate) => typeof candidate === 'number' && Number.isInteger(candidate),
		number: (candidate) => typeof candidate === 'number' && Number.isFinite(candidate),
		array: (candidate) => Array.isArray(candidate),
		object: (candidate) => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate),
	};
	const check = checks[kind];
	if (!check || check(value)) return null;
	return `expects ${kind}`;
}

// =============================================================================
// Whole-config validation
// =============================================================================

/**
 * Validates a node's stored config against its resolved schema — the rules of
 * `rocketlib.resolveConfig`, minus the flatten (the form never needs the view).
 *
 * Step 1: every stored key must have a place in the schema (a leaf or a
 * group/branch prefix); root `name` and `secureParameters` are tolerated.
 * Step 2: a reachable selector must hold a declared branch.
 * Step 3: every reachable leaf validates against its descriptor. A secret
 * whose value is held encrypted by the engine satisfies its requirement.
 *
 * @param schema - The service's resolved schema.
 * @param config - The node's stored config.
 * @returns The problems, empty when the config is valid.
 */
export function validateConfig(schema: Partial<INodeSchema> | undefined, config: IConfigTree | undefined): IConfigProblem[] {
	const properties = schema?.properties;
	if (!Array.isArray(properties)) return [];
	const problems: IConfigProblem[] = [];

	const leaves = flattenLeaves(properties);
	const byPath = new Map<string, ILeafEntry>(leaves.map((entry) => [entry.path, entry]));
	const dotted = dottedNames(properties);
	const { prefixes, names } = collectPrefixes(properties, leaves, dotted);

	// Step 1: unknown keys
	walkStored(config ?? {}, '', byPath, prefixes, names, problems);

	// Step 2: stale selector values
	const stale = new Set<string>();
	for (const entry of leaves) {
		if (!isSelector(entry.property) || !isReachable(config, entry, byPath, dotted)) continue;
		const choice = effectiveValue(config, entry.property, dotted);
		const branches = enumValues(entry.property) ?? [];
		if (!branches.includes(choice)) {
			stale.add(entry.path);
			problems.push({ path: entry.path, message: `is set to ${JSON.stringify(choice)}, which is not one of its options ${branches.map(String).join(', ')}` });
		}
	}

	// Step 3: reachable leaves (a stale selector is already reported)
	for (const entry of leaves) {
		if (stale.has(entry.path) || !isReachable(config, entry, byPath, dotted)) continue;
		if (isFlagged(entry.property, 'secret') && isStoredSecurely(config, entry.path)) continue;
		const message = validateLeafValue(entry.property, effectiveValue(config, entry.property, dotted));
		if (message) problems.push({ path: entry.path, message });
	}

	return problems;
}

/**
 * Validates one leaf in context (used for the inline message under a field).
 *
 * @param schema - The service's resolved schema.
 * @param config - The node's stored config.
 * @param path - The leaf path.
 * @returns The problem message, or null.
 */
export function validateLeafAt(schema: Partial<INodeSchema> | undefined, config: IConfigTree | undefined, path: string): string | null {
	return validateConfig(schema, config).find((problem) => problem.path === path)?.message ?? null;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Every prefix that may hold a stored block (group names, branch names, every
 * ancestor of every leaf path) and every declared OWN name (so a dotted key
 * that IS a declared name, such as a branch "gpt-5.2", is one segment).
 */
function collectPrefixes(properties: ServiceProperty[], leaves: ILeafEntry[], dotted: ReadonlySet<string>): { prefixes: Set<string>; names: Set<string> } {
	const prefixes = new Set<string>();
	const names = new Set<string>();
	for (const { path, property } of leaves) {
		const parts = splitPath(path, dotted);
		for (let depth = 1; depth < parts.length; depth++) prefixes.add(parts.slice(0, depth).join('.'));
		names.add(typeof property.name === 'string' && property.name ? property.name : parts[parts.length - 1]);
	}
	const walk = (list: ServiceProperty[] | undefined, prefix: string): void => {
		for (const property of list ?? []) {
			if (!property || typeof property !== 'object') continue;
			if (isGroup(property)) {
				const name = typeof property.name === 'string' ? property.name : '';
				const groupPrefix = name ? `${prefix}${name}` : prefix.replace(/\.$/, '');
				if (name) {
					prefixes.add(groupPrefix);
					names.add(name);
				}
				walk(property.properties as ServiceProperty[], name ? `${groupPrefix}.` : prefix);
			} else if (isSelector(property) && typeof property.path === 'string') {
				const level = property.path.includes('.') ? property.path.slice(0, property.path.lastIndexOf('.') + 1) : '';
				for (const [value, branch] of Object.entries(property.enum as Record<string, { properties?: ServiceProperty[] }>)) {
					prefixes.add(`${level}${value}`);
					names.add(value);
					walk(branch?.properties, `${level}${value}.`);
				}
			}
		}
	};
	walk(properties, '');
	return { prefixes, names };
}

/** Reports stored keys the schema has no place for (rocketlib `_flatten_conn_config`). */
function walkStored(node: unknown, prefix: string, byPath: Map<string, ILeafEntry>, prefixes: Set<string>, names: Set<string>, problems: IConfigProblem[]): void {
	if (node === null || typeof node !== 'object' || Array.isArray(node)) {
		if (node !== null && node !== undefined) problems.push({ path: prefix.replace(/\.$/, ''), message: 'must be a group of settings' });
		return;
	}
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		const path = `${prefix}${key}`;
		// Several segments written as one flat dotted key would resolve like the
		// nested tree, but the engine's encrypt walk descends object by object
		// and would never find a secret beneath it - only the nested shape is
		// accepted (a dotted key that IS a declared name is one segment)
		if (key.includes('.') && !names.has(key)) {
			problems.push({ path, message: `config key "${path}" must be written nested, not as one dotted key` });
			continue;
		}
		if (byPath.has(path)) continue;
		if (prefixes.has(path)) {
			if (value !== null && value !== undefined) walkStored(value, `${path}.`, byPath, prefixes, names, problems);
			continue;
		}
		if (!prefix && (EDITOR_OWNED_KEYS.has(key) || ENGINE_OWNED_KEYS.has(key))) continue;
		problems.push({ path, message: `unknown config key "${path}"`, unknownKey: true });
	}
}
