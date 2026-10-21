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
// RESULT SUMMARIES — what the model sees of a stored tool result
// =============================================================================

/**
 * Every planning wave resends every earlier result's summary, so a summary
 * shows the shape of a result (field names, lengths, sample values) in a
 * bounded number of characters, and the model peeks the key for the rest.
 * This is a port of Wave's `_describe` and its helpers
 * (`nodes/src/nodes/agent_rocketride/executor.py`); the constants and the
 * texts match it, since the prompt teaches the model to read them.
 *
 * A summary is built in two passes over each container. cost sizes its
 * fields exactly (keys, separators, notes, headers, row labels) without
 * rendering them; render then gives each field a room and renders it within
 * that room. Every container keeps to its room by leaving out whole fields or
 * whole rows, never by cutting a rendered string, so no parent cuts a child
 * again and a list's header counts the rows under it. Whatever a container
 * leaves out is recorded by path, and the short fields among them are listed
 * on the summary's last line. The one cut of a rendered string is describe's
 * backstop at the hard cap.
 *
 * previewArgs is Wave's other renderer: the short form of a call's arguments
 * shown beside its result (`_with_call` and `_render`'s `text_cap`), where
 * every text is capped and nothing is left out.
 */

// =============================================================================
// CONSTANTS — Wave's, unchanged
// =============================================================================

/** Indentation of nested structures. */
const INDENT = '  ';

/** Nesting depth past which a summary stops descending; past a few levels it stops informing the model. */
const SUMMARY_MAX_DEPTH = 6;

/**
 * Longest list of dicts shown whole: its rows split its room like a dict's
 * fields, so an MCP tool's one or two content blocks show their text. A longer
 * list is a sample of as many whole rows as fit, and a list inside a sampled
 * row shows this many rows at most.
 */
const SUMMARY_SHORT_LIST = 2;

/**
 * Character budget for a whole summary. A dict splits its room between the
 * fields that can spend it (long texts, lists, dicts), so a result with many
 * lists cannot cost more than a result with one.
 */
const SUMMARY_BUDGET = 4000;

/**
 * Longest string shown in full inside a sampled list row. A string this long or
 * shorter is a short field: paid for before the budget is split, and listed on
 * the summary's last line if a cut leaves it out.
 */
const ROW_TEXT_CHARS = 80;

/** Fewest characters of a cut text worth showing; below this the text shows its length instead. */
const TEXT_MIN_CHARS = 20;

/**
 * Ceiling on the finished summary. Keys, short fields, length notes and list
 * headers are paid for first and may take a summary past the budget, up to here.
 */
const SUMMARY_HARD_CAP = 6000;

/** Appended when the cap cuts a summary the rooms could not bound, so the model peeks instead of assuming it saw everything. */
const SUMMARY_TRUNCATED = '\n... (truncated, peek the key for the rest)';

/** Room kept under the hard cap for the line listing short fields no container had room for, so no cut hides a status. */
const SUMMARY_MISSING_CHARS = 400;

/** Field names that say whether a call worked: kept before other short fields, and listed first on that line. */
const STATUS_NAME = /^(exit_?code|return_?code|returncode|status(_?code)?|code|ok|success|succeeded|failed|failure|error|errors|is_?error|timed_?out|stderr)$/i;

/** Most left-out short fields remembered for that line, so a huge result costs a bounded walk. */
const SUMMARY_MISSING_FIELDS = 5000;

/** A key that stands bare in a path on that line; any other is quoted, so a key with a dot reads as one key. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Character budget the texts in one call's arguments share, wherever they sit:
 * enough for a path, a query, or the start and end of written content. Paid in
 * every later prompt, like the summaries.
 */
const ARGS_BUDGET = 600;

/**
 * The most an argument preview may take, labels included. A text never shows
 * less than ROW_TEXT_CHARS, so a call with many texts can run over the budget;
 * only a preview far over it is cut here.
 */
const ARGS_HARD_CAP = 2 * ARGS_BUDGET;

// =============================================================================
// VALUES — the JSON shapes and Python's text for them
// =============================================================================

/** A path into a result: keys and row indexes. */
type Path = Array<string | number>;

/** What a value costs to render: `[least, floor, want]` (see cost). */
type Cost = [least: number, floor: number, want: number];

/** One field or row of a container: its label's cost, then its value's (see allocate). */
type Item = [fixed: number, least: number, floor: number, want: number];

/** Whether a value is a JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Characters Python's repr() escapes beyond the ASCII controls: those that are not printable. */
const UNPRINTABLE = /^[\p{C}\p{Z}]$/u;

/**
 * A string as Python's repr() writes it, which is how Wave quotes field names
 * and keys in its texts: single quotes unless the text has one and no double
 * quote, with the quote, backslashes and unprintable characters escaped.
 *
 * @param text - The string to quote.
 * @returns The quoted string, e.g. `'id'` or `"it's"`.
 */
export function pyRepr(text: string): string {
	const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
	let out = quote;
	for (const ch of text) {
		const code = ch.codePointAt(0) as number;
		if (ch === quote || ch === '\\') out += `\\${ch}`;
		else if (ch === '\t') out += '\\t';
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (code < 0x20 || code === 0x7f || (code > 0x7f && UNPRINTABLE.test(ch))) {
			const [prefix, width] = code <= 0xff ? ['\\x', 2] : code <= 0xffff ? ['\\u', 4] : ['\\U', 8];
			out += prefix + code.toString(16).padStart(width as number, '0');
		} else out += ch;
	}
	return out + quote;
}

/**
 * A whole number as Python's `{:,}` writes it, which is how Wave writes the
 * character counts in its texts.
 *
 * @param n - The number.
 * @returns The number with commas between thousands, e.g. `3,629`.
 */
export function withCommas(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A list of strings as Python's str() writes it, e.g. `['id', 'name']`. */
function pyList(items: string[]): string {
	return `[${items.map(pyRepr).join(', ')}]`;
}

/** The indexes 0 to n - 1. */
function range(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i);
}

/** Whether a UTF-16 code unit is the first half of a surrogate pair. */
function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

/** Whether a UTF-16 code unit is the second half of a surrogate pair. */
function isLowSurrogate(unit: number): boolean {
	return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * The first `n` code units of a text, less a pair's first half the cut would
 * leave alone. Python cuts by code point, so Wave never splits a character;
 * a lone half makes the summary ill-formed, and summaries are resent every wave.
 */
function headOf(text: string, n: number): string {
	const head = text.slice(0, n);
	return head && isHighSurrogate(head.charCodeAt(head.length - 1)) ? head.slice(0, -1) : head;
}

/** The last `n` code units of a text, less a pair's second half the cut would leave alone (see headOf). */
function tailOf(text: string, n: number): string {
	const tail = text.slice(Math.max(0, text.length - n));
	return tail && isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail;
}

// =============================================================================
// SUMMARY — the entry point, its cap and its last line
// =============================================================================

/** The short fields a summary left out, by path, for the line that lists them. Holds the first SUMMARY_MISSING_FIELDS. */
class Omitted {
	/** The recorded fields: path, and the field as shown. */
	readonly fields: Array<[Path, string]> = [];
	/** Whether more were left out than are recorded. */
	more = false;

	/** Records a field, or notes that there were more. */
	add(path: Path, shown: string): void {
		if (this.fields.length < SUMMARY_MISSING_FIELDS) this.fields.push([path, shown]);
		else this.more = true;
	}
}

/**
 * Summarizes a tool result for the model. JSON gets Wave's structural summary
 * (field names, array lengths, sample values) within 6000 characters. Other
 * text comes back whole when it fits the 4000-character budget; past that it
 * keeps its start and end, the start taking two thirds, and says its length.
 *
 * @param result - The tool output text.
 * @returns The summary.
 */
export function summarize(result: string): string {
	let value: unknown;
	try {
		value = JSON.parse(result);
	} catch {
		return result.length <= SUMMARY_BUDGET ? result : renderText(result, SUMMARY_BUDGET);
	}
	return describe(value);
}

/**
 * Wave's `_describe`: the root gets the budget, or its fixed costs (short
 * fields, keys, length notes, headers) when those are more, up to the cap. A
 * root that cannot show all its short fields keeps room under the cap for the
 * line that lists the rest.
 */
function describe(value: unknown): string {
	let omitted = new Omitted();
	const [, floor] = cost(value, 0, false, SUMMARY_HARD_CAP);
	// A root given its floor leaves nothing out, so the line is needed only past the cap.
	const room = floor > SUMMARY_HARD_CAP ? SUMMARY_HARD_CAP - SUMMARY_MISSING_CHARS : Math.max(SUMMARY_BUDGET, floor);
	let summary = render(value, 0, room, false, omitted);
	if (!omitted.fields.length) return cap(summary, '');
	let line = missingLine(omitted);
	if (summary.length + line.length > SUMMARY_HARD_CAP) {
		// Not expected: a root within its floor leaves nothing out. Render again with
		// the line's room kept free rather than cut the summary after the fact.
		omitted = new Omitted();
		summary = render(value, 0, SUMMARY_HARD_CAP - SUMMARY_MISSING_CHARS, false, omitted);
		line = missingLine(omitted);
	}
	return cap(summary, line);
}

/** The summary and then the line, the summary cut so both fit the hard cap, notice included. The line is kept whole. */
function cap(summary: string, line: string): string {
	if (summary.length + line.length <= SUMMARY_HARD_CAP) return summary + line;
	const keep = SUMMARY_HARD_CAP - SUMMARY_TRUNCATED.length - line.length;
	return `${headOf(summary, keep)}${SUMMARY_TRUNCATED}${line}`;
}

/**
 * One line listing the short fields a summary left out, within
 * SUMMARY_MISSING_CHARS. Fields named like a status come first, then the
 * shortest entries; an entry too long for the room is skipped, not the ones
 * after it, and the line ends with how many it could not list.
 */
function missingLine(omitted: Omitted): string {
	const ranked = omitted.fields.map(([path, shown]) => {
		const last = path[path.length - 1];
		const status = typeof last === 'string' && STATUS_NAME.test(last);
		// A bound under the entry's length: a path only grows when a key is quoted.
		const bound = path.reduce<number>((n, seg) => n + String(seg).length, 0) + shown.length;
		return { rank: status ? 0 : 1, bound, path, shown };
	});
	ranked.sort((a, b) => a.rank - b.rank || a.bound - b.bound);
	const head = '\n(short fields a cut may have hidden: ';
	const tail = `; and ${omitted.fields.length}+ more`;
	let room = SUMMARY_MISSING_CHARS - head.length - tail.length - 1;
	const parts: string[] = [];
	let skipped = 0;
	for (const { bound, path, shown } of ranked) {
		if (bound + 2 > room) {
			skipped += 1;
			continue;
		}
		const item = `${pathText(path)}: ${shown}`;
		const itemCost = item.length + (parts.length ? 2 : 0);
		if (itemCost > room) {
			skipped += 1;
			continue;
		}
		parts.push(item);
		room -= itemCost;
	}
	if (skipped || omitted.more) {
		const more = `${skipped}${omitted.more ? '+' : ''} more`;
		parts.push(parts.length ? `and ${more}` : `${more}, with paths too long to list`);
	}
	return `${head}${parts.join('; ')})`;
}

/** A path as JMESPath writes it: keys joined by dots, quoted unless plain, list rows by index. */
function pathText(path: Path): string {
	let out = '';
	for (const seg of path) {
		if (typeof seg === 'number') out += `[${seg}]`;
		else {
			const key = PLAIN_KEY.test(seg) ? seg : JSON.stringify(seg);
			out = out ? `${out}.${key}` : key;
		}
	}
	return out;
}

/** True for a value paid for before the budget is split: a scalar, a string a row would show whole, an empty container. */
function isShort(value: unknown): boolean {
	if (Array.isArray(value)) return value.length === 0;
	if (isObject(value)) return Object.keys(value).length === 0;
	return !(typeof value === 'string' && value.length > ROW_TEXT_CHARS);
}

/**
 * Records the short fields of a value no container had room for: its own, its
 * nested dicts' and its short lists' rows'. A longer list's rows are a sample
 * by design, so their fields are not recorded. Depth counts every container edge.
 */
function collectShort(value: unknown, path: Path, depth: number, omitted: Omitted): void {
	if (depth > SUMMARY_MAX_DEPTH || omitted.more) return;
	if (isShort(value)) {
		// Strings as JSON, so a multi-line error stays on the one line.
		omitted.add(path, typeof value === 'string' ? JSON.stringify(value) : render(value, 0, 0));
	} else if (isObject(value)) {
		for (const [k, v] of Object.entries(value)) {
			if (omitted.more) break;
			collectShort(v, [...path, k], depth + 1, omitted);
		}
	} else if (Array.isArray(value) && value.length <= SUMMARY_SHORT_LIST) {
		value.forEach((v, i) => collectShort(v, [...path, i], depth + 1, omitted));
	}
}

// =============================================================================
// TEXT — strings in rows and in rooms
// =============================================================================

/** A string inside a sampled row: whole up to ROW_TEXT_CHARS, else its start and its length. */
function rowText(value: string): string {
	if (value.length <= ROW_TEXT_CHARS) return `"${value}"`;
	// Show prefix and total length so the model knows it can page through with offset/length.
	return `"${headOf(value, ROW_TEXT_CHARS)}..." (${value.length} chars)`;
}

/** What a long text shows when its room is too small for any of it to be worth reading. */
function textNote(length: number): string {
	return `(${length} chars, peek the key to read it)`;
}

/**
 * Quotes a value, keeping its start and end when it is longer than `chars`. A
 * file's closing lines and a traceback's final error are often what the model
 * needs, so the middle is what gets dropped.
 */
function cutText(value: string, chars: number): string {
	const limit = Math.max(TEXT_MIN_CHARS, chars);
	if (value.length <= limit) return `"${value}"`;
	const head = Math.floor((limit * 2) / 3);
	const tail = limit - head;
	return `"${headOf(value, head)} ... ${tailOf(value, tail)}" (${value.length} chars, middle omitted)`;
}

/**
 * A text outside a list row, in at most `room` characters: whole when it fits;
 * else its start and end, with the room less the quotes and the note; else,
 * when that leaves fewer than TEXT_MIN_CHARS, its length alone.
 */
function renderText(value: string, room: number): string {
	const length = value.length;
	if (length + 2 <= room) return `"${value}"`;
	const chars = room - `" ... " (${length} chars, middle omitted)`.length;
	if (chars >= TEXT_MIN_CHARS) return cutText(value, chars);
	return textNote(length);
}

// =============================================================================
// COST — sizing a value without rendering it
// =============================================================================

/** How long a dict's notice of fields left out is at a depth; a dict's least room is the notice for all of them. */
function fieldsNotice(depth: number, shown: number, total: number): number {
	return INDENT.length * depth + `... (showing ${shown} of ${total} fields, peek the key for the rest)`.length;
}

/** True for a list renderSample shows: one that is not empty and does not start with a dict. */
function isPlainList(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0 && !isObject(value[0]);
}

/** The field names a list of dicts shows: those of up to 5 rows, so sparse early rows do not hide later fields. */
function rowKeys(value: unknown[]): string[] {
	const keys = new Set<string>();
	for (const row of value.slice(0, 5)) if (isObject(row)) for (const k of Object.keys(row)) keys.add(k);
	return [...keys];
}

/**
 * How long a value renders at a depth, exactly, as `[least, floor, want]`.
 * least is the fewest characters it can be shown in: a scalar as it is, a list
 * its header, a dict its notice of fields left out. floor is what it shows with
 * no budget to spend: its short fields, a length note for each long text, and
 * the floors of what it nests. want is all of it. A container that wants no
 * more than ROW_TEXT_CHARS is a short field: its three are equal, and it is
 * shown whole or not at all. Counting stops past `limit`, so a huge value costs
 * a bounded walk. Inside a sampled row everything is whole, so the three are
 * equal there too.
 */
function cost(value: unknown, depth: number, inRow: boolean, limit: number): Cost {
	if (depth > SUMMARY_MAX_DEPTH) return [3, 3, 3];
	if (value === null || typeof value === 'boolean' || typeof value === 'number') {
		const length = render(value, depth, 0).length;
		return [length, length, length];
	}
	if (typeof value === 'string') {
		let length = value.length;
		if (inRow) length = rowText(value).length;
		else if (length > ROW_TEXT_CHARS) {
			const note = textNote(length).length;
			return [note, note, length + 2];
		} else length += 2;
		return [length, length, length];
	}
	if (isObject(value)) {
		const entries = Object.entries(value);
		if (!entries.length) return [2, 2, 2];
		const pad = INDENT.length * depth;
		let floor = -1; // the fields' newlines, one fewer than fields
		let want = -1;
		for (const [k, v] of entries) {
			const [, f, w] = cost(v, depth + 1, inRow, limit);
			const label = pad + k.length + 3;
			floor += label + f;
			want += label + w;
			if (floor > limit) break;
		}
		if (inRow || want <= ROW_TEXT_CHARS) return [want, want, want];
		return [Math.min(fieldsNotice(depth, entries.length, entries.length), want), floor, want];
	}
	if (Array.isArray(value)) {
		if (!value.length) return [12, 12, 12]; // "[] (0 items)"
		const n = value.length;
		const pad = INDENT.length * depth;
		let least: number;
		let floor: number;
		let want: number;
		if (isObject(value[0])) {
			const header = `${n} items, fields: ${pyList(rowKeys(value))}`.length;
			if (inRow) {
				const rows = value.slice(0, SUMMARY_SHORT_LIST);
				want = header + (n > rows.length ? ` (showing ${rows.length} of ${n})`.length : 0);
				rows.forEach((row, i) => {
					want += pad + String(i).length + 10 + cost(row, depth + 1, true, limit)[2];
				});
				return [want, want, want];
			}
			least = header + ` (showing 0 of ${n})`.length;
			floor = want = header;
			const whole = n <= SUMMARY_SHORT_LIST;
			for (let i = 0; i < n; i++) {
				const [, f, w] = cost(value[i], depth + 1, !whole, limit);
				const label = pad + String(i).length + 10; // "\n{pad}  row[i]:\n"
				want += label + w;
				if (whole) floor += label + f;
				else if (want > limit) break;
			}
			if (!whole) floor = least;
		} else {
			const shown = value.slice(0, 3);
			const prefix = `${n} items, sample: [`.length;
			least = prefix + 4; // "...]"
			floor = want = prefix + 1 + 2 * (shown.length - 1); // "]" and ", " between items
			for (const item of shown) {
				const [, f, w] = inRow || !isPlainList(item) ? cost(item, depth + 1, inRow, limit) : filledCost(item, depth + 1, limit);
				floor += f;
				want += w;
			}
		}
		if (inRow || want <= ROW_TEXT_CHARS) return [want, want, want];
		return [Math.min(least, want), floor, want];
	}
	const length = render(value, depth, 0).length;
	return [length, length, length];
}

/** The costs of a plain list inside a plain list's sample, which shows as many items as fit; its floor is its least. */
function filledCost(value: unknown[], depth: number, limit: number): Cost {
	if (depth > SUMMARY_MAX_DEPTH) return [3, 3, 3];
	const prefix = `${value.length} items, sample: [`.length;
	let want = prefix - 1; // "]", less the ", " the first item does not have
	for (const item of value) {
		want += 2 + cost(item, depth + 1, true, limit)[2];
		if (want > limit) break;
	}
	if (want <= ROW_TEXT_CHARS) return [want, want, want];
	const least = Math.min(prefix + 4, want); // "...]"
	return [least, least, want];
}

// =============================================================================
// ROOM — sharing a container's room between its items
// =============================================================================

/** Shares room between items that each need so much: those that fit an equal share take only what they need, and the rest is split again. */
function split(room: number, needs: Array<[number, number]>): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let left = needs.length;
	for (const [i, need] of [...needs].sort((a, b) => a[1] - b[1])) {
		const give = Math.min(need, Math.floor(room / left));
		out.push([i, give]);
		room -= give;
		left -= 1;
	}
	return out;
}

/**
 * Which of a container's items fit in its room, and the room each one's value
 * gets. Items are kept in `order` while their label and least fit; `notice` is
 * reserved as soon as one does not, so the container can say so inside its
 * room. The rest of the room then goes to the kept items' floors (short fields
 * first, so a cut dict keeps its status), then to what they want beyond that,
 * each split so an item needing less than an equal share takes only that.
 *
 * @returns The room per kept item, by index, and whether any item was left out.
 */
function allocate(room: number, items: Item[], order: number[], notice: number): [Map<number, number>, boolean] {
	const kept: number[] = [];
	let used = 0;
	for (const i of order) {
		const itemCost = items[i][0] + items[i][1];
		if (used + itemCost <= room) {
			kept.push(i);
			used += itemCost;
		}
	}
	const cut = kept.length < items.length;
	if (cut) {
		// Make room for the notice by giving up the last kept, least wanted, items.
		room -= notice;
		while (used > room && kept.length) {
			const i = kept.pop() as number;
			used -= items[i][0] + items[i][1];
		}
	}
	const rooms = new Map<number, number>(kept.map((i) => [i, items[i][1]]));
	let left = room - used;
	for (const [low, high] of [
		[1, 2],
		[2, 3],
	]) {
		const needs = kept.filter((i) => items[i][high] > items[i][low]).map((i): [number, number] => [i, items[i][high] - items[i][low]]);
		for (const [i, give] of split(left, needs)) {
			rooms.set(i, (rooms.get(i) as number) + give);
			left -= give;
		}
	}
	return [rooms, cut];
}

// =============================================================================
// RENDER — writing a value within its room
// =============================================================================

/**
 * Renders a value within `room` characters. A container keeps to its room by
 * leaving out whole fields or whole rows; what it leaves out is recorded in
 * `omitted` by `path`. A scalar is what it is: its parent paid for it. Inside a
 * sampled list row (`inRow`) everything is shown whole, except that a string
 * is cut to ROW_TEXT_CHARS and a nested list shows SUMMARY_SHORT_LIST rows.
 */
function render(value: unknown, depth: number, room: number, inRow = false, omitted?: Omitted, path: Path = []): string {
	if (depth > SUMMARY_MAX_DEPTH) return '...';
	if (value === null) return 'null';
	if (typeof value === 'boolean' || typeof value === 'number') return String(value);
	if (typeof value === 'string') return inRow ? rowText(value) : renderText(value, room);
	if (Array.isArray(value)) {
		if (!value.length) return '[] (0 items)';
		if (isObject(value[0])) return renderRows(value, depth, room, inRow, omitted, path);
		return renderSample(value, depth, room, inRow, omitted, path);
	}
	if (isObject(value)) {
		if (!Object.keys(value).length) return '{}';
		return describeDict(value, depth, room, inRow, omitted, path);
	}
	return String(value);
}

/**
 * A list of dicts: its field names, then its rows. Up to SUMMARY_SHORT_LIST
 * rows (an MCP tool's content blocks) are shown whole, splitting the room like
 * a dict's fields. A longer list is a sample: its rows are shown whole, in
 * order, while they fit, and the header counts the ones shown. A later row can
 * be a scalar; it is rendered like any value.
 */
function renderRows(value: unknown[], depth: number, room: number, inRow: boolean, omitted: Omitted | undefined, path: Path): string {
	const n = value.length;
	let header = `${n} items, fields: ${pyList(rowKeys(value))}`;
	const pad = INDENT.repeat(depth);
	const labelled = (i: number, body: string): string => `\n${pad}${INDENT}row[${i}]:\n${body}`;

	const rows: string[] = [];
	if (inRow) {
		value.slice(0, SUMMARY_SHORT_LIST).forEach((row, i) => rows.push(labelled(i, render(row, depth + 1, room, true))));
	} else if (n <= SUMMARY_SHORT_LIST) {
		const items = value.map((row, i): Item => [labelled(i, '').length, ...cost(row, depth + 1, false, room)]);
		const [rooms] = allocate(room - header.length, items, range(n), ` (showing 0 of ${n})`.length);
		value.forEach((row, i) => {
			const given = rooms.get(i);
			if (given !== undefined) rows.push(labelled(i, render(row, depth + 1, given, false, omitted, [...path, i])));
			else if (omitted) collectShort(row, [...path, i], depth + 1, omitted);
		});
	} else {
		let used = header.length;
		for (let i = 0; i < n; i++) {
			const text = labelled(i, render(value[i], depth + 1, room, true));
			if (used + text.length > room) break;
			rows.push(text);
			used += text.length;
		}
		// Some rows are left out: give up shown ones until the header's notice fits as
		// well. Reserving it for each row instead hid rows that fit whenever the last
		// row was shorter than the notice.
		while (rows.length > 0 && rows.length < n && used + ` (showing ${rows.length} of ${n})`.length > room) {
			used -= (rows.pop() as string).length;
		}
	}
	// Say the sample is partial, so a lookup peeks the key instead of re-running the search.
	if (rows.length < n) header += ` (showing ${rows.length} of ${n})`;
	return header + rows.join('');
}

/**
 * A list that does not start with a dict: its first 3 items, each rendered
 * like a field of its parent. Outside a sampled row the items split the list's
 * room, so one huge item is cut like any text; an item that does not fit at
 * all is left out and the sample ends in "...". An item that is itself a plain
 * list shows as many of its items as fit (see renderFilled).
 */
function renderSample(value: unknown[], depth: number, room: number, inRow: boolean, omitted: Omitted | undefined, path: Path): string {
	const n = value.length;
	const shown = value.slice(0, 3);
	const prefix = `${n} items, sample: [`;
	if (inRow) return `${prefix}${shown.map((item) => render(item, depth + 1, room, true)).join(', ')}]`;
	const items = shown.map((item): Item => [2, ...(isPlainList(item) ? filledCost(item, depth + 1, room) : cost(item, depth + 1, false, room))]);
	// The first item has no ", " before it, and the room counts the closing bracket.
	const [rooms, cut] = allocate(room - prefix.length + 1, items, range(shown.length), ', ...'.length);
	const parts: string[] = [];
	shown.forEach((item, i) => {
		const given = rooms.get(i);
		if (given !== undefined && isPlainList(item)) parts.push(renderFilled(item, depth + 1, given, omitted, [...path, i]));
		else if (given !== undefined) parts.push(render(item, depth + 1, given, false, omitted, [...path, i]));
		else if (omitted) collectShort(item, [...path, i], depth + 1, omitted);
	});
	if (cut) parts.push('...');
	return `${prefix}${parts.join(', ')}]`;
}

/**
 * A plain list inside a plain list's sample: as many of its items as fit, in
 * order, each shown as in a sampled row, so a whole header row of a table fits.
 * When some are left out the list ends in "..."; a list of up to
 * SUMMARY_SHORT_LIST items records the short fields of those it leaves out.
 */
function renderFilled(value: unknown[], depth: number, room: number, omitted: Omitted | undefined, path: Path): string {
	if (depth > SUMMARY_MAX_DEPTH) return '...';
	const prefix = `${value.length} items, sample: [`;
	const parts: string[] = [];
	let used = prefix.length + 1; // and "]"
	let all = true;
	for (const item of value) {
		const text = render(item, depth + 1, room, true);
		used += text.length + (parts.length ? 2 : 0);
		if (used > room) {
			all = false;
			break;
		}
		parts.push(text);
	}
	if (all) return `${prefix}${parts.join(', ')}]`;
	// Some items are left out: give up shown ones until ", ..." fits as well.
	used = prefix.length + '...]'.length + parts.reduce((sum, part) => sum + part.length + 2, 0);
	while (parts.length && used > room) used -= (parts.pop() as string).length + 2;
	if (omitted && value.length <= SUMMARY_SHORT_LIST) {
		for (let i = parts.length; i < value.length; i++) collectShort(value[i], [...path, i], depth + 1, omitted);
	}
	return `${prefix}${[...parts, '...'].join(', ')}]`;
}

/**
 * A dict as indented `key: value` lines. When all of it fits its room, every
 * field is shown whole. Otherwise the room is allocated once: every key, short
 * field and length note is paid for first, and what is left is split between
 * the fields that can spend it, so a command's stdout cannot crowd out its
 * stderr or exit code. Fields that do not fit even so are left out whole,
 * short fields named like a status last, and a final line says how many.
 */
function describeDict(d: Record<string, unknown>, depth: number, room: number, inRow: boolean, omitted: Omitted | undefined, path: Path): string {
	const pad = INDENT.repeat(depth);
	// A multi-line value goes on its own lines below the key.
	const line = (k: string, desc: string): string => (desc.includes('\n') ? `${pad}${k}:\n${desc}` : `${pad}${k}: ${desc}`);
	const entries = Object.entries(d);

	if (inRow) return entries.map(([k, v]) => line(k, render(v, depth + 1, room, true))).join('\n');
	const items = entries.map(([k, v]): Item => [pad.length + k.length + 3, ...cost(v, depth + 1, false, room)]);
	let rooms: Map<number, number>;
	let cut = false;
	if (items.reduce((sum, item) => sum + item[0] + item[3], 0) - 1 <= room) {
		rooms = new Map(items.map((item, i) => [i, item[3]]));
	} else {
		const priority = (i: number): number => {
			const short = items[i][1] === items[i][3]; // shown whole or not at all
			return short && STATUS_NAME.test(entries[i][0]) ? 0 : short ? 1 : 2;
		};
		const notice = fieldsNotice(depth, entries.length, entries.length) + 1; // and its newline
		const order = range(items.length).sort((a, b) => priority(a) - priority(b) || a - b);
		[rooms, cut] = allocate(room + 1, items, order, notice);
	}
	const lines: string[] = [];
	entries.forEach(([k, v], i) => {
		const given = rooms.get(i);
		if (given !== undefined) lines.push(line(k, render(v, depth + 1, given, false, omitted, [...path, k])));
		else if (omitted && !omitted.more) collectShort(v, [...path, k], depth + 1, omitted);
	});
	if (cut) lines.push(`${pad}... (showing ${rooms.size} of ${entries.length} fields, peek the key for the rest)`);
	return lines.join('\n');
}

// =============================================================================
// ARGUMENT PREVIEWS — a call's arguments, shown beside its result
// =============================================================================

/**
 * The short form of a call's arguments that sits beside its result, so the
 * model sees what it asked for (the code it ran, the content it wrote) and can
 * tell a retry from a repeat. Wave's `_with_call` preview: the texts share a
 * 600-character budget, those that fit are shown whole and the longer ones
 * keep their start and end; a preview still past 1200 characters is cut there
 * and says so.
 *
 * @param args - The arguments as the model wrote them.
 * @returns The preview, laid out like a summary.
 */
export function previewArgs(args: Record<string, unknown>): string {
	const text = renderCapped(args, 0, ARGS_BUDGET, false, argsTextCap(args));
	if (text.length <= ARGS_HARD_CAP) return text;
	return `${headOf(text, ARGS_HARD_CAP)} ... (${withCommas(text.length)} characters, cut at ${withCommas(ARGS_HARD_CAP)})`;
}

/** The lengths of the texts renderCapped shows in a value, at any depth it renders. */
function textLengths(value: unknown, depth = 0): number[] {
	if (depth > SUMMARY_MAX_DEPTH) return [];
	if (typeof value === 'string') return [value.length];
	if (isObject(value)) return Object.values(value).flatMap((v) => textLengths(v, depth + 1));
	if (Array.isArray(value) && value.length && isObject(value[0])) return value.flatMap((row) => textLengths(row, depth + 1));
	if (Array.isArray(value)) return value.slice(0, 3).flatMap((item) => textLengths(item, depth + 1)); // the sample renderCapped shows
	return [];
}

/**
 * The most each text in a call's arguments may show, so together they fit
 * ARGS_BUDGET: texts that fit are shown whole, the longer ones share what is
 * left equally, and none shows less than ROW_TEXT_CHARS.
 */
function argsTextCap(args: unknown): number {
	const lengths = textLengths(args).sort((a, b) => a - b);
	let remaining = ARGS_BUDGET;
	for (let i = 0; i < lengths.length; i++) {
		const left = lengths.length - i;
		if (lengths[i] * left > remaining) return Math.max(ROW_TEXT_CHARS, Math.floor(remaining / left));
		remaining -= lengths[i];
	}
	return ARGS_BUDGET; // everything fits whole
}

/**
 * Renders a value with every text cut to `textCap` and no field left out
 * (Wave's `_render` with `text_cap`). A list of dicts longer than
 * SUMMARY_SHORT_LIST, or any inside a sampled row (`inRow`), shows at least
 * that many rows and then as many as fit `room`; a plain list shows its first 3 items.
 */
function renderCapped(value: unknown, depth: number, room: number, inRow: boolean, textCap: number): string {
	if (depth > SUMMARY_MAX_DEPTH) return '...';
	if (typeof value === 'string') return cutText(value, textCap);
	if (Array.isArray(value) && value.length) {
		if (isObject(value[0])) return renderCappedRows(value, depth, room, inRow, textCap);
		return `${value.length} items, sample: [${value
			.slice(0, 3)
			.map((item) => renderCapped(item, depth + 1, room, inRow, textCap))
			.join(', ')}]`;
	}
	if (isObject(value) && Object.keys(value).length) {
		const pad = INDENT.repeat(depth);
		return Object.entries(value)
			.map(([k, v]) => {
				// A multi-line value goes on its own lines below the key.
				const desc = renderCapped(v, depth + 1, room, inRow, textCap);
				return desc.includes('\n') ? `${pad}${k}:\n${desc}` : `${pad}${k}: ${desc}`;
			})
			.join('\n');
	}
	return render(value, depth, room); // a scalar or an empty container, as in a summary
}

/** A list of dicts in an argument preview: its field names, then its rows, each with its texts capped. */
function renderCappedRows(value: unknown[], depth: number, room: number, inRow: boolean, textCap: number): string {
	const n = value.length;
	let header = `${n} items, fields: ${pyList(rowKeys(value))}`;
	const pad = INDENT.repeat(depth);
	const labelled = (i: number, body: string): string => `\n${pad}${INDENT}row[${i}]:\n${body}`;

	const rows: string[] = [];
	if (n <= SUMMARY_SHORT_LIST && !inRow) {
		value.forEach((row, i) => rows.push(labelled(i, renderCapped(row, depth + 1, room, false, textCap))));
	} else {
		let used = header.length;
		for (let i = 0; i < n; i++) {
			const text = labelled(i, renderCapped(value[i], depth + 1, room, true, textCap));
			if (used + text.length > room && i >= SUMMARY_SHORT_LIST) break;
			rows.push(text);
			used += text.length;
		}
		// Give up shown rows past the first few until the header's notice fits as well.
		while (rows.length > SUMMARY_SHORT_LIST && rows.length < n && used + ` (showing ${rows.length} of ${n})`.length > room) {
			used -= (rows.pop() as string).length;
		}
	}
	if (rows.length < n) header += ` (showing ${rows.length} of ${n})`;
	return header + rows.join('');
}
