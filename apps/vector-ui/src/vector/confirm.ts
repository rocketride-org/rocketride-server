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
// VECTOR - CONFIRM AND REMOVE (pure): what the dialogs say, and the batched writes
// =============================================================================
//
// The console's writes: Move to trash (`soft_delete`), Restore (`restore`),
// and the two permanent ones, Delete permanently and Empty trash, both
// `delete` with `deleted_only` (both are Trash actions: a document that
// still has a live chunk, a partly trashed one, is left whole and named).
// They follow Graph Explorer's rules: Cancel has the focus (so a stray Enter
// cancels), Cancel sends nothing, and the text says exactly what will
// happen: the path, a short objectId, the chunk count the store reported
// (never an estimate), and where.
//
// Moving to the trash can be undone from the Trash, so nothing is typed for
// it and its dialog is not destructive; Restore runs without a dialog. The
// permanent writes are typed: on `rocketride_vector`, whose table is shared
// by every pipeline of the organization that names it, the user types the
// table name; one document is confirmed by typing its file name, several
// documents (and the trash, emptied) by typing their count. Every write is
// sent in batches of at most `write_ids_max` (100), and the first error stops
// the rest; the summary says what already ran, and names the documents kept
// because a chunk of them was still live.
//
// A confirmation belongs to the surface that asked for it (its ORIGIN: the
// console, or one document tab of the full app, which shares the console's
// controller). It shows there only, and another surface asking meanwhile is
// told to finish it first (confirmElsewhereText).
// =============================================================================

import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { MULTI_REMOVE_LIST_MAX } from './budgets';
import { splitPath } from './documents';
import { readDialect } from './results';
import type { IRemoveView, IWriteAudit } from './results';
import { formatCount } from './stats';
import { providerTitle } from './support';
import { failureText } from './wording';
import type { IFailureText } from './wording';

/** The dialogs' cancel label (the focus step looks for it). */
export const REMOVE_CANCEL_LABEL = 'Cancel';

/** Where a confirmation was asked for: the connection's console, or one document tab (`document:<objectId>`). */
export type ConfirmOrigin = string;

/** The console's own confirmations (its tabs, the map, the pending bar). */
export const CONSOLE_ORIGIN: ConfirmOrigin = 'console';

/**
 * The origin of a document tab's confirmations.
 *
 * @param objectId - The document the tab shows.
 * @returns The origin.
 */
export function documentOrigin(objectId: string): ConfirmOrigin {
	return `document:${objectId}`;
}

/**
 * What a surface says when it asked for a confirmation while another one is open elsewhere.
 *
 * @param origin - Where the open one is.
 * @returns The sentence.
 */
export function confirmElsewhereText(origin: ConfirmOrigin): string {
	const where = origin === CONSOLE_ORIGIN ? "this connection's console" : 'a document tab of this connection';
	return `Another confirmation is open in ${where}; finish or cancel it first.`;
}

/** A document to remove. */
export interface IRemoveTarget {
	objectId: string;
	path: string;
	/** Chunks the store reported for it, or null. */
	chunks: number | null;
}

/** Where the documents are removed from. */
export interface IRemoveContext {
	/** The store node's display name. */
	storeName: string;
	collection: string | null;
	backend: string;
	provider: string;
}

/** The writes the summaries are worded for. */
export type RemovalAction = 'trash' | 'restore' | 'delete' | 'empty';

/** A typed confirmation: the confirm button stays disabled until the input equals `expected`. */
export interface ITypedConfirmation {
	expected: string;
	prompt: string;
}

/** What the single-document dialog shows. */
export interface IRemoveConfirmation {
	title: string;
	lines: Array<{ label: string; value: string }>;
	sentence: string;
	/** Further sentences (the shared-table warning). */
	extra: string[];
	confirmLabel: string;
	cancelLabel: string;
	typed: ITypedConfirmation | null;
	/** False for a write that can be undone (Move to trash): its confirm button is not styled as destructive. */
	destructive: boolean;
}

/** What the multi-document dialog shows. */
export interface IMultiRemoveConfirmation {
	title: string;
	/** The list's accessible name. */
	listLabel: string;
	/** Up to MULTI_REMOVE_LIST_MAX paths. */
	listed: string[];
	/** How many more are not listed. */
	more: number;
	sentence: string;
	extra: string[];
	confirmLabel: string;
	cancelLabel: string;
	/** Null for Move to trash, which can be undone. */
	typed: ITypedConfirmation | null;
	destructive: boolean;
}

/**
 * The shared-table sentence of `rocketride_vector`.
 *
 * @param table - The table name.
 * @returns The sentence.
 */
export function sharedTableSentence(table: string): string {
	return `Shared table: every pipeline in this organization that names table '${table}' reads and writes these rows.`;
}

/** The collection's name as the dialogs say it. */
function collectionName(ctx: IRemoveContext): string {
	return ctx.collection ?? 'this collection';
}

/** The typed table-name confirmation of a shared table, or null. */
function sharedTyped(ctx: IRemoveContext): ITypedConfirmation | null {
	if (ctx.provider !== 'rocketride_vector') return null;
	const table = collectionName(ctx);
	return { expected: table, prompt: `Type the table name '${table}' to confirm.` };
}

/** A document's lines, as every single-document dialog shows them. */
function targetLines(target: IRemoveTarget, ctx: IRemoveContext): Array<{ label: string; value: string }> {
	return [
		{ label: 'Path', value: target.path || '(no path)' },
		{ label: 'objectId', value: `${target.objectId.slice(0, 8)}…` },
		{ label: 'Chunks', value: target.chunks === null ? '—' : formatCount(target.chunks) },
		{ label: 'Store', value: [ctx.storeName, ctx.collection, ctx.backend].filter(Boolean).join(' · ') },
	];
}

/** "its 12 chunks", or "all its chunks" when the store gave no count (never an estimate). */
function itsChunks(target: IRemoveTarget): string {
	return target.chunks === null ? 'all its chunks' : `its ${formatCount(target.chunks)} ${target.chunks === 1 ? 'chunk' : 'chunks'}`;
}

/** "their 46 chunks", or "all their chunks" when any count is unknown. */
function theirChunks(targets: readonly IRemoveTarget[]): string {
	return targets.every((t) => t.chunks !== null) ? `their ${formatCount(targets.reduce((sum, t) => sum + (t.chunks ?? 0), 0))} chunks` : 'all their chunks';
}

/** The paths a multi-document dialog lists, and how many more it does not. */
function listedPaths(targets: readonly IRemoveTarget[]): { listed: string[]; more: number } {
	return { listed: targets.slice(0, MULTI_REMOVE_LIST_MAX).map((t) => t.path || '(no path)'), more: Math.max(0, targets.length - MULTI_REMOVE_LIST_MAX) };
}

/**
 * Move one document to the trash: nothing to type (it can be undone), not destructive.
 *
 * @param target - The document.
 * @param ctx - Where it is stored.
 * @returns What the dialog shows.
 */
export function trashConfirmation(target: IRemoveTarget, ctx: IRemoveContext): IRemoveConfirmation {
	const collection = collectionName(ctx);
	return {
		title: 'Move this document to the trash?',
		lines: targetLines(target, ctx),
		sentence: `Moves this document and ${itsChunks(target)} to the trash of ${collection}. Search, chat and the map leave it out until it is restored from the Trash.`,
		extra: sharedTyped(ctx) ? [sharedTableSentence(collection)] : [],
		confirmLabel: 'Move to trash',
		cancelLabel: REMOVE_CANCEL_LABEL,
		typed: null,
		destructive: false,
	};
}

/**
 * Move several documents to the trash: their paths, nothing to type.
 *
 * @param targets - The documents.
 * @param ctx - Where they are stored.
 * @returns What the dialog shows.
 */
export function multiTrashConfirmation(targets: readonly IRemoveTarget[], ctx: IRemoveContext): IMultiRemoveConfirmation {
	const n = formatCount(targets.length);
	const collection = collectionName(ctx);
	return {
		title: `Move ${n} documents to the trash?`,
		listLabel: 'Documents to move to the trash',
		...listedPaths(targets),
		sentence: `Moves these ${n} documents and ${theirChunks(targets)} to the trash of ${collection}, in batches of at most 100; the first error stops the rest. Restore them from the Trash.`,
		extra: sharedTyped(ctx) ? [sharedTableSentence(collection)] : [],
		confirmLabel: `Move ${n} documents to the trash`,
		cancelLabel: REMOVE_CANCEL_LABEL,
		typed: null,
		destructive: false,
	};
}

/**
 * Delete one document permanently (from the Trash): its file name typed (a shared table's name).
 *
 * @param target - The document.
 * @param ctx - Where it is stored.
 * @returns What the dialog shows.
 */
export function removeConfirmation(target: IRemoveTarget, ctx: IRemoveContext): IRemoveConfirmation {
	const collection = collectionName(ctx);
	const shared = sharedTyped(ctx);
	const name = target.path === '' ? target.objectId : splitPath(target.path).name;
	return {
		title: 'Delete this document permanently?',
		lines: targetLines(target, ctx),
		sentence: `Deletes this document and ${itsChunks(target)} from ${collection}. If it still has chunks outside the trash, it is kept whole. This cannot be undone; add the file again to restore it.`,
		extra: shared ? [sharedTableSentence(collection)] : [],
		confirmLabel: 'Delete permanently',
		cancelLabel: REMOVE_CANCEL_LABEL,
		typed: shared ?? { expected: name, prompt: `Type the file name '${name}' to confirm.` },
		destructive: true,
	};
}

/**
 * Delete several documents permanently: typed count (a shared table's name).
 *
 * @param targets - The documents.
 * @param ctx - Where they are stored.
 * @returns What the dialog shows.
 */
export function multiRemoveConfirmation(targets: readonly IRemoveTarget[], ctx: IRemoveContext): IMultiRemoveConfirmation {
	const n = targets.length;
	const collection = collectionName(ctx);
	const shared = sharedTyped(ctx);
	return {
		title: `Delete ${formatCount(n)} documents permanently?`,
		listLabel: 'Documents to delete permanently',
		...listedPaths(targets),
		sentence: `Deletes these ${formatCount(n)} documents and ${theirChunks(targets)} from ${collection}, in batches of at most 100; the first error stops the rest. A document that still has chunks outside the trash is kept whole. This cannot be undone.`,
		extra: shared ? [sharedTableSentence(collection)] : [],
		confirmLabel: `Delete ${formatCount(n)} documents permanently`,
		cancelLabel: REMOVE_CANCEL_LABEL,
		typed: shared ?? { expected: String(n), prompt: `Type ${n} to confirm.` },
		destructive: true,
	};
}

/**
 * Empty the trash: every document listed in it, deleted with `deleted_only`, so a document that still has a
 * live chunk is kept. Always typed: the count of documents, or a shared table's name.
 *
 * @param targets - The documents of the whole trash listing.
 * @param ctx - Where they are stored.
 * @returns What the dialog shows.
 */
export function emptyTrashConfirmation(targets: readonly IRemoveTarget[], ctx: IRemoveContext): IMultiRemoveConfirmation {
	const n = targets.length;
	const collection = collectionName(ctx);
	const shared = sharedTyped(ctx);
	return {
		title: 'Empty the trash?',
		listLabel: 'Documents in the trash',
		...listedPaths(targets),
		sentence: `Deletes the ${formatCount(n)} documents in the trash of ${collection} permanently, in batches of at most 100; a document that still has chunks outside the trash is kept. This cannot be undone.`,
		extra: shared ? [sharedTableSentence(collection)] : [],
		confirmLabel: 'Empty trash',
		cancelLabel: REMOVE_CANCEL_LABEL,
		typed: shared ?? { expected: String(n), prompt: `Type ${n} to confirm.` },
		destructive: true,
	};
}

/**
 * Whether a typed confirmation is satisfied.
 *
 * @param typed - The confirmation, or null when none is needed.
 * @param input - What the user typed.
 * @returns True when the confirm button may be enabled.
 */
export function confirmReady(typed: ITypedConfirmation | null, input: string): boolean {
	return typed === null || input.trim() === typed.expected;
}

// =============================================================================
// THE REMOVAL
// =============================================================================

/**
 * Split ids into batches.
 *
 * @param ids - The objectIds.
 * @param size - The node's write_ids_max.
 * @returns The batches, in order.
 */
export function batches(ids: readonly string[], size: number): string[][] {
	const step = Math.max(1, Math.floor(size));
	const out: string[][] = [];
	for (let i = 0; i < ids.length; i += step) out.push(ids.slice(i, i + step));
	return out;
}

/** What a batched write did. `removed` are the documents it moved or deleted. */
export interface IRemovalOutcome {
	removed: Array<{ objectId: string; chunks: number | null }>;
	notFound: string[];
	/** Empty trash: documents kept because a chunk of them is live. */
	keptLive: string[];
	/** Rows removed in total, or null when any batch could not count them. */
	removedChunks: number | null;
	batchesRun: number;
	batchesTotal: number;
	/** Why it stopped, when a batch failed. */
	error: IFailureText | null;
	/** The audit block of each batch that answered with one. */
	audits?: IWriteAudit[];
}

/**
 * Run a write batch by batch, stopping at the first error. Never retried.
 *
 * @param ids - The objectIds.
 * @param call - Sends one batch (`soft_delete`, `restore` or `delete`) and reads its answer.
 * @param size - The batch size (the node's write_ids_max).
 * @returns What ran.
 */
export async function runRemoval(ids: readonly string[], call: (batch: string[]) => Promise<IRemoveView>, size: number): Promise<IRemovalOutcome> {
	const all = batches(ids, size);
	const outcome: IRemovalOutcome = { removed: [], notFound: [], keptLive: [], removedChunks: 0, batchesRun: 0, batchesTotal: all.length, error: null, audits: [] };
	for (const batch of all) {
		try {
			const view = await call(batch);
			outcome.removed.push(...view.removed);
			outcome.notFound.push(...view.notFound);
			outcome.keptLive.push(...view.keptLive);
			if (view.audit) outcome.audits?.push(view.audit);
			outcome.removedChunks = outcome.removedChunks === null || view.removedChunks === null ? null : outcome.removedChunks + view.removedChunks;
			outcome.batchesRun += 1;
		} catch (error) {
			outcome.error = failureText(error, { write: true }) ?? { headline: 'The removal was dropped.' };
			break;
		}
	}
	return outcome;
}

/** How each write's summary words what it did. */
const SUMMARY_WORDS: Readonly<Record<RemovalAction, { done: string; tail: string; none: string }>> = {
	trash: { done: 'Moved', tail: ' to the trash', none: 'moved to the trash' },
	restore: { done: 'Restored', tail: '', none: 'restored' },
	delete: { done: 'Deleted', tail: ' permanently', none: 'deleted' },
	empty: { done: 'deleted', tail: ' permanently', none: 'deleted' },
};

/**
 * The sentence announced (and shown) after a write.
 *
 * @param outcome - What ran.
 * @param targets - The documents asked for (their paths name a single document).
 * @param action - Which write it was.
 * @returns The sentence.
 */
export function removalSummary(outcome: IRemovalOutcome, targets: ReadonlyArray<{ objectId: string; path: string }>, action: RemovalAction): string {
	const words = SUMMARY_WORDS[action];
	const rows = outcome.removedChunks === null ? '' : ` (${formatCount(outcome.removedChunks)} ${outcome.removedChunks === 1 ? 'chunk' : 'chunks'})`;
	const stopped = outcome.error ? ` Stopped after ${outcome.batchesRun} of ${outcome.batchesTotal} batches: ${outcome.error.headline}` : '';
	// The documents kept whole, by path where the targets know it.
	const paths = new Map(targets.map((t) => [t.objectId, t.path || t.objectId]));
	const keptPaths = outcome.keptLive.slice(0, MULTI_REMOVE_LIST_MAX).map((id) => paths.get(id) ?? id);
	const keptMore = outcome.keptLive.length - keptPaths.length;
	const keptList = `${keptPaths.join(', ')}${keptMore > 0 ? ` and ${formatCount(keptMore)} more` : ''}`;
	const kept = outcome.keptLive.length === 0 ? '' : outcome.keptLive.length === 1 ? ` 1 was kept whole, because it still has chunks outside the trash: ${keptList}.` : ` ${formatCount(outcome.keptLive.length)} were kept whole, because they still have chunks outside the trash: ${keptList}.`;
	if (outcome.removed.length === 0 && outcome.notFound.length === 0 && outcome.keptLive.length === 0) return outcome.error ? outcome.error.headline : `Nothing was ${words.none}.`;
	if (action !== 'empty' && targets.length === 1 && outcome.removed.length <= 1 && !outcome.error) {
		const path = targets[0].path || targets[0].objectId;
		if (outcome.keptLive.length === 1) return `${path} was kept whole, because it still has chunks outside the trash; nothing was ${words.none}.`;
		return outcome.removed.length === 1 ? `${words.done} ${path}${words.tail}${rows}` : `${path} was not stored any more; nothing was ${words.none}`;
	}
	const gone = outcome.notFound.length === 0 ? '' : ` ${formatCount(outcome.notFound.length)} ${outcome.notFound.length === 1 ? 'was' : 'were'} not stored any more.`;
	const removedRows = outcome.error && outcome.removedChunks === null ? '' : rows;
	const what = `${words.done} ${formatCount(outcome.removed.length)} ${outcome.removed.length === 1 ? 'document' : 'documents'}${words.tail}${removedRows}.`;
	return `${action === 'empty' ? `Emptied the trash: ${what}` : what}${gone}${kept}${stopped}`;
}

// =============================================================================
// WHICH CONFIRMATION A PENDING WRITE SHOWS
// =============================================================================

/**
 * Where a connection's documents are removed from, as the confirmations say it.
 *
 * @param endpoint - The connection's live endpoint.
 * @param probe - Its probe, when one exists.
 * @returns The context.
 */
export function removeContextFor(endpoint: Pick<IExplorerEndpoint, 'nodeName' | 'provider'>, probe: IProbeResult | undefined): IRemoveContext {
	const dialect = probe?.ok ? readDialect(probe.info) : null;
	return { storeName: endpoint.nodeName || providerTitle(endpoint.provider), collection: dialect?.collection ?? null, backend: dialect?.backend ?? providerTitle(endpoint.provider), provider: endpoint.provider };
}

/** A pending write's confirmation: one document's, or several documents'. */
export type ConfirmationView = { kind: 'single'; content: IRemoveConfirmation } | { kind: 'multi'; content: IMultiRemoveConfirmation };

/**
 * The confirmation a pending write shows (Move to trash, Delete permanently or Empty trash; one document or several).
 *
 * @param pending - The console controller's pending write.
 * @param pending.action - What Confirm sends.
 * @param pending.kind - One document or several.
 * @param pending.targets - The documents.
 * @param ctx - Where they are removed from.
 * @returns The confirmation.
 */
export function confirmationFor(pending: { action: 'trash' | 'delete' | 'empty'; kind: 'single' | 'multi'; targets: readonly IRemoveTarget[] }, ctx: IRemoveContext): ConfirmationView {
	if (pending.action === 'empty') return { kind: 'multi', content: emptyTrashConfirmation(pending.targets, ctx) };
	if (pending.kind === 'single') return { kind: 'single', content: pending.action === 'trash' ? trashConfirmation(pending.targets[0], ctx) : removeConfirmation(pending.targets[0], ctx) };
	return { kind: 'multi', content: pending.action === 'trash' ? multiTrashConfirmation(pending.targets, ctx) : multiRemoveConfirmation(pending.targets, ctx) };
}
