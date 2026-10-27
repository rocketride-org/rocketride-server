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
// VECTOR - CONSOLE CONTROLLER (no React, no shell): stats, directory, trash, chunks, writes
// =============================================================================
//
// One controller per open console. It owns the console's calls and their
// pacing, so the React view only renders its snapshot and forwards clicks:
//
//   STATS      `stats({mode:'full'})` on open, after a write, after a
//              completed upload and on Refresh (after each of those but the
//              open, the store's dialect is probed again too, deps.reprobe);
//              `stats({mode:'quick'})` at most every 15 s while the console
//              is visible. A failure keeps the last figures (the strip greys
//              them) and says why; with no figures yet, the full call is
//              asked again every 15 s.
//   DIRECTORY  the auto-pager of vector/documents.ts: page after page in the
//              background while the console is visible; hidden, it pauses
//              (and sorts what is loaded); shown, it resumes at its cursor. A
//              refresh starts over and drops any page of the old listing.
//              With a scope, every page asks the store for its conditions
//              and its path box (setFilter); a new filter lists again from
//              the first page, the same one asks nothing, and refreshes keep
//              it. New path text alone keeps the rows when the store skipped
//              the path text (it would list the same ones).
//   TRASH      a second auto-pager over `list_documents {deleted: 'deleted'}`
//              (the documents with a chunk in the trash), listed once the
//              Trash view is first shown and again after Refresh or a write.
//   CHUNKS     the selected document's chunks, a page at a time. A document
//              whose chunks are all in the trash answers IN_TRASH, which says
//              so (vector/wording.ts).
//   WRITES     Move to trash (`soft_delete`) and Delete permanently
//              (`delete {deleted_only: true}`: a Trash action, so a partly
//              trashed document is kept whole) open a confirmation and send
//              NOTHING; Cancel sends nothing and says so; Confirm sends the
//              batches once (never retried). Restore (`restore`) runs at
//              once: it can be undone. Empty trash lists the whole trash
//              first, then confirms, then sends `delete {deleted_only: true}`
//              in batches. Both permanent writes name the documents they
//              kept because a chunk of them is live. A confirmation belongs
//              to the surface that asked (its origin); while it is open,
//              another surface's request opens nothing and says so
//              (`elsewhere`). After any
//              write that ran, the stats are asked in full, both listings
//              start over, the dialect is probed again and the map is told to
//              draw its sample again (deps.onWritten). Nothing opens or is
//              sent while writes are not available, or while another write
//              runs.
//
// Every call goes through injected functions, and time through an injected
// clock, so tests drive it without a browser.
// =============================================================================

import type { IChunkItem, IDocumentsFilter } from '../contract/types';
import { EMPTY_TRASH_MAX_PAGES, QUICK_STATS_INTERVAL_MS } from './budgets';
import { CONSOLE_ORIGIN, confirmElsewhereText, removalSummary, runRemoval } from './confirm';
import type { ConfirmOrigin, IRemovalOutcome, IRemoveTarget, RemovalAction } from './confirm';
import { pagerApplyPage, pagerBegin, pagerFail, pagerInit, pagerLoadMore, pagerPause, pagerResume, pagerWantsPage } from './documents';
import type { IPagerState } from './documents';
import { filterKeys, keepListing, sameFilter } from './filters';
import type { IChunksPageView, IDocumentsPageView, IRemoveView, IStatsView, ITrashView, IWriteAudit } from './results';
import { statsRefreshPlan } from './stats';
import type { StatsTrigger } from './stats';
import { BUSY, CANCELLED_TEXT, EMPTY, failureText } from './wording';
import type { IFailureText } from './wording';

// =============================================================================
// TYPES
// =============================================================================

/** Time and timers (injected for tests). */
export interface IConsoleClock {
	now(): number;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

/** What the controller calls. Each rejects with an ExplorerToolError on failure. */
export interface IConsoleDeps {
	stats(mode: 'full' | 'quick'): Promise<IStatsView>;
	/**
	 * One listing page; `filter` (the scope's conditions) is passed to the node when given. `deleted: 'deleted'`
	 * lists the trash (the active documents otherwise).
	 */
	documents(cursor: string | null, limit: number, filter?: IDocumentsFilter | null, deleted?: 'active' | 'deleted'): Promise<IDocumentsPageView>;
	chunks(objectId: string, afterChunk: number, limit: number): Promise<IChunksPageView>;
	/** One `soft_delete` batch: move documents to the trash. */
	trash(objectIds: string[]): Promise<ITrashView>;
	/** One `restore` batch: move documents back out of the trash. */
	restore(objectIds: string[]): Promise<ITrashView>;
	/** One `delete` batch (the permanent delete); `deletedOnly` keeps a document that still has a live chunk. */
	remove(objectIds: string[], opts?: { deletedOnly?: boolean }): Promise<IRemoveView>;
	/** Speak a short outcome through the polite live region. */
	announce(text: string): void;
	/** Documents that left the stored ones (the trash or a delete): the selection and the map forget them. */
	onRemoved?(objectIds: readonly string[]): void;
	/** A write ran: the map draws its sample again (its points may have gone into or come out of the trash). */
	onWritten?(): void;
	/**
	 * Probe the store again (its `dialect`): after an upload completes and after a write, so what was read at
	 * discovery (an empty collection, no model or index yet) does not stay on screen. Fire and forget.
	 */
	reprobe?(): void;
	clock: IConsoleClock;
}

/** Page sizes and the write batch, from the node's limits. */
export interface IConsoleOptions {
	pageSize: number;
	chunkPage: number;
	writeBatch: number;
}

/** The statistics part of the snapshot. */
export interface IStatsSlot {
	view: IStatsView | null;
	status: 'idle' | 'loading' | 'ready' | 'error';
	error: IFailureText | null;
	/** Epoch ms of the last answer. */
	lastAt: number | null;
	/** The mode of the last answer. */
	mode: 'full' | 'quick' | null;
}

/** The chunk list of the selected document. */
export interface IChunksSlot {
	objectId: string | null;
	items: IChunkItem[];
	status: 'idle' | 'loading' | 'ready' | 'error';
	hasMore: boolean;
	nextAfter: number;
	total: number | null;
	error: IFailureText | null;
}

/** Which listing the directory shows: the stored documents, or the trash. */
export type DirectoryView = 'active' | 'trash';

/** A confirmation waiting for the user. */
export interface IPendingRemoval {
	/** What Confirm sends: move to the trash, delete permanently, or empty the trash. */
	action: 'trash' | 'delete' | 'empty';
	kind: 'single' | 'multi';
	targets: IRemoveTarget[];
	/** The surface that asked: the confirmation shows there only. */
	origin: ConfirmOrigin;
}

/** The console's snapshot (replaced, never mutated). */
export interface IConsoleState {
	visible: boolean;
	stats: IStatsSlot;
	directory: IPagerState;
	/** The trash listing (`list_documents {deleted: 'deleted'}`); idle until the Trash view is first shown. */
	trash: IPagerState;
	view: DirectoryView;
	chunks: IChunksSlot;
	confirm: IPendingRemoval | null;
	/** A surface that asked for a confirmation while `confirm` was open on another one (it is told to finish that first), or null. */
	elsewhere: ConfirmOrigin | null;
	/**
	 * The last write; while one runs, `message` says what it is doing (null: the generic busy word). `audit`: the
	 * audit blocks of a finished write's batches.
	 */
	removal: { status: 'idle' | 'running' | 'done' | 'error'; message: string | null; audit?: readonly IWriteAudit[] };
}

/** The controller. */
export interface IConsoleStore {
	getState(): IConsoleState;
	subscribe(listener: () => void): () => void;
	/** First load: full stats, the directory, and the quick-stats timer. */
	open(): void;
	/** The console was shown or hidden (another tab, the Map). */
	setVisible(visible: boolean): void;
	/** Whether writing is available (the console model's `writes`). */
	setWritesEnabled(enabled: boolean): void;
	/** Refresh: full stats, the directory (and the trash, once listed) from the start. */
	refresh(): void;
	/** An upload completed or documents changed elsewhere. */
	documentsChanged(): void;
	loadMoreDocuments(): void;
	retryDocuments(): void;
	/**
	 * The conditions every page of the directory asks the store for (the scope's, without the path box), or
	 * null for every document. New conditions list again from the first page; the same ones ask nothing.
	 * Before the console opens they are kept for its first listing.
	 */
	setFilter(filter: IDocumentsFilter | null): void;
	/** Show the stored documents or the trash (the trash is listed when first shown). */
	setView(view: DirectoryView): void;
	selectDocument(objectId: string | null): void;
	loadMoreChunks(): void;
	/** Move to trash: opens the confirmation (nothing to type) on the surface that asked (default the console). */
	requestRemove(targets: readonly IRemoveTarget[], origin?: ConfirmOrigin): void;
	/**
	 * Delete permanently, from the Trash: opens the confirmation (typed as vector/confirm.ts says); Confirm sends
	 * `delete {deleted_only: true}`, so a document that still has a live chunk is kept whole.
	 */
	requestDelete(targets: readonly IRemoveTarget[], origin?: ConfirmOrigin): void;
	/** Restore from the trash, at once (it can be undone). */
	restore(targets: readonly IRemoveTarget[]): Promise<void>;
	/** Empty trash: list the whole trash, then open its confirmation (or say it is empty). */
	requestEmptyTrash(origin?: ConfirmOrigin): Promise<void>;
	cancelRemove(): void;
	confirmRemove(): Promise<void>;
	/** Stop every timer; later answers are dropped. */
	dispose(): void;
}

// =============================================================================
// FACTORY
// =============================================================================

const NO_CHUNKS: IChunksSlot = { objectId: null, items: [], status: 'idle', hasMore: false, nextAfter: -1, total: null, error: null };

/** The two listings, by their key in the snapshot. */
type ListKey = 'directory' | 'trash';

/** A trash answer read as a write's view: the documents it moved, the chunks it moved. */
function moved(view: ITrashView): IRemoveView {
	return { removed: view.moved.map((objectId) => ({ objectId, chunks: null })), notFound: view.notFound, keptLive: [], removedChunks: view.matchedChunks };
}

/**
 * Create a console controller.
 *
 * @param deps - The calls, the announcer and the clock.
 * @param opts - Page sizes and the write batch.
 * @returns The controller.
 */
export function createConsoleStore(deps: IConsoleDeps, opts: IConsoleOptions): IConsoleStore {
	let state: IConsoleState = {
		visible: true,
		stats: { view: null, status: 'idle', error: null, lastAt: null, mode: null },
		directory: pagerInit(),
		trash: pagerInit(),
		view: 'active',
		chunks: NO_CHUNKS,
		confirm: null,
		elsewhere: null,
		removal: { status: 'idle', message: null },
	};
	const listeners = new Set<() => void>();
	let disposed = false;
	let writesEnabled = false;
	let timer: unknown = null;
	// Stats: the newest call wins; an older answer that arrives later is dropped.
	let statsSeq = 0;
	let statsApplied = 0;
	let statsInFlight = 0;
	// When the last stats call failed (null once one answers): before any answer, ticks retry in full.
	let statsFailedAt: number | null = null;
	// Each listing is a run; a page of an older run never lands.
	const runs: Record<ListKey, number> = { directory: 0, trash: 0 };
	const pumping: Record<ListKey, number | null> = { directory: null, trash: null };
	// Chunks: each selection is a run.
	let chunkRun = 0;

	/** Replace the snapshot and notify. */
	function set(patch: Partial<IConsoleState>): void {
		if (disposed) return;
		state = { ...state, ...patch };
		for (const listener of [...listeners]) listener();
	}

	// ── Stats ────────────────────────────────────────────────────────────────

	/** Call stats and publish the answer (or the failure, keeping the last figures). */
	async function loadStats(mode: 'full' | 'quick'): Promise<void> {
		const seq = ++statsSeq;
		statsInFlight += 1;
		set({ stats: { ...state.stats, status: 'loading' } });
		try {
			const view = await deps.stats(mode);
			if (disposed || seq < statsApplied) return;
			statsApplied = seq;
			statsFailedAt = null;
			set({ stats: { view, status: 'ready', error: null, lastAt: deps.clock.now(), mode } });
		} catch (error) {
			if (disposed || seq < statsApplied) return;
			const text = failureText(error);
			if (text === null) return;
			statsFailedAt = deps.clock.now();
			set({ stats: { ...state.stats, status: 'error', error: text } });
		} finally {
			statsInFlight -= 1;
		}
	}

	/** Run the refresh plan for a trigger. */
	function planStats(trigger: StatsTrigger): void {
		const mode = statsRefreshPlan(trigger, { visible: state.visible, lastAt: state.stats.lastAt, failedAt: statsFailedAt, now: deps.clock.now(), inFlight: statsInFlight > 0 });
		if (mode !== null) void loadStats(mode);
	}

	/** (Re)arm the quick-stats timer. */
	function arm(): void {
		if (disposed) return;
		if (timer !== null) deps.clock.clearTimer(timer);
		timer = deps.clock.setTimer(() => {
			timer = null;
			if (disposed) return;
			planStats('tick');
			arm();
		}, QUICK_STATS_INTERVAL_MS);
	}

	// ── Listings ─────────────────────────────────────────────────────────────

	/** One page of a listing: the directory with its filter, the trash without one. */
	function page(key: ListKey): Promise<IDocumentsPageView> {
		const pager = state[key];
		return key === 'trash' ? deps.documents(pager.cursor, opts.pageSize, null, 'deleted') : deps.documents(pager.cursor, opts.pageSize, pager.filter);
	}

	/** Ask for pages while the listing wants them and the console is visible. */
	async function pump(key: ListKey, run: number): Promise<void> {
		if (pumping[key] === run) return;
		pumping[key] = run;
		try {
			while (!disposed && run === runs[key] && state.visible && pagerWantsPage(state[key])) {
				let answer: IDocumentsPageView;
				try {
					answer = await page(key);
				} catch (error) {
					if (disposed || run !== runs[key]) return;
					const text = failureText(error);
					if (text !== null) set({ [key]: pagerFail(state[key], text) });
					return;
				}
				if (disposed || run !== runs[key]) return;
				let next = pagerApplyPage(state[key], answer);
				if (!state.visible) next = pagerPause(next);
				set({ [key]: next });
			}
		} finally {
			if (pumping[key] === run) pumping[key] = null;
		}
	}

	/** Start the directory over (with its filter unless another is given). */
	function startDirectory(filter: IDocumentsFilter | null = state.directory.filter): void {
		runs.directory += 1;
		pumping.directory = null;
		set({ directory: pagerBegin(state.directory, filter) });
		void pump('directory', runs.directory);
	}

	/** Start the trash listing over. */
	function startTrash(): void {
		runs.trash += 1;
		pumping.trash = null;
		set({ trash: pagerBegin(state.trash, null) });
		void pump('trash', runs.trash);
	}

	/** The listings start over: the directory always, the trash once it was listed. */
	function relist(): void {
		startDirectory();
		if (state.trash.status !== 'idle') startTrash();
	}

	// ── Chunks ───────────────────────────────────────────────────────────────

	/** Load one page of the selected document's chunks. */
	async function loadChunks(run: number, objectId: string, afterChunk: number): Promise<void> {
		set({ chunks: { ...state.chunks, status: 'loading', error: null } });
		try {
			const answer = await deps.chunks(objectId, afterChunk, opts.chunkPage);
			if (disposed || run !== chunkRun) return;
			const items = afterChunk < 0 ? answer.items : [...state.chunks.items, ...answer.items];
			set({ chunks: { objectId, items, status: 'ready', hasMore: answer.hasMore, nextAfter: answer.nextAfter, total: answer.total, error: null } });
		} catch (error) {
			if (disposed || run !== chunkRun) return;
			const text = failureText(error);
			if (text !== null) set({ chunks: { ...state.chunks, status: 'error', error: text } });
		}
	}

	// ── Writes ───────────────────────────────────────────────────────────────

	/** Whether a write may start now; says why not when another one runs. */
	function canWrite(): boolean {
		if (!writesEnabled) return false;
		// One write at a time: nothing opens or is sent while one runs (a button outside the directory says why).
		if (state.removal.status === 'running') {
			deps.announce(BUSY.removing);
			return false;
		}
		return true;
	}

	/**
	 * Whether a surface may open a confirmation now. One open on another surface stays (it is never replaced): the
	 * asking surface is told to finish that one first.
	 */
	function mayAsk(origin: ConfirmOrigin): boolean {
		const open = state.confirm;
		if (open === null || open.origin === origin) return true;
		set({ elsewhere: origin });
		deps.announce(confirmElsewhereText(open.origin));
		return false;
	}

	/** Open a confirmation on the surface that asked. */
	function ask(action: IPendingRemoval['action'], targets: readonly IRemoveTarget[], origin: ConfirmOrigin): void {
		if (targets.length === 0 || !canWrite() || !mayAsk(origin)) return;
		set({ confirm: { action, kind: targets.length === 1 ? 'single' : 'multi', targets: [...targets], origin }, elsewhere: null });
	}

	/** Run a write's batches, say what it did, and refresh what a write changes. */
	async function write(action: RemovalAction, targets: readonly IRemoveTarget[]): Promise<void> {
		set({ confirm: null, elsewhere: null, removal: { status: 'running', message: action === 'restore' ? BUSY.restoring : null } });
		const ids = targets.map((t) => t.objectId);
		const call = (batch: string[]): Promise<IRemoveView> => {
			if (action === 'trash') return deps.trash(batch).then(moved);
			if (action === 'restore') return deps.restore(batch).then(moved);
			// Both permanent writes are Trash actions: a document that still has a live chunk is kept whole.
			return deps.remove(batch, { deletedOnly: true });
		};
		const outcome: IRemovalOutcome = await runRemoval(ids, call, opts.writeBatch);
		const message = removalSummary(outcome, targets, action);
		set({ removal: { status: outcome.error ? 'error' : 'done', message, audit: outcome.audits ?? [] } });
		deps.announce(message);
		// What left the stored documents: a restored one comes back, a kept one stays where it was.
		const gone = action === 'restore' ? [] : [...outcome.removed.map((r) => r.objectId), ...outcome.notFound];
		if (gone.length > 0) {
			deps.onRemoved?.(gone);
			if (state.chunks.objectId !== null && gone.includes(state.chunks.objectId)) {
				chunkRun += 1;
				set({ chunks: NO_CHUNKS });
			}
		}
		if (outcome.batchesRun > 0) {
			planStats('write');
			relist();
			deps.reprobe?.();
			deps.onWritten?.();
		}
	}

	/**
	 * Every document of the trash, page after page (EMPTY_TRASH_MAX_PAGES at most), or null when a page failed.
	 * A page that brings no document not already listed ends the listing, as the directory's does.
	 */
	async function wholeTrash(): Promise<IRemoveTarget[] | null> {
		const found = new Map<string, IRemoveTarget>();
		let cursor: string | null = null;
		for (let n = 0; n < EMPTY_TRASH_MAX_PAGES; n++) {
			let answer: IDocumentsPageView;
			try {
				answer = await deps.documents(cursor, opts.pageSize, null, 'deleted');
			} catch (error) {
				const text = failureText(error) ?? { headline: 'The trash could not be listed.' };
				set({ removal: { status: 'error', message: text.headline } });
				deps.announce(text.headline);
				return null;
			}
			let added = 0;
			for (const item of answer.items) {
				if (found.has(item.objectId)) continue;
				found.set(item.objectId, { objectId: item.objectId, path: item.path, chunks: item.chunks });
				added += 1;
			}
			if (answer.nextCursor === null || added === 0 || answer.pagingUnsupported) break;
			cursor = answer.nextCursor;
		}
		return [...found.values()];
	}

	// ── Public ───────────────────────────────────────────────────────────────

	return {
		getState: () => state,
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		open(): void {
			planStats('open');
			startDirectory();
			arm();
		},
		setVisible(visible: boolean): void {
			if (visible === state.visible) return;
			if (!visible) {
				set({ visible, directory: pagerPause(state.directory), trash: pagerPause(state.trash) });
				return;
			}
			const resume = (pager: IPagerState): IPagerState => (pager.status === 'paused' ? pagerResume(pager) : pager);
			set({ visible, directory: resume(state.directory), trash: resume(state.trash) });
			void pump('directory', runs.directory);
			void pump('trash', runs.trash);
		},
		setWritesEnabled(enabled: boolean): void {
			writesEnabled = enabled;
			if (!enabled && state.confirm !== null) set({ confirm: null, elsewhere: null });
		},
		refresh(): void {
			planStats('manual');
			relist();
			// The dialect too: a store found empty and filled from elsewhere (a seed script, another app) would keep its
			// empty-collection answer (no index, no size) until a Test connection otherwise.
			deps.reprobe?.();
		},
		documentsChanged(): void {
			planStats('upload');
			relist();
			deps.reprobe?.();
		},
		loadMoreDocuments(): void {
			const key: ListKey = state.view === 'trash' ? 'trash' : 'directory';
			set({ [key]: pagerLoadMore(state[key]) });
			void pump(key, runs[key]);
		},
		retryDocuments(): void {
			const key: ListKey = state.view === 'trash' ? 'trash' : 'directory';
			set({ [key]: pagerResume(state[key]) });
			void pump(key, runs[key]);
		},
		setFilter(filter: IDocumentsFilter | null): void {
			const next = filter !== null && filterKeys(filter).length > 0 ? { ...filter } : null;
			if (sameFilter(next, state.directory.filter)) return;
			if (state.directory.status === 'idle') {
				set({ directory: { ...state.directory, filter: next } });
				return;
			}
			// Only the path box changed and the store skipped it: it would list the same rows again.
			const kept = keepListing(state.directory, next);
			if (kept !== null) {
				set({ directory: kept });
				return;
			}
			startDirectory(next);
		},
		setView(view: DirectoryView): void {
			if (view === state.view) return;
			set({ view });
			if (view === 'trash' && state.trash.status === 'idle') startTrash();
		},
		selectDocument(objectId: string | null): void {
			chunkRun += 1;
			if (objectId === null) {
				set({ chunks: NO_CHUNKS });
				return;
			}
			set({ chunks: { ...NO_CHUNKS, objectId, status: 'loading' } });
			void loadChunks(chunkRun, objectId, -1);
		},
		loadMoreChunks(): void {
			const { objectId, hasMore, status, nextAfter } = state.chunks;
			if (objectId === null || !hasMore || status === 'loading') return;
			void loadChunks(chunkRun, objectId, nextAfter);
		},
		requestRemove(targets: readonly IRemoveTarget[], origin: ConfirmOrigin = CONSOLE_ORIGIN): void {
			ask('trash', targets, origin);
		},
		requestDelete(targets: readonly IRemoveTarget[], origin: ConfirmOrigin = CONSOLE_ORIGIN): void {
			ask('delete', targets, origin);
		},
		async restore(targets: readonly IRemoveTarget[]): Promise<void> {
			if (targets.length === 0 || !canWrite()) return;
			await write('restore', targets);
		},
		async requestEmptyTrash(origin: ConfirmOrigin = CONSOLE_ORIGIN): Promise<void> {
			if (!canWrite() || !mayAsk(origin)) return;
			set({ removal: { status: 'running', message: BUSY.listingTrash } });
			const targets = await wholeTrash();
			if (disposed || targets === null) return;
			if (targets.length === 0) {
				set({ removal: { status: 'done', message: EMPTY.trash } });
				deps.announce(EMPTY.trash);
				return;
			}
			set({ removal: { status: 'idle', message: null } });
			if (!writesEnabled || !mayAsk(origin)) return;
			set({ confirm: { action: 'empty', kind: 'multi', targets, origin }, elsewhere: null });
		},
		cancelRemove(): void {
			if (state.confirm === null) return;
			set({ confirm: null, elsewhere: null, removal: { status: 'idle', message: CANCELLED_TEXT } });
			deps.announce(CANCELLED_TEXT);
		},
		async confirmRemove(): Promise<void> {
			const pending = state.confirm;
			if (pending === null || !writesEnabled || state.removal.status === 'running') return;
			await write(pending.action, pending.targets);
		},
		dispose(): void {
			if (timer !== null) deps.clock.clearTimer(timer);
			timer = null;
			disposed = true;
			listeners.clear();
		},
	};
}
