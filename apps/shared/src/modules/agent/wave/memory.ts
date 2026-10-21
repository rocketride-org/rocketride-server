// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// RUN MEMORY — stored tool results, paths into them, and memory.peek
// =============================================================================

/**
 * Every tool result of a run is stored under a key, and the model sees only
 * a summary of it (see summary.ts). memory.peek is how the model reads the
 * rest: a path into a JSON result, or a chunk of the stored text. This is a
 * port of Wave's peek (`nodes/src/nodes/agent_rocketride/executor.py`) and
 * its descriptor (`planner.py`). The one change: Wave evaluates JMESPath,
 * and this evaluates the subset of it a peek needs (fields, `[n]`, `[a:b]`,
 * `[*]`), with JMESPath's semantics, so there is no library to load.
 */

import { pyRepr } from './summary';

// =============================================================================
// MEMORY — the run's stored results
// =============================================================================

/** Most array items a path peek returns; the rest are counted, so the model can index past them. */
const PEEK_MAX_ARRAY_ITEMS = 50;

/** Characters a chunk peek returns by default: most single-record API responses in one read. */
const PEEK_DEFAULT_LENGTH = 8000;

/**
 * The memory key of a tool result: wave `wave` (counting from 0), call `index`.
 *
 * @param wave - The wave's number, from 0.
 * @param index - The call's position in the wave, from 0.
 * @returns The key, e.g. `wave-0.r2`.
 */
export function resultKey(wave: number, index: number): string {
	return `wave-${wave}.r${index}`;
}

/** The tool results of one run, by key. Values are the tool output text, as returned. */
export class RunMemory {
	/** The stored results, in the order they were put. */
	private readonly values = new Map<string, string>();

	/**
	 * Stores a result, replacing any under the same key.
	 *
	 * @param key - The result's key (see resultKey).
	 * @param value - The tool output text.
	 */
	put(key: string, value: string): void {
		this.values.set(key, value);
	}

	/**
	 * Reads a result.
	 *
	 * @param key - The result's key.
	 * @returns The stored text, or undefined when nothing is stored under the key.
	 */
	get(key: string): string | undefined {
		return this.values.get(key);
	}

	/**
	 * Whether a result is stored under a key.
	 *
	 * @param key - The result's key.
	 */
	has(key: string): boolean {
		return this.values.has(key);
	}

	/**
	 * Drops results. Keys that hold nothing are ignored.
	 *
	 * @param keys - The keys to drop.
	 */
	clear(keys: string[]): void {
		for (const key of keys) this.values.delete(key);
	}

	/** The stored keys, in the order they were first put. */
	keys(): string[] {
		return [...this.values.keys()];
	}
}

// =============================================================================
// PATHS — the JMESPath subset a peek accepts
// =============================================================================

/** Thrown for a path outside the supported subset; the message says what the subset is. */
class PathError extends Error {
	/** Builds the error with the one message every unsupported path gets. */
	constructor() {
		super('Paths support field names, [n], [a:b] and [*] only.');
		this.name = 'PathError';
	}
}

/** One step of a path. A slice or `[*]` projects the rest of the path over the items it selects. */
type Step = { kind: 'field'; name: string } | { kind: 'index'; at: number } | { kind: 'slice'; start?: number; end?: number } | { kind: 'all' };

/** A field name: an identifier, or a JSON string for a key that is not one (as the summary writes it). */
const FIELD = /[A-Za-z_][A-Za-z0-9_]*|"(?:[^"\\]|\\.)*"/y;

/** A bracket: `[*]`, `[n]` or `[a:b]`, either bound optional, negatives allowed. */
const BRACKET = /\[\s*(?:(\*)|(-?\d+)|(-?\d+)?\s*:\s*(-?\d+)?)\s*\]/y;

/** Whether a value is a JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Matches a sticky pattern at `pos`, or returns null. */
function matchAt(pattern: RegExp, text: string, pos: number): RegExpExecArray | null {
	pattern.lastIndex = pos;
	return pattern.exec(text);
}

/** Reads a field name token into a step. */
function fieldStep(token: string): Step {
	if (!token.startsWith('"')) return { kind: 'field', name: token };
	try {
		return { kind: 'field', name: JSON.parse(token) as string };
	} catch {
		throw new PathError();
	}
}

/** Reads a bracket match into a step. */
function bracketStep(match: RegExpExecArray): Step {
	const [, star, index, start, end] = match;
	if (star) return { kind: 'all' };
	if (index !== undefined) return { kind: 'index', at: Number(index) };
	return { kind: 'slice', start: start === undefined ? undefined : Number(start), end: end === undefined ? undefined : Number(end) };
}

/** Splits a path into steps: a field or a bracket first, then `.field` or a bracket. */
function parsePath(path: string): Step[] {
	const text = path.trim();
	const steps: Step[] = [];
	let pos = 0;
	while (pos < text.length) {
		const dotted = steps.length > 0 && text[pos] === '.';
		const at = dotted ? pos + 1 : pos;
		const bracket = dotted ? null : matchAt(BRACKET, text, at);
		const field = bracket || (steps.length > 0 && !dotted) ? null : matchAt(FIELD, text, at);
		if (bracket) steps.push(bracketStep(bracket));
		else if (field) steps.push(fieldStep(field[0]));
		else throw new PathError();
		pos = at + (bracket ?? field)![0].length;
	}
	if (!steps.length) throw new PathError();
	return steps;
}

/** Applies steps from `from` on, as JMESPath does: a miss is null, and a projection drops the items that come out null. */
function applySteps(value: unknown, steps: Step[], from: number): unknown {
	let current = value;
	for (let i = from; i < steps.length; i++) {
		if (current === null) return null;
		const step = steps[i];
		if (step.kind === 'field') {
			current = isObject(current) && Object.prototype.hasOwnProperty.call(current, step.name) ? current[step.name] : null;
			continue;
		}
		if (!Array.isArray(current)) return null;
		if (step.kind === 'index') {
			const at = step.at < 0 ? current.length + step.at : step.at;
			current = at >= 0 && at < current.length ? current[at] : null;
			continue;
		}
		const items = step.kind === 'all' ? current : current.slice(step.start, step.end);
		const projected: unknown[] = [];
		for (const item of items) {
			const out = applySteps(item, steps, i + 1);
			if (out !== null) projected.push(out);
		}
		return projected;
	}
	return current;
}

/**
 * Evaluates a path into a JSON value: field names (an identifier, or a JSON
 * string for any other key), `[n]` (negative counts from the end), `[a:b]`
 * (either bound optional) and `[*]`. A slice or `[*]` projects the rest of
 * the path over each item. Follows JMESPath: a field of a non-object, an
 * index out of range or a bracket on a non-array is null, and a projection
 * drops the items whose result is null.
 *
 * @param value - The parsed JSON to read.
 * @param path - The path, e.g. `rows[0:5].city`.
 * @returns What the path selects; null when it selects nothing.
 * @throws PathError for any other syntax (filters, functions, pipes, `.*`, steps).
 */
function evalPath(value: unknown, path: string): unknown {
	return applySteps(value, parsePath(path), 0);
}

// =============================================================================
// PEEK — reading a stored result
// =============================================================================

/** Reads JSON text, or reports that it is not JSON. */
function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/** A whole-number argument, or its default when absent; anything else throws, saying what to send. */
function wholeNumber(args: Record<string, unknown>, name: string, fallback: number): number {
	const value = args[name];
	if (value === undefined || value === null) return fallback;
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	if (!Number.isFinite(n)) throw new Error(`${name} must be a whole number of characters, got ${JSON.stringify(value)}.`);
	return Math.trunc(n);
}

/**
 * Runs a memory.peek call. With a path, it parses the stored text as JSON and
 * returns what the path selects, an array capped at 50 items. Without one, it
 * returns a chunk of the stored text, as stored, from `offset` (default 0)
 * for `length` characters (default 8000).
 *
 * @param memory - The run's stored results.
 * @param args - The call's arguments: `key`, and `path` or `offset`/`length`.
 * @returns JSON text of Wave's peek result, without its tool and key: `{path, preview}`,
 *   `{path, preview, truncated, returned_items, total_items}` when an array was capped,
 *   or `{preview, offset, length, total_chars}` in chunk mode.
 * @throws Error when the key holds nothing, a path is given for text that is not JSON,
 *   or offset/length is not a number; PathError for an unsupported path.
 */
export function peek(memory: RunMemory, args: Record<string, unknown>): string {
	const key = args.key ?? '';
	const named = typeof key === 'string' ? pyRepr(key) : JSON.stringify(key);
	const stored = typeof key === 'string' ? memory.get(key) : undefined;
	if (stored === undefined) throw new Error(`key ${named} not found`);

	if (args.path) {
		const path = String(args.path);
		const parsed = tryParse(stored);
		if (!parsed.ok) throw new Error(`key ${named} holds text, not JSON. Peek it without a path to read it in chunks.`);
		const value = evalPath(parsed.value, path);
		// Cap large arrays so one peek cannot flood the prompt; the counts tell the
		// model to index past the cap or reference the key in its answer instead.
		if (Array.isArray(value) && value.length > PEEK_MAX_ARRAY_ITEMS) {
			return JSON.stringify({
				path,
				preview: JSON.stringify(value.slice(0, PEEK_MAX_ARRAY_ITEMS)),
				truncated: true,
				returned_items: PEEK_MAX_ARRAY_ITEMS,
				total_items: value.length,
			});
		}
		return JSON.stringify({ path, preview: typeof value === 'string' ? value : JSON.stringify(value) });
	}

	const offset = wholeNumber(args, 'offset', 0);
	const length = wholeNumber(args, 'length', PEEK_DEFAULT_LENGTH);
	const chunk = stored.slice(offset, offset + length);
	return JSON.stringify({ preview: chunk, offset, length: chunk.length, total_chars: stored.length });
}

// =============================================================================
// DESCRIPTOR — what the model reads about memory.peek
// =============================================================================

/**
 * memory.peek as the model sees it, listed after the other tools. It runs in
 * the loop, not through a toolkit, so it is a descriptor rather than an
 * AgentTool. Wave's text, with "a JMESPath expression" now "a path".
 */
export const MEMORY_PEEK_TOOL: { name: 'memory.peek'; description: string; parameters: Record<string, unknown> } = {
	name: 'memory.peek',
	description: 'Extract data from a stored result using a path (field names, [n], [a:b], [*]), or page through a large value in text chunks. Use the structural summary in Previous tool results to identify the path you need.',
	parameters: {
		type: 'object',
		required: ['key'],
		properties: {
			key: { type: 'string', description: 'Memory key to read from' },
			path: {
				type: 'string',
				description: `Path (field names, [n], [a:b], [*]) to extract a specific field or slice (e.g. "results[0].name", "rows[0:5].city", "postcodes[2]"). Arrays are capped at ${PEEK_MAX_ARRAY_ITEMS} items — use indexed paths for specific elements.`,
			},
			offset: { type: 'integer', description: 'Character offset for chunk reading (default 0). Only when path is omitted.' },
			length: { type: 'integer', description: `Characters to return for chunk reading (default ${PEEK_DEFAULT_LENGTH}). Only when path is omitted.` },
		},
	},
};

// =============================================================================
// MEMORY REFERENCES — {{memory.ref:key:format:path}} in tool arguments and answers
// =============================================================================

/**
 * The model never carries a large result in its reply. It writes a tag naming
 * the stored result instead: `{{memory.ref:key}}`, `{{memory.ref:key:format}}`
 * or `{{memory.ref:key:format:path}}`. The loop resolves tags in a call's
 * arguments before the call runs, and in the final answer before it is
 * delivered. This is a port of Wave's resolution
 * (`nodes/src/nodes/agent_rocketride/executor.py`). The path applies first, so a
 * format sees only the part the path selects. Stored results are text, so
 * JSON text is parsed before a path or a table format reads it, and a tag
 * always becomes text. (Wave hands a tool the stored object itself when an
 * argument is a bare tag; here the stored value already is text.)
 */

// =============================================================================
// TAGS — what a tag looks like
// =============================================================================

/**
 * A memory tag. Key and format cannot contain `:` or `}`; the path can contain
 * `:` (a slice such as `rows[0:5]`), as it is always the last part. Global, so
 * use it with String methods (match, replace), never with test() or exec().
 */
const REF_PATTERN = /\{\{memory\.ref:([^}:]+)(?::([^}:]+))?(?::([^}]+))?\}\}/g;

/** A string that is exactly one tag. */
const WHOLE_TAG = new RegExp(`^${REF_PATTERN.source}$`);

/** Thrown for a tool argument that is one whole tag naming a key nothing is stored under; the message says the call did not run. */
class MissingRefError extends Error {
	/** Builds the error with the message the loop reports to the model. */
	constructor(message: string) {
		super(message);
		this.name = 'MissingRefError';
	}
}

// =============================================================================
// READING A TAG — the stored data, narrowed by the path
// =============================================================================

/** What a tag with this path selects from the stored text; the whole text when it is not JSON or the path is not supported. */
function narrow(stored: string, path: string): unknown {
	try {
		return evalPath(JSON.parse(stored), path);
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof PathError) return stored;
		throw error;
	}
}

/** Text for data written into the middle of other text: a string as it is, anything else as JSON. */
function embedded(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The text a tag stands for: the stored text, narrowed by the path, then rendered in the format. */
function render(stored: string, format: string | undefined, path: string | undefined): string {
	const data = path ? narrow(stored, path) : stored;
	return format ? formatValue(data, format) : embedded(data);
}

/** Replaces each tag in a string with its text; a tag whose key is not stored reads as `[missing data: key]`. */
function substitute(text: string, memory: RunMemory): string {
	return text.replace(REF_PATTERN, (_tag, key: string, format: string | undefined, path: string | undefined) => {
		const stored = memory.get(key);
		return stored === undefined ? `[missing data: ${key}]` : render(stored, format, path);
	});
}

// =============================================================================
// TOOL ARGUMENTS — tags resolved before a call runs
// =============================================================================

/** Resolves the tags in one value, walking into objects and lists. */
function resolveValue(value: unknown, memory: RunMemory): unknown {
	if (typeof value === 'string') {
		// A call must not run on data that is not there: the model mistyped the key, or the call that stored it failed.
		const whole = WHOLE_TAG.exec(value);
		if (whole && !memory.has(whole[1])) throw new MissingRefError(`{{memory.ref:${whole[1]}}} names no stored key, so the call did not run`);
		return substitute(value, memory);
	}
	if (Array.isArray(value)) return value.map((item) => resolveValue(item, memory));
	if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, memory)]));
	return value;
}

/**
 * Resolves the memory tags in a tool call's arguments, at any depth. A tag
 * becomes the stored text, narrowed by its path and rendered in its format;
 * a path that cannot be read leaves the whole stored text. Only a string
 * argument that is exactly one tag must name a stored key; a tag inside
 * longer text reads `[missing data: key]` instead, so the text still goes
 * through.
 *
 * @param args - The call's arguments, as the model wrote them.
 * @param memory - The run's stored results.
 * @returns The arguments with their tags resolved; the input is not changed.
 * @throws MissingRefError when an argument that is one whole tag names a key nothing is stored under.
 */
export function resolveArgRefs(args: Record<string, unknown>, memory: RunMemory): Record<string, unknown> {
	return resolveValue(args, memory) as Record<string, unknown>;
}

// =============================================================================
// ANSWERS — tags resolved before the answer is delivered
// =============================================================================

/**
 * Resolves the memory tags in the final answer. Each tag becomes the stored
 * text, narrowed by its path and rendered in its format; a tag whose key is
 * not stored reads `[missing data: key]`, so the user sees what is absent.
 *
 * @param answer - The answer, as the model wrote it.
 * @param memory - The run's stored results.
 * @returns The answer text with no tags left.
 */
export function resolveAnswerRefs(answer: string, memory: RunMemory): string {
	return substitute(answer, memory);
}

// =============================================================================
// ANSWER FORMATS — markdown_table, html_table, csv, json and text
// =============================================================================

/**
 * The model can write `{{memory.ref:key:format}}` in its answer, and the
 * stored data is rendered in that format without passing through the model.
 * This is a port of Wave's formatters (`nodes/src/nodes/agent_rocketride/formatters.py`)
 * and keeps their output shapes. Two changes, both because the engine's last
 * resort, asking the model to render the data, is not ported: an unknown
 * format name renders as `json`, and so does data that is not a table when a
 * table format is asked for. The prompt only offers the five formats.
 */

// =============================================================================
// VALUES — Python's text for a JSON value, which is how Wave writes a cell
// =============================================================================

/** A JSON value as Python's repr() writes it: `None`, `True`, `'text'`, `[1, 'a']`, `{'k': 1}`. */
function pyValue(value: unknown): string {
	if (value === null) return 'None';
	if (typeof value === 'boolean') return value ? 'True' : 'False';
	if (typeof value === 'string') return pyRepr(value);
	if (Array.isArray(value)) return `[${value.map(pyValue).join(', ')}]`;
	if (isObject(value))
		return `{${Object.entries(value)
			.map(([k, v]) => `${pyRepr(k)}: ${pyValue(v)}`)
			.join(', ')}}`;
	return String(value);
}

/** A cell's text as Python's str() writes it: a string as it is, anything else as pyValue. */
function cellText(value: unknown): string {
	return typeof value === 'string' ? value : pyValue(value);
}

/** The cell of `row` under `header`; a row that lacks the column shows an empty cell. */
function cell(row: Record<string, unknown>, header: string): unknown {
	return Object.prototype.hasOwnProperty.call(row, header) ? row[header] : '';
}

/** Python's html.escape(text, quote=True). */
function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/** Pretty-printed JSON, two-space indent. */
function prettyJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

// =============================================================================
// ROWS — reading stored data as a table
// =============================================================================

/**
 * Reads data as table rows, accepting the shapes tool results come in: JSON
 * text (parsed first); `{rows: [...]}`; an object with exactly one non-empty
 * list of records under any key; a single record (a one-row table); or a list
 * of records. A list whose items are not all records is not a table, where
 * Wave would fail on the first item that is not.
 *
 * @param data - The data to read, parsed or as JSON text.
 * @returns The rows, or null when the data is not a table.
 */
function toRows(data: unknown): Array<Record<string, unknown>> | null {
	let current = data;
	if (typeof current === 'string') {
		try {
			current = JSON.parse(current);
		} catch {
			return null;
		}
	}
	if (isObject(current)) {
		if (Array.isArray(current.rows)) current = current.rows;
		else {
			const lists = Object.values(current).filter((v) => Array.isArray(v) && v.length > 0 && isObject(v[0]));
			current = lists.length === 1 ? lists[0] : [current];
		}
	}
	if (Array.isArray(current) && current.length > 0 && current.every(isObject)) return current as Array<Record<string, unknown>>;
	return null;
}

// =============================================================================
// FORMATTERS — each returns null when the data does not fit its format
// =============================================================================

/** A markdown table: header line, `---` separator line, one line per row. */
function markdownTable(data: unknown): string | null {
	const rows = toRows(data);
	if (!rows) return null;
	const headers = Object.keys(rows[0]);
	const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
	for (const row of rows) lines.push(`| ${headers.map((h) => cellText(cell(row, h))).join(' | ')} |`);
	return lines.join('\n');
}

/** An HTML table with thead and tbody, cell text escaped. */
function htmlTable(data: unknown): string | null {
	const rows = toRows(data);
	if (!rows) return null;
	const headers = Object.keys(rows[0]);
	const parts = ['<table>', '<thead><tr>', ...headers.map((h) => `<th>${escapeHtml(h)}</th>`), '</tr></thead>', '<tbody>'];
	for (const row of rows) parts.push('<tr>', ...headers.map((h) => `<td>${escapeHtml(cellText(cell(row, h)))}</td>`), '</tr>');
	parts.push('</tbody></table>');
	return parts.join('');
}

/** One CSV field as Python's csv module (excel dialect, minimal quoting) writes it. */
function csvField(value: unknown): string {
	const text = value === null ? '' : cellText(value);
	return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A CSV line; Python writes a line that is one empty field as `""`, so it is not blank. */
function csvLine(values: unknown[]): string {
	return values.length === 1 && values[0] === '' ? '""' : values.map(csvField).join(',');
}

/** CSV with a header row, `\r\n` between lines and none at the end. */
function csv(data: unknown): string | null {
	const rows = toRows(data);
	if (!rows) return null;
	const headers = Object.keys(rows[0]);
	return [csvLine(headers), ...rows.map((row) => csvLine(headers.map((h) => cell(row, h))))].join('\r\n');
}

/** Pretty JSON. JSON text is parsed and re-indented; text that is not JSON is returned as it is. */
function json(data: unknown): string {
	if (typeof data !== 'string') return prettyJson(data);
	try {
		return prettyJson(JSON.parse(data));
	} catch {
		return data;
	}
}

/** `key: value` lines, a blank line between rows; data that is not a table as it would print in json, text as it is. */
function text(data: unknown): string {
	const rows = toRows(data);
	if (rows)
		return rows
			.map((row) =>
				Object.entries(row)
					.map(([k, v]) => `${k}: ${cellText(v)}`)
					.join('\n')
			)
			.join('\n\n');
	return typeof data === 'string' ? data : prettyJson(data);
}

// =============================================================================
// FORMAT — one entry point
// =============================================================================

/**
 * Renders data in one of the five formats a memory tag can name:
 * `markdown_table`, `html_table`, `csv`, `json` and `text`. Anything else,
 * and data a table format cannot lay out, renders as `json`.
 *
 * @param value - The data: parsed JSON, or text (JSON text is parsed).
 * @param format - The format name from the tag.
 * @returns The rendered text.
 */
function formatValue(value: unknown, format: string): string {
	switch (format) {
		case 'markdown_table':
			return markdownTable(value) ?? json(value);
		case 'html_table':
			return htmlTable(value) ?? json(value);
		case 'csv':
			return csv(value) ?? json(value);
		case 'text':
			return text(value);
		default:
			return json(value);
	}
}
