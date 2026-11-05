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
// VECTOR-UI — CONNECTION DRAWER DETAILS (what the store node says about itself)
// =============================================================================
//
// Describes the collection first (vector/connections.ts drawerView: its name,
// documents and chunks when the console has counted them, embedding model,
// dimension, metric, index and size), then the metadata fields read so far,
// the first chunks of the first document (two reads, on open), and the
// quick actions that open the workbench on a tab. The connection's own rows
// (sources, pipeline, node, run, backend, nodes, write switch) are behind a
// collapsed "Connection details". Nothing here reads a component's
// configuration or holds a credential.
// =============================================================================

import React from 'react';
import { Button, LabelValue, Section } from 'shell';
import type { IDrawerView } from '../vector/connections';
import { fieldsSummary } from '../vector/fields';
import type { IFieldsEstimate } from '../vector/fields';
import type { SampleState } from '../vector/sampleChunks';
import type { WorkbenchTab } from '../vector/workbench';
import { styles } from '../styles';

/** The quick actions: the tab each opens. */
export const QUICK_ACTIONS: ReadonlyArray<{ label: string; tab: WorkbenchTab }> = [
	{ label: 'Browse documents', tab: 'documents' },
	{ label: 'Search', tab: 'query' },
	{ label: 'Open map', tab: 'map' },
];

/** Props for the {@link ConnectionDrawerDetails} component. */
export interface IConnectionDrawerDetailsProps {
	drawer: IDrawerView;
	/** The metadata fields read so far (the Collection tab reads them); undefined leaves the section out. */
	fields?: IFieldsEstimate | null;
	/** The sample chunks' state; undefined leaves the section out. */
	sample?: SampleState;
	/** Open the workbench on a tab; undefined leaves the quick actions out. */
	onOpenTab?(tab: WorkbenchTab): void;
}

/**
 * The drawer's details.
 *
 * @param props - {@link IConnectionDrawerDetailsProps}.
 * @returns The sections.
 */
export function ConnectionDrawerDetails({ drawer, fields, sample, onOpenTab }: IConnectionDrawerDetailsProps): React.ReactElement {
	return (
		<>
			{drawer.collection.length > 0 && (
				<Section label="Collection">
					{drawer.collection.map((row) => (
						<LabelValue key={row.label} label={row.label}>
							{row.value}
						</LabelValue>
					))}
				</Section>
			)}
			{fields !== undefined && (
				<Section label="Metadata fields">
					<div style={styles.small}>{fieldsSummary(fields)}</div>
				</Section>
			)}
			{sample !== undefined && sample.status !== 'skipped' && (
				<Section label="Sample chunks">
					{sample.status === 'loading' && (
						<div role="status" style={styles.small}>
							Reading the first document…
						</div>
					)}
					{sample.status === 'empty' && <div style={styles.small}>The store lists no document.</div>}
					{sample.status === 'error' && <div style={styles.small}>{sample.message}</div>}
					{sample.status === 'done' && (
						<>
							<div style={{ ...styles.small, marginBottom: 6, overflowWrap: 'anywhere' }}>{`The first chunks of ${sample.sample.path}`}</div>
							<ol style={{ margin: 0, paddingLeft: 20 }} aria-label="First chunks of the first document">
								{sample.sample.chunks.map((chunk) => (
									<li key={chunk.chunkId} style={{ ...styles.small, marginBottom: 6, overflowWrap: 'anywhere' }}>
										{chunk.snippet === '' ? '(no text)' : chunk.snippet}
									</li>
								))}
							</ol>
							{sample.sample.chunks.length === 0 && <div style={styles.small}>The store returned no chunks for it.</div>}
						</>
					)}
				</Section>
			)}
			{onOpenTab && (
				<Section label="Quick actions">
					<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
						{QUICK_ACTIONS.map((action) => (
							<Button key={action.tab} variant="secondary" onClick={() => onOpenTab(action.tab)}>
								{action.label}
							</Button>
						))}
					</div>
				</Section>
			)}
			<details style={{ margin: '12px 0' }}>
				<summary style={{ cursor: 'pointer', fontWeight: 600 }}>Connection details</summary>
				<Section label="Connection">
					{drawer.connection.map((row) => (
						<LabelValue key={row.label} label={row.label}>
							{row.value}
						</LabelValue>
					))}
				</Section>
			</details>
			{drawer.notes.length > 0 && (
				<Section label="What to know">
					{drawer.notes.map((note) => (
						<div key={note} style={{ ...styles.small, marginBottom: 8 }}>
							{note}
						</div>
					))}
				</Section>
			)}
		</>
	);
}

export default ConnectionDrawerDetails;
