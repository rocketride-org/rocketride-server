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
// VECTOR-UI — INGEST QUEUE (one connection's drops, probes, sends and counts)
// =============================================================================
//
// One queue per open connection; the React hook (useIngest.ts) wires it to
// the connection's channels and renders its state. For each drop:
//
//   1. PLAN     paths and caps (uploads.ts planDrop); refused files get a row
//               that says why, nothing else happens to them.
//   2. PROBE    for every accepted file, `chunks({object_id, limit: 1})` on
//               the objectId the engine will derive: NOT_FOUND → queued; an
//               answer → it is stored; anything else → could not tell.
//   3. ASK      stored or uncheckable files wait for one question
//               (replaceQuestion); Cancel sends none of them.
//   4. SEND     uploads.ts batchForSend: unique base names together, shared
//               ones one at a time; the name locks keep a base name single
//               across the app. Progress events (handleEvent) move the row of
//               the one file of that name in flight; the result sendFiles
//               returns decides the outcome.
//   5. COUNT    `documents({object_ids: [id]})` reports how many chunks the
//               store holds ("N chunks added"). A completed upload the store
//               still does not list after the recounts was not added: the
//               pipeline stored no chunks for it (a file without text the
//               parser can read ends this way; the engine reports no error).
//               Then onDocumentsChanged lets the console refresh its stats
//               and directory.
//   6. SUMMARY  every drop with a row is kept as an IngestDrop (uploads.ts):
//               its row ids, each row as it ended, and its start and end
//               times, so the list can say "Drop of 12 files: 9 added (341
//               chunks) · …" live and after Clear finished. A drop of more
//               than one file is announced once, after its last file's own
//               line. Clear finished forgets the drops that have finished.
//
// Drops are planned and asked about in order; sends run one call at a time.
// Nothing here retries, and nothing ever sends an objectId. dispose() forgets
// everything (identity change, connection closed): a send in flight cannot be
// recalled, so its result is ignored.
// =============================================================================

import type { ISendFile } from 'shared/explorer';
import type { IUploadEvent } from '../contract/types';
import { outcomeFromError } from '../chat/toolCalls';
import type { CallOutcome } from '../chat/toolCalls';
import { CANCELLED_SENTENCE, FINISHED, applyFinalResult, applyUploadEvent, batchForSend, chunkCountMessage, classifyProbe, dropSummaryText, planDrop, replaceQuestion, sendFilesPayload, settleDrops, summariseDrop, uploadLabel } from '../vector/uploads';
import type { ConfirmItem, DropCandidate, DropShown, IngestDrop, PlannedUpload, ProbeOutcome, ReplaceQuestion, SendUnit, UploadRow } from '../vector/uploads';
import { sharedUploadLocks } from './nameLocks';
import type { NameLocks } from './nameLocks';
import { TRAVERSAL_SCAN_CAP } from './dropTraversal';

/**
 * Waits before each recount of a completed upload the store does not list. The
 * engine answers an upload once its pipeline has run, so a stored document is
 * normally listed at the first look; the recounts give a store that lists a
 * little late a few seconds before the row says the file was not added.
 */
export const RECOUNT_DELAYS_MS: readonly number[] = [1_500, 3_000];

/** A completed upload the store lists no chunk of after the recounts. */
export const NOT_STORED_SENTENCE = "Not added: the pipeline stored no chunks for this file. The parser may have found no text in it; the pipeline's run log may say why.";

/** What the queue needs from the connection. Read on every use, so getters may change. */
export interface IngestDeps {
	/** Whether the collision probe can run (a channel that can call tools, and a store with `chunks`). */
	canProbe: boolean;
	/** Whether the chunk count can be read after an upload. */
	canCount: boolean;
	/** Call a tool on the store node (never throws). */
	callTool(tool: 'chunks' | 'list_documents', input: Record<string, unknown>): Promise<CallOutcome>;
	/** The ingest role's sendFiles. */
	sendFiles(files: ISendFile[], options: { maxConcurrent: number }): Promise<Array<Record<string, unknown>>>;
	/** Uploads completed (stored or not): refresh stats and the directory. */
	onDocumentsChanged(objectIds: readonly string[]): void;
	/** Say something through the polite live region. */
	announce(message: string): void;
	/** Timer seam (tests). */
	sleep?(ms: number): Promise<void>;
	/** Clock seam for the drops' times (tests; default Date.now). */
	now?(): number;
	/** Base-name locks (default: shared by every queue of the app). */
	locks?: NameLocks;
}

/** The open replace question. */
export interface ConfirmRequest extends ReplaceQuestion {
	id: number;
	items: ConfirmItem[];
}

/** What the upload panel renders. */
export interface IngestState {
	rows: readonly UploadRow[];
	confirm: ConfirmRequest | null;
	/** Sentences about the latest drop (skipped hidden files, unreadable files, the scan cap). */
	notes: readonly string[];
	/** The drops whose rows are listed (or were, until Clear finished), oldest first. */
	drops: readonly IngestDrop[];
	/** True while anything is being checked, sent or counted. */
	busy: boolean;
}

/** Extra facts about a drop from the traversal. */
export interface AddDropOptions {
	prefix?: string;
	skipped?: readonly string[];
	errors?: readonly string[];
	truncated?: boolean;
}

/** One connection's upload queue. */
export interface IngestQueue {
	getState(): IngestState;
	subscribe(listener: () => void): () => void;
	/** Plan, probe and (after any question) enqueue a drop. Resolves once the drop is enqueued or abandoned. */
	addDrop(candidates: readonly DropCandidate[], options?: AddDropOptions): Promise<void>;
	/** Answer the open replace question. */
	answerConfirm(replace: boolean): void;
	/** An `apaevt_status_upload` body from the shell's event stream. */
	handleEvent(event: IUploadEvent): void;
	/** Drop finished rows, and the drops that have finished, from the list. */
	clearFinished(): void;
	/** Remember what "Show new chunks on the map" sent for a drop. */
	markShown(dropId: string, shown: DropShown): void;
	/** Resolves when nothing is being planned, sent or counted. */
	idle(): Promise<void>;
	/** Resolves when the state satisfies `predicate`. */
	waitFor(predicate: (state: IngestState) => boolean): Promise<void>;
	/** Forget everything; late results are ignored. */
	dispose(): void;
}

/**
 * Whether a value is a plain object.
 *
 * @param value - Anything.
 * @returns True for non-null, non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The sentence for a send that never started.
 *
 * @param failure - Why sendFiles rejected.
 * @returns The sentence.
 */
function notSentSentence(failure: Extract<CallOutcome, { ok: false }>): string {
	if (failure.kind === 'unavailable') return "Not sent: this pipeline's Ingest source is not running. Start its dropper source and try again.";
	return `Not sent: ${failure.message}`;
}

/**
 * Create a queue.
 *
 * @param deps - The connection's seams.
 * @returns The queue.
 */
export function createIngestQueue(deps: IngestDeps): IngestQueue {
	const locks = deps.locks ?? sharedUploadLocks;
	const sleep = (ms: number): Promise<void> => (deps.sleep ? deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms)));
	const now = (): number => (deps.now ? deps.now() : Date.now());
	const listeners = new Set<() => void>();

	let state: IngestState = { rows: [], confirm: null, notes: [], drops: [], busy: false };
	let disposed = false;
	let rowCounter = 0;
	let dropCounter = 0;
	let confirmCounter = 0;
	let dropsPending = 0;
	let dropChain: Promise<void> = Promise.resolve();
	let pendingConfirm: ((replace: boolean) => void) | null = null;
	const units: SendUnit[] = [];
	let runner: Promise<void> | null = null;
	const counting = new Set<Promise<void>>();
	/** Base name → row id of the file of that name in flight. */
	let inFlight = new Map<string, string>();

	/**
	 * Replace the state and notify.
	 *
	 * @param patch - The fields that change.
	 */
	const set = (patch: Partial<IngestState>): void => {
		if (disposed) return;
		const next = { ...state, ...patch };
		const settled = settleDrops(next.drops, next.rows, now());
		next.drops = settled.drops;
		next.busy = dropsPending > 0 || runner !== null || counting.size > 0 || next.rows.some((row) => !FINISHED.has(row.status));
		state = next;
		for (const listener of [...listeners]) listener();
		for (const drop of settled.finished) announceDrop(drop);
	};

	/**
	 * Say a finished drop's summary, after the line its last file says (a
	 * one-file drop's row already said everything).
	 *
	 * @param drop - The drop that just finished.
	 */
	const announceDrop = (drop: IngestDrop): void => {
		if (drop.rowIds.length < 2) return;
		const line = dropSummaryText(summariseDrop(drop, state.rows, drop.finishedAt ?? now()));
		void Promise.resolve().then(() => {
			if (!disposed) deps.announce(line);
		});
	};

	/**
	 * Change one row.
	 *
	 * @param id - The row id.
	 * @param change - New fields, or a function of the row.
	 */
	const updateRow = (id: string, change: Partial<UploadRow> | ((row: UploadRow) => UploadRow)): void => {
		const rows = state.rows.map((row) => (row.id !== id ? row : typeof change === 'function' ? change(row) : { ...row, ...change }));
		set({ rows });
	};

	const rowOf = (id: string): UploadRow | undefined => state.rows.find((row) => row.id === id);

	/**
	 * Ask the replace question and wait for the answer.
	 *
	 * @param items - The files concerned.
	 * @returns True to replace.
	 */
	const ask = (items: ConfirmItem[]): Promise<boolean> =>
		new Promise((resolve) => {
			confirmCounter += 1;
			pendingConfirm = resolve;
			set({ confirm: { id: confirmCounter, items, ...replaceQuestion(items) } });
		});

	/**
	 * Read the chunk count of finished uploads, then report them.
	 *
	 * @param files - Files whose upload completed.
	 */
	const countChunks = async (files: readonly PlannedUpload[]): Promise<void> => {
		const completed: string[] = [];
		for (const file of files) {
			if (disposed) return;
			// The id the engine reported for the upload (applyFinalResult), else the derived one.
			const objectId = rowOf(file.id)?.objectId ?? file.objectId;
			let chunks: number | null = null;
			let message: string | null;
			let stored = true;
			if (!deps.canCount) {
				message = 'Sent. Refresh to see it in the list.';
			} else {
				let listed = false;
				let failure: string | null = null;
				for (let attempt = 0; attempt <= RECOUNT_DELAYS_MS.length && !listed && failure === null; attempt++) {
					if (attempt > 0) await sleep(RECOUNT_DELAYS_MS[attempt - 1] as number);
					const outcome = await deps.callTool('list_documents', { object_ids: [objectId], limit: 1 });
					if (disposed) return;
					if (!outcome.ok) {
						failure = outcome.message;
						break;
					}
					const items = Array.isArray(outcome.value.items) ? outcome.value.items : [];
					const item = items.find((candidate) => isRecord(candidate) && candidate.objectId === objectId);
					if (isRecord(item)) {
						listed = true;
						chunks = typeof item.chunks === 'number' && Number.isFinite(item.chunks) ? item.chunks : null;
					}
				}
				const replaced = rowOf(file.id)?.replaces === true;
				if (failure !== null) message = `${replaced ? 'Replaced' : 'Added'}. The chunk count could not be read: ${failure}`;
				else if (!listed) {
					stored = false;
					message = NOT_STORED_SENTENCE;
				} else message = chunkCountMessage(chunks, replaced);
			}
			updateRow(file.id, { status: stored ? 'done' : 'failed', chunks, message });
			completed.push(objectId);
			const row = rowOf(file.id);
			if (row) deps.announce(`${file.path}: ${uploadLabel(row)}`);
		}
		// The pipeline ran for every one of them, so the console refreshes what it shows either way.
		if (completed.length > 0 && !disposed) deps.onDocumentsChanged(completed);
	};

	/** Send queued units one call at a time. */
	const runUnits = async (): Promise<void> => {
		while (units.length > 0 && !disposed) {
			const unit = units.shift() as SendUnit;
			const release = await locks.acquire(unit.files.map((file) => file.name));
			if (disposed) {
				release();
				return;
			}
			inFlight = new Map(unit.files.map((file) => [file.name, file.id]));
			let results: Array<Record<string, unknown>> | null = null;
			let failure: Extract<CallOutcome, { ok: false }> | null = null;
			try {
				results = await deps.sendFiles(sendFilesPayload(unit), { maxConcurrent: unit.maxConcurrent });
			} catch (error) {
				failure = outcomeFromError(error);
			} finally {
				inFlight = new Map();
				release();
			}
			if (disposed) return;
			const completed: PlannedUpload[] = [];
			unit.files.forEach((file, index) => {
				if (failure !== null) {
					updateRow(file.id, { status: 'failed', message: notSentSentence(failure), detail: failure.detail ?? null });
					return;
				}
				const result = Array.isArray(results) && isRecord(results[index]) ? results[index] : null;
				updateRow(file.id, (row) => applyFinalResult(row, result));
				const row = rowOf(file.id);
				if (row?.status === 'counting') completed.push(file);
				else if (row) deps.announce(`${file.path}: not added.`);
			});
			if (completed.length > 0) {
				const task = countChunks(completed).finally(() => {
					counting.delete(task);
					set({});
				});
				counting.add(task);
			}
		}
	};

	/** Start the sender if it is not running. */
	const pump = (): void => {
		if (runner !== null || disposed) return;
		runner = runUnits().finally(() => {
			runner = null;
			if (units.length > 0 && !disposed) pump();
			else set({});
		});
		set({});
	};

	/**
	 * Plan, probe and ask about one drop, then enqueue what is sent.
	 *
	 * @param candidates - The dropped files.
	 * @param options - Traversal facts and the folder prefix.
	 */
	const runDrop = async (candidates: readonly DropCandidate[], options: AddDropOptions, startedAt: number): Promise<void> => {
		if (disposed) return;
		const inFlightPaths = new Set(state.rows.filter((row) => !FINISHED.has(row.status)).map((row) => row.path));
		const plan = planDrop(candidates, {
			prefix: options.prefix ?? '',
			inFlightPaths,
			nextId: () => {
				rowCounter += 1;
				return `u${rowCounter}`;
			},
		});

		const notes: string[] = [];
		const skipped = options.skipped?.length ?? 0;
		if (skipped > 0) notes.push(skipped === 1 ? 'Skipped 1 hidden or system file.' : `Skipped ${skipped.toLocaleString('en-US')} hidden or system files.`);
		for (const error of options.errors ?? []) notes.push(error);
		if (options.truncated) notes.push(`More than ${TRAVERSAL_SCAN_CAP.toLocaleString('en-US')} files were dropped; only the first ${TRAVERSAL_SCAN_CAP.toLocaleString('en-US')} were read.`);

		const fresh: Array<{ index: number; row: UploadRow }> = [...plan.accepted.map((file) => ({ index: file.index, row: { id: file.id, path: file.path, name: file.name, objectId: file.objectId, size: file.size, status: 'checking' as const, bytesSent: 0, fileSize: file.size, chunks: null, existingChunks: null, message: null, detail: null } })), ...plan.refused.map((file) => ({ index: file.index, row: { id: file.id, path: file.path, name: file.name, objectId: '', size: file.size, status: 'refused' as const, bytesSent: 0, fileSize: file.size, chunks: null, existingChunks: null, message: file.reason, detail: null } }))];
		fresh.sort((a, b) => a.index - b.index);
		const drops = [...state.drops];
		if (fresh.length > 0) {
			dropCounter += 1;
			drops.push({ id: `d${dropCounter}`, startedAt, finishedAt: null, rowIds: fresh.map((entry) => entry.row.id), ended: {}, shown: null });
		}
		set({ rows: [...state.rows, ...fresh.map((entry) => entry.row)], notes, drops });
		if (plan.refused.length > 0) {
			deps.announce(plan.refused.length === 1 ? '1 file was not added; the list says why.' : `${plan.refused.length} files were not added; the list says why.`);
		} else if (plan.accepted.length === 0 && notes.length > 0) {
			// Nothing to add and no row to show: the notes are all this drop has to say.
			deps.announce(notes.join(' '));
		}

		// Probe every accepted file before anything of this drop is sent.
		const confirmItems: ConfirmItem[] = [];
		const ready = new Set<string>();
		for (const file of plan.accepted) {
			let outcome: ProbeOutcome;
			if (!deps.canProbe) outcome = { state: 'unknown', reason: 'this store cannot look documents up' };
			else outcome = classifyProbe(await deps.callTool('chunks', { object_id: file.objectId, limit: 1 }));
			if (disposed) return;
			if (outcome.state === 'absent') {
				ready.add(file.id);
				updateRow(file.id, { status: 'queued' });
			} else if (outcome.state === 'exists') {
				confirmItems.push({ rowId: file.id, path: file.path, state: 'exists', chunks: outcome.chunks });
				updateRow(file.id, { status: 'confirm', existingChunks: outcome.chunks });
			} else {
				confirmItems.push({ rowId: file.id, path: file.path, state: 'unknown', reason: outcome.reason });
				updateRow(file.id, { status: 'confirm' });
			}
		}

		if (confirmItems.length > 0) {
			const replace = await ask(confirmItems);
			if (disposed) return;
			for (const item of confirmItems) {
				if (replace) {
					ready.add(item.rowId);
					// A path the probe found stored is replaced; one it could not check is only sent.
					updateRow(item.rowId, item.state === 'exists' ? { status: 'queued', replaces: true } : { status: 'queued' });
				} else {
					updateRow(item.rowId, { status: 'cancelled', message: CANCELLED_SENTENCE });
				}
			}
			if (!replace) deps.announce(CANCELLED_SENTENCE);
		}

		const toSend = plan.accepted.filter((file) => ready.has(file.id));
		units.push(...batchForSend(toSend));
		pump();
	};

	/**
	 * Listen to state changes.
	 *
	 * @param listener - Called after every change.
	 * @returns Unsubscribe.
	 */
	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};

	return {
		getState: () => state,
		subscribe,
		addDrop(candidates, options = {}) {
			if (disposed) return Promise.resolve();
			dropsPending += 1;
			set({});
			const startedAt = now();
			const run = (): Promise<void> => runDrop(candidates, options, startedAt);
			const step = dropChain.then(run, run).finally(() => {
				dropsPending -= 1;
				set({});
			});
			dropChain = step.catch(() => undefined);
			return step;
		},
		answerConfirm(replace) {
			const resolve = pendingConfirm;
			pendingConfirm = null;
			set({ confirm: null });
			resolve?.(replace);
		},
		handleEvent(event) {
			if (disposed || !isRecord(event) || typeof event.filepath !== 'string') return;
			const id = inFlight.get(event.filepath);
			if (id === undefined) return;
			updateRow(id, (row) => applyUploadEvent(row, event));
		},
		clearFinished() {
			set({ rows: state.rows.filter((row) => !FINISHED.has(row.status)), notes: [], drops: state.drops.filter((drop) => drop.finishedAt === null) });
		},
		markShown(dropId, shown) {
			if (!state.drops.some((drop) => drop.id === dropId)) return;
			set({ drops: state.drops.map((drop) => (drop.id === dropId ? { ...drop, shown: { placed: shown.placed, total: shown.total } } : drop)) });
		},
		async idle() {
			for (;;) {
				await dropChain;
				if (runner !== null) await runner;
				if (counting.size > 0) await Promise.all([...counting]);
				if (dropsPending === 0 && runner === null && counting.size === 0 && units.length === 0) return;
			}
		},
		waitFor(predicate) {
			if (predicate(state)) return Promise.resolve();
			return new Promise((resolve) => {
				const unsubscribe = subscribe(() => {
					if (predicate(state)) {
						unsubscribe();
						resolve();
					}
				});
			});
		},
		dispose() {
			const resolve = pendingConfirm;
			pendingConfirm = null;
			units.length = 0;
			inFlight = new Map();
			state = { rows: [], confirm: null, notes: [], drops: [], busy: false };
			for (const listener of [...listeners]) listener();
			disposed = true;
			resolve?.(false);
		},
	};
}
