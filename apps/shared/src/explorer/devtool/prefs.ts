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
// EXPLORER DEV TOOL — FS-BACKED HISTORY PREFERENCES (§3.5)
// =============================================================================
//
// Dev-tool mounts get no workspace preferences (neither host gives store
// tools ToolHostServices/prefs), so the CONTROLLER persists history itself, in
// a per-user file beside the SQL tool's saved connections:
//
//   @/User/.workspace/rocketride.<tool>.history.json      historyPrefsPath(tool)
//
// `createFsPrefs` is an IPrefsAccessor over that file, for the history store's
// `attachPrefs`. The rules:
//
//   LOAD FIRST. The history store reads getPref synchronously at attach, so an
//     accessor attached before the file is read starts empty and its first
//     write overwrites the file. `attachWhenLoaded(prefs, attach)` attaches
//     only once `load()` settled. A change made before or during the load is
//     QUEUED and applied over the loaded file (it wins over the stored value),
//     then written once the load is ready.
//   NEVER CLOBBER. `client.fsStat` tells a missing file (first run: start
//     empty, writes allowed) from one that exists. The engine answers
//     `{exists: false}` for a missing file AND for a missing parent folder
//     (packages/ai/src/ai/account/file_store.py FileStore.stat: an absent
//     prefix lists nothing, and get_file_info's StorageNotFoundError is
//     caught), so a first run is always a clean `ready`. Only a failed request
//     fails a load; it is retried (PREFS_LOAD_ATTEMPTS in all) before the
//     session falls back to memory. A file that exists but cannot be read, or
//     holds an unknown or newer format, is never written: the session keeps
//     its history in memory and the failure is reported.
//   ONE BAG PER OWNER. The owner is the identity fingerprint (user,
//     organization, development team). The file keeps one bag per owner and
//     an accessor reads and writes only its own; the others are written back
//     untouched (at most MAX_PREFS_OWNERS bags, the least recently written
//     dropped once a write succeeds). An accessor is made for ONE owner, and
//     the owner is checked before every file request AND again after every
//     awaited one (a write's mkdir, a load's stat and read):
//       - `ownerNow()` null (a reconnect: nobody is vouched for yet) HOLDS a
//         due write, which looks again (at most every 30 s, without using up
//         the failure retries) and lands once the same owner is back, and
//         makes a load wait before its next request;
//       - `ownerNow()` naming someone else DROPS a pending write (an identity
//         change), as the history store drops its own, and stops a load;
//       - an answer that arrives after the owner changed is discarded (a load
//         reads again once the owner is back), and a write is composed only
//         after its mkdir settled and the owner was checked again;
//       - after dispose() nothing is sent and nothing read is accepted.
//   CAPS. The history store trims its bag to MAX_HISTORY_BAG_CHARS (256 KB);
//     the whole file, measured as the SDK writes it (two-space indented
//     JSON, client.ts fsWriteJson), is capped at MAX_PREFS_FILE_CHARS, other
//     owners' bags being dropped first, and a file still over it is refused,
//     not written.
//   WRITES are debounced (PREFS_WRITE_DEBOUNCE_MS), serialised, and made
//     after one `client.fsMkdir` of the folder. A failed write keeps the
//     change and retries with backoff, PREFS_WRITE_RETRIES times; the next
//     change, flush() or close() tries again after that. Every fs request
//     names its bus timeout (PREFS_FS_TIMEOUT_MS).
//   LAST WRITER WINS across windows: each window writes the whole file from
//     what it loaded, so two windows of the same user that both write keep
//     only the later one's view. A known limitation.
// =============================================================================

import { isPlainObject } from '../checks';
import { MAX_HISTORY_BAG_CHARS } from '../history/types';
import type { IPrefsAccessor } from '../history/types';
import { busRequest } from './busClient';
import type { IExplorerBus } from './busClient';
import { assertTimeoutMs } from './timeouts';

/** The file format version this module reads and writes. */
export const PREFS_FILE_VERSION = 1;

/** Bus timeout of each fs request (stat, read, mkdir, write). */
export const PREFS_FS_TIMEOUT_MS = 15_000;

/** Quiet period before a batch of preference changes is written. */
export const PREFS_WRITE_DEBOUNCE_MS = 1_000;

/** Ceiling on the whole file as written (two-space indented JSON, characters): two full history bags. */
export const MAX_PREFS_FILE_CHARS = 2 * MAX_HISTORY_BAG_CHARS;

/** Load attempts (the first plus retries) before a failed request leaves the session in memory. */
export const PREFS_LOAD_ATTEMPTS = 3;

/** Pause before load retry n (1-based): 1 s, then 3 s. */
const LOAD_RETRY_DELAYS_MS = [1_000, 3_000];

/** How often a load waiting for its owner to be signed in again looks. */
const OWNER_POLL_MS = 1_000;

/** Retries of a FAILED write before it waits for the next change, flush() or close() (a write held while nobody is signed in does not use them). */
export const PREFS_WRITE_RETRIES = 5;

/** The longest pause between write retries (the backoff doubles from the debounce up to this). */
const MAX_WRITE_RETRY_DELAY_MS = 30_000;

/** Owner bags one file keeps (the least recently written beyond it are dropped). */
export const MAX_PREFS_OWNERS = 8;

/**
 * The history file of a tool.
 *
 * @param tool - The tool's short name ('sql', 'graph', 'vector').
 * @returns `@/User/.workspace/rocketride.<tool>.history.json`.
 */
export function historyPrefsPath(tool: string): string {
	// '@/User/.workspace/…' and the scope-less '.workspace/…' that SQL's saved
	// connections use (sql-ui savedConnections.ts) are the SAME folder: a
	// scope-less store path defaults to the User scope (client.ts
	// validateStorePath; file_store.py scope resolution). Keep the explicit form.
	return `@/User/.workspace/rocketride.${tool}.history.json`;
}

/** Where the accessor is in its life. */
export type FsPrefsStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** One owner's bag in the file. */
interface IOwnerBag {
	/** Epoch ms of its last write. */
	at: number;
	/** Its preferences, by key. */
	prefs: Record<string, unknown>;
}

/** What {@link createFsPrefs} needs. */
export interface IFsPrefsOptions {
	/** The controller realm's bus (its ConnectionManager). */
	cm: IExplorerBus;
	/** The file (see {@link historyPrefsPath}). */
	path: string;
	/** The identity fingerprint this accessor belongs to (required; no identity: no file). */
	owner: string;
	/** Who is signed in NOW; writes stop once it is not `owner` (default: always `owner`). */
	ownerNow?: () => string | null;
	/** The folder to create before the first write (default: the path's folder). */
	dir?: string;
	/** Bus timeout per fs request (default {@link PREFS_FS_TIMEOUT_MS}). */
	timeoutMs?: number;
	/** Write debounce (default {@link PREFS_WRITE_DEBOUNCE_MS}). */
	debounceMs?: number;
	/** File cap (default {@link MAX_PREFS_FILE_CHARS}). */
	maxFileChars?: number;
	/** Owner bags kept (default {@link MAX_PREFS_OWNERS}). */
	maxOwners?: number;
	/** Told about a failed load or write (the file was left alone). */
	onError?: (error: unknown, phase: 'load' | 'write') => void;
	/** Clock and timers (default: real). */
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

/** The accessor. */
export interface IFsPrefs extends IPrefsAccessor {
	/** The owner it reads and writes for. */
	readonly owner: string;
	/** The file. */
	readonly path: string;
	/** Where it is in its life. */
	status(): FsPrefsStatus;
	/**
	 * Read the file (once; later calls return the same promise). Never rejects.
	 * A failed request is retried (PREFS_LOAD_ATTEMPTS in all); changes made
	 * before it settles are applied over what it read.
	 */
	load(): Promise<FsPrefsStatus>;
	/** Write pending changes now. */
	flush(): Promise<void>;
	/** Write pending changes, then stop (unmount under the same identity). */
	close(): Promise<void>;
	/** Stop, DROPPING pending changes (identity change). Idempotent. */
	dispose(): void;
}

/** The stored file is not in this module's format (it is never written over). */
class FileFormatError extends Error {
	/**
	 * @param message - What is wrong.
	 */
	constructor(message: string) {
		super(message);
		this.name = 'FileFormatError';
		Object.setPrototypeOf(this, FileFormatError.prototype);
	}
}

/**
 * Read the stored file.
 *
 * @param raw - What `client.fsReadJson` answered.
 * @returns The owner bags.
 * @throws Error for anything but this module's format (the file is then never written).
 */
function readFile(raw: unknown): Record<string, IOwnerBag> {
	if (!isPlainObject(raw) || raw.version !== PREFS_FILE_VERSION || !isPlainObject(raw.owners)) {
		throw new FileFormatError(`The history file is not in format version ${PREFS_FILE_VERSION}; it is left untouched.`);
	}
	const owners: Record<string, IOwnerBag> = {};
	for (const [id, bag] of Object.entries(raw.owners)) {
		if (!isPlainObject(bag) || !isPlainObject(bag.prefs)) continue;
		owners[id] = { at: typeof bag.at === 'number' && Number.isFinite(bag.at) ? bag.at : 0, prefs: bag.prefs };
	}
	return owners;
}

/**
 * Create a history-preferences accessor over a file in the user store.
 *
 * @param opts - See {@link IFsPrefsOptions}.
 * @returns The accessor; `load()` it (or use {@link attachWhenLoaded}) before attaching.
 * @throws RangeError without an owner or with an unusable timeout.
 */
export function createFsPrefs(opts: IFsPrefsOptions): IFsPrefs {
	const { cm, path, owner } = opts;
	if (typeof owner !== 'string' || owner === '') {
		throw new RangeError('createFsPrefs needs the identity fingerprint as its owner; without an identity, history stays in memory.');
	}
	const timeoutMs = assertTimeoutMs(opts.timeoutMs ?? PREFS_FS_TIMEOUT_MS, 'prefs fs timeoutMs');
	const debounceMs = opts.debounceMs ?? PREFS_WRITE_DEBOUNCE_MS;
	const maxFileChars = opts.maxFileChars ?? MAX_PREFS_FILE_CHARS;
	const maxOwners = Math.max(1, opts.maxOwners ?? MAX_PREFS_OWNERS);
	const now = opts.now ?? Date.now;
	const setTimer = opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
	const clearTimer = opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const dir = opts.dir ?? (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
	/** Who is signed in now, relative to the owner. */
	const ownerState = (): 'owner' | 'unknown' | 'other' => {
		if (!opts.ownerNow) return 'owner';
		const current = opts.ownerNow();
		if (current === owner) return 'owner';
		return current === null || current === undefined || current === '' ? 'unknown' : 'other';
	};
	const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimer(resolve, ms); });

	let status: FsPrefsStatus = 'idle';
	let loading: Promise<FsPrefsStatus> | null = null;
	let others: Record<string, IOwnerBag> = {};
	let mine: Record<string, unknown> = {};
	/** Changes made before the load reached ready: applied over what it read. */
	const queued: Record<string, unknown> = {};
	let dirty = false;
	let timer: unknown = null;
	let retries = 0;
	let madeDir = false;
	let disposed = false;
	let chain: Promise<void> = Promise.resolve();

	/** Arm the write timer (debounce, or a retry backoff) when a write is due. */
	const schedule = (delayMs: number = debounceMs): void => {
		if (disposed || status !== 'ready' || !dirty || timer !== null) return;
		timer = setTimer(() => {
			timer = null;
			void writeNow();
		}, delayMs);
	};

	/** Schedule the next retry of a FAILED write, if any are left. */
	const retryLater = (): void => {
		if (retries >= PREFS_WRITE_RETRIES) return;
		retries += 1;
		schedule(Math.min(debounceMs * 2 ** retries, MAX_WRITE_RETRY_DELAY_MS));
	};

	/** Look again for a write HELD while nobody is signed in: not a failure, so no budget; at most every 30 s. */
	let holds = 0;
	const holdForOwner = (): void => {
		holds = Math.min(holds + 1, 16);
		schedule(Math.min(debounceMs * 2 ** holds, MAX_WRITE_RETRY_DELAY_MS));
	};

	/** Still this owner's accessor, signed in as this owner, after an await. */
	const stillOwner = (): boolean => !disposed && ownerState() === 'owner';

	/**
	 * Wait until the owner is signed in (or someone else is, or the accessor is disposed).
	 *
	 * @returns Which.
	 */
	const untilOwnerKnown = async (): Promise<'owner' | 'other' | 'disposed'> => {
		for (;;) {
			if (disposed) return 'disposed';
			const who = ownerState();
			if (who !== 'unknown') return who;
			await sleep(OWNER_POLL_MS);
		}
	};

	/**
	 * One attempt at reading the file. Each request's answer is used only while
	 * the owner is still the one signed in.
	 *
	 * @returns The owner's bag and the others, or 'stale' when the owner changed during a request.
	 */
	const readOnce = async (): Promise<{ mine: Record<string, unknown>; others: Record<string, IOwnerBag> } | 'stale'> => {
		const stat = await busRequest(cm, 'client.fsStat', { path }, timeoutMs);
		if (!stillOwner()) return 'stale';
		if (isPlainObject(stat) && stat.exists === false) return { mine: {}, others: {} };
		if (!isPlainObject(stat) || stat.exists !== true) throw new Error('client.fsStat gave no answer about the history file.');
		const raw = await busRequest(cm, 'client.fsReadJson', { path }, timeoutMs);
		if (!stillOwner()) return 'stale';
		const owners = readFile(raw);
		const own = { ...(owners[owner]?.prefs ?? {}) };
		delete owners[owner];
		return { mine: own, others: owners };
	};

	const load = (): Promise<FsPrefsStatus> => {
		if (loading !== null) return loading;
		status = 'loading';
		loading = (async (): Promise<FsPrefsStatus> => {
			let lastError: unknown = null;
			let failures = 0;
			let loaded = false;
			for (;;) {
				// No request, first or retry, unless the owner is the one signed in.
				const who = await untilOwnerKnown();
				if (who === 'disposed') break;
				if (who === 'other') {
					lastError = new Error('The signed-in identity changed before the history file was read.');
					break;
				}
				let result: Awaited<ReturnType<typeof readOnce>>;
				try {
					result = await readOnce();
				} catch (error) {
					// An answer that came back after the owner changed proves nothing.
					if (!stillOwner()) continue;
					lastError = error;
					failures += 1;
					// A file in a foreign format will not change on a retry.
					if (error instanceof FileFormatError || failures >= PREFS_LOAD_ATTEMPTS) break;
					await sleep(LOAD_RETRY_DELAYS_MS[failures - 1] ?? LOAD_RETRY_DELAYS_MS[LOAD_RETRY_DELAYS_MS.length - 1]);
					continue;
				}
				// Read while the owner was not signed in: discarded; look again.
				if (result === 'stale') continue;
				mine = result.mine;
				others = result.others;
				lastError = null;
				loaded = true;
				break;
			}
			if (disposed) {
				// A disposed accessor accepts nothing and writes nothing.
				status = 'failed';
				return status;
			}
			if (!loaded) {
				mine = {};
				status = 'failed';
				opts.onError?.(lastError, 'load');
			} else {
				status = 'ready';
			}
			// Changes made before the load win over what it read.
			if (Object.keys(queued).length > 0) {
				Object.assign(mine, queued);
				for (const key of Object.keys(queued)) delete queued[key];
				dirty = true;
			}
			schedule();
			return status;
		})();
		return loading;
	};

	/**
	 * The file to write, and the other owners it keeps; null when it is over the cap (reported).
	 *
	 * @returns The file and the kept owners.
	 */
	const compose = (): { file: { version: number; owners: Record<string, IOwnerBag> }; kept: Record<string, IOwnerBag> } | null => {
		const own: IOwnerBag = { at: now(), prefs: JSON.parse(JSON.stringify(mine)) as Record<string, unknown> };
		const kept = Object.entries(others).sort((a, b) => b[1].at - a[1].at).slice(0, maxOwners - 1);
		for (;;) {
			const file = { version: PREFS_FILE_VERSION, owners: { ...Object.fromEntries(kept), [owner]: own } };
			// Measured as client.ts fsWriteJson writes it: JSON.stringify(obj, null, 2).
			if (JSON.stringify(file, null, 2).length <= maxFileChars) return { file, kept: Object.fromEntries(kept) };
			if (kept.length === 0) break;
			kept.pop();
		}
		opts.onError?.(new RangeError(`The history file would exceed ${maxFileChars} characters; it was not written.`), 'write');
		return null;
	};

	/**
	 * Whether a write may go on now: the accessor is live and its owner is the
	 * one signed in. Another identity drops the pending change; nobody signed
	 * in keeps it and tries again later.
	 *
	 * @returns True to go on.
	 */
	const mayWrite = (): boolean => {
		if (disposed) return false;
		const who = ownerState();
		if (who === 'other') {
			// The identity changed: this owner's pending change is dropped.
			dirty = false;
			return false;
		}
		if (who === 'unknown') {
			// Nobody is vouched for (a reconnect): keep the change, look again later.
			holdForOwner();
			return false;
		}
		holds = 0;
		return true;
	};

	const write = async (): Promise<void> => {
		if (disposed || status !== 'ready' || !dirty) return;
		if (!mayWrite()) return;
		try {
			if (!madeDir && dir !== '') {
				try {
					await busRequest(cm, 'client.fsMkdir', { path: dir }, timeoutMs);
				} catch {
					// Usually "already exists"; a real failure surfaces on the write.
				}
				madeDir = true;
				// The owner may have changed, or the accessor gone, while the folder was made.
				if (!mayWrite()) return;
			}
			// Composed only now, from the bag of an owner who is signed in now.
			const composed = compose();
			dirty = false;
			if (composed === null) return;
			await busRequest(cm, 'client.fsWriteJson', { path, value: composed.file }, timeoutMs);
			if (disposed) return;
			others = composed.kept;
			retries = 0;
		} catch (error) {
			if (disposed) return;
			dirty = true;
			opts.onError?.(error, 'write');
			retryLater();
		}
	};

	const writeNow = (): Promise<void> => {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
		chain = chain.then(write, write);
		return chain;
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
		dirty = false;
	};

	return {
		owner,
		path,
		status: () => status,
		load,
		getPref: (key) => (status === 'idle' || status === 'loading' ? queued[key] : mine[key]),
		setPref(key, value) {
			if (status === 'idle' || status === 'loading') {
				queued[key] = value;
				return;
			}
			mine[key] = value;
			dirty = true;
			retries = 0;
			schedule();
		},
		flush: () => (disposed ? chain : writeNow()),
		close: async () => {
			if (!disposed) await writeNow();
			dispose();
		},
		dispose,
	};
}

/**
 * Attach a history store once the file is loaded (whatever the load's
 * outcome: a failed load attaches a session-only accessor that never writes).
 *
 * @param prefs - The accessor.
 * @param attach - Usually `(api, owner) => store.attachPrefs(api, owner)`.
 * @returns Detach; before the load settles it cancels the attach.
 */
export function attachWhenLoaded(prefs: IFsPrefs, attach: (api: IPrefsAccessor, owner: string) => () => void): () => void {
	let detach: (() => void) | null = null;
	let cancelled = false;
	void prefs.load().then(() => {
		if (!cancelled) detach = attach(prefs, prefs.owner);
	});
	return () => {
		cancelled = true;
		detach?.();
		detach = null;
	};
}
