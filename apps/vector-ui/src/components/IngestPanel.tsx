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
// VECTOR-UI — IngestPanel (the console's "Add documents", R4)
// =============================================================================
//
// The top half of the console's right column: the drop zone, the optional
// "Store under folder" prefix, the upload list, and the question asked before
// a dropped file replaces a stored one. Files go to the pipeline's Ingest
// source (parse → chunk → embed → store); when that source also feeds other
// store nodes, the panel says so. Without a running Ingest source, or on a
// read-only connection, it says why nothing can be added.
//
// Above the upload rows, each drop's summary; a finished drop offers "Show
// new chunks on the map" (the console's showOnMap, cut at the connection's
// pin limit), disabled with the reason on a store whose map cannot place
// them.
// =============================================================================

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { EmptyState } from 'shell';
import type { IngestPanelProps } from '../contract/types';
import { useIngest } from '../ingest/useIngest';
import { ReplaceConfirmDialog } from '../ingest/ReplaceConfirmDialog';
import { normaliseFolderPrefix, showNewChunksReason } from '../vector/uploads';
import { IngestDropZone } from './IngestDropZone';
import { UploadList } from './UploadList';

export type { IngestPanelProps };

/** Shown when the connection has no running Ingest source. */
export const NO_INGEST_SENTENCE = 'This pipeline has no running Ingest source. Start its dropper source to add documents.';

const S = {
	root: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, height: '100%', overflow: 'auto', padding: '8px 10px' } as CSSProperties,
	heading: { margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--rr-text-secondary)' } as CSSProperties,
	prefixRow: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--rr-text-secondary)', flexWrap: 'wrap' } as CSSProperties,
	input: { flex: '1 1 160px', minWidth: 120, fontSize: 12, padding: '3px 6px', borderRadius: 4, border: '1px solid var(--rr-border-input)', background: 'var(--rr-bg-input)', color: 'var(--rr-text-primary)' } as CSSProperties,
	error: { fontSize: 12, color: 'var(--rr-color-error)', margin: 0 } as CSSProperties,
	note: { fontSize: 12, color: 'var(--rr-text-secondary)', margin: 0, overflowWrap: 'anywhere' } as CSSProperties,
};

/**
 * Add documents to the connection's collection.
 *
 * @param props - The frozen props (src/contract/types.ts).
 * @returns The panel.
 */
export function IngestPanel(props: IngestPanelProps): React.ReactElement {
	const { model, channels, alsoReaches } = props;
	const ingest = useIngest(props);
	const [prefix, setPrefix] = useState('');
	const prefixCheck = normaliseFolderPrefix(prefix);
	const available = model.ingest.enabled && channels.ingest !== null;
	const reason = !available ? (model.ingest.reason ?? NO_INGEST_SENTENCE) : !prefixCheck.ok ? prefixCheck.reason : null;
	const folder = prefixCheck.ok ? prefixCheck.path : '';

	return (
		<section style={S.root} aria-label="Add documents">
			<h2 style={S.heading}>Add documents</h2>
			{!available ? (
				<EmptyState title="Adding documents is not available" description={model.ingest.reason ?? NO_INGEST_SENTENCE} />
			) : (
				<>
					<IngestDropZone collection={model.collection} disabledReason={reason} onDrop={(transfer) => ingest.addFromDrop(transfer, folder)} onPick={(files) => ingest.addFromInput(files, folder)} />
					<label style={S.prefixRow}>
						Store under folder
						<input style={S.input} type="text" value={prefix} placeholder="optional, e.g. C:/demo/inbox" spellCheck={false} onChange={(event) => setPrefix(event.currentTarget.value)} aria-invalid={!prefixCheck.ok || undefined} />
					</label>
					{!prefixCheck.ok && <p style={S.error}>{prefixCheck.reason}</p>}
					{alsoReaches.length > 0 && <p style={S.note}>{`This pipeline's ingest also reaches: ${alsoReaches.join(', ')}`}</p>}
				</>
			)}
			<UploadList rows={ingest.state.rows} notes={ingest.state.notes} onClearFinished={ingest.clearFinished} drops={ingest.state.drops} onShowNew={ingest.showNewChunks} showNewReason={showNewChunksReason(model.capabilities)} pinLimit={model.limits.project_keys_max} />
			{ingest.state.confirm !== null && <ReplaceConfirmDialog key={ingest.state.confirm.id} question={ingest.state.confirm} onReplace={() => ingest.answerConfirm(true)} onCancel={() => ingest.answerConfirm(false)} />}
		</section>
	);
}

export default IngestPanel;
