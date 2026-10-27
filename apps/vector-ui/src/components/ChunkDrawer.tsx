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

// =============================================================================
// VECTOR-UI - CHUNK DRAWER (one chunk of a document, docked beside the Chunks grid)
// =============================================================================
//
// Inline, never a Modal or a DetailPanel (rocket-ui keeps hidden documents
// mounted). It shows the chunk's text, its own metadata keys, its 12 nearest
// chunks in the whole collection (read when it opens; none for a chunk in the
// trash, which the store skips), and the actions that belong to a chunk. It
// takes the focus when it opens; Escape inside it closes it (the innermost
// handler acts and calls preventDefault, an event already handled is left
// alone) and the grid gets the focus back.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, BxX, Button, commonStyles } from 'shell';
import type { ConsoleActions, IChunkItem, VectorKey } from '../contract/types';
import { fetchNeighbors } from '../adapters/actions';
import type { IVectorCaller } from '../adapters/actions';
import { DRAWER_NEIGHBOURS, neighbourRows, neighboursCaption, neighboursUnavailable } from '../vector/chunkRows';
import type { INeighbourRow } from '../vector/chunkRows';
import { formatCount } from '../vector/stats';
import { failureText } from '../vector/wording';
import type { IFailureText } from '../vector/wording';
import { styles as appStyles } from '../styles';

const styles = {
	drawer: { flex: '0 0 380px', width: 380, minWidth: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--rr-border)', background: 'var(--rr-bg-paper)', outline: 'none', overflow: 'hidden' } as CSSProperties,
	header: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px 8px 16px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	title: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere' } as CSSProperties,
	close: commonStyles.paneHeaderButton,
	body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 16px 16px' } as CSSProperties,
	heading: { margin: '16px 0 6px', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' } as CSSProperties,
	text: { margin: 0, fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as CSSProperties,
	meta: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: 0, fontSize: 12 } as CSSProperties,
	actions: { display: 'flex', flexWrap: 'wrap', gap: 8 } as CSSProperties,
	list: { listStyle: 'none', margin: 0, padding: 0 } as CSSProperties,
	neighbour: { padding: '6px 0', borderTop: '1px solid var(--rr-border)' } as CSSProperties,
	link: { padding: 0, border: 'none', background: 'none', color: 'inherit', font: 'inherit', fontWeight: 600, textDecoration: 'underline', cursor: 'pointer', textAlign: 'left', overflowWrap: 'anywhere' } as CSSProperties,
};

/** The longest metadata value shown. */
const VALUE_CHARS = 200;

/**
 * A metadata value as text.
 *
 * @param value - Any value the store kept.
 * @returns The text, cut.
 */
export function metadataText(value: unknown): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS - 1)}…` : text;
}

type NeighboursState = { status: 'skipped'; reason: string } | { status: 'loading' } | { status: 'error'; error: IFailureText } | { status: 'done'; rows: INeighbourRow[] };

/** Props. */
export interface IChunkDrawerProps {
	objectId: string;
	path: string;
	/** The chunk, or null when it is no longer in the listing (the document changed). */
	chunk: IChunkItem | null;
	caller: IVectorCaller | null;
	store: string;
	actions: Pick<ConsoleActions, 'showOnMap' | 'openDocument' | 'requestRemove' | 'announce'>;
	writes: { enabled: boolean; reason: string | null };
	/** Close it (the parent puts the focus back on the grid). */
	onClose(): void;
	/** Show the chunk in the Reader. */
	onOpenInReader(chunkId: number): void;
	/** Copy a text (says so when the window does not allow it). */
	onCopy(text: string): void;
	/** Use the chunk's text as the Query tab's question. Absent where this mount cannot hand a question to the workbench. */
	onUseAsQuery?(text: string): void;
}

/**
 * The drawer.
 *
 * @param props - {@link IChunkDrawerProps}.
 * @returns The drawer.
 */
export function ChunkDrawer({ objectId, path, chunk, caller, store, actions, writes, onClose, onOpenInReader, onCopy, onUseAsQuery }: IChunkDrawerProps): React.ReactElement {
	const region = useRef<HTMLElement>(null);
	const [state, setState] = useState<NeighboursState>({ status: 'loading' });
	const [attempt, setAttempt] = useState(0);
	const chunkId = chunk?.chunkId ?? null;
	const deleted = chunk?.isDeleted ?? false;

	// It opens with the focus (its content is read, and Escape reaches it).
	useEffect(() => {
		region.current?.focus();
	}, []);

	// The neighbours: once per chunk shown, again on Retry; a late answer for another chunk is dropped.
	useEffect(() => {
		if (chunkId === null) return undefined;
		const reason = neighboursUnavailable({ isDeleted: deleted });
		if (reason !== null) {
			setState({ status: 'skipped', reason });
			return undefined;
		}
		if (caller === null) {
			setState({ status: 'skipped', reason: 'No source of this pipeline is running, so neighbours cannot be read.' });
			return undefined;
		}
		let live = true;
		setState({ status: 'loading' });
		const key: VectorKey = [objectId, chunkId];
		fetchNeighbors(caller, store, key, DRAWER_NEIGHBOURS).then(
			(answer) => {
				if (live) setState({ status: 'done', rows: neighbourRows(answer.items, objectId) });
			},
			(error) => {
				if (live) setState({ status: 'error', error: failureText(error) ?? { headline: 'The neighbours could not be read.' } });
			}
		);
		return () => {
			live = false;
		};
	}, [caller, store, objectId, chunkId, deleted, attempt]);

	const keys = useCallback((): VectorKey[] => (chunkId === null ? [] : [[objectId, chunkId]]), [objectId, chunkId]);

	return (
		<aside
			ref={region}
			tabIndex={-1}
			aria-label={chunkId === null ? 'Chunk' : `Chunk ${chunkId}`}
			style={styles.drawer}
			data-chunk-drawer=""
			onKeyDown={(event) => {
				if (event.key !== 'Escape' || event.defaultPrevented) return;
				event.preventDefault();
				onClose();
			}}
		>
			<div style={styles.header}>
				<div style={styles.title}>{chunkId === null ? 'Chunk' : `Chunk ${chunkId}`}</div>
				<button type="button" style={styles.close} title="Close the chunk" aria-label="Close the chunk" onClick={onClose}>
					<BxX size={18} />
				</button>
			</div>
			<div style={styles.body}>
				{chunk === null ? (
					<p style={appStyles.small}>This chunk is no longer in the list; the document may have changed. Close the drawer and pick another.</p>
				) : (
					<>
						<div style={{ ...appStyles.small, overflowWrap: 'anywhere' }}>{path}</div>
						<div style={styles.heading}>Text</div>
						<p style={styles.text}>{chunk.content === '' ? '(no text)' : chunk.content}</p>
						<div style={styles.heading}>Metadata</div>
						<dl style={styles.meta}>
							<dt style={{ fontWeight: 600 }}>objectId</dt>
							<dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{objectId}</dd>
							<dt style={{ fontWeight: 600 }}>chunkId</dt>
							<dd style={{ margin: 0 }}>{chunk.chunkId}</dd>
							<dt style={{ fontWeight: 600 }}>Chars</dt>
							<dd style={{ margin: 0 }}>{formatCount(chunk.length)}</dd>
							{chunk.pointId !== null && (
								<>
									<dt style={{ fontWeight: 600 }}>pointId</dt>
									<dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{chunk.pointId}</dd>
								</>
							)}
							{Object.entries(chunk.metadata).map(([name, value]) => (
								<React.Fragment key={name}>
									<dt style={{ fontWeight: 600 }}>{name}</dt>
									<dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{metadataText(value)}</dd>
								</React.Fragment>
							))}
						</dl>
						<div style={styles.heading}>Neighbours</div>
						{state.status === 'loading' && (
							<div role="status" style={appStyles.small}>
								Reading the nearest chunks…
							</div>
						)}
						{state.status === 'skipped' && <p style={appStyles.small}>{state.reason}</p>}
						{state.status === 'error' && (
							<>
								<Banner variant="error">{state.error.headline}</Banner>
								<div style={{ marginTop: 8 }}>
									<Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
										Try again
									</Button>
								</div>
							</>
						)}
						{state.status === 'done' && (
							<>
								<p style={{ ...appStyles.small, margin: '0 0 6px' }}>{state.rows.length === 0 ? 'The store returned no neighbours for this chunk.' : neighboursCaption(state.rows)}</p>
								<ol style={styles.list} aria-label="Nearest chunks in the collection">
									{state.rows.map((row) => (
										<li key={row.id} style={styles.neighbour}>
											<button type="button" style={styles.link} onClick={() => actions.openDocument(row.objectId, row.chunkId)}>
												{`${row.path} #${row.chunkId}`}
											</button>
											<div style={appStyles.small}>
												{`similarity ${row.similarity.toFixed(3)}`}
												{row.sameDocument ? ' · this document' : ''}
												{row.belowFloor ? ' · below the store\'s floor' : ''}
											</div>
											{row.preview !== '' && <div style={{ ...appStyles.small, overflowWrap: 'anywhere' }}>{row.preview}</div>}
										</li>
									))}
								</ol>
							</>
						)}
						<div style={styles.heading}>Actions</div>
						<div style={styles.actions}>
							<Button variant="secondary" onClick={() => actions.showOnMap(keys(), 'document')}>
								Show on map
							</Button>
							{onUseAsQuery && (
								<Button variant="secondary" disabled={chunk.content === ''} onClick={() => onUseAsQuery(chunk.content)}>
									Use as query
								</Button>
							)}
							<Button variant="secondary" onClick={() => onOpenInReader(chunk.chunkId)}>
								Open in reader
							</Button>
							<Button variant="ghost" onClick={() => onCopy(chunk.content)}>
								Copy text
							</Button>
							<Button variant="ghost" disabled={!writes.enabled} title={writes.enabled ? 'Move the whole document to the trash' : (writes.reason ?? undefined)} onClick={() => actions.requestRemove([objectId])}>
								Move document to Trash
							</Button>
						</div>
						{!writes.enabled && writes.reason && <p style={{ ...appStyles.small, margin: '6px 0 0' }}>{writes.reason}</p>}
					</>
				)}
			</div>
		</aside>
	);
}

export default ChunkDrawer;
