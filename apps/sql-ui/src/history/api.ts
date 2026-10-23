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
// HISTORY — THE API THE VIEWS USE (one seam, two places history lives)
// =============================================================================
//
// The query view records runs and the History drawer reads and edits them
// through this interface, from SqlEnv, never from a store directly:
//
//   full app   the module history store, persisted through the shell's
//              workspace preferences (localEnv.ts);
//   dev tool   the CONTROLLER's history store, persisted in a file in the
//              user's store; a frame reads it through a retained state topic
//              and ops, and edits it through ops (history/remoteHistory.ts).
//
// What may cross from a frame is checked here, so the controller never
// writes anything but a well-formed entry into the user's file.
// =============================================================================

import { ExplorerToolError } from 'shared/explorer/errors';
import { isPlainObject } from 'shared/explorer/checks';
import type { SqlEndpoint } from '../connect';
import type { HistoryEntry } from './types';

/** One connection's history, as the views use it. */
export interface SqlHistoryApi {
	/** Subscribe to one connection's entries, newest first (a hook). */
	useHistory(endpoint: SqlEndpoint): HistoryEntry[];
	/** Subscribe to one connection's recording switch (a hook; default on). */
	useRecording(endpoint: SqlEndpoint): boolean;
	/** Where history is kept, in one sentence: the drawer's privacy line (a hook). */
	usePrivacyNotice(): string;
	/** Record one finished statement (unless recording is off for the connection). */
	record(endpoint: SqlEndpoint, entry: HistoryEntry): void;
	/** Forget one entry. */
	removeEntry(endpoint: SqlEndpoint, id: string): void;
	/** Flip one entry's pinned state. */
	togglePin(endpoint: SqlEndpoint, id: string): void;
	/** Set (or clear, with '') one entry's note. */
	setNote(endpoint: SqlEndpoint, id: string, note: string): void;
	/** Forget every entry for one connection, pinned entries included. */
	clearForKey(endpoint: SqlEndpoint): void;
	/** Turn recording on or off for one connection; existing entries are kept either way. */
	setRecording(endpoint: SqlEndpoint, on: boolean): void;
}

/** One edit a frame asks the controller to make. */
export type HistoryEdit =
	| { action: 'remove'; id: string }
	| { action: 'pin'; id: string }
	| { action: 'note'; id: string; note: string }
	| { action: 'clear' }
	| { action: 'recording'; on: boolean };

/** Where the controller keeps history: its file, this session only (the file could not be read), or nowhere yet (nobody signed in). */
export type HistoryStorage = 'file' | 'session' | 'none';

/** The full app's privacy line: history rides the shell's workspace preferences. */
export const APP_PRIVACY_NOTICE = 'Saved in your RocketRide workspace file on the server, not in this browser. Statements are stored as typed, including literal values.';

/**
 * The dev tool's privacy line for where its controller keeps history.
 *
 * @param storage - Where history is kept.
 * @returns The sentence.
 */
export function devToolPrivacyNotice(storage: HistoryStorage): string {
	switch (storage) {
		case 'file':
			return 'Saved in a history file in your RocketRide user storage on the server (rocketride.sql.history.json), not in this window. Statements are stored as typed, including literal values. If two windows change history at once, the last one to save wins.';
		case 'session':
			return 'Kept for this session only: the history file in your RocketRide user storage could not be read, so nothing is written to it. Statements are held as typed, including literal values.';
		default:
			return 'Not saved: nobody is signed in to a RocketRide server.';
	}
}

/** Outcomes a history entry may carry. */
const OUTCOMES: ReadonlySet<string> = new Set(['rows', 'affected', 'error', 'abandoned']);
/** Kinds a history entry may carry. */
const KINDS: ReadonlySet<string> = new Set(['read', 'write', 'ddl', 'tx', 'other']);

/**
 * Check a history entry that arrived from a frame and rebuild it with only
 * the fields an entry has (in the persisted order).
 *
 * @param value - The entry.
 * @returns A clean entry.
 * @throws ExplorerToolError `invalid` naming what is wrong.
 */
export function checkHistoryEntry(value: unknown): HistoryEntry {
	const fail = (why: string): never => { throw new ExplorerToolError({ kind: 'invalid', tool: 'historyRecord', message: `The run was not recorded: ${why}.` }); };
	if (!isPlainObject(value)) return fail('it is not a history entry');
	const { id, sql, at, ms, outcome, kind } = value;
	if (typeof id !== 'string' || id === '') fail("'id' is missing");
	if (typeof sql !== 'string') fail("'sql' is missing");
	if (typeof at !== 'number' || !Number.isFinite(at)) fail("'at' is not a time");
	if (typeof ms !== 'number' || !Number.isFinite(ms)) fail("'ms' is not a duration");
	if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) fail("'outcome' is not one of rows, affected, error, abandoned");
	if (typeof kind !== 'string' || !KINDS.has(kind)) fail("'kind' is not one of read, write, ddl, tx, other");
	const number = (field: string): number | undefined => (typeof value[field] === 'number' && Number.isFinite(value[field]) ? (value[field] as number) : undefined);
	const rows = number('rows');
	const limit = number('limit');
	const affected = number('affected');
	return {
		id: id as string,
		sql: sql as string,
		at: at as number,
		ms: ms as number,
		outcome: outcome as HistoryEntry['outcome'],
		kind: kind as HistoryEntry['kind'],
		...(rows !== undefined ? { rows } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(affected !== undefined ? { affected } : {}),
		...(typeof value.error === 'string' ? { error: value.error } : {}),
	};
}

/**
 * Check an edit that arrived from a frame.
 *
 * @param value - The edit.
 * @returns The edit.
 * @throws ExplorerToolError `invalid` naming what is wrong.
 */
export function checkHistoryEdit(value: unknown): HistoryEdit {
	const fail = (): never => { throw new ExplorerToolError({ kind: 'invalid', tool: 'historyEdit', message: 'The history was not changed: the edit is not one this app makes.' }); };
	if (!isPlainObject(value)) return fail();
	switch (value.action) {
		case 'remove':
		case 'pin':
			return typeof value.id === 'string' && value.id !== '' ? { action: value.action, id: value.id } : fail();
		case 'note':
			return typeof value.id === 'string' && value.id !== '' && typeof value.note === 'string' ? { action: 'note', id: value.id, note: value.note } : fail();
		case 'clear':
			return { action: 'clear' };
		case 'recording':
			return typeof value.on === 'boolean' ? { action: 'recording', on: value.on } : fail();
		default:
			return fail();
	}
}
