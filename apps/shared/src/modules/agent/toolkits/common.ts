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
 * tokens, credentials, private keys, access/account/ssh keys (including
 * `serviceAccountKey`), bearer values, auth and header values, webhook URLs and
 * connection strings.
 *
 * A bare `url` is not matched: it is too common a field name to hide. The one
 * secure field that goes by it (graph_falkordb.url) is a known gap.
 */
const SECRET_KEY = /api[_-]?key|secret|passw(?:or)?d|passphrase|token|credential|private[_-]?key|(?:access|account|ssh)[_-]?key|bearer|auth(?:orization)?[_-]?value|header[_-]?value|webhook[_-]?url|connection[_-]?string/i;

/** A secret reference: `${ROCKETRIDE_*}` names a key without holding it. */
const PLACEHOLDER = /^\$\{ROCKETRIDE_\w+\}$/;

// =============================================================================
// CLIP
// =============================================================================

/**
 * Cuts text that is too long and says how much was cut and what to do about it.
 *
 * @param text - The text to return.
 * @param hint - How the model can see less or see the rest (shown in the cut notice).
 * @param max - The most characters to keep.
 * @returns The text unchanged when it fits, otherwise its first `max` characters and a notice.
 */
export function clip(text: string, hint: string, max: number = RESULT_MAX_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[TRUNCATED: showing first ${max} of ${text.length} chars — ${hint}]`;
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
		const named = SECRET_KEY.test(key);
		out[key] = redactValue(child, secret || named);
	}
	return out;
}

/**
 * Copies a value with every secret string replaced by `[redacted]`.
 *
 * A string is a secret when its key looks like one (see `SECRET_KEY`: api key,
 * secret, password, token, credential, private/access/account/ssh key, bearer,
 * auth or header value, webhook URL, connection string), or when a key like that
 * sits above it. That includes a field named `token`: node configs use it for
 * real secrets. A bare `url` is not hidden, so graph_falkordb.url (a secure
 * field) is a known gap. `${ROCKETRIDE_*}` placeholders stay, since they name a
 * secret without holding it. Numbers, booleans and null are never changed.
 *
 * @param value - The value a tool is about to show the model.
 * @returns A deep copy; the input is not changed.
 */
export function redactSecrets<T>(value: T): T {
	return redactValue(value, false) as T;
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
 * @returns The tool's result string.
 */
export function toolText(value: unknown, hint: string): string {
	return clip(JSON.stringify(redactSecrets(value), null, 1) ?? 'null', hint);
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
 * Error text made fit for a summary: the raw text on one line, cut short. The
 * step output keeps the full text.
 *
 * @param text - The raw error text.
 * @returns At most about 200 characters on one line.
 */
export function brief(text: string): string {
	const line = text.replace(/\s+/g, ' ').trim();
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
