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
// SAVED QUERIES — named statements kept per connection (the pure store)
// =============================================================================
//
// A saved query is a statement the user chose to keep, under a name, for one
// connection. Unlike history nothing is recorded on its own and nothing is
// trimmed: a save past a bound is REFUSED, and the user is told why, rather
// than an older query silently making room. Saved queries keep the text,
// never results.
//
// Where they live follows the mount, as history does:
//
//   full app   the shell's workspace preferences, key `sql.savedQueries`,
//              through the accessor history uses (history/localSavedQueries.ts);
//   dev tool   the CONTROLLER's own file in the user's store,
//              SAVED_QUERIES_PATH, one bag per account
//              (history/savedQueriesFile.ts); frames read and edit through
//              ops (history/remoteSavedQueries.ts).
//
// Everything here is pure: the bag, its checks and its bounds. What may cross
// from a frame is checked here, so the controller never writes anything but
// well-formed queries into the user's file. The preference key and the
// fields of a persisted query must never change: renaming either silently
// orphans every user's saved queries. A write keeps what this build cannot
// read (an entry it cannot parse, a field it does not know) where it was, so
// a newer build's queries survive an older build's edit.
// =============================================================================

import { ExplorerToolError } from 'shared/explorer/errors';
import { isPlainObject } from 'shared/explorer/checks';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import type { SqlEndpoint } from '../connect';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Preference key holding every connection's saved queries. */
export const SAVED_QUERIES_PREF = 'sql.savedQueries';

/** The dev tool's file (beside the history file, in the user's store). */
export const SAVED_QUERIES_PATH = '@/User/.workspace/rocketride.sql.queries.json';

/** Saved queries one connection keeps. */
export const MAX_SAVED_QUERIES = 50;

/** Characters of statement one saved query holds. */
export const MAX_SAVED_SQL_CHARS = 16 * 1024;

/** Characters of name one saved query holds. */
export const MAX_SAVED_NAME_CHARS = 120;

/**
 * Characters the whole bag may take as the file is written (two-space
 * indented JSON), so one account's bag always fits the dev-tool file's cap
 * (shared/explorer/devtool/prefs MAX_PREFS_FILE_CHARS, twice this).
 */
export const MAX_SAVED_BAG_CHARS = 256 * 1024;

/** The longest suggested name (the dialog's field starts with it). */
const SUGGESTED_NAME_CHARS = 60;

// =============================================================================
// TYPES
// =============================================================================

/** One saved query. Every field is persisted under this name. */
export interface SavedQuery {
	/** Stable id (made where the query was first saved). */
	id: string;
	/** What the user called it. */
	name: string;
	/** The statement text, as typed. */
	sql: string;
	/** Epoch ms it was saved. */
	at: number;
}

/** Every connection's saved queries, keyed by endpoint key (newest first), as the reader shows them. */
export type SavedQueriesBag = Record<string, SavedQuery[]>;

/** The bag as stored: per connection a list that may also hold entries this build cannot read. */
export type StoredQueriesBag = Record<string, unknown>;

/** One change to a connection's saved queries. */
export type SavedQueryEdit =
	| { action: 'add'; query: SavedQuery }
	| { action: 'rename'; id: string; name: string }
	| { action: 'remove'; id: string };

/** Where the dev tool's controller keeps saved queries: its file, this session only (the file could not be read), or nowhere (nobody signed in). */
export type SavedQueriesStorage = 'file' | 'session' | 'none';

/** Where reading one connection's saved queries stands. */
export type SavedQueriesReadState =
	| { status: 'loading' }
	| { status: 'ready' }
	| { status: 'failed'; message: string };

/** One connection's saved queries, as the views use them (from SqlEnv). */
export interface SqlSavedQueriesApi {
	/** Subscribe to one connection's saved queries, newest first (a hook). */
	useSavedQueries(endpoint: SqlEndpoint): SavedQuery[];
	/** Subscribe to where reading them stands (a hook): an empty list means "none" only once this is ready. */
	useReadState(endpoint: SqlEndpoint): SavedQueriesReadState;
	/** Read one connection's saved queries again (after a failure). */
	retry(endpoint: SqlEndpoint): void;
	/** Where saved queries are kept, in one sentence: the panel's privacy line (a hook). */
	usePrivacyNotice(): string;
	/** Save one; rejects, saving nothing, past a cap or when nobody is signed in. */
	save(endpoint: SqlEndpoint, query: SavedQuery): Promise<void>;
	/** Rename one; rejects when it is gone or the name does not fit. */
	rename(endpoint: SqlEndpoint, id: string, name: string): Promise<void>;
	/** Delete one. */
	remove(endpoint: SqlEndpoint, id: string): Promise<void>;
}

// =============================================================================
// PRIVACY LINES
// =============================================================================

/** The full app's privacy line: saved queries ride the shell's workspace preferences. */
export const APP_SAVED_QUERIES_NOTICE = 'Saved in your RocketRide workspace file on the server, for your account, not in this browser. A saved query keeps its text as typed, including literal values, never its results.';

/**
 * The dev tool's privacy line for where its controller keeps saved queries.
 *
 * @param storage - Where they are kept.
 * @returns The sentence.
 */
export function devToolSavedQueriesNotice(storage: SavedQueriesStorage): string {
	switch (storage) {
		case 'file':
			return 'Saved in a file in your RocketRide user storage on the server (rocketride.sql.queries.json), for your account, not in this window. A saved query keeps its text as typed, including literal values, never its results. If two windows change saved queries at once, the last one to save wins.';
		case 'session':
			return 'Kept for this session only: the saved-queries file in your RocketRide user storage could not be read, so nothing is written to it. A saved query keeps its text as typed, including literal values.';
		default:
			return 'Not saved: nobody is signed in to a RocketRide server.';
	}
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * A refusal: nothing was changed.
 *
 * @param message - The sentence the user reads.
 * @returns The error.
 */
function refuse(message: string): ExplorerToolError {
	return new ExplorerToolError({ kind: 'invalid', tool: 'savedQueryEdit', message });
}

/**
 * Whether a value is a well-formed saved query.
 *
 * @param value - Anything.
 * @returns True for a saved query.
 */
function isSavedQuery(value: unknown): value is SavedQuery {
	return isPlainObject(value)
		&& typeof value.id === 'string' && value.id !== ''
		&& typeof value.name === 'string'
		&& typeof value.sql === 'string'
		&& typeof value.at === 'number' && Number.isFinite(value.at);
}

/**
 * A saved query with its own fields only, in the persisted order.
 *
 * @param query - The query.
 * @returns A clean copy.
 */
function cleanQuery(query: SavedQuery): SavedQuery {
	return { id: query.id, name: query.name, sql: query.sql, at: query.at };
}

/**
 * Whether a character may not appear in a name: control characters, and the
 * marks and overrides that change the direction text is shown in (a name is
 * shown on one line, in a list and on a tab).
 *
 * @param code - The character's code point.
 * @returns True when it is dropped.
 */
function unsafeInName(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code <= 0x9f)
		|| code === 0x200e || code === 0x200f
		|| (code >= 0x202a && code <= 0x202e)
		|| (code >= 0x2066 && code <= 0x2069);
}

/**
 * A name that fits: one plain line (white space runs, line breaks included,
 * become one space; control characters and direction overrides are dropped),
 * trimmed.
 *
 * @param name - What the user typed.
 * @param verb - What was being done ('saved', 'renamed').
 * @returns The name.
 * @throws ExplorerToolError `invalid` when it is empty or too long.
 */
function fittingName(name: string, verb: string): string {
	const plain = Array.from(name.replace(/\s+/g, ' ')).filter((char) => !unsafeInName(char.codePointAt(0) ?? 0)).join('');
	const trimmed = plain.replace(/ {2,}/g, ' ').trim();
	if (trimmed === '') throw refuse(`The query was not ${verb}: give it a name.`);
	if (trimmed.length > MAX_SAVED_NAME_CHARS) throw refuse(`The query was not ${verb}: a name holds at most ${MAX_SAVED_NAME_CHARS} characters.`);
	return trimmed;
}

// =============================================================================
// THE BAG
// =============================================================================

/**
 * Read a stored bag, keeping the well-formed queries only. Never throws: a
 * damaged entry is not shown, and not a reason to lose the rest (a write
 * keeps it; applySavedQueryEdit).
 *
 * @param raw - What the preferences hold.
 * @returns The bag.
 */
export function readSavedQueriesBag(raw: unknown): SavedQueriesBag {
	if (!isPlainObject(raw)) return {};
	const bag: SavedQueriesBag = {};
	for (const [key, list] of Object.entries(raw)) {
		if (!Array.isArray(list)) continue;
		const kept = list.filter(isSavedQuery).map(cleanQuery);
		if (kept.length > 0) bag[key] = kept;
	}
	return bag;
}

/**
 * Apply one edit to a stored bag. The bag given is never changed, and what
 * this build cannot read stays where it was: other connections' lists as
 * stored, entries it cannot parse, and fields it does not know.
 *
 * @param bag - The current bag, as stored.
 * @param key - The connection's endpoint key.
 * @param edit - The (checked) edit.
 * @returns The new bag (the same one when nothing changed).
 * @throws ExplorerToolError `invalid` when a cap or a missing query refuses it; nothing is changed.
 */
export function applySavedQueryEdit(bag: StoredQueriesBag, key: string, edit: SavedQueryEdit): StoredQueriesBag {
	const list: unknown[] = Array.isArray(bag[key]) ? (bag[key] as unknown[]) : [];
	const hasId = (entry: unknown, id: string): boolean => isPlainObject(entry) && entry.id === id;
	let next: unknown[];
	switch (edit.action) {
		case 'remove': {
			if (!list.some((entry) => hasId(entry, edit.id))) return bag;
			next = list.filter((entry) => !hasId(entry, edit.id));
			break;
		}
		case 'rename': {
			const name = fittingName(edit.name, 'renamed');
			if (!list.some((entry) => isSavedQuery(entry) && entry.id === edit.id)) throw refuse('The query was not renamed: it no longer exists.');
			next = list.map((entry) => (isSavedQuery(entry) && entry.id === edit.id ? { ...entry, name } : entry));
			break;
		}
		default: {
			const name = fittingName(edit.query.name, 'saved');
			const { sql } = edit.query;
			if (sql.trim() === '') throw refuse('The query was not saved: there is no statement to save.');
			if (sql.length > MAX_SAVED_SQL_CHARS) {
				throw refuse(`The query was not saved: a saved query holds at most ${MAX_SAVED_SQL_CHARS.toLocaleString('en-US')} characters, and this one has ${sql.length.toLocaleString('en-US')}.`);
			}
			const query = { ...cleanQuery(edit.query), name };
			// The same id again (a call sent twice) replaces it where it stands,
			// keeping any field this build does not know.
			if (list.some((entry) => hasId(entry, query.id))) {
				next = list.map((entry) => (hasId(entry, query.id) ? { ...(entry as object), ...query } : entry));
			} else {
				// Counted as the user sees them: an entry nobody can see or delete never blocks a save.
				if (list.filter(isSavedQuery).length >= MAX_SAVED_QUERIES) {
					throw refuse(`The query was not saved: this connection already keeps ${MAX_SAVED_QUERIES} saved queries. Delete one to save another.`);
				}
				next = [query, ...list];
			}
		}
	}
	const result: StoredQueriesBag = { ...bag };
	if (next.length > 0) result[key] = next;
	else delete result[key];
	// Measured as the file is written (two-space indented JSON).
	if (edit.action !== 'remove' && JSON.stringify(result, null, 2).length > MAX_SAVED_BAG_CHARS) {
		throw refuse(`The query was not ${edit.action === 'add' ? 'saved' : 'renamed'}: saved queries are full (${MAX_SAVED_BAG_CHARS / 1024} KB across all connections). Delete some to save more.`);
	}
	return result;
}

/**
 * One connection's saved queries, read through a preferences accessor.
 *
 * @param prefs - The accessor (workspace preferences, or the controller's file).
 * @param key - The connection's endpoint key.
 * @returns Its saved queries, newest first (empty when none).
 */
export function savedQueriesIn(prefs: IPrefsAccessor, key: string): SavedQuery[] {
	return readSavedQueriesBag(prefs.getPref(SAVED_QUERIES_PREF))[key] ?? [];
}

/**
 * Apply one edit through a preferences accessor. A refused edit writes nothing.
 *
 * @param prefs - The accessor.
 * @param key - The connection's endpoint key.
 * @param edit - The (checked) edit.
 * @throws ExplorerToolError `invalid` when the edit is refused.
 */
export function editSavedQueriesIn(prefs: IPrefsAccessor, key: string, edit: SavedQueryEdit): void {
	const stored = prefs.getPref(SAVED_QUERIES_PREF);
	const bag: StoredQueriesBag = isPlainObject(stored) ? stored : {};
	const next = applySavedQueryEdit(bag, key, edit);
	if (next !== bag) prefs.setPref(SAVED_QUERIES_PREF, next);
}

// =============================================================================
// FROM A FRAME
// =============================================================================

/**
 * Check an edit that arrived from a frame and rebuild it with its own fields
 * only. The caps are applied where the bag is (applySavedQueryEdit).
 *
 * @param value - The edit.
 * @returns The edit.
 * @throws ExplorerToolError `invalid` naming what is wrong.
 */
export function checkSavedQueryEdit(value: unknown): SavedQueryEdit {
	const fail = (): never => { throw refuse('The saved queries were not changed: the edit is not one this app makes.'); };
	if (!isPlainObject(value)) return fail();
	const id = typeof value.id === 'string' && value.id !== '' ? value.id : null;
	switch (value.action) {
		case 'remove':
			return id !== null ? { action: 'remove', id } : fail();
		case 'rename':
			return id !== null && typeof value.name === 'string' ? { action: 'rename', id, name: value.name } : fail();
		case 'add':
			return isSavedQuery(value.query) ? { action: 'add', query: cleanQuery(value.query) } : fail();
		default:
			return fail();
	}
}

// =============================================================================
// A NEW QUERY
// =============================================================================

/**
 * A new saved query.
 *
 * @param name - Its name.
 * @param sql - Its statement text.
 * @param at - When it is saved (epoch ms; default now).
 * @returns The query, with a fresh id.
 */
export function newSavedQuery(name: string, sql: string, at: number = Date.now()): SavedQuery {
	return { id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 10)}`, name, sql, at };
}

/**
 * The name the save dialog starts with: a leading `--` comment's text (the
 * way a query is usually titled), else the first line with text, cut to a
 * readable length; "Untitled query" when there is none.
 *
 * @param sql - The statement text.
 * @returns The suggested name.
 */
export function suggestQueryName(sql: string): string {
	for (const raw of sql.split('\n')) {
		const line = raw.trim();
		if (line === '') continue;
		const text = line.startsWith('--') ? line.slice(2).trim() : line;
		if (text === '') continue;
		return text.slice(0, SUGGESTED_NAME_CHARS);
	}
	return 'Untitled query';
}
