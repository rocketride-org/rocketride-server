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
// GRAPH - THE FULL APP'S WORKSPACE PREFERENCES: WHOSE THEY ARE
// =============================================================================
//
// Ported from sql-ui (history/workspacePin.ts). The shell reads an app's
// workspace preferences from the signed-in account's file once per page, and
// writes the WHOLE bag back, through whoever is signed in at that moment,
// whenever any key changes. So after another account signs in without a
// reload, the bag in memory is still the first account's, and any write, of
// any key, copies all of it into the next account's file.
//
// So the full app pins the first account it sees. Everything Graph Explorer
// keeps in those preferences (drafts, captions, the editor height, grid
// layouts, label styles, saved queries, and history through `pinHistory`)
// asks this pin first, and for any other account reads nothing and writes
// nothing until the page reloads, or until the first account is back, whose
// bag it still is. While nobody is signed in nothing is read or written
// either. A write the shell makes on its own in that time (an app switch, a
// theme change) still writes the bag it holds: only a reload ends that.
//
// ONE PIN PER PAGE (APP_WORKSPACE_PIN), like the shell's own read: it must
// outlive an env rebuild and the app being switched away and back.
//
// Dev-tool mounts never use it: their preferences are session-only, and the
// controller keeps one section per account in its own files.
// =============================================================================

import type { IDataGridPersistence } from 'shell';
import { ExplorerToolError } from 'shared/explorer';
import type { IPrefsAccessor } from 'shared/explorer';
import type { IPrefsAttachable } from 'shared/explorer/react';
import { CAPTIONS_PREF_KEY } from '../adapters/explorer';
import { APP_HISTORY_PRIVACY_NOTE, memoryPrefs } from '../env';
import { APP_USER_DATA_NOTE, createStoredUserData } from './userData';
import type { IOwnedUserData, IStoredUserDataOptions, IUserDataSource } from './userData';

/** Where the account signed in now stands against the preferences in memory. */
export type WorkspaceAccess = 'nobody' | 'owner' | 'another';

/** Whose workspace preferences these are. */
export interface IWorkspacePin {
	/**
	 * Where an account stands. The first account given binds; null is nobody and binds nothing.
	 *
	 * @param owner - The identity fingerprint, or null when nobody is signed in.
	 * @returns `owner` for the bound account, `another` for any other, `nobody` for null.
	 */
	access(owner: string | null): WorkspaceAccess;
}

/** What a view says instead of another account's styles and saved queries. */
export const ANOTHER_ACCOUNT_USER_DATA = 'Signed in as a different account: reload the page to see your saved queries and styles.';

/** Said where nothing is saved because nobody is signed in. */
const NOBODY_NOTE = 'Not saved: nobody is signed in to a RocketRide server.';

/**
 * Where the full app keeps styles and saved queries, for the account signed in now.
 *
 * @param access - Where that account stands against the page's pin.
 * @returns The sentence.
 */
export function appUserDataNote(access: WorkspaceAccess): string {
	if (access === 'owner') return APP_USER_DATA_NOTE;
	return access === 'another' ? 'Not saved: you are signed in as a different account. Reload the page to save to your own workspace file.' : NOBODY_NOTE;
}

/**
 * Where the full app keeps history, for the account signed in now: another account's runs are kept in memory for the
 * session (pinHistory gives it a throwaway accessor), never in the workspace file.
 *
 * @param access - Where that account stands against the page's pin.
 * @returns The sentence.
 */
export function appHistoryNote(access: WorkspaceAccess): string {
	if (access === 'owner') return APP_HISTORY_PRIVACY_NOTE;
	return access === 'another' ? 'Signed in as a different account: statements run now are kept for this session only. Reload the page to see your history.' : NOBODY_NOTE;
}

/**
 * Make a pin. The full app has one, {@link APP_WORKSPACE_PIN}; tests make their own.
 *
 * @returns The pin, bound to nobody yet.
 */
export function createWorkspacePin(): IWorkspacePin {
	let pinned: string | null = null;
	return {
		access(owner) {
			if (owner === null) return 'nobody';
			pinned ??= owner;
			return owner === pinned ? 'owner' : 'another';
		},
	};
}

/** The full app's pin: one per page, as the shell reads the preferences once per page. */
export const APP_WORKSPACE_PIN: IWorkspacePin = createWorkspacePin();

/** The full app's workspace preferences with one stable identity, pointed at the shell's latest accessor. */
export interface IForwardingPrefs extends IPrefsAccessor {
	/**
	 * Point at the shell's accessor of this render.
	 *
	 * @param api - The accessor `usePrefs()` handed out.
	 * @returns True when it is a new one (a reader told about a write before it existed should read again).
	 */
	bind(api: IPrefsAccessor): boolean;
	/** Be told after every write made through it (GraphApp: a change the person made in this page). */
	onWrite(listener: () => void): () => void;
}

/**
 * Workspace prefs with one stable identity. The shell hands out a new accessor whenever any preference changes, and
 * each one is a SNAPSHOT of one render (its getPref reads the bag as it was), so a value just written is not in it
 * until the shell renders again. What was set since the last bind is therefore read back from here (read your own
 * writes): a reader told about a change sees it, and a second change made before the next render builds on the
 * first instead of replacing it. A new accessor already holds those writes, so binding one clears them.
 *
 * @returns The accessor and its binder.
 */
export function createForwardingPrefs(): IForwardingPrefs {
	let current: IPrefsAccessor | null = null;
	const written = new Map<string, unknown>();
	const listeners = new Set<() => void>();
	return {
		bind(api) {
			if (api === current) return false;
			current = api;
			written.clear();
			return true;
		},
		getPref: (key) => (written.has(key) ? written.get(key) : current?.getPref(key)),
		setPref: (key, value) => {
			if (!current) return;
			written.set(key, value);
			current.setPref(key, value);
			listeners.forEach((listener) => listener());
		},
		onWrite(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/**
 * Preferences that read and write through only for the pinned account.
 *
 * @param pin - The pin.
 * @param prefs - The shell's workspace preferences.
 * @param ownerNow - Who is signed in now (the identity fingerprint), or null.
 * @returns The guarded accessor: reads undefined and drops writes for anyone else.
 */
export function pinnedPrefs(pin: IWorkspacePin, prefs: IPrefsAccessor, ownerNow: () => string | null): IPrefsAccessor {
	return {
		getPref: (key) => (pin.access(ownerNow()) === 'owner' ? prefs.getPref(key) : undefined),
		setPref: (key, value) => {
			if (pin.access(ownerNow()) === 'owner') prefs.setPref(key, value);
		},
	};
}

/**
 * Grid layouts that read and write through only for the pinned account. The shell keeps them in the same preferences
 * bag, so a layout written for another account would carry the first account's bag with it.
 *
 * @param pin - The pin.
 * @param grids - The layouts' own persistence.
 * @param ownerNow - Who is signed in now (the identity fingerprint), or null.
 * @returns The guarded persistence: nothing stored for anyone else, and nothing kept.
 */
export function pinnedGrids(pin: IWorkspacePin, grids: IDataGridPersistence, ownerNow: () => string | null): IDataGridPersistence {
	const owns = (): boolean => pin.access(ownerNow()) === 'owner';
	return {
		read: (tableId, type) => (owns() ? grids.read(tableId, type) : false),
		write: (tableId, type, data) => {
			if (owns()) grids.write(tableId, type, data);
		},
		clear: (tableId) => {
			if (owns()) grids.clear(tableId);
		},
	};
}

/**
 * The full app's styles and saved queries: two keys of the workspace preferences, for the pinned account only, and
 * only once the shell has loaded them (until then they read as loading, and no colour slot is written: a write before
 * the load would replace what the account's file holds). Colour slots, and the caption choices 1.2 kept under
 * `graph.captions`, are shown at once and saved only with the person's next change in this page (`userWrote`): two
 * pages of one account each write their whole partition, so an automatic write from an older page would replace what
 * the newer one saved. Nobody signed in, or another account, reads nothing (the
 * saved queries say why) and changes nothing (refused with the reason). GraphApp calls `notify()` when the account
 * or the load changes.
 *
 * @param prefs - The shell's workspace preferences (a stable accessor over `usePrefs`).
 * @param ownerNow - Who is signed in now (the identity fingerprint), or null.
 * @param loaded - Whether the shell has loaded the preferences from the account's file.
 * @param pin - Whose preferences these are (default: the page's).
 * @param opts - Clock and timers (tests).
 * @returns The user data.
 */
export function createAppUserData(prefs: IPrefsAccessor, ownerNow: () => string | null, loaded: () => boolean, pin: IWorkspacePin = APP_WORKSPACE_PIN, opts: IStoredUserDataOptions = {}): IOwnedUserData {
	const pinned = pinnedPrefs(pin, prefs, ownerNow);
	const source: IUserDataSource = {
		read() {
			const access = pin.access(ownerNow());
			if (access === 'nobody') return { status: 'error', note: 'Not signed in to a RocketRide server.' };
			if (access === 'another') return { status: 'error', note: ANOTHER_ACCOUNT_USER_DATA };
			return loaded() ? { status: 'ready', prefs: pinned } : { status: 'loading', note: null };
		},
		async accessor(tool) {
			const access = pin.access(ownerNow());
			if (access === 'nobody') throw new ExplorerToolError({ kind: 'unavailable', tool, message: 'Not signed in to a RocketRide server, so nothing was changed.' });
			if (access === 'another') throw new ExplorerToolError({ kind: 'stale', tool, message: 'Signed in as a different account, so nothing was changed. Reload the page to see and change your saved queries and styles.' });
			if (!loaded()) throw new ExplorerToolError({ kind: 'unavailable', tool, message: 'Your workspace is still loading, so nothing was changed. Try again in a moment.' });
			return pinned;
		},
	};
	// The page writes its whole preferences partition on any write: what is automatic waits for the person's next change
	// in this page (holdSlots), and 1.2's caption choices are moved into the styles then, once.
	return createStoredUserData({ styles: source, saved: source, owner: ownerNow, privacyNote: () => appUserDataNote(pin.access(ownerNow())) }, { holdSlots: true, legacyCaptionsPref: CAPTIONS_PREF_KEY, ...opts });
}

/** A history store's attach, through the page's pin. */
export interface IPinnedHistory extends IPrefsAttachable {
	/** Where the account the store was last attached for stands. */
	access(): WorkspaceAccess;
}

/**
 * Attach a history store to the shell's preferences only for the pinned account (ported from sql-ui's pinHistory):
 * any other account, or nobody, gets a throwaway accessor under its own owner, so the store forgets what it held and
 * reads and writes nothing of the shell's. Without it the shared bridge re-attaches under the new owner over the same
 * in-memory bag, shows the first account's history, and the next run writes it into the new account's file.
 *
 * @param store - The history store.
 * @param pin - Whose preferences these are (default: the page's).
 * @returns The attach, and where the last attached account stands.
 */
export function pinHistory(store: IPrefsAttachable, pin: IWorkspacePin = APP_WORKSPACE_PIN): IPinnedHistory {
	let access: WorkspaceAccess = 'nobody';
	return {
		attachPrefs(api, owner) {
			if (owner === undefined) return store.attachPrefs(api);
			access = pin.access(owner);
			return store.attachPrefs(access === 'owner' ? api : memoryPrefs(), owner);
		},
		access: () => access,
	};
}
