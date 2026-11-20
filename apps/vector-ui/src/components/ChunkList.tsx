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
// VECTOR-UI — CHUNK LIST (the selected document's chunks, in reading order)
// =============================================================================

import React from 'react';
import { Banner, Button } from 'shell';
import type { VectorKey } from '../contract/types';
import type { IChunksSlot } from '../vector/consoleStore';
import { formatCount } from '../vector/stats';
import { styles } from '../styles';

/** How much of a chunk the list shows (the document tab shows it all). */
const PREVIEW_CHARS = 180;

/** Props for the {@link ChunkList} component. */
export interface IChunkListProps {
	chunks: IChunksSlot;
	/** The document's path, for the title. */
	path: string | null;
	onMore(): void;
	onOpen(chunkId: number): void;
	onMap(key: VectorKey): void;
}

/**
 * The first characters of a chunk, on one line.
 *
 * @param text - The chunk.
 * @returns At most PREVIEW_CHARS characters, with an ellipsis when cut.
 */
export function chunkPreview(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, '')}…`;
}

/**
 * The chunk list.
 *
 * @param props - {@link IChunkListProps}.
 * @returns The panel element.
 */
export function ChunkList({ chunks, path, onMore, onOpen, onMap }: IChunkListProps): React.ReactElement | null {
	if (chunks.objectId === null) return null;
	const objectId = chunks.objectId;
	return (
		<section aria-label={`Chunks of ${path ?? objectId}`} style={{ ...styles.panel, maxHeight: '42%', marginTop: 8 }}>
			<div style={styles.panelTitle}>
				<span>Chunks</span>
				<span style={{ ...styles.small, fontWeight: 400, textTransform: 'none', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path ?? objectId}</span>
				{chunks.total !== null && <span style={{ ...styles.small, fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 'auto' }}>{`${formatCount(chunks.total)} chunks`}</span>}
			</div>
			<div style={{ overflowY: 'auto', minHeight: 0, padding: '4px 0' }}>
				{chunks.status === 'error' && chunks.error && (
					<div style={{ padding: '4px 12px' }}>
						<Banner variant="error">{chunks.error.headline}</Banner>
					</div>
				)}
				<ol aria-label="Chunks in reading order" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
					{chunks.items.map((chunk) => (
						<li key={chunk.chunkId} style={{ padding: '6px 12px', borderBottom: '1px solid var(--rr-border)' }}>
							<div style={{ display: 'flex', gap: 8, alignItems: 'center', ...styles.small }}>
								<strong>{`#${chunk.chunkId}`}</strong>
								<span>{`${formatCount(chunk.length)} chars`}</span>
								{chunk.isTable && <span style={styles.chip('var(--rr-border-input)')}>table</span>}
								<span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
									<Button mini variant="ghost" onClick={() => onOpen(chunk.chunkId)}>
										open
									</Button>
									<Button mini variant="ghost" onClick={() => onMap([objectId, chunk.chunkId])}>
										map
									</Button>
								</span>
							</div>
							<div style={{ fontSize: 12.5, marginTop: 2, overflowWrap: 'anywhere' }}>{chunkPreview(chunk.content)}</div>
						</li>
					))}
				</ol>
				{chunks.status === 'loading' && <div style={{ ...styles.small, padding: '6px 12px' }}>Loading chunks…</div>}
				{chunks.hasMore && chunks.status !== 'loading' && (
					<div style={{ padding: '6px 12px' }}>
						<Button small variant="secondary" onClick={onMore}>
							More chunks
						</Button>
					</div>
				)}
			</div>
		</section>
	);
}

export default ChunkList;
