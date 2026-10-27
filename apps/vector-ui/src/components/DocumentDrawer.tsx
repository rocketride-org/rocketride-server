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
// VECTOR-UI - DOCUMENT DRAWER (one document, docked beside the Documents grid)
// =============================================================================
//
// Inline, beside the grid (which narrows; nothing is covered), never a
// modal. Its sections:
//
//   Text         the first chunks the console read (the controller reads the
//                selected document's chunks, one page), each with Open at
//                chunk and Map; the rest of the page on request, More chunks
//                for the next page.
//   Metadata     the listing's fields (path, objectId with Copy, chunks and
//                their ids where the store reports them, tables, size,
//                ingested, node, deleted chunks where reported).
//   Health       the document's flags (components/HealthPanel.tsx).
//   Neighbours   on request: the documents among the nearest chunks to its
//                first chunk that was read (`neighbors`, asking for enough
//                to cover the document's own chunks, which are left out; the
//                store runs one such call at a time, fetchNeighbors waits its
//                turn and a store still busy says so). There is no
//                document-level similarity, and the words say what was asked,
//                including when no other document is among them.
//   Actions      Show on map, Ask about this (the full app; the dev tool says
//                why not), Open document; apart, Move to Trash, which STAGES
//                it (the pending bar applies), or Unstage.
//
// Escape closes it while the focus is inside it (unless an inner handler
// already acted), and the Documents tab puts the focus back on its row.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner } from 'shell';
import { fetchNeighbors } from '../adapters/actions';
import type { IVectorCaller } from '../adapters/actions';
import type { Availability, IDocumentItem, VectorKey } from '../contract/types';
import type { IChunksSlot } from '../vector/consoleStore';
import { chunkPreview, similarDocuments, similarFailureText, similarK, splitPath } from '../vector/documents';
import type { ISimilarDocument } from '../vector/documents';
import { fileTypeOf, formatSize } from '../vector/fileType';
import { formatCount } from '../vector/stats';
import { copyText } from '../views/DocumentView';
import { FOCUS_RING, styles as appStyles } from '../styles';
import GatedButton from './GatedButton';
import HealthPanel from './HealthPanel';

/** Chunks the Text section shows before "Show all". */
const FIRST_CHUNKS = 3;

const styles = {
	drawer: { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, height: '100%', overflowY: 'auto', background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', borderRadius: 8 } as CSSProperties,
	head: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	title: { margin: 0, fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere', outline: 'none' } as CSSProperties,
	subtitle: { ...appStyles.small, margin: '2px 0 0', overflowWrap: 'anywhere' } as CSSProperties,
	section: { padding: '10px 12px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	heading: { margin: '0 0 6px', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' } as CSSProperties,
	chunk: { padding: '6px 0', borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)' } as CSSProperties,
	chunkHead: { ...appStyles.small, display: 'flex', alignItems: 'center', gap: 8 } as CSSProperties,
	chunkText: { fontSize: 12.5, marginTop: 2, overflowWrap: 'anywhere' } as CSSProperties,
	lines: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '3px 10px', margin: 0, fontSize: 12.5 } as CSSProperties,
	term: { fontWeight: 600 } as CSSProperties,
	value: { margin: 0, overflowWrap: 'anywhere', display: 'flex', alignItems: 'center', gap: 6 } as CSSProperties,
	row: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } as CSSProperties,
	moreRow: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 6 } as CSSProperties,
	note: { ...appStyles.small, margin: '6px 0 0' } as CSSProperties,
	similar: { listStyle: 'none', margin: '6px 0 0', padding: 0 } as CSSProperties,
	similarItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12.5 } as CSSProperties,
	link: { flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', textDecoration: 'underline', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	danger: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
	close: { flex: 'none', marginLeft: 'auto' } as CSSProperties,
	headText: { minWidth: 0 } as CSSProperties,
	chunkActions: { marginLeft: 'auto', display: 'flex', gap: 4 } as CSSProperties,
	mono: { fontFamily: 'var(--rr-font-mono, monospace)', overflowWrap: 'anywhere' } as CSSProperties,
};

/** The Neighbours section's state. */
type SimilarState = { status: 'idle' } | { status: 'running'; k: number } | { status: 'done'; k: number; documents: ISimilarDocument[] } | { status: 'error'; message: string };

/** Props for the {@link DocumentDrawer} component. */
export interface IDocumentDrawerProps {
	objectId: string;
	/** The listing's row, or null when the document is not among the loaded rows (chosen on the map, or staged from it). */
	item: IDocumentItem | null;
	/** Its path (the row's, else the selection's). */
	path: string;
	/** The controller's chunks (shown when they are this document's). */
	chunks: IChunksSlot;
	/** Median chunks per loaded document, for "oversize" (null while unknown). */
	median: number | null;
	staged: boolean;
	/** Staging (the console's writes, while no other write runs). */
	writes: Availability;
	/** Ask about this (the chat). */
	chat: Availability;
	/** `limits.neighbors_k_max`. */
	neighborsMax: number;
	/** Who answers `neighbors`, or null while nothing can be sent; and the store node. */
	neighbors: { caller: IVectorCaller | null; nodeId: string };
	/** Changes when the drawer is opened from a row: the heading takes the focus. */
	focusNonce: number;
	onClose(): void;
	onStage(): void;
	onUnstage(): void;
	onShowOnMap(keys: readonly VectorKey[]): void;
	onAskAbout(): void;
	onOpenDocument(chunkId?: number): void;
	onMoreChunks(): void;
	/** A document from Neighbours: show it in the drawer. */
	onShowDocument(objectId: string, path: string): void;
	announce(text: string): void;
}

/**
 * The drawer.
 *
 * @param props - {@link IDocumentDrawerProps}.
 * @returns The drawer element.
 */
export function DocumentDrawer(props: IDocumentDrawerProps): React.ReactElement {
	const { objectId, item, path, chunks, median, staged, writes, chat, neighborsMax, neighbors, focusNonce, onClose, onStage, onUnstage, onShowOnMap, onAskAbout, onOpenDocument, onMoreChunks, onShowDocument, announce } = props;
	const heading = useRef<HTMLHeadingElement>(null);
	const [allChunks, setAllChunks] = useState(false);
	const [similar, setSimilar] = useState<SimilarState>({ status: 'idle' });
	// The document changed: its own chunk list and neighbours, from the start.
	const shownFor = useRef(objectId);
	if (shownFor.current !== objectId) {
		shownFor.current = objectId;
		setAllChunks(false);
		setSimilar({ status: 'idle' });
	}
	useEffect(() => {
		if (focusNonce > 0) heading.current?.focus({ preventScroll: true });
	}, [focusNonce]);
	// An answer for a document the drawer no longer shows is dropped.
	const asking = useRef(0);

	const parts = splitPath(path);
	// A document asked for from elsewhere that the listing has not loaded may have no known path: its objectId names it.
	const unknownPath = path === '' && item === null;
	const name = unknownPath ? `objectId ${objectId.slice(0, 8)}…` : parts.name;
	const mine = chunks.objectId === objectId ? chunks : null;
	const read = mine?.items ?? [];
	const listed = allChunks ? read : read.slice(0, FIRST_CHUNKS);
	const keys = read.map((c): VectorKey => [objectId, c.chunkId]);
	const first = read[0] ?? null;
	const total = mine?.total ?? item?.chunks ?? null;

	const findSimilar = (): void => {
		if (first === null || neighbors.caller === null) return;
		const k = similarK(neighborsMax, item?.chunks ?? null, read.length);
		const run = ++asking.current;
		setSimilar({ status: 'running', k });
		fetchNeighbors(neighbors.caller, neighbors.nodeId, [objectId, first.chunkId], k).then(
			(answer) => {
				if (run === asking.current) setSimilar({ status: 'done', k, documents: similarDocuments(answer.items, objectId) });
			},
			(error: unknown) => {
				if (run !== asking.current) return;
				// A request dropped for a newer one (fetchNeighbors keeps only the newest waiting) says nothing: ask again.
				const message = similarFailureText(error);
				setSimilar(message === null ? { status: 'idle' } : { status: 'error', message });
			}
		);
	};
	const similarUnavailable = neighbors.caller === null ? 'The store cannot be reached from here right now.' : first === null ? (mine?.status === 'loading' ? 'Its chunks are loading.' : 'No chunk of this document has been read.') : similar.status === 'running' ? 'Asking the store…' : null;

	return (
		<aside
			aria-label={`Document ${name}`}
			data-document-drawer=""
			style={styles.drawer}
			onKeyDown={(event) => {
				if (event.defaultPrevented || event.key !== 'Escape') return;
				event.preventDefault();
				onClose();
			}}
		>
			<div style={styles.head}>
				<div style={styles.headText}>
					<h2 ref={heading} tabIndex={-1} style={styles.title}>
						{name}
					</h2>
					<p style={styles.subtitle}>{[unknownPath ? null : parts.uploaded ? 'Uploaded' : parts.folder, unknownPath ? null : fileTypeOf(path), total === null ? 'chunk count not reported' : `${formatCount(total)} ${total === 1 ? 'chunk' : 'chunks'}`, item?.size !== null && item?.size !== undefined ? formatSize(item.size) : null].filter(Boolean).join(' · ')}</p>
				</div>
				<span style={styles.close}>
					<GatedButton onClick={onClose} title="Close (Escape)">
						Close
					</GatedButton>
				</span>
			</div>

			<section aria-label="Text" style={styles.section}>
				<h3 style={styles.heading}>{read.length > FIRST_CHUNKS && !allChunks ? `Text: first ${FIRST_CHUNKS} of ${formatCount(total ?? read.length)} chunks` : 'Text'}</h3>
				{mine?.status === 'error' && mine.error && <Banner variant="error">{mine.error.headline}</Banner>}
				{mine === null || (mine.status === 'loading' && read.length === 0) ? <p style={styles.note}>Loading chunks…</p> : null}
				{listed.map((chunk) => (
					<div key={chunk.chunkId} style={styles.chunk}>
						<div style={styles.chunkHead}>
							<strong>{`#${chunk.chunkId}`}</strong>
							<span>{`${formatCount(chunk.length)} chars`}</span>
							{chunk.isTable && <span>table</span>}
							<span style={styles.chunkActions}>
								<GatedButton onClick={() => onOpenDocument(chunk.chunkId)} title={`Open the document at chunk ${chunk.chunkId}`}>
									Open at chunk
								</GatedButton>
								<GatedButton onClick={() => onShowOnMap([[objectId, chunk.chunkId]])} title={`Show chunk ${chunk.chunkId} on the map`}>
									Map
								</GatedButton>
							</span>
						</div>
						<div style={styles.chunkText}>{chunkPreview(chunk.content)}</div>
					</div>
				))}
				<div style={styles.moreRow}>
					{read.length > FIRST_CHUNKS && (
						<GatedButton onClick={() => setAllChunks(!allChunks)} pressed={allChunks}>
							{allChunks ? `Show the first ${FIRST_CHUNKS}` : `Show all ${formatCount(read.length)} read`}
						</GatedButton>
					)}
					{allChunks && (
						<GatedButton unavailable={mine?.hasMore ? (mine.status === 'loading' ? 'Loading chunks…' : null) : 'Every chunk is read.'} onClick={onMoreChunks}>
							More chunks
						</GatedButton>
					)}
				</div>
			</section>

			<section aria-label="Metadata" style={styles.section}>
				<h3 style={styles.heading}>Metadata</h3>
				<dl style={styles.lines}>
					<dt style={styles.term}>Path</dt>
					<dd style={styles.value}>{path || (item === null ? 'not known: this document is not among the loaded rows' : '(no path)')}</dd>
					<dt style={styles.term}>objectId</dt>
					<dd style={styles.value}>
						<span style={styles.mono}>{objectId}</span>
						<GatedButton onClick={() => copyText(objectId, announce)} title="Copy the objectId">
							Copy
						</GatedButton>
					</dd>
					{item !== null && (
						<>
							<dt style={styles.term}>Chunks</dt>
							<dd style={styles.value}>{item.chunks === null ? 'not reported' : item.max_chunk_id !== null && item.max_chunk_id !== undefined ? `${formatCount(item.chunks)} (ids 0 to ${formatCount(item.max_chunk_id)})` : formatCount(item.chunks)}</dd>
							<dt style={styles.term}>Tables</dt>
							<dd style={styles.value}>{item.tables === null ? 'not reported' : formatCount(item.tables)}</dd>
							<dt style={styles.term}>Size</dt>
							<dd style={styles.value}>{formatSize(item.size)}</dd>
							<dt style={styles.term}>Ingested</dt>
							<dd style={styles.value}>{item.ingestedAt === null ? '—' : item.ingestedAt.replace('T', ' ').replace('Z', ' UTC')}</dd>
							{item.nodeId !== null && (
								<>
									<dt style={styles.term}>Node</dt>
									<dd style={styles.value}>{item.nodeId}</dd>
								</>
							)}
							{item.deleted_chunks !== null && item.deleted_chunks !== undefined && (
								<>
									<dt style={styles.term}>Deleted chunks</dt>
									<dd style={styles.value}>{formatCount(item.deleted_chunks)}</dd>
								</>
							)}
						</>
					)}
				</dl>
				{item === null && <p style={styles.note}>This document is not among the loaded rows, so only its path and objectId are shown here.</p>}
			</section>

			<section aria-label="Health" style={styles.section}>
				<h3 style={styles.heading}>Health</h3>
				{item !== null ? <HealthPanel item={item} medianChunks={median} listing="active" /> : <p style={styles.note}>Health is read from the listing; this document is not among the loaded rows.</p>}
			</section>

			<section aria-label="Neighbours" style={styles.section}>
				<h3 style={styles.heading}>Neighbours</h3>
				<div style={styles.row}>
					<GatedButton unavailable={similarUnavailable} onClick={findSimilar}>
						Find similar
					</GatedButton>
				</div>
				{similar.status === 'running' && (
					<p role="status" style={styles.note}>
						Asking the store…
					</p>
				)}
				{similar.status === 'error' && (
					<p role="alert" style={styles.note}>
						{similar.message}
					</p>
				)}
				{similar.status === 'done' && (
					<>
						<p role="status" style={styles.note}>
							{similar.documents.length === 0 ? `No other document is among the ${formatCount(similar.k)} nearest chunks to chunk #${first?.chunkId ?? 0}.` : `Documents among the ${formatCount(similar.k)} nearest chunks to chunk #${first?.chunkId ?? 0}, the nearest first:`}
						</p>
						<ul style={styles.similar} aria-label="Documents near its first chunk read">
							{similar.documents.map((doc) => (
								<li key={doc.objectId} style={styles.similarItem}>
									<button type="button" style={styles.link} title={doc.path} onClick={() => onShowDocument(doc.objectId, doc.path)} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')}>
										{doc.path || doc.objectId}
									</button>
									<span style={appStyles.small}>{`similarity ${doc.best.toFixed(3)} · ${doc.chunks} ${doc.chunks === 1 ? 'chunk' : 'chunks'}`}</span>
								</li>
							))}
						</ul>
					</>
				)}
			</section>

			<section aria-label="Actions" style={styles.section}>
				<h3 style={styles.heading}>Actions</h3>
				<div style={styles.row}>
					<GatedButton unavailable={keys.length === 0 ? 'Its chunks have not been read yet.' : null} onClick={() => onShowOnMap(keys)}>
						Show on map
					</GatedButton>
					<GatedButton unavailable={chat.enabled ? null : (chat.reason ?? 'Chat is not available.')} onClick={onAskAbout}>
						Ask about this
					</GatedButton>
					<GatedButton onClick={() => onOpenDocument()}>Open document</GatedButton>
				</div>
				{!chat.enabled && chat.reason && <p style={styles.note}>{chat.reason}</p>}
			</section>

			<div style={styles.danger}>
				{staged ? (
					<GatedButton onClick={onUnstage}>Unstage</GatedButton>
				) : (
					<GatedButton variant="danger" unavailable={writes.enabled ? null : writes.reason} title="Stage it: the pending bar applies the staged documents" onClick={onStage}>
						Move to Trash
					</GatedButton>
				)}
				<p style={styles.note}>{staged ? 'Staged: Apply in the pending bar moves it to the trash.' : writes.enabled ? 'Stages it; nothing moves until you Apply in the pending bar.' : writes.reason}</p>
			</div>
		</aside>
	);
}

export default DocumentDrawer;
