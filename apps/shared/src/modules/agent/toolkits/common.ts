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
// ROCKETRIDE COMMON — what every RocketRide tool shares
// =============================================================================

import type { RocketRideClient } from 'rocketride';

import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';

// =============================================================================
// ROCKETRIDE CLIENT — how agent code reaches the connected client
// =============================================================================

/**
 * Agent code never calls the shell's getClient() itself (it is undefined
 * under the test runner). The host passes in a getter, and this section turns a
 * missing client into an error the model can read.
 */

/** The error message when there is no connected client. */
export const NOT_CONNECTED_MESSAGE = 'Not connected to RocketRide — reconnect and try again.';

/** Returns the connected client, or null when there is none. */
export type ClientGetter = () => RocketRideClient | null;

/**
 * The connected client, or an error that says how to recover.
 *
 * @param get - The host's client getter.
 * @returns The connected client.
 */
export function requireClient(get: ClientGetter): RocketRideClient {
	const client = get();
	if (!client) throw new Error(NOT_CONNECTED_MESSAGE);
	return client;
}

// =============================================================================
// UNSAVED CHANGES — asking the user what to do with their unsaved typing
// =============================================================================

/** What the user chose; 'unasked' means the question never showed, because another dialog was open. */
export type UnsavedChoice = 'save' | 'discard' | 'keep' | 'unasked';

/**
 * Asks the user what to do with their unsaved changes. Escape means 'keep',
 * and so does `signal` aborting (the run ended), which also takes the dialog
 * down. The host passes it in, so tests answer without a browser.
 */
export type ChoiceFn = (title: string, message: string, signal?: AbortSignal) => Promise<UnsavedChoice>;

/** The three-button dialog in ../choice.tsx, loaded on the first question so the test runner never loads React DOM. */
export function shellChoice(): ChoiceFn {
	return async (title, message, signal) => (await import('../choice')).showChoice(title, message, signal);
}

// =============================================================================
// TOOL RESULTS — clipping, secret stripping and the text a tool returns
// =============================================================================

/**
 * Every RocketRide tool returns a string, and the model reads all of it. These
 * helpers keep that string short enough to be useful and free of secrets:
 * `clip` cuts long text and says how to see the rest, `redactSecrets` strips
 * secret values from anything a RocketRide tool shows the model, and `toolText`
 * does both for a client result.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** The most characters a tool returns before its text is cut. */
export const RESULT_MAX_CHARS = 32_000;

/** What a secret value is replaced with. */
const REDACTED = '[redacted]';

/**
 * Field names that hold secrets: api keys, secrets, passwords and passphrases,
 * credentials, private keys, access/account/ssh keys (including
 * `serviceAccountKey`), bearer values, auth and header values, webhook URLs and
 * connection strings. A name is read as words (`secretKind`), and this is
 * tested against the words joined, up to the end of each word in turn: so
 * `client_secret`, `secretKey` and `apikey` match, and `secretary` and
 * `passwordless` do not.
 *
 * A bare `url` is not matched: it is too common a field name to hide. The one
 * secure field that goes by it (graph_falkordb.url) is a known gap.
 */
const SECRET_WORD = /(?:apikey|secret|passw(?:or)?d|passphrase|credential|privatekey|(?:access|account|ssh)key|bearer|auth(?:orization)?value|headervalue|webhookurl|connectionstring)s?$/;

/**
 * A token field: the name's last word is `token` (`token`, `auth_token`,
 * `refreshToken`). With other words after it, `token` names a setting
 * (`token_limit`, `token_count`); `tokens` and `tokenizer` are other words.
 */
const TOKEN_WORD = /token$/;

/**
 * A variable reference: `${NAME}` names a value without holding it. The server
 * fills in only `${ROCKETRIDE_*}`, and any other name arrives as written, so
 * neither holds a key. The guide's wrong-prefix example, `"apikey":
 * "${OPENAI_KEY}"`, must reach the model whole.
 */
const PLACEHOLDER = /^\$\{[A-Za-z_]\w*\}$/;

// =============================================================================
// CLIP
// =============================================================================

/**
 * Redacts text, then cuts it when it is too long and says how much was cut
 * and what to do about it.
 *
 * @param text - The text to return.
 * @param hint - How the model can see less or see the rest (shown in the cut notice).
 * @param max - The most characters to keep.
 * @returns The redacted text when it fits, otherwise its first `max` characters and a notice.
 */
export function clip(text: string, hint: string, max: number = RESULT_MAX_CHARS): string {
	// redact before the cut: a cut inside a credential leaves a part no pattern matches
	const safe = redactText(text);
	if (safe.length <= max) return safe;
	return `${safe.slice(0, max)}\n[TRUNCATED: showing first ${max} of ${safe.length} chars — ${hint}]`;
}

// =============================================================================
// REDACT
// =============================================================================

/**
 * Whether a value is something to copy and walk into: an array or a plain object.
 *
 * @param value - Any value.
 * @returns True for arrays and plain objects.
 */
export function isWalkable(value: unknown): value is Record<string, unknown> | unknown[] {
	if (Array.isArray(value)) return true;
	if (typeof value !== 'object' || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** What a secret-named field is named for: a token, or any other secret (see `secretKind`). */
export type SecretKind = 'token' | 'secret';

/**
 * The words of a field name, lower-cased. `_`, `-`, `.`, spaces, digits and
 * camelCase all split words: `OPENAI_API_KEY`, `openaiApiKey` and
 * `openai.api-key` all give `openai`, `api`, `key`.
 *
 * @param name - A JSON or YAML key.
 * @returns Its words, in order.
 */
function nameWords(name: string): string[] {
	return name
		.replace(/([a-z\d])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z]+/)
		.filter((word) => word.length > 0);
}

/**
 * Whether a field name holds secrets, and what kind. The name is read as
 * words, so a word inside another word does not count: `max_tokens`,
 * `tokenizer` and `token_limit` are not secret-named, and `auth_token` is.
 *
 * @param name - A JSON or YAML key.
 * @returns 'secret' for a `SECRET_WORD`, 'token' when the last word is `token`, or null.
 */
export function secretKind(name: string): SecretKind | null {
	let joined = '';
	for (const word of nameWords(name)) {
		joined += word;
		if (SECRET_WORD.test(joined)) return 'secret';
	}
	return TOKEN_WORD.test(joined) ? 'token' : null;
}

/**
 * Whether a field name holds secrets (see `secretKind`).
 *
 * @param name - A JSON or YAML key.
 * @returns True for api keys, secrets, passwords, tokens and the rest of `SECRET_WORD`.
 */
export function isSecretName(name: string): boolean {
	return secretKind(name) !== null;
}

/**
 * Copies a value, hiding strings that are secrets.
 *
 * @param value - The value to copy.
 * @param secret - True when a secret-named key sits above this value.
 * @returns The copy.
 */
function redactValue(value: unknown, secret: boolean): unknown {
	if (typeof value === 'string') return secret && !PLACEHOLDER.test(value) ? REDACTED : value;
	if (Array.isArray(value)) return value.map((item) => redactValue(item, secret));
	if (!isWalkable(value)) return value;

	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		const named = isSecretName(key);
		out[key] = redactValue(child, secret || named);
	}
	return out;
}

/**
 * Copies a value with every secret string replaced by `[redacted]`.
 *
 * A string is a secret when its key looks like one (see `secretKind`: api key,
 * secret, password, token, credential, private/access/account/ssh key, bearer,
 * auth or header value, webhook URL, connection string), or when a key like that
 * sits above it. That includes a field named `token`: node configs use it for
 * real secrets. A bare `url` is not hidden, so graph_falkordb.url (a secure
 * field) is a known gap. `${NAME}` placeholders stay, since they name a
 * secret without holding it. Numbers, booleans and null are never changed.
 *
 * @param value - The value a tool is about to show the model.
 * @returns A deep copy; the input is not changed.
 */
export function redactSecrets<T>(value: T): T {
	return redactValue(value, false) as T;
}

// =============================================================================
// REDACT TEXT — credentials inside free text
// =============================================================================

/**
 * `redactSecrets` works on structured results, by field name. Text has no
 * fields, so `findSecrets` looks for what a credential looks like: a known key
 * shape, a bearer token, a password in a URL, a private key block, or a JSON
 * string or number under a secret-named key (`"apikey": "..."`). `redactText`
 * hides what it finds; every tool result passes through it on its way to the
 * model (wave/loop.ts), and so do the answer, the session rows and the title.
 * `looksLikeCredential` runs the same search on what the user types, and
 * counts only what is sure to be a key. The file tools put markers in place
 * of these instead (`./secretMarkers.ts`), so an edit can put the real value
 * back; `redactText` leaves every marker as it is, since `[redacted]` in its
 * place would be written over the value.
 *
 * Bare `key: value` and `NAME=value` lines are left to the file markers, which
 * apply them to YAML and `.env`-style files only: in code, `token: string` is
 * a type, not a secret.
 */

/** One credential found in text. */
export interface SecretSpan {
	/** Where it starts. */
	start: number;
	/** Where it ends (exclusive). */
	end: number;
	/** What it looks like, as the pasted-key message names it ("OpenAI-style"). */
	kind: string;
	/** Whether it is sure to be a key, sure enough to hold a pasted message back: a key shape, a private key or a URL password. */
	sure: boolean;
}

/** A marker the file tools show in place of a secret value: `«secret:<id>»`. */
const MARKER = /^«secret:[^»\s]{1,64}»$/;

/** Every marker in a text. */
const MARKERS = /«secret:[^»\s]{1,64}»/g;

/**
 * Credential shapes, most specific first, each with the kind it is reported
 * as. A lookbehind keeps a shape from starting inside a longer word (`task-…`
 * holds `sk-`). For bearer tokens and URL passwords only the secret part
 * matches, so `Bearer` and the user and host stay readable. A bearer token is
 * not sure: `Bearer` may be followed by an ordinary word. A URL password stops
 * at `?` and `#`, which a URL cannot hold before its host, and at `«`, which
 * starts a marker. A prefix that ordinary text also starts with (FullCalendar's
 * `fc-` classes, the model name `pplx-70b-online`) matches only when as many
 * key characters follow it as a real key has.
 */
const SHAPES: ReadonlyArray<{ kind: string; sure: boolean; pattern: RegExp }> = [
	// An unclosed block (a read window cut it) runs to the end of the text.
	{ kind: 'a private key', sure: true, pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
	{ kind: 'Anthropic-style', sure: true, pattern: /(?<![\w-])sk-ant-[\w-]{16,}/g },
	{ kind: 'OpenAI-style', sure: true, pattern: /(?<![\w-])sk-[\w-]{16,}/g },
	{ kind: 'Stripe-style', sure: true, pattern: /(?<![\w-])[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
	{ kind: 'AWS-style', sure: true, pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g },
	{ kind: 'GitHub-style', sure: true, pattern: /(?<![\w-])(?:gh[oprsu]_[A-Za-z0-9]{30,}|github_pat_\w{22,})/g },
	{ kind: 'Slack-style', sure: true, pattern: /(?<![\w-])xox[abp]-[A-Za-z0-9-]{20,}/g },
	{ kind: 'Google-style', sure: true, pattern: /(?<![\w-])AIza[\w-]{35,}/g },
	{ kind: 'xAI-style', sure: true, pattern: /(?<![\w-])xai-[A-Za-z0-9_]{80,}/g },
	{ kind: 'Perplexity-style', sure: true, pattern: /(?<![\w-])pplx-[A-Za-z0-9]{48,}/g },
	{ kind: 'Tavily-style', sure: true, pattern: /(?<![\w-])tvly-[\w-]{20,}/g },
	{ kind: 'Pinecone-style', sure: true, pattern: /(?<![\w-])pcsk_[A-Za-z0-9]{5,6}_[A-Za-z0-9]{63,}/g },
	// `fc-` and a UUID without its dashes
	{ kind: 'Firecrawl-style', sure: true, pattern: /(?<![\w-])fc-[0-9a-f]{32}(?![A-Za-z0-9])/g },
	{ kind: 'a bearer token', sure: false, pattern: /(?<=\bBearer )[\w.~+/-]{20,}=*/g },
	{ kind: 'a password in a URL', sure: true, pattern: /(?<=\b[a-z][\w+.-]*:\/\/[^\s/:@?#«»]*:)[^\s/@?#«»]+(?=@)/gi },
];

/** A JSON string or number under its key, escapes allowed: group 1 is the key, group 2 a string's value as written, group 3 a number. */
const JSON_FIELD = /"((?:[^"\\\n]|\\.){1,100})"\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|(-?\d[\d.eE+-]*))/g;

/** A plain number. Under a token name it is a count or a limit (`"max_token": "4096"`), not a secret. */
const NUMBER = /^-?\d+(?:\.\d+)?$/;

/** The run token's prefix. `use` and `deploy.run` hand the run token to the model on purpose (`./rocketrideClient.ts`). */
const RUN_TOKEN_PREFIX = 'tk_';

/**
 * Whether a value under a secret-named field holds no secret: it is empty, a
 * `${NAME}` placeholder, a file marker, already `[redacted]`, or a
 * plain number under a token name.
 *
 * @param value - The field's value, unescaped.
 * @param kind - What the field is named for; a password or secret field holds a number as a secret.
 * @returns True when there is nothing to hide.
 */
export function holdsNoSecret(value: string, kind: SecretKind = 'secret'): boolean {
	return value === '' || value === REDACTED || PLACEHOLDER.test(value) || MARKER.test(value) || (kind === 'token' && NUMBER.test(value));
}

/**
 * A JSON string's content as written, unescaped.
 *
 * @param raw - The text between the quotes.
 * @returns The string it stands for; `raw` itself when its escapes do not parse.
 */
export function unescapeJson(raw: string): string {
	try {
		return JSON.parse(`"${raw}"`) as string;
	} catch {
		return raw;
	}
}

/**
 * Every credential in a text, in order of where it starts, overlaps kept. A
 * file marker already stands for a value, so a span that touches one is left
 * out. Each marker is read as a run of digits: part of a word, as the value
 * it hides was, and the start of no shape or URL scheme. So a shape next to a
 * marker matches only where it matched before the value was hidden:
 * `-----END PRIVATE KEY-----sk-…` holds no `sk-` key, and hiding the block
 * must not make one.
 *
 * @param text - Any text.
 * @returns Each one's place, kind and sureness.
 */
function credentials(text: string): SecretSpan[] {
	const markers = [...text.matchAll(MARKERS)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
	const touchesMarker = (start: number, end: number): boolean => markers.some((marker) => start < marker.end && end > marker.start);
	if (markers.length > 0) text = text.replace(MARKERS, (marker) => '0'.repeat(marker.length));
	const spans: SecretSpan[] = [];
	for (const { kind, sure, pattern } of SHAPES) {
		for (const m of text.matchAll(pattern)) {
			if (!touchesMarker(m.index, m.index + m[0].length)) spans.push({ start: m.index, end: m.index + m[0].length, kind, sure });
		}
	}
	for (const m of text.matchAll(JSON_FIELD)) {
		const [whole, key, quoted, number] = m;
		const named = secretKind(unescapeJson(key));
		const raw = quoted ?? number;
		const value = quoted === undefined ? number : unescapeJson(quoted);
		// The run token is the one secret-named value the model is meant to read. A key that holds a marker is not a key the file had.
		if (!named || holdsNoSecret(value, named) || (key === 'token' && value.startsWith(RUN_TOKEN_PREFIX)) || touchesMarker(m.index, m.index + whole.length)) continue;
		const end = m.index + whole.length - (quoted === undefined ? 0 : 1);
		spans.push({ start: end - raw.length, end, kind: `the "${key}" field`, sure: false });
	}
	return spans.sort((a, b) => a.start - b.start);
}

/**
 * Every credential in a text, in order, overlaps merged.
 *
 * @param text - Any text.
 * @returns Where each one is and what kind it is; empty when there is none.
 */
export function findSecrets(text: string): SecretSpan[] {
	return mergeSpans(credentials(text));
}

/**
 * Sorts spans and merges the ones that overlap; a merged span keeps the kind
 * of the one that starts first.
 *
 * @param spans - Spans in any order.
 * @returns Spans in order, none overlapping.
 */
export function mergeSpans<T extends { start: number; end: number }>(spans: T[]): T[] {
	const merged: T[] = [];
	for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
		const last = merged[merged.length - 1];
		if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
		else merged.push({ ...span });
	}
	return merged;
}

/**
 * Replaces each span of a text.
 *
 * @param text - The text.
 * @param spans - Spans in order, none overlapping (see `mergeSpans`).
 * @param replace - The replacement for a span, given its text.
 * @returns The text with every span replaced.
 */
export function replaceSpans<T extends { start: number; end: number }>(text: string, spans: T[], replace: (found: string, span: T) => string): string {
	let out = '';
	let at = 0;
	for (const span of spans) {
		out += text.slice(at, span.start) + replace(text.slice(span.start, span.end), span);
		at = span.end;
	}
	return out + text.slice(at);
}

/**
 * Hides every credential in a text (see `findSecrets`) as `[redacted]`.
 * `${NAME}` placeholders, file markers and the run token stay.
 *
 * @param text - Text on its way to the model, the chat or the session file.
 * @returns The text with each credential replaced; the same text when there is none.
 */
export function redactText(text: string): string {
	const spans = findSecrets(text);
	return spans.length === 0 ? text : replaceSpans(text, spans, () => REDACTED);
}

/**
 * Whether a text holds something sure to be a credential: a key shape, a
 * private key or a password in a URL. Used on what the user types, before
 * anything is sent. A secret-named field or a `Bearer` word is not enough:
 * `"max_token": "4096"` and "the API wants Bearer token_from_login" are not
 * keys, and holding them back would stop the user.
 *
 * @param text - The user's message.
 * @returns The kind of the first one found ("OpenAI-style"), or null.
 */
export function looksLikeCredential(text: string): string | null {
	return credentials(text).find((span) => span.sure)?.kind ?? null;
}

// =============================================================================
// TOOL TEXT
// =============================================================================

/**
 * Turns a client result into the string a tool returns: secrets stripped,
 * pretty-printed, and clipped.
 *
 * @param value - The client's result.
 * @param hint - How the model can see less or see the rest if the text is cut.
 * @param hide - Hides the values the run's file tools hid, before the cut.
 * @returns The tool's result string.
 */
export function toolText(value: unknown, hint: string, hide = (text: string): string => text): string {
	return clip(hide(JSON.stringify(redactSecrets(value), null, 1) ?? 'null'), hint);
}

// =============================================================================
// ARGUMENTS — the model's number and text arguments
// =============================================================================

/**
 * A number argument, given as a number or numeric text.
 *
 * @param args - The tool arguments.
 * @param key - The argument name.
 * @param whole - True when only whole numbers are valid.
 * @returns The number; undefined when the argument is absent.
 * @throws When the argument is not a number.
 */
export function numberArg(args: Record<string, unknown>, key: string, whole = false): number | undefined {
	const raw = args[key];
	if (raw === undefined || raw === null || raw === '') return undefined;
	const value = typeof raw === 'string' ? Number(raw) : raw;
	if (typeof value !== 'number' || !Number.isFinite(value) || (whole && !Number.isInteger(value))) {
		throw new Error(`${key} must be a ${whole ? 'whole number' : 'number'}.`);
	}
	return value;
}

/**
 * A text argument, trimmed.
 *
 * @param args - The tool arguments.
 * @param key - The argument name.
 * @returns The text; empty when the argument is absent or not text.
 */
export function textArg(args: Record<string, unknown>, key: string): string {
	const raw = args[key];
	return typeof raw === 'string' ? raw.trim() : '';
}

// =============================================================================
// SUMMARIES AND WAITS
// =============================================================================

/** The longest the detail in a summary runs, in characters; the step output has the full text. */
const SUMMARY_DETAIL_MAX_CHARS = 200;

/**
 * Error text made fit for a summary: the text redacted, on one line, cut
 * short. The step output keeps the full text.
 *
 * @param text - The raw error text.
 * @returns At most about 200 characters on one line.
 */
export function brief(text: string): string {
	// redact before the cut: a cut inside a credential leaves a part no pattern matches
	const line = redactText(text).replace(/\s+/g, ' ').trim();
	return line.length > SUMMARY_DETAIL_MAX_CHARS ? `${line.slice(0, SUMMARY_DETAIL_MAX_CHARS - 1).trimEnd()}…` : line;
}

/**
 * Waits.
 *
 * @param ms - Milliseconds.
 * @param signal - Ends the wait at once when it aborts (immediately if it already has).
 * @returns Resolves after the wait, or when the signal aborts.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const end = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', end);
			resolve();
		};
		const timer = setTimeout(end, ms);
		signal?.addEventListener('abort', end, { once: true });
	});
}

// =============================================================================
// PIPE FILES — turning a path or an inline object into the flat pipeline config
// =============================================================================

/**
 * `pipelineArg` serves the validate every `.pipe` save runs and the client
 * tool's `filepath`. It takes a pipeline two ways: `path` (a `.pipe` file in the
 * workspace) or `pipeline` (the object itself). Either may be wrapped as
 * `{ "pipeline": { ... } }`, the way a saved `.pipe` file often is. The client's
 * `use()` and `validate()` want the flat config (`components`, `source` and
 * `project_id` at the top level), so `pipelineArg` hands back that shape.
 */

// =============================================================================
// TYPES
// =============================================================================

/** A JSON object: not null, not an array. */
export type JsonObject = Record<string, unknown>;

// =============================================================================
// CONSTANTS
// =============================================================================

/** The message when neither argument is given. */
const NEED_ONE = 'Pass path (a .pipe file in the workspace) or pipeline (the pipeline object).';

/** How to write a path that a path refusal asks for. */
const FROM_ROOT = 'Pass the path from the workspace root, for example pipelines/chat.pipe.';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Whether a value is a JSON object.
 *
 * @param value - Any value.
 * @returns True for a non-null, non-array object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strips the `{ "pipeline": { ... } }` wrapper. The engine reads a missing
 * version as legacy, so a version written beside the wrapper moves inside.
 *
 * @param file - A pipeline object, wrapped or flat.
 * @returns The flat config.
 */
function unwrap(file: JsonObject): JsonObject {
	const inner = file.pipeline;
	if (!isJsonObject(inner)) return file;
	return typeof file.version === 'number' && inner.version === undefined ? { ...inner, version: file.version } : inner;
}

/**
 * The text of a failure, ready to sit inside a longer message.
 *
 * @param err - Whatever was thrown.
 * @returns Its message without a closing period, so a sentence can follow.
 */
export function messageOf(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).replace(/[.\s]+$/, '');
}

/**
 * Spells a workspace path the one way the workspace stores it, so `./pipelines/x.pipe`,
 * `/pipelines/x.pipe` and `pipelines\x.pipe` all name `pipelines/x.pipe`. Unlike the
 * file tools' `normalizePath` (`./filesystem.ts`), which refuses a `.` segment,
 * this drops it, because a leading `./` is how people write a relative path.
 *
 * @param raw - The path as the model passed it.
 * @returns The path with `/` separators and no empty or `.` segments.
 * @throws When a segment is `..`, or no segment is left; the message says what to pass instead.
 */
export function workspacePath(raw: string): string {
	const segments = raw
		.replace(/\\/g, '/')
		.split('/')
		.filter((segment) => segment !== '' && segment !== '.');
	if (segments.includes('..')) throw new Error(`Path '${raw}' uses '..', which the workspace does not allow. ${FROM_ROOT}`);
	if (segments.length === 0) throw new Error(`Path '${raw}' names no file. ${FROM_ROOT}`);
	return segments.join('/');
}

/**
 * Reads and parses one pipeline file.
 *
 * @param vfs - The workspace view.
 * @param path - The workspace path of the file.
 * @returns The file's JSON object, wrapped or flat.
 * @throws When the file is missing, is not JSON, or is not an object.
 */
async function readPipeFile(vfs: IWorkspaceFileSystem, path: string): Promise<JsonObject> {
	let raw: unknown;
	try {
		raw = await vfs.read(path);
	} catch (err) {
		throw new Error(`Cannot read '${path}': ${messageOf(err)}. list_workspace shows the pipeline files.`);
	}

	let parsed: unknown = raw;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			// The parser's message quotes part of the file, which may hold a key
			// someone pasted in, so say only where it broke.
			const at = /position (\d+)/.exec(messageOf(err))?.[1];
			throw new Error(`'${path}' is not valid JSON${at ? ` (near character ${at})` : ''}. Fix the syntax and try again.`);
		}
	}
	if (!isJsonObject(parsed)) throw new Error(`'${path}' must hold a JSON object.`);
	return parsed;
}

// =============================================================================
// PIPELINE ARGUMENT
// =============================================================================

/**
 * Resolves a tool call's `path` or `pipeline` argument to a flat pipeline config.
 *
 * @param args - The tool arguments; exactly one of `path` and `pipeline`.
 * @param vfs - The workspace view a `path` is read from.
 * @returns The flat config, and the `path` (spelled as `workspacePath` spells it) when that is where it came from.
 * @throws When both or neither argument is given, the path holds `..` or no file, or the pipeline cannot be read; the message says how to fix it.
 */
export async function pipelineArg(args: Record<string, unknown>, vfs: IWorkspaceFileSystem): Promise<{ pipeline: JsonObject; path?: string }> {
	const raw = typeof args.path === 'string' ? args.path.trim() : '';
	const given = args.pipeline !== undefined && args.pipeline !== null;

	if (raw && given) throw new Error('Pass either path or pipeline, not both.');
	if (raw) {
		const path = workspacePath(raw);
		return { pipeline: unwrap(await readPipeFile(vfs, path)), path };
	}
	if (!given) throw new Error(NEED_ONE);
	if (!isJsonObject(args.pipeline)) throw new Error('pipeline must be a JSON object. Pass the object itself (not text), or pass path.');
	return { pipeline: unwrap(args.pipeline) };
}
