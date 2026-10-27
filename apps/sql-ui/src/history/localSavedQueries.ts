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
// SAVED QUERIES — THE FULL APP'S (the shell's workspace preferences)
// =============================================================================
//
// The full app keeps saved queries in the shell's workspace preferences, key
// `sql.savedQueries`, through the same stable accessor history uses
// (SqlApp.tsx over `usePrefs`). Nothing is held here: every read goes to the
// accessor, and the parsed bag is cached only for as long as the account and
// the stored value are the same. While nobody is signed in nothing is read
// or written.
//
// THE ACCOUNT IS PINNED. The shell reads the workspace from disk once per
// page, so after another account signs in without a reload the preferences
// still hold the first account's bag (and a write would land in the next
// account's file). So the first account seen is the only one served: any
// other is served nothing and saves nothing, with a sentence saying to
// reload, until the page reloads (or the first account is back). The pin is
// the page's (workspacePin.ts), shared with history and every other
// preference the full app keeps, so it outlives an env rebuild and the app
// being switched away and back.
//
// Dev-tool frames never import this module (localEnv.ts is the full app's).
// =============================================================================

import { useSyncExternalStore } from 'react';
import { ExplorerToolError } from 'shared/explorer/errors';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import { APP_SAVED_QUERIES_NOTICE, SAVED_QUERIES_PREF, editSavedQueriesIn, readSavedQueriesBag } from './savedQueries';
import type { SavedQueriesBag, SavedQueriesReadState, SavedQuery, SavedQueryEdit, SqlSavedQueriesApi } from './savedQueries';
import { ANOTHER_ACCOUNT_SAVED, createWorkspacePin } from './workspacePin';
import type { WorkspacePin } from './workspacePin';
import type { SqlEndpoint } from '../connect';

/** Shared empty list, so an unknown connection keeps a stable snapshot. */
const NO_QUERIES: SavedQuery[] = [];

/** The read states (shared, so snapshots stay stable). */
const READY: SavedQueriesReadState = { status: 'ready' };
const NOBODY: SavedQueriesReadState = { status: 'failed', message: 'Not signed in to a RocketRide server.' };
const ANOTHER: SavedQueriesReadState = { status: 'failed', message: ANOTHER_ACCOUNT_SAVED };

/** The full app's saved queries, with reads outside React (tests, diagnostics). */
export interface LocalSavedQueries extends SqlSavedQueriesApi {
	/** One connection's saved queries for the account signed in now (outside React). */
	entriesOf(endpoint: SqlEndpoint): SavedQuery[];
	/** Where reading stands (outside React): at once, unless nobody or another account is signed in. */
	readStateOf(endpoint: SqlEndpoint): SavedQueriesReadState;
}

/**
 * The full app's saved queries over its workspace preferences.
 *
 * @param prefs - The shell's workspace preferences (a stable accessor over `usePrefs`).
 * @param ownerNow - Who is signed in now (the identity fingerprint), or null.
 * @param pin - Whose preferences these are (the full app passes the page's; default: a pin of its own).
 * @returns The views' API.
 */
export function createLocalSavedQueries(prefs: IPrefsAccessor, ownerNow: () => string | null, pin: WorkspacePin = createWorkspacePin()): LocalSavedQueries {
	const listeners = new Set<() => void>();
	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => { listeners.delete(listener); };
	};
	/** The last bag parsed, with what it was parsed from (a new object with the same text is the same bag). */
	let cache: { owner: string; raw: unknown; text: string; bag: SavedQueriesBag } | null = null;

	/**
	 * The account signed in now, when it is the one these preferences belong to.
	 *
	 * @returns Its fingerprint, or null (nobody, or another account).
	 */
	const owned = (): string | null => {
		const owner = ownerNow();
		return owner !== null && pin.access(owner) === 'owner' ? owner : null;
	};

	/**
	 * The signed-in account's bag (empty while nobody, or another account, is signed in).
	 *
	 * @returns The bag; the same object until the account or the stored value changes.
	 */
	const bag = (): SavedQueriesBag => {
		const owner = owned();
		if (owner === null) return {};
		const raw = prefs.getPref(SAVED_QUERIES_PREF);
		if (cache !== null && cache.owner === owner && cache.raw === raw) return cache.bag;
		const text = JSON.stringify(raw ?? null);
		if (cache === null || cache.owner !== owner || cache.text !== text) cache = { owner, raw, text, bag: readSavedQueriesBag(raw) };
		else cache = { ...cache, raw };
		return cache.bag;
	};

	/**
	 * Where reading stands: the preferences answer at once, so only who is
	 * signed in can make it fail.
	 *
	 * @returns The read state.
	 */
	const readState = (): SavedQueriesReadState => {
		if (ownerNow() === null) return NOBODY;
		return owned() === null ? ANOTHER : READY;
	};

	/**
	 * Apply one change for the signed-in account.
	 *
	 * @param endpoint - The connection.
	 * @param change - The change.
	 * @param verb - What it does, for the refusal ('saved', 'renamed', 'deleted').
	 */
	const edit = async (endpoint: SqlEndpoint, change: SavedQueryEdit, verb: string): Promise<void> => {
		if (ownerNow() === null) throw new ExplorerToolError({ kind: 'unavailable', tool: 'savedQueryEdit', message: `Not signed in to a RocketRide server, so nothing was ${verb}.` });
		// Checked right before the write: nothing awaits between it and the write.
		if (owned() === null) {
			throw new ExplorerToolError({ kind: 'stale', tool: 'savedQueryEdit', message: `Signed in as a different account, so nothing was ${verb}. Reload the page to see and change your saved queries.` });
		}
		editSavedQueriesIn(prefs, endpoint.key, change);
		listeners.forEach((listener) => listener());
	};

	return {
		useSavedQueries(endpoint) {
			return useSyncExternalStore(subscribe, () => bag()[endpoint.key] ?? NO_QUERIES);
		},
		useReadState() {
			return useSyncExternalStore(subscribe, readState);
		},
		// Nothing to read again: the preferences answer at once; a re-render shows what they hold now.
		retry: () => listeners.forEach((listener) => listener()),
		usePrivacyNotice: () => APP_SAVED_QUERIES_NOTICE,
		save: (endpoint, query) => edit(endpoint, { action: 'add', query }, 'saved'),
		rename: (endpoint, id, name) => edit(endpoint, { action: 'rename', id, name }, 'renamed'),
		remove: (endpoint, id) => edit(endpoint, { action: 'remove', id }, 'deleted'),
		entriesOf: (endpoint) => bag()[endpoint.key] ?? NO_QUERIES,
		readStateOf: () => readState(),
	};
}
