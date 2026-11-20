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
// VECTOR-UI — HealthPanel (a document tab's health)
// =============================================================================
//
// What may be wrong with one stored document: no first chunk, gaps in its
// chunk ids, soft-deleted chunks, an empty parse, many more chunks than the
// median. Flags whose fields the store does not report are left uncomputed
// and the panel says which stores report them. On a store that soft-deletes
// but did not report the count, "Count deleted chunks" asks for it on
// demand (the document tab runs the two one-row `chunks` calls).
// =============================================================================

import React from 'react';
import type { HealthPanelProps as ContractHealthPanelProps } from '../contract/types';
import { HEALTH_NOT_REPORTED, documentHealth } from '../vector/health';
import type { IHealthContext } from '../vector/health';
import { TONE_EDGE } from '../vector/colors';
import { FOCUS_RING, styles } from '../styles';

/** The on-demand count of a document's soft-deleted chunks. */
export interface IHealthProbe {
	status: 'idle' | 'running' | 'done' | 'error';
	/** The count, when the store's totals gave one. */
	deleted?: number | null;
	/** What to say instead of a count. */
	message?: string | null;
}

/** The frozen props plus the tab's own (optional, so the frozen mount still renders). */
export interface HealthPanelProps extends ContractHealthPanelProps {
	/** How the row was listed: 'all' in a document tab (deleted rows counted), 'active' in the directory. */
	listing?: IHealthContext['listing'];
	/** The document's loaded chunk lengths, and whether every chunk is loaded. */
	chunkLengths?: IHealthContext['chunkLengths'];
	/** Offer "Count deleted chunks" (the store soft-deletes but did not report the count). */
	canProbe?: boolean;
	probe?: IHealthProbe;
	onProbe?(): void;
}

export type { ContractHealthPanelProps };

/**
 * The health of one document.
 *
 * @param props - {@link HealthPanelProps}.
 * @returns The section.
 */
export function HealthPanel({ item, medianChunks = null, listing = 'all', chunkLengths = null, canProbe = false, probe = { status: 'idle' }, onProbe }: HealthPanelProps): React.ReactElement {
	const heading = <h2 style={{ ...styles.small, fontWeight: 700, margin: '0 0 4px' }}>Health</h2>;
	if (item === null) {
		return (
			<section aria-label="Document health" data-component="HealthPanel" style={{ margin: '0 0 12px' }}>
				{heading}
				<p role="status" style={{ ...styles.small, margin: 0 }}>
					Checking this document…
				</p>
			</section>
		);
	}
	const health = documentHealth(item, { medianChunks, listing, chunkLengths });
	const gapsUnchecked = health.unchecked.includes('gaps') || health.unchecked.includes('deleted_chunks');
	const others = health.unchecked.filter((k) => k === 'empty_parse' || k === 'oversize');
	return (
		<section aria-label="Document health" data-component="HealthPanel" style={{ margin: '0 0 12px' }}>
			{heading}
			{health.flags.length === 0 ? (
				<p style={{ ...styles.small, margin: 0 }}>{health.unchecked.length === 0 ? 'No problem found: the first chunk is stored, the chunk ids have no gap, no chunk is soft-deleted, the parse found text and the size is ordinary.' : 'No problem found in what this store reports.'}</p>
			) : (
				<ul aria-label="Problems found" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
					{health.flags.map((flag) => (
						<li key={flag.kind} style={{ ...styles.small, display: 'flex', gap: 8, alignItems: 'baseline' }} data-flag={flag.kind}>
							<span style={styles.chip(TONE_EDGE.warning)}>{flag.label}</span>
							<span>{flag.detail}</span>
						</li>
					))}
				</ul>
			)}
			{gapsUnchecked && (
				<p role="note" style={{ ...styles.small, margin: '4px 0 0' }}>
					{HEALTH_NOT_REPORTED}
				</p>
			)}
			{others.includes('oversize') && (
				<p role="note" style={{ ...styles.small, margin: '4px 0 0' }}>
					Oversize is not checked until the console has loaded documents to compare with.
				</p>
			)}
			{canProbe && (
				<div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, ...styles.small }}>
					<button type="button" disabled={probe.status === 'running'} style={{ ...styles.small, padding: '2px 8px', color: 'inherit', background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border-input)', borderRadius: 4, cursor: probe.status === 'running' ? 'progress' : 'pointer' }} onClick={() => onProbe?.()} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')}>
						{probe.status === 'running' ? 'Counting…' : 'Count deleted chunks'}
					</button>
					{probe.status === 'done' && <span role="status">{probe.deleted === null || probe.deleted === undefined ? (probe.message ?? 'The store did not count the chunks, so deleted chunks cannot be counted.') : probe.deleted === 0 ? 'No soft-deleted chunk of this document is stored.' : `${probe.deleted.toLocaleString('en-US')} soft-deleted ${probe.deleted === 1 ? 'chunk' : 'chunks'} of this document ${probe.deleted === 1 ? 'is' : 'are'} still stored.`}</span>}
					{probe.status === 'error' && <span role="alert">{probe.message ?? 'The store did not answer.'}</span>}
				</div>
			)}
		</section>
	);
}

export default HealthPanel;
