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
// VECTOR-UI - DOCUMENT VIEW (one stored document, every chunk in reading order)
// =============================================================================
//
// Header: path, objectId (copy), chunk count, size, type and ingest time
// where the store keeps them, the document's health (no first chunk, gaps,
// deleted chunks, empty parse, oversize against the console's loaded
// documents; "Count deleted chunks" on demand where the store soft-deletes
// without reporting the count), the support badge and the trash button
// (gated; it asks the console, which confirms). Body:
// the chunks in reading order, a page of 100 at a time, table chunks tagged,
// each with its length and "map"; "Show chunk path on map"; a toggle that
// includes deleted chunks; the heat strip, every chunk's similarity to the
// active query (the map's text query or the chat question shown there:
// embedded on the embedding node, scored by the store's `neighbors`), or a
// line saying how to get a query when there is none. Calls ride on the
// connection's anchor channel (Tools, or Chat on a read-only connection).
// =============================================================================

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Banner, Button, BxTrash, ContentHeader } from 'shell';
import type { DocumentViewProps as ContractDocumentViewProps, IChunkItem, IDocumentItem, VectorKey } from '../contract/types';
import { fetchChunks, fetchDocument, scoreChunks } from '../adapters/actions';
import type { IVectorCaller } from '../adapters/actions';
import { existingEntry } from '../adapters/connections';
import HealthPanel from '../components/HealthPanel';
import type { IHealthProbe } from '../components/HealthPanel';
import HeatStrip from '../components/HeatStrip';
import SupportBadge from '../components/SupportBadge';
import { CHUNKS_PAGE } from '../vector/budgets';
import { fileTypeOf, formatSize } from '../vector/fileType';
import { deletedFromTotals, medianChunks } from '../vector/health';
import { HEAT_NO_EMBED, HEAT_NO_QUERY, HEAT_SCORING, heatCaption, heatKeys } from '../vector/heat';
import type { IHeatScore } from '../vector/heat';
import { formatCount } from '../vector/stats';
import { supportOf } from '../vector/support';
import { failureText } from '../vector/wording';
import type { IFailureText } from '../vector/wording';
import { FOCUS_RING, styles } from '../styles';

/** Props: the frozen ones plus whether the tab is in front. */
export interface DocumentViewProps extends ContractDocumentViewProps {
	/** The tab is the one in front (editors stay mounted when hidden); nothing is scored while it is not. Default true. */
	active?: boolean;
	/**
	 * The console's median chunks per document, when the mount knows it apart from the console (a dev-tool document
	 * frame reads it from the console's summary). Undefined: read from the full app's console of the connection.
	 */
	consoleMedian?: number | null;
	/** Told what the document's own row is once it was read (null: the store does not hold it). */
	onDocument?: (row: IDocumentItem | null) => void;
	/** Shown under the header (a dev-tool frame's inline confirmation). */
	beforeBody?: React.ReactNode;
}

/** The chunks of the document, loaded a page at a time. */
interface IChunkState {
	items: IChunkItem[];
	hasMore: boolean;
	nextAfter: number;
	total: number | null;
	loading: boolean;
	error: IFailureText | null;
}

const NO_CHUNKS: IChunkState = { items: [], hasMore: false, nextAfter: -1, total: null, loading: false, error: null };

/** Nothing loaded in the console: no rows to compare with. */
const NO_ROWS: readonly IDocumentItem[] = [];
const noRows = (): readonly IDocumentItem[] => NO_ROWS;
const noSubscription = (): (() => void) => () => undefined;

/** Said when the window does not allow the clipboard (a VS Code webview may not): the text is on screen to select. */
export const COPY_BLOCKED_NOTE = 'Copying is not allowed in this window. Select the objectId and copy it with Ctrl+C (Cmd+C on a Mac).';

/**
 * Copy a text (silently, as before), and say so when the window does not allow it (a dev-tool mount may block the
 * clipboard).
 *
 * @param text - The text.
 * @param announce - Speaks through the polite live region.
 */
export function copyText(text: string, announce: (message: string) => void): void {
	const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
	if (!clipboard) {
		announce(COPY_BLOCKED_NOTE);
		return;
	}
	clipboard.writeText(text).then(
		() => undefined,
		() => announce(COPY_BLOCKED_NOTE)
	);
}

/** The heat strip's answer for one query: the scores, or why there are none. */
type HeatState = { query: string; chunks: number; scores: IHeatScore[] } | { query: string; chunks: number; error: IFailureText };

/**
 * One document's tab.
 *
 * @param props - The frozen DocumentViewProps.
 * @returns The view.
 */
export function DocumentView({ model, channels, selection, actions, objectId, path, chunkId, active = true, consoleMedian, onDocument, beforeBody }: DocumentViewProps): React.ReactElement {
	const caller: IVectorCaller | null = channels.tools ?? channels.chat ?? channels.ingest;
	const embedCaller: IVectorCaller | null = channels.tools ?? channels.chat;
	const store = model.nodes.store;
	const embedNode = model.nodes.embed;
	const embedReady = embedCaller !== null && !!embedNode && model.embed.enabled;
	const state = useSyncExternalStore(selection.subscribe, selection.getState, selection.getState);
	const query = state.connectionKey === model.connectionKey ? state.query : null;
	const [info, setInfo] = useState<IDocumentItem | null>(null);
	const [infoError, setInfoError] = useState<IFailureText | null>(null);
	const [withDeleted, setWithDeleted] = useState(false);
	const [chunks, setChunks] = useState<IChunkState>(NO_CHUNKS);
	const [heat, setHeat] = useState<HeatState | null>(null);
	const [probe, setProbe] = useState<IHealthProbe>({ status: 'idle' });
	const run = useRef(0);
	// The console's loaded documents (when its connection is open), for the median chunks "oversize" compares with; a
	// mount that knows the median apart from the console passes it in.
	const consoleEntry = consoleMedian === undefined ? existingEntry(model.connectionKey) : undefined;
	const consoleState = useSyncExternalStore(consoleEntry ? consoleEntry.controller.subscribe : noSubscription, consoleEntry ? () => consoleEntry.controller.getState().directory.rows : noRows, consoleEntry ? () => consoleEntry.controller.getState().directory.rows : noRows);
	const median = consoleMedian !== undefined ? consoleMedian : medianChunks(consoleState);
	const told = useRef(onDocument);
	told.current = onDocument;

	const load = useCallback(
		async (afterChunk: number) => {
			if (caller === null) return;
			const mine = run.current;
			setChunks((prev) => ({ ...(afterChunk < 0 ? NO_CHUNKS : prev), loading: true, error: null }));
			try {
				const page = await fetchChunks(caller, store, { objectId, afterChunk, limit: Math.min(CHUNKS_PAGE, model.limits.chunks_page), deleted: withDeleted ? 'all' : 'active' });
				if (mine !== run.current) return;
				setChunks((prev) => ({ items: afterChunk < 0 ? page.items : [...prev.items, ...page.items], hasMore: page.hasMore, nextAfter: page.nextAfter, total: page.total, loading: false, error: null }));
			} catch (error) {
				if (mine !== run.current) return;
				const text = failureText(error);
				if (text) setChunks((prev) => ({ ...prev, loading: false, error: text }));
			}
		},
		[caller, store, objectId, withDeleted, model.limits.chunks_page]
	);

	useEffect(() => {
		run.current += 1;
		void load(-1);
	}, [load]);

	useEffect(() => {
		if (caller === null) return undefined;
		let live = true;
		fetchDocument(caller, store, objectId).then(
			(row) => {
				if (!live) return;
				setInfo(row);
				told.current?.(row);
			},
			(error) => {
				if (live) setInfoError(failureText(error));
			}
		);
		return () => {
			live = false;
		};
	}, [caller, store, objectId]);

	// Scroll to the chunk the tab was opened at, once it is listed.
	const listRef = useRef<HTMLOListElement>(null);
	useEffect(() => {
		if (chunkId === undefined) return;
		const el = listRef.current?.querySelector(`[data-chunk="${chunkId}"]`);
		if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'center' });
	}, [chunkId, chunks.items.length]);

	// The heat strip: every chunk scored against the active query while the tab is in front, again when
	// the query (or the chunk count) changes; a hidden tab sends nothing until it is in front again.
	const chunkCount = info?.chunks ?? chunks.total ?? chunks.items.length;
	const scopeMax = model.limits.scope_keys_max;
	useEffect(() => {
		if (!active || query === null || !embedReady || caller === null || embedCaller === null || !embedNode || chunkCount <= 0) return undefined;
		if (heat !== null && heat.query === query && heat.chunks === chunkCount) return undefined;
		let live = true;
		scoreChunks({ caller, nodeId: store }, { caller: embedCaller, nodeId: embedNode }, heatKeys(objectId, chunkCount, scopeMax), query).then(
			(scores) => {
				if (live) setHeat({ query, chunks: chunkCount, scores });
			},
			(error) => {
				const text = failureText(error);
				if (live && text) setHeat({ query, chunks: chunkCount, error: text });
			}
		);
		return () => {
			live = false;
		};
		// `heat` is read to skip a query already scored, not to score again when the answer lands.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, query, embedReady, caller, embedCaller, embedNode, store, objectId, chunkCount, scopeMax]);
	const heatNow = heat !== null && heat.query === query ? heat : null;

	// "Count deleted chunks": the document's chunk totals with and without soft-deleted rows (one row each).
	const countDeleted = useCallback(async () => {
		if (caller === null) return;
		setProbe({ status: 'running' });
		try {
			const all = await fetchChunks(caller, store, { objectId, afterChunk: -1, limit: 1, deleted: 'all' });
			const active = await fetchChunks(caller, store, { objectId, afterChunk: -1, limit: 1, deleted: 'active' });
			setProbe({ status: 'done', deleted: deletedFromTotals(all.total, active.total) });
		} catch (error) {
			setProbe({ status: 'error', message: failureText(error)?.headline ?? null });
		}
	}, [caller, store, objectId]);
	const canProbe = caller !== null && info !== null && (info.deleted_chunks === null || info.deleted_chunks === undefined) && model.capabilities.soft_delete === true;

	const shownPath = info?.path ?? path ?? objectId;
	const focused = state.chunk;
	const keys: VectorKey[] = chunks.items.map((c) => [objectId, c.chunkId] as const);

	return (
		<div style={styles.root} data-document={objectId}>
			<ContentHeader
				title={shownPath}
				subtitle={`${model.collection ?? 'collection'} · ${model.connection.endpoint.pipelineName}`}
				actions={
					<>
						<SupportBadge support={supportOf(model.connection.endpoint.provider, model.connection.dialect)} />
						<Button variant="ghost" disabled={keys.length === 0} onClick={() => actions.showOnMap(keys, 'document')}>
							Show chunk path on map
						</Button>
						<button type="button" style={{ ...styles.iconButton, opacity: model.writes.enabled ? 1 : 0.55, cursor: model.writes.enabled ? 'pointer' : 'not-allowed' }} aria-label={`Move ${shownPath} to the trash`} title={model.writes.enabled ? `Move ${shownPath} to the trash` : (model.writes.reason ?? undefined)} disabled={!model.writes.enabled} onClick={() => actions.requestRemove([objectId])} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')}>
							<BxTrash />
						</button>
					</>
				}
			/>
			{beforeBody}
			<div style={styles.content}>
				{caller === null && <Banner variant="warning">No source of this pipeline is running, so the document cannot be read.</Banner>}
				{infoError && <Banner variant="error">{infoError.headline}</Banner>}
				<dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', margin: '0 0 12px', ...styles.small }}>
					<dt style={{ fontWeight: 600 }}>objectId</dt>
					<dd style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
						<code style={{ overflowWrap: 'anywhere' }}>{objectId}</code>
						<Button mini variant="ghost" onClick={() => copyText(objectId, actions.announce)}>
							Copy
						</Button>
					</dd>
					<dt style={{ fontWeight: 600 }}>Chunks</dt>
					<dd style={{ margin: 0 }}>{info?.chunks != null ? formatCount(info.chunks) : chunks.total !== null ? formatCount(chunks.total) : '—'}</dd>
					<dt style={{ fontWeight: 600 }}>Type</dt>
					<dd style={{ margin: 0 }}>{fileTypeOf(shownPath)}</dd>
					{info?.size != null && (
						<>
							<dt style={{ fontWeight: 600 }}>Size</dt>
							<dd style={{ margin: 0 }}>{formatSize(info.size)}</dd>
						</>
					)}
					{info?.ingestedAt && (
						<>
							<dt style={{ fontWeight: 600 }}>Ingested</dt>
							<dd style={{ margin: 0 }}>{info.ingestedAt.replace('T', ' ').replace('Z', ' UTC')}</dd>
						</>
					)}
				</dl>
				<HealthPanel item={info} medianChunks={median} listing="all" chunkLengths={withDeleted ? null : { lengths: chunks.items.map((c) => c.length), complete: chunks.items.length > 0 && !chunks.hasMore && !chunks.loading }} canProbe={canProbe} probe={probe} onProbe={() => void countDeleted()} />
				<div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0' }}>
					<label style={{ display: 'flex', gap: 6, alignItems: 'center', ...styles.small }}>
						<input type="checkbox" checked={withDeleted} onChange={(event) => setWithDeleted(event.target.checked)} />
						Include deleted chunks
					</label>
				</div>
				{query === null ? (
					<p style={{ ...styles.small, margin: '4px 0' }}>{HEAT_NO_QUERY}</p>
				) : !embedReady ? (
					<p style={{ ...styles.small, margin: '4px 0' }}>{HEAT_NO_EMBED}</p>
				) : heatNow !== null && 'error' in heatNow ? (
					<Banner variant="error">{heatNow.error.headline}</Banner>
				) : heatNow !== null ? (
					<>
						<div style={styles.small}>{heatCaption(query)}</div>
						<HeatStrip chunks={chunkCount} scores={heatNow.scores} focused={focused !== null && focused[0] === objectId ? focused[1] : null} onSelectChunk={(id) => selection.focusChunk([objectId, id])} label="Similarity of each chunk to the query" />
					</>
				) : (
					<p role="status" style={{ ...styles.small, margin: '4px 0' }}>
						{HEAT_SCORING}
					</p>
				)}
				{chunks.error && <Banner variant="error">{chunks.error.headline}</Banner>}
				<ol ref={listRef} aria-label="Chunks in reading order" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
					{chunks.items.map((chunk) => (
						<li key={chunk.chunkId} data-chunk={chunk.chunkId} style={{ padding: '10px 0', borderTop: '1px solid var(--rr-border)', borderLeft: chunk.chunkId === chunkId ? '3px solid var(--rr-border-focus)' : '3px solid transparent', paddingLeft: 10 }}>
							<div style={{ display: 'flex', gap: 8, alignItems: 'center', ...styles.small }}>
								<strong>{`#${chunk.chunkId}`}</strong>
								<span>{`${formatCount(chunk.length)} chars`}</span>
								{chunk.isTable && <span style={styles.chip('var(--rr-border-input)')}>table</span>}
								{chunk.isDeleted && <span style={styles.chip('var(--rr-border-input)')}>deleted</span>}
								<Button mini variant="ghost" onClick={() => actions.showOnMap([[objectId, chunk.chunkId]], 'document')}>
									map
								</Button>
							</div>
							<div style={{ fontSize: 13, lineHeight: 1.55, marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{chunk.content}</div>
						</li>
					))}
				</ol>
				{chunks.loading && <div style={styles.small}>Loading chunks…</div>}
				{chunks.hasMore && !chunks.loading && (
					<Button variant="secondary" onClick={() => void load(chunks.nextAfter)}>
						More chunks
					</Button>
				)}
			</div>
		</div>
	);
}

export default DocumentView;
