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
// THE FULL APP'S WORKSPACE PREFERENCES — WHOSE THEY ARE
// =============================================================================
//
// The shell reads an app's workspace preferences from the signed-in account's
// file once per page (packages/shell workspaceStore: a partition is read once
// and kept), and writes the WHOLE bag back, through whoever is signed in at
// that moment, whenever any key changes. So after another account signs in
// without a reload, the bag in memory is still the first account's, and any
// write, of any key, copies all of it into the next account's file.
//
// So the full app pins the first account it sees. Everything SQL Explorer
// reads or writes in those preferences (history, saved queries, grid
// layouts, drawer widths, small switches) asks this pin first, and for any
// other account reads nothing and writes nothing until the page reloads, or
// until the first account is back, whose bag it still is. While nobody is
// signed in nothing is read or written either.
//
// ONE PIN PER PAGE (APP_WORKSPACE_PIN), like the shell's own read: it must
// outlive an env rebuild and the app being switched away and back, which
// makes a new engine core but does not read the preferences again.
//
// Dev-tool frames never use it: their preferences are session-only, and the
// controller keeps one section per account in its own files.
// =============================================================================

import type { IDataGridPersistence } from 'shell';
import type { IPrefsAccessor } from 'shared/explorer/history/types';

/** Where the account signed in now stands against the preferences in memory. */
export type WorkspaceAccess = 'nobody' | 'owner' | 'another';

/** Whose workspace preferences these are. */
export interface WorkspacePin {
	/**
	 * Where an account stands. The first account given binds; null is nobody
	 * and binds nothing.
	 *
	 * @param owner - The identity fingerprint, or null when nobody is signed in.
	 * @returns `owner` for the bound account, `another` for any other, `nobody` for null.
	 */
	access(owner: string | null): WorkspaceAccess;
}

/** What the History drawer says instead of another account's entries. */
export const ANOTHER_ACCOUNT_HISTORY = 'Signed in as a different account: reload the page to see your history.';

/** What the Saved drawer says instead of another account's saved queries. */
export const ANOTHER_ACCOUNT_SAVED = 'Signed in as a different account: reload the page to see your saved queries.';

/**
 * Make a pin. The full app has one, {@link APP_WORKSPACE_PIN}; tests make
 * their own.
 *
 * @returns The pin, bound to nobody yet.
 */
export function createWorkspacePin(): WorkspacePin {
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
export const APP_WORKSPACE_PIN: WorkspacePin = createWorkspacePin();

/**
 * Preferences that read and write through only for the pinned account.
 *
 * @param pin - The pin.
 * @param prefs - The shell's workspace preferences.
 * @param ownerNow - Who is signed in now (the identity fingerprint), or null.
 * @returns The guarded accessor: reads undefined and drops writes for anyone else.
 */
export function pinnedPrefs(pin: WorkspacePin, prefs: IPrefsAccessor, ownerNow: () => string | null): IPrefsAccessor {
	return {
		getPref: (key) => (pin.access(ownerNow()) === 'owner' ? prefs.getPref(key) : undefined),
		setPref: (key, value) => {
			if (pin.access(ownerNow()) === 'owner') prefs.setPref(key, value);
		},
	};
}

/**
 * Grid layouts that read and write through only for the pinned account. The
 * shell keeps them in the same preferences bag, so a layout written for
 * another account would carry the first account's bag with it.
 *
 * @param pin - The pin.
 * @param grids - The layouts' own persistence.
 * @param ownerNow - Who is signed in now (the identity fingerprint), or null.
 * @returns The guarded persistence: nothing stored for anyone else, and nothing kept.
 */
export function pinnedGrids(pin: WorkspacePin, grids: IDataGridPersistence, ownerNow: () => string | null): IDataGridPersistence {
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
