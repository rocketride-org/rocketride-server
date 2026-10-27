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
// SAVED QUERIES — THE CONTROLLER'S FILE (dev tool), per account
// =============================================================================
//
// A dev tool's controller keeps saved queries in their own file in the user's
// store, SAVED_QUERIES_PATH, through a SECOND accessor of the dev-tool
// library's createFsPrefs (history has the first, in its own file, so saved
// queries never fill the history file's cap). The library gives one bag per
// account, owner checks before and after every file request, debounced
// writes, and never writes a file it could not read. This module follows the
// signed-in account the way the controller's history does:
//
//   - the file is read once the tool is activated (R7), for the account
//     signed in then;
//   - another account: the previous account's accessor is DROPPED at once,
//     its pending write with it, and nothing of it is served again;
//   - nobody signed in (a disconnect, a sign-out, an org switch): the accessor
//     is PARKED, holding its pending write, which lands if the same account
//     is known again while the sidebar is open;
//   - an unmount writes what is pending, then stops.
//
// Reads and edits wait (bounded) for the account's file to be read: an edit
// applied before the read would replace the whole stored bag with a new one.
// The caller (sqlController.ts) checks the calling frame's account before and
// after every wait.
// =============================================================================

import { ExplorerToolError } from 'shared/explorer/errors';
import { createFsPrefs } from 'shared/explorer/devtool/prefs';
import type { IFsPrefs } from 'shared/explorer/devtool/prefs';
import type { IExplorerBus } from 'shared/explorer/devtool/busClient';
import type { IIdentitySnapshot, IIdentityTracker } from 'shared/explorer/devtool/identity';
import type { IActivationGate } from 'shared/explorer/devtool/activation';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import { SAVED_QUERIES_PATH } from './savedQueries';
import type { SavedQueriesStorage } from './savedQueries';

/** What {@link createSavedQueriesFile} needs. */
export interface SavedQueriesFileOptions {
	/** The controller realm's bus. */
	cm: IExplorerBus;
	/** The controller core's identity tracker. */
	identity: IIdentityTracker;
	/** The controller core's activation gate (nothing is read before it opens). */
	activation: IActivationGate;
	/** How long a read or an edit waits for the account's file to be read. */
	loadWaitMs: number;
	/** Told on every change of storage or contents (the controller republishes its topic). */
	onChange: () => void;
}

/** The controller's saved-queries file, following the signed-in account. */
export interface SavedQueriesFile {
	/** Where saved queries are kept now. */
	storage(): SavedQueriesStorage;
	/** A revision that moves on every change: an account change, the file read, an edit. */
	rev(): number;
	/**
	 * The signed-in account's accessor, once its file is read (bounded).
	 *
	 * @param tool - The op (named in errors).
	 * @returns The accessor: its file's bag, or this session's when the file could not be read.
	 * @throws ExplorerToolError `unavailable` (nobody signed in, the file not read in time) or `stale` (the account changed meanwhile).
	 */
	accessor(tool: string): Promise<IPrefsAccessor>;
	/** Note an edit made through the accessor (moves the revision). */
	changed(): void;
	/** Write what is pending, then stop (the controller's unmount; idempotent). */
	close(): void;
}

/**
 * Follow the signed-in account's saved-queries file.
 *
 * @param opts - See {@link SavedQueriesFileOptions}.
 * @returns The file follower; close it with the controller.
 */
export function createSavedQueriesFile(opts: SavedQueriesFileOptions): SavedQueriesFile {
	let owner: string | null = null;
	let current: IFsPrefs | null = null;
	/** The previous account's accessor, kept while nobody is signed in (see the header). */
	let parked: IFsPrefs | null = null;
	let storage: SavedQueriesStorage = 'none';
	let rev = 0;
	let offActive: (() => void) | null = null;
	let closed = false;

	const changed = (): void => {
		rev += 1;
		opts.onChange();
	};

	/**
	 * One account's accessor.
	 *
	 * @param account - The account's fingerprint.
	 * @returns The accessor (not read yet).
	 */
	const fileFor = (account: string): IFsPrefs => {
		const accessor = createFsPrefs({
			cm: opts.cm,
			path: SAVED_QUERIES_PATH,
			owner: account,
			// Who is signed in now: the library HOLDS a write while it is null
			// and drops it once another account is known.
			ownerNow: () => {
				const now = opts.identity.get();
				return now.known ? now.fingerprint : null;
			},
			onError: (_error, phase) => {
				if (phase !== 'load' || current !== accessor) return;
				storage = 'session';
				changed();
			},
		});
		return accessor;
	};

	/**
	 * Read the account's file (or carry on with its parked accessor).
	 *
	 * @param account - The account signed in.
	 */
	const attach = (account: string): void => {
		let accessor: IFsPrefs;
		if (parked !== null && parked.owner === account) {
			// The same account is back: what its accessor still holds is written now.
			accessor = parked;
			parked = null;
			void accessor.flush();
		} else {
			parked?.dispose();
			parked = null;
			accessor = fileFor(account);
		}
		current = accessor;
		void accessor.load().then(() => {
			if (current === accessor && !closed) changed();
		});
	};

	const follow = (snapshot: IIdentitySnapshot): void => {
		const next = snapshot.known ? snapshot.fingerprint : null;
		if (next === owner) return;
		owner = next;
		if (current !== null) {
			if (next === null) {
				// Nobody is vouched for: keep it (see `parked`).
				parked?.dispose();
				parked = current;
			} else {
				// Another account: the previous one's pending write is dropped.
				current.dispose();
			}
			current = null;
		}
		offActive?.();
		offActive = null;
		storage = next === null ? 'none' : 'file';
		if (next !== null) {
			offActive = opts.activation.subscribe(() => {
				if (owner === next && !closed) attach(next);
			});
		}
		changed();
	};

	follow(opts.identity.get());
	const offIdentity = opts.identity.subscribe(follow);

	return {
		storage: () => storage,
		rev: () => rev,
		async accessor(tool) {
			const accessor = current;
			if (accessor === null) {
				throw new ExplorerToolError({
					kind: 'unavailable',
					tool,
					message: owner === null ? 'Not signed in to a RocketRide server, so no saved query was read or changed.' : 'Your saved queries are not read yet. Try again.',
				});
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const read = await Promise.race([
				accessor.load().then(() => true),
				new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), opts.loadWaitMs); }),
			]);
			clearTimeout(timer);
			if (current !== accessor) throw new ExplorerToolError({ kind: 'stale', tool, message: 'The signed-in account changed, so no saved query was read or changed.' });
			if (!read) throw new ExplorerToolError({ kind: 'unavailable', tool, message: 'Your saved queries could not be read from the server yet. Try again.' });
			return accessor;
		},
		changed,
		close() {
			if (closed) return;
			closed = true;
			offIdentity();
			offActive?.();
			// Each accessor writes what it holds, then stops; a write held because
			// nobody is vouched for is dropped (as history's are).
			void current?.close();
			void parked?.close();
			parked = null;
		},
	};
}
