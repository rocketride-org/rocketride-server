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
// VECTOR-UI — useIngest (the console's drop zone and upload list)
// =============================================================================
//
// Wires the connection's upload queue (ingestQueue.ts, kept per connection in
// src/chat/registry.ts) to the console:
//
//   - uploads go through the shared library's ingest role channel (which
//     holds the token);
//   - the collision probe and the chunk count call the store node through
//     the Tools source (src/chat/toolCalls.ts);
//   - upload progress arrives as `apaevt_status_upload` events on the shell's
//     event stream, which every app shares; the queue applies an event only
//     to the one file of that base name it has in flight;
//   - finished uploads tell the console to refresh its stats and directory;
//   - "Show new chunks on the map" under a finished drop hands the drop's
//     new chunk keys to the map as a document highlight
//     (actions.showOnMap(keys, 'document')), at most the connection's pin
//     limit (limits.project_keys_max); the map pins them through its own
//     `project` call, and the drop remembers how many of how many it sent.
//
// The connection's uploads (rows and drops) and its chat live in the
// registry, keyed by the endpoint key, so they outlive the panels. A change
// of identity must forget them with every other per-connection cache, so
// this module registers the registry's reset with the app's cache registry
// (`connectionCaches`); the same endpoint key then gets a new, empty queue.
// It registers no per-connection forget: a dev-tool frame never holds chat
// or uploads, and the full app keeps them across a reconnect.
// =============================================================================

import { useCallback, useSyncExternalStore } from 'react';
import { useShellEvent } from 'shell';
import { ExplorerToolError } from 'shared/explorer';
import type { ConsoleActions, IUploadEvent, IngestPanelProps } from '../contract/types';
import { connectionCaches } from '../adapters/explorer';
import { callTool, toolChannelFor } from '../chat/toolCalls';
import { forgetChatAndIngest, ingestQueueFor } from '../chat/registry';
import { newChunkKeys, placedSentence, summariseDrop } from '../vector/uploads';
import type { DropShown } from '../vector/uploads';
import type { IngestDeps, IngestQueue, IngestState } from './ingestQueue';
import { entriesFromDataTransfer, filesFromInput, traverseDrop } from './dropTraversal';
import type { DataTransferLike } from './dropTraversal';

/** How long the probe and the count may take. */
const TOOL_TIMEOUT_MS = 30_000;

/** The name the uploads and the chat are cleared under when the signed-in identity changes. */
export const CHAT_AND_INGEST_CACHE = 'chat and ingest';

connectionCaches.register(CHAT_AND_INGEST_CACHE, () => forgetChatAndIngest());

/** What the ingest panel gets from the hook. */
export interface VectorIngest {
	state: IngestState;
	/** A drop on the zone: call inside the drop handler (the entries are taken synchronously). */
	addFromDrop(transfer: DataTransferLike, prefix: string): void;
	/** Files chosen with "Add files" or "Add folder". */
	addFromInput(files: ArrayLike<File>, prefix: string): void;
	answerConfirm(replace: boolean): void;
	clearFinished(): void;
	/** "Show new chunks on the map" under a finished drop. */
	showNewChunks(dropId: string): void;
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
 * Show a finished drop's new chunks on the map: every new document's chunk
 * 0 first, cut at `cap`, as one document highlight; say what was sent and
 * remember it on the drop. Nothing happens for a drop that is unknown, still
 * running, or has no counted chunk.
 *
 * @param queue - The connection's queue.
 * @param dropId - The drop.
 * @param actions - The console's actions (showOnMap, announce).
 * @param cap - The map's pin limit (limits.project_keys_max).
 * @returns What was sent, or null when nothing was.
 */
export function showDropOnMap(queue: Pick<IngestQueue, 'getState' | 'markShown'>, dropId: string, actions: Pick<ConsoleActions, 'showOnMap' | 'announce'>, cap: number): DropShown | null {
	const state = queue.getState();
	const drop = state.drops.find((candidate) => candidate.id === dropId);
	if (drop === undefined || drop.finishedAt === null) return null;
	const plan = newChunkKeys(summariseDrop(drop, state.rows, drop.finishedAt).newDocuments, cap);
	if (plan.keys.length === 0) return null;
	const shown: DropShown = { placed: plan.keys.length, total: plan.total };
	actions.showOnMap(plan.keys, 'document');
	queue.markShown(dropId, shown);
	actions.announce(placedSentence(shown.placed, shown.total, cap) ?? `Showing ${shown.total === 1 ? '1 new chunk' : `${shown.total.toLocaleString('en-US')} new chunks`} on the map.`);
	return shown;
}

/**
 * The connection's uploads.
 *
 * @param props - The ingest panel's props.
 * @returns State and actions.
 */
export function useIngest(props: Pick<IngestPanelProps, 'model' | 'channels' | 'actions'>): VectorIngest {
	const { model, channels, actions } = props;
	const tools = toolChannelFor(model, channels);
	const store = model.nodes.store;
	const deps: IngestDeps = {
		canProbe: tools !== null && model.capabilities.chunks !== false,
		canCount: tools !== null && model.capabilities.documents !== false,
		callTool: (tool, input) => callTool(tools, tool, input, store, { timeoutMs: TOOL_TIMEOUT_MS }),
		sendFiles: (files, options) => {
			const ingest = channels.ingest;
			if (ingest === null) return Promise.reject(new ExplorerToolError({ kind: 'unavailable', tool: 'sendFiles', message: 'This pipeline has no running Ingest source.' }));
			return ingest.sendFiles(files, options);
		},
		onDocumentsChanged: (objectIds) => actions.documentsChanged(objectIds),
		announce: (message) => actions.announce(message),
	};
	const queue = ingestQueueFor(model.connectionKey, deps);
	const state = useSyncExternalStore(queue.subscribe, queue.getState, queue.getState);

	useShellEvent('shell:event', (payload) => {
		const message = payload?.event as unknown;
		if (!isRecord(message) || message.event !== 'apaevt_status_upload' || !isRecord(message.body)) return;
		queue.handleEvent(message.body as unknown as IUploadEvent);
	});

	const addFromDrop = useCallback(
		(transfer: DataTransferLike, prefix: string) => {
			// Taken now: the browser empties the DataTransfer when the drop handler returns.
			const snapshot = entriesFromDataTransfer(transfer);
			void traverseDrop(snapshot).then((result) => queue.addDrop(result.files, { prefix, skipped: result.skipped, errors: result.errors, truncated: result.truncated }));
		},
		[queue]
	);
	const addFromInput = useCallback(
		(files: ArrayLike<File>, prefix: string) => {
			const picked = filesFromInput(files);
			void queue.addDrop(picked.files, { prefix, skipped: picked.skipped });
		},
		[queue]
	);

	const showNewChunks = useCallback(
		(dropId: string) => {
			showDropOnMap(queue, dropId, actions, model.limits.project_keys_max);
		},
		[queue, actions, model.limits.project_keys_max]
	);

	return { state, addFromDrop, addFromInput, answerConfirm: queue.answerConfirm, clearFinished: queue.clearFinished, showNewChunks };
}
