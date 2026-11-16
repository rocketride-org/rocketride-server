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
// NODE-CONFIG — the form model: resolved properties + a config tree by path
// =============================================================================
//
// The engine resolves every service's `properties` into a tree whose leaves
// carry a dotted `path` (services.cpp, "Resolved schema"). A node's config in
// the .pipe is a tree addressed by exactly those paths, so the form needs
// three primitives and nothing else: display = get(path) ?? default, change =
// set(path, value), reset = delete(path). Defaults are NEVER written: an
// absent key means "use the node's default", and a node shipping a better
// default later flows through (plan §5.6.2 / §5.6.5).
//
// This module is pure (no React): the renderer, the validator, the canvas's
// red-gear check and the API Params page all read the same model.
// =============================================================================

import type { ServiceParamDescriptor, ServiceProperty } from 'rocketride';

// =============================================================================
// Types
// =============================================================================

/** A node's stored configuration: a tree addressed by leaf `path`. */
export type IConfigTree = Record<string, unknown>;

/** One `[value, label]` pair of a plain enum, or a bare value. */
export type IEnumListEntry = [unknown, string] | unknown;

/** One branch of a selector (an enum with property sets). */
export interface ISelectorBranch {
	/** Display label of the branch. */
	title?: string;
	/** The branch's resolved properties (each leaf carries its own `path`). */
	properties?: ServiceProperty[];
}

/** The resolved schema of one service as the form consumes it. */
export interface INodeSchema {
	/** The resolved property tree, every leaf with a `path`. */
	properties: ServiceProperty[];
	/** The `param`-flagged leaves, self-contained (plan §5.1). */
	params?: ServiceParamDescriptor[];
}

/** The reasons a leaf has no editable value of its own. */
export type LeafKind = 'constant' | 'oauth2' | 'upload' | 'array' | 'object' | 'selector' | 'enum' | 'boolean' | 'number' | 'integer' | 'string' | 'other';

// =============================================================================
// Constants
// =============================================================================

/** Root keys the editor owns that are not node configuration (rocketlib EDITOR_OWNED_KEYS). */
export const EDITOR_OWNED_KEYS: ReadonlySet<string> = new Set(['name']);

/** Root keys the engine writes (the encrypted-secret section; rocketlib ENGINE_OWNED_KEYS). */
export const ENGINE_OWNED_KEYS: ReadonlySet<string> = new Set(['secureParameters']);

/** Matches a `${ROCKETRIDE_*}` environment placeholder anywhere in a string. */
export const ENV_PLACEHOLDER = /\$\{(ROCKETRIDE_[A-Za-z0-9_]*)\}/;

/** Property types whose stored value is never validated (rocketlib UNCHECKED_TYPES). */
export const UNCHECKED_TYPES: ReadonlySet<string> = new Set(['constant', 'oauth2', 'upload', 'secret', 'env', 'null', 'auto', 'semantic']);

// =============================================================================
// Path primitives — the three operations the form is built on
// =============================================================================

/**
 * Splits a dotted path into its segments.
 *
 * @param path - A leaf path such as `service.customerId`.
 * @returns The segments, in order.
 */
export function splitPath(path: string, dotted?: ReadonlySet<string>): string[] {
	const parts = path.split('.').filter((segment) => segment.length > 0);
	if (!dotted || dotted.size === 0) return parts;
	// A declared name that itself holds a dot ("gpt-5.2") is ONE segment: at
	// each position take the longest run of parts that spells such a name
	const segments: string[] = [];
	for (let index = 0; index < parts.length; ) {
		let taken = 1;
		for (let end = parts.length; end > index + 1; end--) {
			if (dotted.has(parts.slice(index, end).join('.'))) {
				taken = end - index;
				break;
			}
		}
		segments.push(parts.slice(index, index + taken).join('.'));
		index += taken;
	}
	return segments;
}

/**
 * Collects every declared name in the schema that contains a dot (group,
 * branch or leaf names such as "gpt-5.2"), so paths can be segmented the way
 * the server walks the stored tree: one key per declared name.
 *
 * @param properties - The resolved property list.
 * @returns The dotted names; empty for the common schema.
 */
export function dottedNames(properties: ServiceProperty[] | undefined): ReadonlySet<string> {
	const names = new Set<string>();
	const walk = (list: ServiceProperty[] | undefined): void => {
		for (const property of list ?? []) {
			if (!property || typeof property !== 'object') continue;
			if (typeof property.name === 'string' && property.name.includes('.')) names.add(property.name);
			if (isGroup(property)) {
				walk(property.properties as ServiceProperty[]);
				continue;
			}
			for (const [value, branch] of selectorBranches(property)) {
				if (value.includes('.')) names.add(value);
				walk(branch?.properties);
			}
		}
	};
	walk(properties);
	return names;
}

/**
 * Reads the stored value at `path`.
 *
 * @param config - The config tree.
 * @param path - The leaf path.
 * @returns The stored value, or undefined when the key is absent (= default).
 */
export function getAtPath(config: IConfigTree | undefined, path: string, dotted?: ReadonlySet<string>): unknown {
	let current: unknown = config;
	for (const segment of splitPath(path, dotted)) {
		if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
		if (!Object.hasOwn(current as object, segment)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Writes ONE key, returning a new tree (the input is never mutated). The
 * intermediate groups are created as needed; sibling keys are preserved,
 * which is exactly what lets a switched-away branch's block survive.
 *
 * @param config - The config tree.
 * @param path - The leaf path.
 * @param value - The value to store.
 * @returns The new tree.
 */
export function setAtPath(config: IConfigTree | undefined, path: string, value: unknown, dotted?: ReadonlySet<string>): IConfigTree {
	const segments = splitPath(path, dotted);
	const root: IConfigTree = { ...(config ?? {}) };
	let parent: IConfigTree = root;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index];
		const existing = parent[segment];
		const child: IConfigTree = existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as IConfigTree) } : {};
		parent[segment] = child;
		parent = child;
	}
	parent[segments[segments.length - 1]] = value;
	return root;
}

/**
 * Removes ONE key, returning a new tree. Groups left empty by the removal are
 * dropped too, so a fully reset block leaves no `{}` behind in the file.
 *
 * @param config - The config tree.
 * @param path - The leaf path.
 * @returns The new tree.
 */
export function deleteAtPath(config: IConfigTree | undefined, path: string, dotted?: ReadonlySet<string>): IConfigTree {
	const segments = splitPath(path, dotted);
	if (!config || segments.length === 0 || getAtPath(config, path, dotted) === undefined) return { ...(config ?? {}) };

	const prune = (node: IConfigTree, depth: number): IConfigTree | undefined => {
		const segment = segments[depth];
		const copy: IConfigTree = { ...node };
		if (depth === segments.length - 1) {
			delete copy[segment];
		} else {
			const child = copy[segment];
			if (child === null || typeof child !== 'object' || Array.isArray(child)) return copy;
			const pruned = prune(child as IConfigTree, depth + 1);
			if (pruned === undefined || Object.keys(pruned).length === 0) delete copy[segment];
			else copy[segment] = pruned;
		}
		return copy;
	};

	return prune(config, 0) ?? {};
}

// =============================================================================
// Property classification
// =============================================================================

/**
 * A grouped subsection: `properties` and no `enum`. Groups carry no `path`;
 * their children carry the dotted path.
 *
 * @param property - The resolved property.
 * @returns Whether it is a group.
 */
export function isGroup(property: ServiceProperty): boolean {
	return Array.isArray(property.properties) && !isSelector(property);
}

/**
 * A selector: an enum whose value space is an object keyed by value, each
 * value carrying its own property set.
 *
 * @param property - The resolved property.
 * @returns Whether it is a selector.
 */
export function isSelector(property: ServiceProperty): boolean {
	const options = property.enum;
	return options !== null && typeof options === 'object' && !Array.isArray(options);
}

/**
 * The branches of a selector, in declaration order.
 *
 * @param property - A selector property.
 * @returns `[value, branch]` pairs.
 */
export function selectorBranches(property: ServiceProperty): Array<[string, ISelectorBranch]> {
	if (!isSelector(property)) return [];
	return Object.entries(property.enum as Record<string, ISelectorBranch>);
}

/**
 * The allowed values of a plain enum, each with its display label.
 *
 * @param property - A property with a list `enum`.
 * @returns `[value, label]` pairs.
 */
export function enumOptions(property: ServiceProperty | Record<string, unknown>): Array<[unknown, string]> {
	const options = property.enum;
	if (Array.isArray(options)) {
		return options.map((entry: IEnumListEntry) => (Array.isArray(entry) ? [entry[0], String(entry[1] ?? entry[0])] : [entry, String(entry)]));
	}
	if (options !== null && typeof options === 'object') {
		return Object.entries(options as Record<string, ISelectorBranch>).map(([value, branch]) => [value, branch?.title ?? value]);
	}
	return [];
}

/**
 * The allowed values of any enum form (list of pairs, bare list, or
 * selector object), or null when the property is not an enum.
 *
 * @param descriptor - The property or param descriptor.
 * @returns The allowed values.
 */
export function enumValues(descriptor: Record<string, unknown>): unknown[] | null {
	const options = descriptor.enum;
	if (Array.isArray(options)) return options.map((entry: IEnumListEntry) => (Array.isArray(entry) && entry.length ? entry[0] : entry));
	if (options !== null && typeof options === 'object') return Object.keys(options as object);
	return null;
}

/**
 * Classifies a resolved property for widget selection.
 *
 * @param property - The resolved property.
 * @returns The leaf kind.
 */
export function leafKind(property: ServiceProperty): LeafKind {
	if (isSelector(property)) return 'selector';
	const type = typeof property.type === 'string' ? property.type : '';
	if (Array.isArray(property.enum)) return 'enum';
	switch (type) {
		case 'constant':
		case 'oauth2':
		case 'upload':
		case 'array':
		case 'object':
		case 'boolean':
		case 'number':
		case 'integer':
		case 'string':
			return type;
		default:
			return 'other';
	}
}

/**
 * Whether a property is flagged (`secret`, `hidden`, `readonly`, `required`).
 *
 * @param property - The resolved property.
 * @param flag - The flag name.
 * @returns True when the flag is set to true.
 */
export function isFlagged(property: Record<string, unknown>, flag: string): boolean {
	return property[flag] === true;
}

/**
 * The item schema of an array property (`item`, or the older `items`).
 *
 * @param property - An array property.
 * @returns The item schema, or undefined.
 */
export function arrayItem(property: ServiceProperty): ServiceProperty | undefined {
	const item = property.item ?? property.items;
	return item !== null && typeof item === 'object' ? (item as ServiceProperty) : undefined;
}

// =============================================================================
// Schema walk
// =============================================================================

/** One leaf of the flattened schema, with the branch chain that reaches it. */
export interface ILeafEntry {
	/** The leaf's dotted path. */
	path: string;
	/** The resolved descriptor. */
	property: ServiceProperty;
	/** `[selectorPath, branchValue]` pairs that must hold for the leaf to be reachable. */
	under: Array<[string, string]>;
}

/**
 * The dotted prefix of a path's parent level ('' at the root).
 *
 * @param path - A leaf path.
 * @returns The prefix, with its trailing dot.
 */
export function parentPrefix(path: string): string {
	return path.includes('.') ? path.slice(0, path.lastIndexOf('.') + 1) : '';
}

/**
 * Flattens a resolved property tree into its leaves — every leaf anywhere,
 * including every branch of every selector — each with the chain of selector
 * choices that makes it reachable. The stored value of a selector is itself a
 * leaf. Array items are NOT leaves (an array is one leaf, plan P25).
 *
 * @param properties - The resolved properties.
 * @returns The leaves, in document order.
 */
export function flattenLeaves(properties: ServiceProperty[] | undefined): ILeafEntry[] {
	const leaves: ILeafEntry[] = [];
	const seen = new Set<string>();

	const walk = (list: ServiceProperty[] | undefined, under: Array<[string, string]>): void => {
		for (const property of list ?? []) {
			if (!property || typeof property !== 'object') continue;
			if (isGroup(property)) {
				walk(property.properties as ServiceProperty[], under);
				continue;
			}
			const path = typeof property.path === 'string' ? property.path : '';
			if (!path) continue;
			// A hoisted leaf is emitted inside every branch too, at the parent's
			// path: record it once, and let only the branches whose prefix its
			// path actually carries own it (rocketlib `branch_of`), so a hoisted
			// leaf is reachable for every value of the selector.
			if (!seen.has(path)) {
				seen.add(path);
				leaves.push({ path, property, under: under.filter(([selectorPath, branch]) => path.startsWith(`${parentPrefix(selectorPath)}${branch}.`)) });
			}
			if (isSelector(property)) {
				for (const [value, branch] of selectorBranches(property)) {
					walk(branch?.properties, [...under, [path, value]]);
				}
			}
		}
	};

	walk(properties, []);
	return leaves;
}

/**
 * The effective value of a leaf: the stored value, else its default. A
 * `constant` always resolves to its default (the resolver ignores a stored
 * value for it).
 *
 * @param config - The config tree.
 * @param leaf - The leaf descriptor (with `path`).
 * @returns The effective value.
 */
export function effectiveValue(config: IConfigTree | undefined, leaf: ServiceProperty, dotted?: ReadonlySet<string>): unknown {
	if (leaf.type === 'constant') return leaf.default;
	const stored = typeof leaf.path === 'string' ? getAtPath(config, leaf.path, dotted) : undefined;
	return stored === undefined || stored === null ? leaf.default : stored;
}

/**
 * Whether a leaf is reachable under the current selector values: every
 * selector on its chain must hold the branch that contains it.
 *
 * @param config - The config tree.
 * @param entry - The leaf entry.
 * @param byPath - Leaf lookup by path (for the selectors' own defaults).
 * @returns True when reachable.
 */
export function isReachable(config: IConfigTree | undefined, entry: ILeafEntry, byPath: Map<string, ILeafEntry>, dotted?: ReadonlySet<string>): boolean {
	for (const [selectorPath, branch] of entry.under) {
		const selector = byPath.get(selectorPath);
		if (!selector) return false;
		if (effectiveValue(config, selector.property, dotted) !== branch) return false;
	}
	return true;
}

/**
 * Whether a service exposes a user-configurable form: at least one leaf that
 * is neither hidden nor a constant, anywhere in the tree.
 *
 * @param schema - The service's resolved schema (may be a summary without properties).
 * @returns True when the config panel has something to render.
 */
export function hasConfigurableSchema(schema: Partial<INodeSchema> | undefined): boolean {
	if (!schema || !Array.isArray(schema.properties)) return false;
	return flattenLeaves(schema.properties).some(({ property }) => property.type !== 'constant' && !isFlagged(property, 'hidden'));
}

/**
 * The root-level `constant` markers of a schema as `{path: default}`. The
 * server's implied-source rule (`pipeline.py`: the component whose
 * `config.mode == 'Source'`) and the editor's source lists read this marker
 * from the stored config, so a new node materializes exactly these — the one
 * exception to "defaults are never written" (plan §5.6.2), confined here.
 *
 * @param schema - The service's resolved schema.
 * @returns The constant markers.
 */
export function constantMarkers(schema: Partial<INodeSchema> | undefined): IConfigTree {
	const markers: IConfigTree = {};
	for (const property of schema?.properties ?? []) {
		if (property && property.type === 'constant' && typeof property.path === 'string' && !property.path.includes('.') && property.default !== undefined) {
			markers[property.path] = property.default;
		}
	}
	return markers;
}

/**
 * Looks up the `params` descriptor of a leaf, when the leaf is `param`-flagged.
 *
 * @param schema - The service's resolved schema.
 * @param path - The leaf path.
 * @returns The descriptor, or undefined.
 */
export function paramDescriptor(schema: Partial<INodeSchema> | undefined, path: string): ServiceParamDescriptor | undefined {
	return schema?.params?.find((descriptor) => descriptor.field === path);
}

/**
 * Whether a string value is (or contains) a `${ROCKETRIDE_*}` placeholder.
 *
 * @param value - Any value.
 * @returns True when a placeholder is present anywhere inside it.
 */
export function hasPlaceholder(value: unknown): boolean {
	if (typeof value === 'string') return ENV_PLACEHOLDER.test(value);
	if (Array.isArray(value)) return value.some(hasPlaceholder);
	if (value !== null && typeof value === 'object') return Object.values(value as object).some(hasPlaceholder);
	return false;
}

/**
 * Whether a secret leaf's value lives in the engine's encrypted section
 * (`secureParameters.secure` lists the paths it holds) rather than in plain
 * text in the config.
 *
 * @param config - The config tree.
 * @param path - The leaf path.
 * @returns True when the value is stored encrypted.
 */
export function isStoredSecurely(config: IConfigTree | undefined, path: string): boolean {
	const section = config?.secureParameters;
	if (section === null || typeof section !== 'object') return false;
	const names = (section as Record<string, unknown>).secure;
	return Array.isArray(names) && names.includes(path);
}

/**
 * Removes a value the engine holds in the encrypted section. The engine
 * restores a token value at its path whenever the path has no plaintext, so a
 * bare delete would bring the credential back on the next load: the path is
 * written EMPTY (the engine then keeps the empty value) and dropped from the
 * `secure` list; once no secured name remains the whole section goes, and
 * with it the need for the empty marker.
 *
 * @param config - The node's config.
 * @param path - The leaf path.
 * @param dotted - Declared dotted names (see {@link dottedNames}).
 * @returns The new config.
 */
export function clearSecure(config: IConfigTree | undefined, path: string, dotted?: ReadonlySet<string>): IConfigTree {
	if (!isStoredSecurely(config, path)) return deleteAtPath(config, path, dotted);
	const section = (config as IConfigTree).secureParameters as Record<string, unknown>;
	const secure = (section.secure as unknown[]).filter((name) => name !== path);
	const readonlyNames = Array.isArray(section.readonly) ? section.readonly : [];
	if (secure.length === 0 && readonlyNames.length === 0) {
		const { secureParameters: _dropped, ...rest } = config as IConfigTree;
		return deleteAtPath(rest, path, dotted);
	}
	return { ...setAtPath(config, path, '', dotted), secureParameters: { ...section, secure } };
}
