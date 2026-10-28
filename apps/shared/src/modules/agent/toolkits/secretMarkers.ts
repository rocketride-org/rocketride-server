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
// SECRET MARKERS — secret values in files, shown to the model as markers
// =============================================================================

/**
 * A file the agent reads may hold a secret: an inline key in a `.pipe`, a
 * token in a config file. The model must never see it, but it must be able to
 * edit the file without losing it. So read_file and search_files show
 * `«secret:<id>»` in place of each secret value, and write_file and edit_file
 * put the value back before they write. The id is 8 random hex characters, not
 * derived from the value. One value keeps one marker for the whole run, so a
 * re-read shows the same marker and edit anchors keep matching. The map lives
 * in a `SecretMarkers`, one per run (`FilesystemTools` owns it), and never
 * leaves the page.
 *
 * What counts as a secret value:
 * - In `.pipe`, `.json`, `.yaml` and `.yml` files, every string under a
 *   secret-named key (`secretKind`), the way `redactSecrets` decides for
 *   structured results, unless it holds no secret (`holdsNoSecret`). A number
 *   counts too under a password or secret name, not under a token name.
 * - In `.env*`, `.toml`, `.ini`, `.properties` and `.sh` files, the value of
 *   each secret-named `NAME=value`, one per line or each one an `export`
 *   sets, unless it holds no secret. In a shell or `.env` file, a `$NAME`
 *   value names another variable, so it holds none.
 * - In any file, what `findSecrets` finds: key shapes, bearer tokens, URL
 *   passwords, private key blocks and JSON secret fields. Every tool result
 *   passes through `redactText`, which hides the same things as `[redacted]`;
 *   a marker first means a read never shows `[redacted]`, which a write would
 *   then save over the user's key.
 * - In any file, in every tool result (wave/loop.ts), and on cards and in the
 *   answer (run.ts), a value this run already hid, when it is 16 characters
 *   or longer, or 8 or longer with a character that is not a letter.
 *
 * An edit anchor is matched against the file as the model sees it, markers in
 * place: matched against the real text, it would tell the model whether a
 * guess at part of a value is right.
 *
 * Not seen: a key encoded (base64) or split across lines, YAML block scalars,
 * a quoted YAML value that runs onto the next line, YAML values nested under a
 * secret-named key, a JSON value after an unclosed quote earlier on the
 * same line, a `NAME=value` value that runs onto the next line, and a TOML
 * inline table.
 */

import { findSecrets, holdsNoSecret, mergeSpans, replaceSpans, secretKind, unescapeJson, type SecretKind } from './common';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Any marker-shaped text, known to this run or not. */
const MARKER_PATTERN = /«secret:[^»\s]{1,64}»/g;

/** The shortest value hidden wherever it appears; a shorter one could be an ordinary word. */
const KNOWN_MIN_CHARS = 8;

/** The shortest all-letter value hidden wherever it appears. Dev passwords such as `postgres` and `changeme` are also words in node names, guides and answers. */
const KNOWN_MIN_WORD_CHARS = 16;

/** A character that is not a letter. A key has one; a word does not. */
const NOT_A_LETTER = /\P{L}/u;

/** The most places a note names before it says how many more there are. */
const NOTE_MAX_PLACES = 5;

/** Files whose secret-named JSON fields are hidden. */
const JSON_FILE = /\.(?:pipe|json)$/i;

/** Files whose secret-named YAML fields are hidden. */
const YAML_FILE = /\.ya?ml$/i;

/** A YAML `key: value` line, the key bare or quoted: group 2 is the key, group 3 the value and any comment. */
const YAML_FIELD = /^[ \t]*(?:-[ \t]+)?(["']?)([\w.-]+)\1[ \t]*:[ \t]+(\S.*?)[ \t]*$/gm;

/** Tags (`!!str`, `!secret`) and anchors (`&pw`) before a YAML value, each with the space after it. */
const YAML_PROPERTIES = /^(?:[!&]\S*[ \t]+)+/;

/** Files whose secret-named `NAME=value` lines are hidden. */
const KEY_VALUE_FILE = /(?:^|\/)\.env[^/]*$|\.(?:env|toml|ini|properties|sh)$/i;

/** `NAME=value` files a shell reads, where `$NAME` names another variable. */
const SHELL_FILE = /(?:^|\/)\.env[^/]*$|\.(?:env|sh)$/i;

/** `.properties` files, where `#` starts a comment only at the start of a line. */
const PROPERTIES_FILE = /\.properties$/i;

/** TOML files, where a string may sit in triple quotes. */
const TOML_FILE = /\.toml$/i;

/** A `NAME=value` line, the name bare or quoted: group 2 is the name, group 3 the value and any comment. */
const KEY_VALUE_FIELD = /^[ \t]*(["']?)([\w.-]+)\1[ \t]*=[ \t]*(\S.*?)[ \t]*$/gm;

/** An `export` line: group 1 is everything after `export`. */
const EXPORT_LINE = /^[ \t]*export[ \t]+(.*)$/gm;

/** The start of an `export` word that sets a name: `NAME=` or `NAME =`. */
const EXPORT_SETS_NAME = /[\w.-]+[ \t]*=/;

/** `EXPORT_SETS_NAME` for the word right after `NAME= `, where a word that ends in `=` is a base64 value, not an empty assignment. */
const EXPORT_SETS_NAME_AFTER_SPACE = /[\w.-]+(?:[ \t]+=|=(?!=*(?:[ \t]|$)))/;

/** One shell word: quoted and unquoted parts with nothing between them. Read whole, it lets `plainOrQuoted` find the real closing quote past a `\"` or a `''`. A quote left open runs to the end of the line, as in a shell. */
const SHELL_WORD = /(?:"[^"]*"?|'[^']*'?|[^\s"']\S*)+/;

/** A `NAME=value` among an `export` line's words, the name bare or quoted: group 2 is the name, group 3 the value. Dotenv reads the rest of the line as the value, spaces after `=` too, and a shell reads each `NAME=value` word as its own assignment, so the value runs up to the next word that sets a name. Group 3 is empty when that word follows `NAME= ` (see `lineFields`). */
const EXPORT_FIELD = new RegExp(String.raw`(?<![^ \t])(["']?)([\w.-]+)\1[ \t]*=(?:[ \t]+(?!${EXPORT_SETS_NAME_AFTER_SPACE.source}))?((?:${SHELL_WORD.source}(?:[ \t]+(?!${EXPORT_SETS_NAME.source})${SHELL_WORD.source})*)?)`, 'g');

/** A value that only names a shell variable. */
const SHELL_REFERENCE = /^\$[A-Za-z_]\w*$/;

/** A TOML string in triple quotes that closes on the same line: group 1 is a basic string, where a backslash escapes the next character, group 2 a literal one. */
const TRIPLE_QUOTED = /^(?:"""((?:\\.|[^\\])*?)"""|'''(.*?)''')/;

/** How a YAML value starts when it is not one plain or quoted string: a block, a flow, an anchor, an alias, a tag or a comment. */
const YAML_NOT_SCALAR = /^[|>{[&*!#]/;

/** A JSON number, read from where it starts. */
const JSON_NUMBER = /-?\d[\d.eE+-]*/y;

// =============================================================================
// TYPES
// =============================================================================

/** One secret value in a text: where it is, and where the note says it sits. */
interface Found {
	/** Where the value starts. */
	start: number;
	/** Where it ends (exclusive). */
	end: number;
	/** A JSON path or a YAML key; empty when only the line number names it. */
	where: string;
}

/** One open object or array while JSON text is scanned. */
interface Frame {
	/** True for an array. */
	array: boolean;
	/** Its path from the root; '' for the root. */
	path: string;
	/** What the secret-named key above it is named for, if there is one. */
	secret: SecretKind | null;
	/** The key being read: in an object, or in an array that holds a stray `"key":`. */
	key: string;
	/** The item being read (arrays). */
	index: number;
	/** Whether the next string is a key when no `:` follows it (objects): true after `{` and `,`. */
	expectKey: boolean;
}

// =============================================================================
// FINDING SECRET FIELDS
// =============================================================================

/**
 * The path of the value a frame is reading now.
 *
 * @param frame - The innermost open object or array.
 * @returns For example `components[1].config.apikey`.
 */
function childPath(frame: Frame): string {
	if (frame.array) return `${frame.path}[${frame.index}]`;
	return frame.path ? `${frame.path}.${frame.key}` : frame.key;
}

/**
 * What the value a frame is reading now is a secret for, from its own key
 * and the keys above it. A secret name above a token name wins.
 *
 * @param frame - The innermost open object or array.
 * @returns 'secret', 'token', or null when no key above it is secret-named.
 */
function childSecret(frame: Frame): SecretKind | null {
	const own = frame.key ? secretKind(frame.key) : null;
	return frame.secret === 'secret' || own === 'secret' ? 'secret' : (frame.secret ?? own);
}

/**
 * The first character at or after a position that is not white space.
 *
 * @param text - The text.
 * @param from - Where to start looking.
 * @returns The character; '' at the end of the text.
 */
function nextNonSpace(text: string, from: number): string {
	for (let i = from; i < text.length; i++) {
		if (!/\s/.test(text[i])) return text[i];
	}
	return '';
}

/**
 * The secret values in JSON text: every string, and every number, under a
 * secret-named key. The text is scanned, not parsed, so a file mid-edit that
 * is not valid JSON is still covered, and each span points into the text as
 * written. A string followed by `:` is a key whatever came before it, so a
 * missing comma or an unclosed string on the line above does not turn the
 * next key into a value.
 *
 * @param text - The file's text.
 * @returns Each value's span (inside its quotes, for a string), with its JSON path.
 */
function jsonFields(text: string): Found[] {
	const found: Found[] = [];
	const stack: Frame[] = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const top = stack[stack.length - 1];
		if (c === '{' || c === '[') {
			stack.push({ array: c === '[', path: top ? childPath(top) : '', secret: top ? childSecret(top) : null, key: '', index: 0, expectKey: c === '{' });
		} else if (c === '}' || c === ']') {
			stack.pop();
		} else if (c === ',' && top) {
			if (top.array) top.index += 1;
			top.key = '';
			top.expectKey = !top.array;
		} else if (c === ':' && top) {
			top.expectKey = false;
		} else if (c === '"') {
			// step: find the closing quote; JSON strings never hold a raw newline
			let end = i + 1;
			while (end < text.length && text[end] !== '"' && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
			end = Math.min(end, text.length);
			const raw = text.slice(i + 1, end);
			if (top && (nextNonSpace(text, end + 1) === ':' || (!top.array && top.expectKey))) {
				top.key = unescapeJson(raw);
				top.expectKey = false;
			} else if (top) {
				const secret = childSecret(top);
				if (secret && !holdsNoSecret(unescapeJson(raw), secret)) found.push({ start: i + 1, end, where: childPath(top) });
			}
			i = end;
		} else if (top && (c === '-' || (c >= '0' && c <= '9'))) {
			// step: a number under a password or secret name is a secret too
			JSON_NUMBER.lastIndex = i;
			const number = JSON_NUMBER.exec(text)?.[0];
			if (!number) continue;
			const secret = childSecret(top);
			if (secret && !holdsNoSecret(number, secret)) found.push({ start: i, end: i + number.length, where: childPath(top) });
			i += number.length - 1;
		}
	}
	return found;
}

/**
 * Where a quoted YAML value closes: in double quotes a backslash escapes the
 * next character, and in single quotes `''` is a quote, not the end.
 *
 * @param rest - The value, starting with its opening quote.
 * @returns The position of the closing quote; the length of `rest` when it does not close on this line.
 */
function yamlClose(rest: string): number {
	const quote = rest[0];
	let at = 1;
	while (at < rest.length) {
		if (quote === '"' && rest[at] === '\\') at += 2;
		else if (rest[at] !== quote) at += 1;
		else if (quote === "'" && rest[at + 1] === "'") at += 2;
		else return at;
	}
	return rest.length;
}

/**
 * The string a plain or quoted value holds.
 *
 * @param value - The value and anything after it on the line.
 * @param comments - Whether ` #` starts a comment after an unquoted value.
 * @param toml - Whether a string may sit in triple quotes.
 * @returns The string and where it starts in `value`.
 */
function plainOrQuoted(value: string, comments = true, toml = false): { text: string; offset: number } {
	const triple = toml ? TRIPLE_QUOTED.exec(value) : null;
	if (triple) return { text: triple[1] ?? triple[2], offset: 3 };
	if (value[0] === '"' || value[0] === "'") return { text: value.slice(1, yamlClose(value)), offset: 1 };
	// step: an unquoted value ends where a comment starts
	const comment = comments ? value.search(/\s#/) : -1;
	return { text: (comment < 0 ? value : value.slice(0, comment)).trimEnd(), offset: 0 };
}

/**
 * The plain or quoted string a YAML value holds, after any tag or anchor.
 *
 * @param rest - Everything after `key: ` on the line.
 * @returns The string and where it starts in `rest`; null for a block, flow, alias or comment, or a tag or anchor with nothing after it.
 */
function yamlScalar(rest: string): { text: string; offset: number } | null {
	const skip = YAML_PROPERTIES.exec(rest)?.[0].length ?? 0;
	const value = rest.slice(skip);
	if (YAML_NOT_SCALAR.test(value)) return null;
	const scalar = plainOrQuoted(value);
	return { text: scalar.text, offset: skip + scalar.offset };
}

/**
 * The secret values in text made of `key: value` (YAML) or `NAME=value`
 * lines: the value of each line whose key is secret-named.
 *
 * @param text - The file's text.
 * @param field - The line pattern: group 2 is the key, group 3 the value and any comment, empty for an `export` name a word that sets a name follows.
 * @param scalar - Reads the string a value holds, told whether white space comes before it; null when it holds none.
 * @returns Each value's span, named by its key.
 */
function lineFields(text: string, field: RegExp, scalar: (rest: string, spaced: boolean) => { text: string; offset: number } | null): Found[] {
	const found: Found[] = [];
	let open = -1;
	for (const m of text.matchAll(field)) {
		const [line, , key, rest] = m;
		const secret = secretKind(key);
		// step: `A= B=x` is an empty A and B=x to a shell, and A=`B=x` to dotenv. A's value counts where B's hides nothing, so B's stays its own.
		if (!rest) {
			if (secret) open = m.index;
			continue;
		}
		const from = open;
		open = -1;
		const value = secret ? scalar(rest, /[ \t]/.test(line[line.lastIndexOf(rest) - 1])) : null;
		if (!secret || !value || holdsNoSecret(value.text, secret)) {
			if (from >= 0) found.push(...lineFields(text.slice(from, m.index + line.length), KEY_VALUE_FIELD, scalar).map((span) => ({ ...span, start: from + span.start, end: from + span.end })));
			continue;
		}
		const start = m.index + line.lastIndexOf(rest) + value.offset;
		found.push({ start, end: start + value.text.length, where: key });
	}
	return found;
}

/**
 * The secret values in a `NAME=value` file: the value of each line whose name
 * is secret-named, and of each name an `export` line sets.
 *
 * @param path - The file's path; its name decides how `#` and `$NAME` read.
 * @param text - The file's text.
 * @returns Each value's span, named by its name.
 */
function keyValueFields(path: string, text: string): Found[] {
	const scalar = (rest: string, spaced: boolean): { text: string; offset: number } | null => {
		// step: `NAME= # note` is an empty NAME and a comment, while `NAME=#x` sets `#x`
		if (spaced && rest[0] === '#' && !PROPERTIES_FILE.test(path)) return null;
		const value = plainOrQuoted(rest, !PROPERTIES_FILE.test(path), TOML_FILE.test(path));
		// step: in single quotes `$NAME` is text
		return SHELL_FILE.test(path) && rest[0] !== "'" && SHELL_REFERENCE.test(value.text) ? null : value;
	};
	const found = lineFields(text, KEY_VALUE_FIELD, scalar);
	for (const line of text.matchAll(EXPORT_LINE)) {
		const at = line.index + line[0].length - line[1].length;
		for (const field of lineFields(line[1], EXPORT_FIELD, scalar)) found.push({ ...field, start: at + field.start, end: at + field.end });
	}
	return found;
}

/**
 * The line a position falls on.
 *
 * @param text - The text.
 * @param at - A position in it.
 * @returns `line N`, counted from 1.
 */
function lineOf(text: string, at: number): string {
	let line = 1;
	for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line += 1;
	return `line ${line}`;
}

/**
 * The note a read ends with when it hid anything. It says the file holds the
 * value in plain text: told only that a marker stands in, the model took the
 * marker for a stored secret and stopped telling the user to move the key.
 *
 * @param places - Where each hidden value sits.
 * @returns The note: how many values were hidden, where, that the file holds them in plain text, and where they should go.
 */
function hiddenNote(places: string[]): string {
	const one = places.length === 1;
	const more = places.length > NOTE_MAX_PLACES ? `, and ${places.length - NOTE_MAX_PLACES} more` : '';
	const hidden = `${places.length} secret ${one ? 'value' : 'values'} hidden (${places.slice(0, NOTE_MAX_PLACES).join(', ')}${more}).`;
	const plain = one ? 'The file stores it in plain text; you see a marker in its place.' : 'The file stores them in plain text; you see a marker in place of each.';
	const keep = one ? 'Keep the marker as it is when you edit this file.' : 'Keep the markers as they are when you edit this file.';
	const move = one ? 'A key written in a file should move to Variables: tell the user to set it there and use a ${ROCKETRIDE_<NAME>} placeholder.' : 'Keys written in a file should move to Variables: tell the user to set them there and use ${ROCKETRIDE_<NAME>} placeholders.';
	return `${hidden} ${plain} ${keep} ${move}`;
}

/**
 * A new marker id: 8 random hex characters.
 *
 * @returns The id.
 */
function randomId(): string {
	return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// =============================================================================
// SECRET MARKERS
// =============================================================================

/** The markers of one run: each secret value the file tools hid, and the marker that stands for it. */
export class SecretMarkers {
	/** The marker of each hidden value, by the value as the file holds it. */
	private readonly markers = new Map<string, string>();
	/** The value each marker stands for. */
	private readonly values = new Map<string, string>();

	/**
	 * Hides the secret values in a file's text. Run it on the whole file,
	 * before any window: a window could cut a value in half, and half a key
	 * no longer matches.
	 *
	 * @param path - The file's path; its name decides whether fields are read as JSON, YAML or `NAME=value` lines.
	 * @param text - The file's full text.
	 * @returns The text with markers, and the note for the end of a read ('' when nothing was hidden).
	 */
	hide(path: string, text: string): { text: string; note: string } {
		const spans = this.spans(path, text);
		if (spans.length === 0) return { text, note: '' };
		return {
			text: replaceSpans(text, spans, (value) => this.markerFor(value)),
			note: hiddenNote(spans.map((span) => span.where || lineOf(text, span.start))),
		};
	}

	/**
	 * Where an edit anchor matches a file as the model sees it, each secret
	 * value hidden behind its marker. Matched against the real text instead,
	 * an anchor holding a guess at part of a value would tell the model
	 * whether the guess is right. An anchor that holds part of a marker
	 * matches nothing.
	 *
	 * @param path - The file's path.
	 * @param text - The file's full text.
	 * @param anchor - The model's anchor, markers and all.
	 * @returns Each match as a span of `text`, in order, none overlapping.
	 */
	anchors(path: string, text: string, anchor: string): Array<{ start: number; end: number }> {
		// step: lay the text out as a read shows it, keeping where each marker sits in both
		const placed: Array<{ at: number; end: number; start: number; stop: number }> = [];
		let shown = '';
		let from = 0;
		for (const span of this.spans(path, text)) {
			shown += text.slice(from, span.start);
			const marker = this.markerFor(text.slice(span.start, span.end));
			placed.push({ at: shown.length, end: shown.length + marker.length, start: span.start, stop: span.end });
			shown += marker;
			from = span.end;
		}
		shown += text.slice(from);

		// step: a position outside every marker maps to the real text through the last marker before it
		const real = (at: number): number => {
			const before = placed.filter((p) => p.end <= at).pop();
			return before ? before.stop + (at - before.end) : at;
		};
		const matches: Array<{ start: number; end: number }> = [];
		for (let at = shown.indexOf(anchor); at >= 0; ) {
			const end = at + anchor.length;
			if (placed.some((p) => at < p.end && end > p.at && (at > p.at || end < p.end))) {
				at = shown.indexOf(anchor, at + 1);
				continue;
			}
			matches.push({ start: real(at), end: real(end) });
			at = shown.indexOf(anchor, end);
		}
		return matches;
	}

	/**
	 * Hides the values this run already hid that look like a key, wherever
	 * they appear: a save's note may quote the config the engine just
	 * validated, and a run's output or an error may quote a value too.
	 *
	 * @param text - A tool result, an error, or a card or answer the chat shows.
	 * @returns The text with each known value replaced by its marker.
	 */
	hideKnown(text: string): string {
		const spans = this.known(text);
		return spans.length === 0 ? text : replaceSpans(text, spans, (value) => this.markerFor(value));
	}

	/**
	 * Puts back the value of each marker, before a write.
	 *
	 * @param text - Content or an edit anchor from the model.
	 * @param op - The tool name, for the refusal.
	 * @returns The text with every marker replaced by its value.
	 * @throws When a marker is not one this run made.
	 */
	reveal(text: string, op: string): string {
		return text.replace(MARKER_PATTERN, (marker) => {
			const value = this.values.get(marker);
			if (value === undefined) throw new Error(`${op} refused: ${marker} is not a marker from this run. Read the file again and keep its markers as they are.`);
			return value;
		});
	}

	/**
	 * The marker of a value, made the first time the value is hidden.
	 *
	 * @param value - The value as the file holds it.
	 * @returns Its marker.
	 */
	private markerFor(value: string): string {
		let marker = this.markers.get(value);
		if (marker === undefined) {
			do {
				marker = `«secret:${randomId()}»`;
			} while (this.values.has(marker));
			this.markers.set(value, marker);
			this.values.set(marker, value);
		}
		return marker;
	}

	/**
	 * Where a file's text holds a secret value: its secret fields, what
	 * `findSecrets` finds, and the values this run already hid. The values
	 * found here are learned first, so a second copy of one that looks like a
	 * key, where no field name or shape gives it away, is hidden on the first
	 * read too.
	 *
	 * @param path - The file's path; its name decides whether fields are read as JSON, YAML or `NAME=value` lines.
	 * @param text - The file's full text.
	 * @returns The spans, in order, none overlapping.
	 */
	private spans(path: string, text: string): Found[] {
		const fields = JSON_FILE.test(path) ? jsonFields(text) : YAML_FILE.test(path) ? lineFields(text, YAML_FIELD, yamlScalar) : KEY_VALUE_FILE.test(path) ? keyValueFields(path, text) : [];
		const shapes = findSecrets(text).map(({ start, end }) => ({ start, end, where: '' }));
		const found = mergeSpans([...fields, ...shapes]);
		for (const span of found) this.markerFor(text.slice(span.start, span.end));
		return mergeSpans([...found, ...this.known(text)]);
	}

	/**
	 * Where a text holds a value this run already hid.
	 *
	 * @param text - Any text.
	 * @returns The spans of every known value of 16 characters or more, or of 8 or more with a character that is not a letter, in order, none overlapping.
	 */
	private known(text: string): Found[] {
		const found: Found[] = [];
		for (const value of this.markers.keys()) {
			if (value.length < KNOWN_MIN_CHARS || (value.length < KNOWN_MIN_WORD_CHARS && !NOT_A_LETTER.test(value))) continue;
			for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length)) found.push({ start: at, end: at + value.length, where: '' });
		}
		return mergeSpans(found);
	}
}
