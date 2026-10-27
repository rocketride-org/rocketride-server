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
// VECTOR-UI - ADD DOCUMENTS (an aside of the workbench, opened from its header)
// =============================================================================
//
// For now it holds the upload area as the console had it: the drop zone,
// "Store under folder", the upload rows and the replace question. Where
// uploads cannot work (a dev-tool mount) it says why instead. Once opened it
// stays mounted, hidden while closed, so an upload in flight keeps
// following its progress. Closing it with the focus inside gives the focus
// back to what opened it.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { BxX, EmptyState, commonStyles } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { VECTOR_PROVIDERS } from '../adapters/explorer';
import type { ConsoleActions, ConsoleModel, VectorChannels } from '../contract/types';
import { alsoReaches } from '../vector/consoleModel';
import IngestPanel from './IngestPanel';

const styles = {
	aside: (open: boolean): CSSProperties => ({ display: open ? 'flex' : 'none', flexDirection: 'column', flex: '0 0 360px', minHeight: 0, minWidth: 0, borderLeft: '1px solid var(--rr-border)' }),
	header: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px 0 12px' } as CSSProperties,
	title: { ...commonStyles.textEllipsis, flex: 1, margin: 0, fontSize: 14, fontWeight: 600 } as CSSProperties,
	close: commonStyles.paneHeaderButton,
	body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto', padding: 12 } as CSSProperties,
};

/** Props for the {@link AddDocumentsAside} component. */
export interface IAddDocumentsAsideProps {
	model: ConsoleModel;
	channels: VectorChannels;
	actions: ConsoleActions;
	/** The live endpoint (the other stores its pipeline feeds). */
	endpoint: IExplorerEndpoint;
	/** Shown, or hidden (it stays mounted). */
	open: boolean;
	onClose(): void;
}

/**
 * The Add documents aside.
 *
 * @param props - {@link IAddDocumentsAsideProps}.
 * @returns The aside.
 */
export function AddDocumentsAside({ model, channels, actions, endpoint, open, onClose }: IAddDocumentsAsideProps): React.ReactElement {
	const region = useRef<HTMLElement>(null);
	const opener = useRef<Element | null>(null);
	// Opened: remember what had the focus. Closed with the focus inside (or lost): give it back, if still on the page.
	useEffect(() => {
		if (typeof document === 'undefined') return;
		if (open) {
			opener.current = document.activeElement;
			return;
		}
		const focused = document.activeElement;
		const node = region.current;
		const lost = focused === null || focused === document.body || (node !== null && node.contains(focused));
		const back = opener.current;
		opener.current = null;
		if (lost && back instanceof HTMLElement && back.isConnected) back.focus();
	}, [open]);
	return (
		<aside ref={region} aria-label="Add documents" style={styles.aside(open)}>
			<div style={styles.header}>
				<h2 style={styles.title}>Add documents</h2>
				<button type="button" style={styles.close} title="Close Add documents" aria-label="Close Add documents" onClick={onClose}>
					<BxX size={18} />
				</button>
			</div>
			<div style={styles.body}>{model.ingest.enabled ? <IngestPanel model={model} channels={channels} actions={actions} alsoReaches={alsoReaches(endpoint, VECTOR_PROVIDERS)} /> : <EmptyState title="Add documents" description={model.ingest.reason ?? undefined} />}</div>
		</aside>
	);
}

export default AddDocumentsAside;
