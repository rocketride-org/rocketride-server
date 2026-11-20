/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Convert an old-format node definition to the current format
 * (`rocketride node convert`).
 *
 * Breaking change B6: the engine loads `propertyDefinitions`/`properties`
 * only. A custom node written against the old format (`preconfig`, `fields`,
 * `shape`) is converted once, offline, by this module.
 *
 * This is a port of the Python CLI's `rocketride/cli/node_convert.py`: the
 * SAME rules, function for function, documented there. Both suites check the
 * cases in `packages/client-python/tests/fixtures/node_convert`, so the two
 * converters produce the same definition, the same `legacy` block (derived
 * exactly as `tools/legacy_blocks.py` derives it) and the same warnings.
 */

// =============================================================================
// TYPES & CONSTANTS
// =============================================================================

/** A parsed JSON object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a node definition is arbitrary JSON, read member by member as the old format allowed
export type Json = Record<string, any>;

/** What `convertDefinition` returns. */
export interface NodeConversion {
	/** The converted definition. */
	definition: Json;
	/** What the conversion could not carry over, one sentence each. */
	warnings: string[];
	/** Whether a `legacy` block was written. */
	legacy: boolean;
}

/** Profile keys that describe the profile, not the node's config. */
const PROFILE_METADATA = new Set(['title', 'deprecated', 'deprecatedBy', 'migration']);

/** Field members the conversion consumes or drops (never copied as-is). */
const CONSUMED_MEMBERS = new Set(['optional', 'secure', 'const', 'enum', 'enumNames', 'conditional', 'field', 'ui', 'items', 'object', 'section']);

/** Top-level members the current engine refuses or that the conversion replaces. */
const REPLACED_MEMBERS = new Set(['preconfig', 'fields', 'shape', 'config']);

/** Sections tried, in order, for the node's own properties. */
const SECTION_ORDER = ['Pipe', 'Source'];

/** The enum entry prefix that expands a member of the file itself. */
const ENUM_EXPANSION = '*>';

/** The name every converted profile selector is stored under. */
const PROFILE_SELECTOR = 'profile';

// =============================================================================
// VALUE HELPERS (the Python built-ins the rules lean on)
// =============================================================================

/** Whether `value` is a JSON object (Python `dict`). */
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Own-member test (Python `key in dict`). */
const has = (obj: Json, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** Own-member lookup (Python `dict.get`): never a prototype member such as `constructor`. */
const get = (obj: Json, key: string): Json[string] => (has(obj, key) ? obj[key] : undefined);

/**
 * Own-member write (Python `dict[key] = value`): a key such as `__proto__`
 * becomes a member that serializes, never the prototype setter.
 */
const put = (obj: Json, key: string, value: unknown): void => {
	Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
};

/** Python truthiness for JSON values. */
const truthy = (value: unknown): boolean => {
	if (Array.isArray(value)) return value.length > 0;
	if (isObject(value)) return Object.keys(value).length > 0;
	return Boolean(value);
};

/** Deep JSON equality (Python `==` on parsed JSON). */
function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
	if (isObject(a) && isObject(b)) {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every((key) => has(b, key) && equal(a[key], b[key]));
	}
	return false;
}

/** Deep JSON membership (Python `value in list`). */
const contains = (list: unknown[], value: unknown): boolean => list.some((item) => equal(item, value));

/** A deep copy of a JSON value (Python `copy.deepcopy`). */
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** `str.partition(sep)`. */
function partition(text: string, sep: string): [string, string, string] {
	const index = text.indexOf(sep);
	return index < 0 ? [text, '', ''] : [text.slice(0, index), sep, text.slice(index + sep.length)];
}

/** The property name a reference resolves to: its last dotted component. */
const short = (ref: string): string => ref.split('.').slice(-1)[0];

/** A value in a warning: compact JSON, identical to the Python CLI's `_show`. */
const show = (value: unknown): string => (value === undefined ? 'null' : JSON.stringify(value));

// =============================================================================
// JSON WITH COMMENTS (tools/legacy_blocks.py)
// =============================================================================

/** Remove `//` comments outside strings, line by line. */
function stripComments(text: string): string {
	return text
		.split(/\r\n|\r|\n/)
		.map((line) => {
			let quotes = 0;
			let i = 0;
			while (i < line.length) {
				const ch = line[i];
				if (ch === '\\' && quotes % 2 === 1) {
					i += 2;
					continue;
				}
				if (ch === '"') quotes += 1;
				else if (ch === '/' && line.slice(i, i + 2) === '//' && quotes % 2 === 0) return line.slice(0, i);
				i += 1;
			}
			return line;
		})
		.join('\n');
}

/** Remove a `,` that directly precedes `}` or `]` (whitespace between), outside strings. */
function stripTrailingCommas(text: string): string {
	let out = '';
	let quotes = 0;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '\\' && quotes % 2 === 1) {
			out += text.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === '"') quotes += 1;
		else if (ch === ',' && quotes % 2 === 0) {
			let j = i + 1;
			while (j < text.length && ' \t\r\n'.includes(text[j])) j += 1;
			if (j < text.length && '}]'.includes(text[j])) {
				i += 1;
				continue;
			}
		}
		out += ch;
		i += 1;
	}
	return out;
}

/**
 * Parse a services.json, tolerating the `//` comments and trailing commas the
 * files may carry.
 *
 * @param text - The file text.
 * @returns The parsed definition.
 */
export function loadJson(text: string): Json {
	let doc: Json;
	try {
		doc = JSON.parse(text);
	} catch {
		doc = JSON.parse(stripTrailingCommas(stripComments(text)));
	}
	refuseUnsafeIntegers(stripComments(text));
	return doc;
}

/**
 * Refuse an integer literal a JavaScript number cannot hold exactly: parsing
 * rounds it, and the converted file would carry another value. The Python
 * CLI keeps such integers, so the message points there.
 *
 * @param text - The file text, comments removed.
 * @throws Error naming the first such literal.
 */
function refuseUnsafeIntegers(text: string): void {
	let inString = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (inString) {
			if (ch === '\\') i += 1;
			else if (ch === '"') inString = false;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			i += 1;
			continue;
		}
		const match = /^-?\d+(?![\d.eE])/.exec(text.slice(i, i + 400));
		if (match && (i === 0 || !/[\w.]/.test(text[i - 1]))) {
			if (!Number.isSafeInteger(Number(match[0]))) {
				throw new Error(`the integer ${match[0]} is larger than this converter can keep exactly; convert this file with the Python CLI (pip install rocketride)`);
			}
			i += match[0].length;
			continue;
		}
		i += 1;
	}
}

// =============================================================================
// THE LEGACY BLOCK (tools/legacy_blocks.py, without its in-repo HAND table)
// =============================================================================

/** `chunker.chunk_size` -> `chunk_size`; `opensearch.auth.enabled` -> `auth.enabled`. */
function stripPrefix(key: string): string {
	const [head, , rest] = partition(key, '.');
	return rest || head;
}

/** Return [old keys, selector key, default profile, profiles verbatim]. */
function oldSchema(doc: Json): [Set<string>, string | null, unknown, Json] {
	const keys = new Set<string>();
	const pre: Json = doc.preconfig || {};
	const profiles: Json = pre.profiles || {};
	const fields: Json = doc.fields || {};
	// Members of an array item are not node keys
	const arrayNames = Object.keys(fields).filter((n) => isObject(fields[n]) && fields[n].type === 'array');
	const itemFields = new Set(Object.keys(fields).filter((n) => arrayNames.some((a) => n.startsWith(a + '.'))));

	const storedName = (name: string): string => {
		const [head, , rest] = partition(name, '.');
		return rest && !has(fields, head) ? rest : name;
	};

	for (const [name, item] of Object.entries(fields)) {
		if (!isObject(item) || has(item, 'object') || itemFields.has(name)) continue;
		// The profile selector itself: the stored key was always `profile`
		const enumValue = item.enum;
		if (Array.isArray(enumValue) && enumValue.some((e) => typeof e === 'string' && e.startsWith('*>preconfig'))) continue;
		if (short(storedName(name)) === 'profile' && truthy(profiles)) continue;
		keys.add(storedName(name));
	}
	for (const profile of Object.values(profiles)) {
		if (isObject(profile)) for (const key of Object.keys(profile)) if (key !== 'title') keys.add(key);
	}
	const selector = truthy(profiles) ? 'profile' : null;
	return [keys, selector, pre.default, profiles];
}

/** Return [leaf short names, selector names] the new definition declares. */
function newSchema(doc: Json, shared: Json): [Set<string>, Set<string>] {
	const leaves = new Set<string>();
	const selectors = new Set<string>();
	const defs: Json = { ...shared, ...(doc.propertyDefinitions || {}) };

	const addDef = (key: string): void => {
		const value = get(defs, key);
		if (isObject(value) && isObject(value.enum)) {
			selectors.add(short(stripPrefix(key)));
			for (const branch of Object.values(value.enum)) if (isObject(branch)) walk(branch.properties);
		} else {
			leaves.add(short(key));
			if (isObject(value)) {
				if (Array.isArray(value.properties)) walk(value.properties);
				for (const item of [value.item, value.items]) {
					if (typeof item === 'string') addDef(item);
					else if (isObject(item)) walk([item]);
				}
			}
		}
	};

	const walk = (props: unknown): void => {
		for (const prop of Array.isArray(props) ? props : []) {
			if (typeof prop === 'string') {
				addDef(prop);
				continue;
			}
			if (!isObject(prop)) continue;
			if (has(prop, 'base') && !has(prop, 'name')) {
				addDef(prop.base);
				continue;
			}
			const name = prop.name || (has(prop, 'base') ? short(prop.base) : null);
			if (isObject(prop.enum)) {
				if (name) selectors.add(name);
				for (const branch of Object.values(prop.enum)) if (isObject(branch)) walk(branch.properties);
			} else if (name) {
				leaves.add(name);
			}
			if (Array.isArray(prop.properties)) walk(prop.properties);
			for (const item of [prop.item, prop.items]) {
				if (typeof item === 'string') addDef(item);
				else if (isObject(item)) walk([item]);
			}
		}
	};

	walk(doc.properties);
	return [leaves, selectors];
}

/**
 * Derive one node's `legacy` block from its old and new definitions.
 *
 * @param old - The old definition.
 * @param next - The converted definition.
 * @param shared - Shared `propertyDefinitions`, when available.
 * @returns The block.
 */
export function buildBlock(old: Json, next: Json, shared: Json): Json {
	const [oldKeys, selector, defaultProfile, profiles] = oldSchema(old);
	const [leaves, selectors] = newSchema(next, shared);
	const renamed: Json = {};

	// LLM family: the custom profile's `model` became the root leaf `customModel`
	const custom = profiles.custom;
	if (isObject(custom) && has(custom, 'model') && leaves.has('customModel')) renamed['custom.model'] = 'customModel';

	const mapped = new Set([...Object.keys(renamed), ...Object.keys(renamed).map(short)]);
	const dropped = [...oldKeys].filter((key) => !mapped.has(key) && !leaves.has(short(key)) && !selectors.has(short(key)) && !leaves.has(key)).sort();

	const block: Json = {};
	if (selector) block.selector = selector;
	if (defaultProfile !== undefined && defaultProfile !== null) block.default = defaultProfile;
	block.profiles = profiles;
	block.dropped = dropped;
	if (truthy(renamed)) block.renamed = renamed;
	return block;
}

/** Whether a definition gets the block: it had old config, and an old pipe could carry a key the new schema rejects. */
function wantsBlock(old: Json, block: Json): boolean {
	if (!truthy(old.preconfig) && !truthy(old.fields)) return false;
	return ['profiles', 'dropped', 'renamed', 'credential', 'profileMap'].some((key) => truthy(block[key]));
}

// =============================================================================
// FIELD CONVERSION
// =============================================================================

/** The member of `doc` at the dotted `path` (undefined when absent). */
function lookup(doc: Json, path: string): unknown {
	let node: unknown = doc;
	for (const part of path.split('.')) {
		if (!isObject(node) || !has(node, part)) return undefined;
		node = node[part];
	}
	return node;
}

/** Whether `item`'s enum lists the file's profiles (it is the profile selector). */
function isProfileEnum(item: Json): boolean {
	const marker = ENUM_EXPANSION + 'preconfig.profiles';
	return Array.isArray(item.enum) && item.enum.some((e: unknown) => typeof e === 'string' && e.startsWith(marker));
}

/** A conditional's value and the properties it shows. */
type Conditional = [unknown, unknown[]];

/** One definition's conversion; collects the converted local definitions and the warnings. */
class Converter {
	private readonly fields: Json;
	private readonly profiles: Json;
	private readonly defaultProfile: unknown;
	readonly definitions: Json = {};
	readonly warnings: string[] = [];
	private readonly sharedRefs: string[] = [];
	private readonly reached = new Set<string>();
	/** Each generated profile constant, and each profile selector -> the old selector field's short name. */
	private readonly generated = new Set<object>();
	private readonly profileSelectors = new Map<object, string>();

	constructor(
		private readonly doc: Json,
		private readonly shared: Json
	) {
		this.fields = doc.fields || {};
		const pre: Json = doc.preconfig || {};
		this.profiles = pre.profiles || {};
		this.defaultProfile = pre.default;
	}

	// -------------------------------------------------------------------------
	// One field definition
	// -------------------------------------------------------------------------

	private warn(text: string): void {
		if (!this.warnings.includes(text)) this.warnings.push(text);
	}

	/**
	 * Whether `item` is the profile selector: its enum lists the profiles, or
	 * it is the field the old engine read the profile from (named `profile`,
	 * with an enum or a conditional) in a file that has profiles.
	 */
	private selectsProfile(ref: string, item: Json): boolean {
		if (isProfileEnum(item)) return true;
		return truthy(this.profiles) && short(ref) === PROFILE_SELECTOR && (has(item, 'conditional') || has(item, 'enum'));
	}

	private enumList(item: Json): unknown[] {
		const names: unknown[] | null = Array.isArray(item.enumNames) ? item.enumNames : null;
		const out: unknown[] = [];
		(Array.isArray(item.enum) ? item.enum : []).forEach((entry: unknown, index: number) => {
			if (Array.isArray(entry)) out.push([...entry]);
			else if (typeof entry === 'string' && entry.startsWith(ENUM_EXPANSION)) {
				const [path, marker, key] = partition(entry.slice(ENUM_EXPANSION.length), '.*.');
				const members = lookup(this.doc, path);
				if (isObject(members)) {
					for (const [value, body] of Object.entries(members)) {
						const label = marker && isObject(body) ? body[key] : undefined;
						out.push([value, typeof label === 'string' ? label : value]);
					}
				}
			} else if (names !== null && index < names.length) out.push([entry, names[index]]);
			else out.push(entry);
		});
		return out;
	}

	private uiHints(name: string, item: Json, out: Json): void {
		const hints: Json = {};
		if (isObject(item.ui)) Object.assign(hints, item.ui);
		for (const [key, value] of Object.entries(item)) if (key.startsWith('ui:')) hints[key] = value;
		const widget = hints['ui:widget'];
		if (widget === 'hidden') out.hidden = true;
		else if (widget === 'textarea') out.format = 'textarea';
		else if (widget === 'password' || widget === 'ApiKeyWidget') out.secret = true;
		else if (widget === 'GoogleButtonWidget' || widget === 'MicrosoftButtonWidget') {
			out.type = 'oauth2';
			this.warn(`${name}: the ${widget} became an "oauth2" property; add its "options" (scopes) by hand`);
		} else if (widget !== undefined && widget !== null) {
			this.warn(`${name}: the ui widget ${show(widget)} has no counterpart and was dropped`);
		}
		// An upload's accepted file types move to its "options"
		const options: Json = isObject(hints['ui:options']) ? hints['ui:options'] : {};
		const accept = has(hints, 'ui:options:accept') ? hints['ui:options:accept'] : options.accept;
		if (out.type === 'upload' && typeof accept === 'string') out.options = { accept };
	}

	private convertField(name: string, item: Json): Json {
		const out: Json = {};
		let upload = false;
		for (const [key, value] of Object.entries(item)) {
			if (CONSUMED_MEMBERS.has(key) || key.startsWith('ui:')) continue;
			if (key === 'type' && Array.isArray(value)) {
				const kinds = value.filter((v) => v !== 'null');
				out.type = kinds.length ? kinds[0] : 'string';
				this.warn(`${name}: the type list ${show(value)} became ${show(out.type)}`);
				continue;
			}
			if (key === 'format' && value === 'password') {
				out.secret = true;
				continue;
			}
			if (key === 'format' && value === 'data-url') {
				upload = true;
				continue;
			}
			put(out, key, clone(value));
		}
		// After the copy, so a `type` listed after `format` cannot undo it
		if (upload) out.type = 'upload';
		if (item.secure === true) out.secret = true;
		if (has(item, 'enum')) out.enum = this.enumList(item);
		if (has(item, 'const')) {
			out.type = 'constant';
			out.default = clone(item.const);
		}
		if (isObject(item.items) || typeof item.items === 'string') {
			out.item = this.convertItem(name, item.items);
			// The engine refuses a secret inside an array item (its encrypt
			// walk has no "[]" step): the array itself carries the flag
			if (this.hasSecret(out.item)) {
				out.item = this.unsecret(out.item);
				out.secret = true;
				this.warn(`${name}: "secret" moved from the array item's members to the array`);
			}
			const unknown = this.unresolved(out.item);
			if (unknown.length) {
				this.warn(`${name}: the array item references ${unknown.join(', ')}, which this offline conversion cannot read; the engine refuses a secret inside an array item, so check none of them is secret before loading the node`);
			}
		}
		this.uiHints(name, item, out);
		return out;
	}

	/** The shared references in an array item whose definition (and so whose `secret` flag) is unknown here. */
	private unresolved(spec: unknown): string[] {
		if (typeof spec === 'string') return has(this.definitions, spec) || has(this.shared, spec) ? [] : [spec];
		if (!isObject(spec)) return [];
		if (Array.isArray(spec.properties)) {
			const found: string[] = [];
			for (const member of spec.properties) for (const ref of this.unresolved(member)) if (!found.includes(ref)) found.push(ref);
			return found;
		}
		if (!has(spec, 'secret') && typeof spec.base === 'string') return this.unresolved(spec.base);
		return [];
	}

	private isSecret(spec: unknown): boolean {
		if (typeof spec === 'string') {
			const definition = get(this.definitions, spec) || get(this.shared, spec);
			return isObject(definition) && definition.secret === true;
		}
		if (isObject(spec)) {
			if (has(spec, 'secret')) return spec.secret === true;
			return typeof spec.base === 'string' && this.isSecret(spec.base);
		}
		return false;
	}

	private hasSecret(spec: unknown): boolean {
		if (isObject(spec) && Array.isArray(spec.properties)) return spec.properties.some((member: unknown) => this.hasSecret(member));
		return this.isSecret(spec);
	}

	private unsecret(spec: unknown): unknown {
		if (isObject(spec) && Array.isArray(spec.properties)) return { ...spec, properties: spec.properties.map((member: unknown) => this.unsecret(member)) };
		if (!this.isSecret(spec)) return spec;
		if (typeof spec === 'string') return { base: spec, secret: false };
		return { ...(spec as Json), secret: false };
	}

	private convertItem(name: string, items: unknown): unknown {
		if (typeof items === 'string') {
			const specs = this.reference(items, {});
			return specs.length ? specs[0] : items;
		}
		const item = items as Json;
		if (item.type === 'object' && Array.isArray(item.properties)) return { name: 'entry', properties: this.properties(item.properties, {}) };
		return { name: 'entry', ...this.convertField(name, item) };
	}

	// -------------------------------------------------------------------------
	// Property lists
	// -------------------------------------------------------------------------

	properties(refs: unknown[], values: Json, unwrap: string | null = null): unknown[] {
		const out: unknown[] = [];
		for (const ref of refs || []) {
			if (typeof ref === 'string') {
				const item = get(this.fields, ref);
				if (unwrap !== null && isObject(item) && item.object === unwrap && Array.isArray(item.properties)) {
					this.reached.add(ref);
					out.push(...this.properties(item.properties, values));
					continue;
				}
				out.push(...this.reference(ref, values));
			} else if (isObject(ref)) {
				out.push(...this.inline(ref, values));
			}
		}
		this.pruneConstants(out);
		return out;
	}

	/**
	 * Drop a profile constant that names a property declared beside the
	 * profile selector (Python `prune_constants`: branch and leaf names share
	 * one namespace per level, so a hoisted constant would collide).
	 */
	private pruneConstants(level: unknown[]): void {
		const siblings = new Set<string>();
		for (const spec of level) {
			if (isObject(spec) && isObject(spec.enum)) continue;
			if (typeof spec === 'string') for (const name of this.names([spec])) siblings.add(name);
			else siblings.add(this.levelName(spec));
		}
		for (const spec of level) {
			if (!isObject(spec) || !this.profileSelectors.has(spec)) continue;
			const own = this.profileSelectors.get(spec) as string;
			const reserved = new Set([...siblings, PROFILE_SELECTOR, own]);
			for (const [value, branch] of Object.entries(spec.enum as Json)) {
				const kept: unknown[] = [];
				for (const prop of (branch as Json).properties || []) {
					if (isObject(prop) && this.generated.has(prop) && reserved.has(prop.name)) {
						if (prop.name !== PROFILE_SELECTOR && prop.name !== own) {
							// Names only: the values may be secret
							if (!equal(this.siblingDefault(level, prop.name), prop.default)) {
								this.warn(`profile ${show(value)} sets ${prop.name}, which is declared outside the profile with a different default; the profile's value is not carried`);
							}
						}
						continue;
					}
					kept.push(prop);
				}
				(branch as Json).properties = kept;
			}
		}
	}

	private levelName(spec: unknown): string {
		if (typeof spec === 'string') return short(spec);
		const obj = spec as Json;
		return short(obj.name || (typeof obj.base === 'string' ? obj.base : ''));
	}

	private siblingDefault(level: unknown[], name: string): unknown {
		for (const spec of level) {
			if (this.levelName(spec) !== name) continue;
			if (isObject(spec) && has(spec, 'default')) return spec.default;
			const ref = typeof spec === 'string' ? spec : (spec as Json).base;
			const definition = typeof ref === 'string' ? get(this.definitions, ref) || get(this.shared, ref) : undefined;
			return isObject(definition) ? (definition.default ?? null) : null;
		}
		return null;
	}

	private reference(ref: string, values: Json): unknown[] {
		const item = get(this.fields, ref);
		if (!isObject(item)) {
			// A shared definition: kept by name
			if (!this.sharedRefs.includes(ref)) this.sharedRefs.push(ref);
			return [this.withDefault(ref, values, get(this.shared, ref))];
		}
		this.reached.add(ref);
		if (has(item, 'combo')) {
			this.warn(`${ref}: a "combo" (sub-provider) field has no counterpart and was dropped`);
			return [];
		}
		if (has(item, 'object') || has(item, 'section')) return [this.group(ref, item, values)];
		if (has(item, 'conditional') || this.selectsProfile(ref, item)) return this.selector(ref, item);
		if (!has(this.definitions, ref)) put(this.definitions, ref, this.convertField(ref, item));
		return [this.withDefault(ref, values, this.definitions[ref])];
	}

	private inline(item: Json, values: Json): unknown[] {
		const name = item.name || item.object || item.section || 'entry';
		if (has(item, 'object') || has(item, 'section')) return [this.group(name, item, values)];
		if (has(item, 'conditional') || this.selectsProfile(name, item)) return this.selector(name, item);
		const converted = this.convertField(name, item);
		if (!has(converted, 'name')) converted.name = name;
		// The profile in force sets its default, by the rules `withDefault` applies to a reference
		const key = short(String(converted.name));
		const value = get(values, key);
		if (has(values, key) && value !== '' && value !== null && value !== undefined && !equal(converted.default, value)) converted.default = clone(value);
		return [converted];
	}

	private withDefault(ref: string, values: Json, definition: unknown): unknown {
		const key = short(ref);
		if (!has(values, key)) return ref;
		const value = values[key];
		if (value === '' || value === null || value === undefined) return ref;
		if (isObject(definition) && equal(definition.default, value)) return ref;
		return { base: ref, default: clone(value) };
	}

	private group(ref: string, item: Json, values: Json): Json {
		const out: Json = { name: item.object || item.section || short(ref) };
		for (const key of ['title', 'description']) if (has(item, key)) out[key] = clone(item[key]);
		out.properties = this.properties(item.properties || [], values);
		return out;
	}

	// -------------------------------------------------------------------------
	// Selectors
	// -------------------------------------------------------------------------

	private conditionalsOf(item: Json): Conditional[] {
		const out: Conditional[] = [];
		for (const cond of Array.isArray(item.conditional) ? item.conditional : []) {
			if (isObject(cond)) out.push([cond.value, [...(cond.properties || [])]]);
		}
		return out;
	}

	private selector(ref: string, item: Json): unknown[] {
		const conditionals = this.conditionalsOf(item);
		if (this.selectsProfile(ref, item)) return [this.profileSelector(ref, item, conditionals)];

		const options = this.enumList(item);
		const values = options.map((o) => (Array.isArray(o) ? o[0] : o));
		for (const [value] of conditionals) {
			for (const each of Array.isArray(value) ? value : [value]) {
				if (!contains(values, each)) {
					values.push(each);
					options.push(each);
				}
			}
		}
		if (values.some((v) => typeof v !== 'string')) {
			// A branch key is a string: a boolean (or numeric) toggle is flattened
			this.warn(`${ref}: the conditional on a non-string value is flattened; its properties are always shown`);
			const plain: Json = { ...item };
			delete plain.conditional;
			const out = this.referencePlain(ref, plain);
			for (const [, props] of conditionals) {
				for (const spec of this.properties(props, {})) if (!contains(out, spec)) out.push(spec);
			}
			return out;
		}

		const labels = new Map<string, unknown>();
		for (const o of options) labels.set((Array.isArray(o) ? o[0] : o) as string, Array.isArray(o) && o.length > 1 ? o[1] : null);
		const head = this.selectorHead(ref, item);
		const branches: Json = {};
		for (const value of values as string[]) {
			const props: unknown[] = [];
			for (const [condValue, condProps] of conditionals) {
				if (equal(condValue, value) || (Array.isArray(condValue) && contains(condValue, value))) props.push(...condProps);
			}
			put(branches, value, { title: labels.get(value) || value, properties: this.properties(props, {}, value) });
		}
		head.enum = branches;
		return [head];
	}

	private referencePlain(ref: string, item: Json): unknown[] {
		if (has(this.fields, ref)) {
			put(this.definitions, ref, this.convertField(ref, item));
			return [ref];
		}
		const converted = this.convertField(ref, item);
		if (!has(converted, 'name')) converted.name = ref;
		return [converted];
	}

	private selectorHead(ref: string, item: Json): Json {
		const head: Json = { name: short(ref) };
		for (const key of ['title', 'description', 'type', 'default', 'hidden', 'readonly']) if (has(item, key)) head[key] = clone(item[key]);
		if (!has(head, 'type')) head.type = 'string';
		return head;
	}

	private profileSelector(ref: string, item: Json, conditionals: Conditional[]): Json {
		const head = this.selectorHead(ref, item);
		this.profileSelectors.set(head, head.name);
		if (head.name !== PROFILE_SELECTOR) {
			this.warn(`${ref}: the profile selector is stored as "${PROFILE_SELECTOR}", as the old engine stored it`);
			head.name = PROFILE_SELECTOR;
		}
		if (!has(head, 'default') && this.defaultProfile !== undefined && this.defaultProfile !== null) head.default = this.defaultProfile;
		const order: string[] = [];
		const labels = new Map<string, unknown>();
		for (const option of this.enumList(item)) {
			const value = Array.isArray(option) ? option[0] : option;
			if (typeof value === 'string' && !order.includes(value)) {
				order.push(value);
				labels.set(value, Array.isArray(option) && option.length > 1 ? option[1] : value);
			}
		}
		for (const [value] of conditionals) {
			for (const each of Array.isArray(value) ? value : [value]) {
				if (typeof each === 'string' && !order.includes(each)) {
					order.push(each);
					labels.set(each, this.profileTitle(each));
				}
			}
		}
		// A profile no option or conditional names is still a value the old engine accepted
		for (const each of Object.keys(this.profiles)) {
			if (!order.includes(each)) {
				order.push(each);
				labels.set(each, this.profileTitle(each));
			}
		}
		const branches: Json = {};
		for (const value of order) {
			const props: unknown[] = [];
			for (const [condValue, condProps] of conditionals) {
				if (equal(condValue, value) || (Array.isArray(condValue) && contains(condValue, value))) props.push(...condProps);
			}
			const profile: Json = isObject(get(this.profiles, value)) ? get(this.profiles, value) : {};
			const specs = this.properties(props, profile, value);
			specs.push(...this.constants(profile, specs));
			put(branches, value, { title: labels.get(value) || value, properties: specs });
		}
		head.enum = branches;
		return head;
	}

	/** A profile's own `title`, else its name (the label of a branch no option labels). */
	private profileTitle(name: string): string {
		const profile = get(this.profiles, name);
		const title = isObject(profile) ? profile.title : undefined;
		return typeof title === 'string' ? title : name;
	}

	constants(profile: Json, specs: unknown[]): unknown[] {
		const names = this.names(specs);
		const out: unknown[] = [];
		for (const [key, value] of Object.entries(profile)) {
			if (PROFILE_METADATA.has(key) || names.has(key)) continue;
			const constant = { name: key, type: 'constant', default: clone(value) };
			this.generated.add(constant);
			out.push(constant);
		}
		return out;
	}

	private names(specs: unknown[]): Set<string> {
		const found = new Set<string>();
		const add = (more: Set<string>): void => more.forEach((name) => found.add(name));
		for (const spec of specs) {
			if (typeof spec === 'string') {
				found.add(short(spec));
				const definition = get(this.definitions, spec);
				if (isObject(definition) && Array.isArray(definition.properties)) add(this.names(definition.properties));
			} else if (isObject(spec)) {
				const name = spec.name || (typeof spec.base === 'string' ? short(spec.base) : null);
				if (name) found.add(short(name));
				if (Array.isArray(spec.properties)) add(this.names(spec.properties));
				if (isObject(spec.enum)) for (const branch of Object.values(spec.enum)) if (isObject(branch)) add(this.names(branch.properties || []));
			}
		}
		return found;
	}

	// -------------------------------------------------------------------------
	// The definition
	// -------------------------------------------------------------------------

	private section(): Json | null {
		const sections: Json[] = (Array.isArray(this.doc.shape) ? this.doc.shape : []).filter(isObject);
		for (const wanted of SECTION_ORDER) {
			const found = sections.find((section) => section.section === wanted);
			if (found) return found;
		}
		return sections.length ? sections[0] : null;
	}

	run(): Json {
		const hasService = typeof this.doc.protocol === 'string';
		let properties: unknown[] = [];
		if (hasService) {
			const chosen = this.section();
			for (const other of Array.isArray(this.doc.shape) ? this.doc.shape : []) {
				if (isObject(other) && other !== chosen) this.warn(`the "${other.section ?? 'None'}" section has no counterpart and was dropped`);
			}
			let rootValues: Json = {};
			if (chosen !== null) {
				if (truthy(this.profiles) && !Object.entries(this.fields).some(([n, f]) => isObject(f) && this.selectsProfile(n, f))) {
					const profile = truthy(this.defaultProfile) ? get(this.profiles, this.defaultProfile as string) : undefined;
					rootValues = isObject(profile) ? profile : {};
				}
				properties = this.properties(chosen.properties || [], rootValues);
				if (truthy(rootValues)) properties.push(...this.constants(rootValues, properties));
			}
		} else {
			// A shared-definition library: every field converts as itself, a
			// conditional one as a selector definition (its name is its key)
			for (const [name, item] of Object.entries(this.fields)) {
				if (!isObject(item)) continue;
				this.reached.add(name);
				if (has(item, 'conditional')) {
					const specs = this.selector(name, item);
					if (specs.length === 1 && isObject(specs[0]) && isObject(specs[0].enum)) {
						const { name: _name, ...definition } = specs[0];
						put(this.definitions, name, definition);
						continue;
					}
				}
				put(this.definitions, name, this.convertField(name, item));
			}
		}

		if (has(this.doc, 'config')) this.warn('the "config" member is refused by the current engine and was dropped; mark fields "secret" or "readonly" instead');
		const unreached = Object.keys(this.fields).filter((n) => !this.reached.has(n));
		if (unreached.length && hasService) this.warn(`not reached from the node's section, so not carried over: ${unreached.join(', ')}`);
		if (this.sharedRefs.length) this.warn('kept as references to shared definitions (check each exists in the current catalog): ' + this.sharedRefs.join(', '));

		// `propertyDefinitions` takes the place of `fields` (else of `shape`),
		// `properties` the place of `shape`; every other member stays put
		const out: Json = {};
		const haveDefs = truthy(this.definitions);
		let placedDefs = false;
		let placedProps = false;
		for (const [key, value] of Object.entries(this.doc)) {
			if ((key === 'fields' || key === 'shape') && haveDefs && !placedDefs) {
				out.propertyDefinitions = this.definitions;
				placedDefs = true;
			}
			if (key === 'shape' && hasService) {
				out.properties = properties;
				placedProps = true;
			}
			if (REPLACED_MEMBERS.has(key) || key === 'legacy') continue;
			put(out, key, clone(value));
		}
		if (haveDefs && !placedDefs) out.propertyDefinitions = this.definitions;
		if (hasService && !placedProps) out.properties = properties;
		return out;
	}
}

// =============================================================================
// ENTRY POINTS
// =============================================================================

/**
 * Whether `doc` is an old-format definition (`preconfig`, `fields` or
 * `shape`, and no current members).
 *
 * @param doc - The parsed definition.
 * @returns True when it is old-format.
 */
export function isOldFormat(doc: Json): boolean {
	if (has(doc, 'propertyDefinitions') || has(doc, 'properties')) return false;
	return ['preconfig', 'fields', 'shape'].some((key) => has(doc, key));
}

/**
 * Convert one old-format node definition and attach its `legacy` block.
 *
 * @param old - The parsed old definition (`loadJson`).
 * @param shared - Shared `propertyDefinitions` (`core/services.common*.json`)
 *   when available; a reference to a definition it does not hold is kept by
 *   name.
 * @returns The converted definition, its warnings, and whether a `legacy`
 *   block was written.
 * @throws Error when `old` is not an old-format definition.
 */
export function convertDefinition(old: Json, shared: Json = {}): NodeConversion {
	if (!isObject(old) || !isOldFormat(old)) {
		throw new Error('not an old-format node definition (no "preconfig", "fields" or "shape", or it already declares "properties")');
	}
	// The containers the conversion walks: a wrong type is this file's error, never a crash mid-batch
	const containers: [string, (value: unknown) => boolean, string][] = [
		['fields', isObject, 'an object'],
		['preconfig', isObject, 'an object'],
		['shape', Array.isArray, 'a list'],
	];
	for (const [key, isKind, what] of containers) {
		if (old[key] !== undefined && old[key] !== null && !isKind(old[key])) throw new Error(`"${key}" must be ${what}`);
	}
	const profiles = isObject(old.preconfig) ? old.preconfig.profiles : undefined;
	if (profiles !== undefined && profiles !== null && !isObject(profiles)) throw new Error('"preconfig.profiles" must be an object');
	const converter = new Converter(old, shared);
	const definition = converter.run();
	const result: NodeConversion = { definition, warnings: converter.warnings, legacy: false };
	if (typeof old.protocol === 'string') {
		const block = buildBlock(old, definition, shared);
		if (wantsBlock(old, block)) {
			definition.legacy = block;
			result.legacy = true;
		}
	}
	return result;
}

/**
 * The converted definition as the file text: tab-indented JSON with a
 * trailing newline (Python `json.dumps(..., indent='\t')`).
 *
 * @param conversion - The conversion.
 * @returns The file text.
 */
export function conversionText(conversion: NodeConversion): string {
	return JSON.stringify(conversion.definition, null, '\t') + '\n';
}
