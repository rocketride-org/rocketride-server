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
// VECTOR-UI - THE COLLECTION TAB (what the store node reports about the collection)
// =============================================================================
//
// Read-only. Embedding, index, storage and writes are what the dialect says
// (vector/connections.ts collectionView), the console's last stats filling
// what it lacks. Below them the metadata fields: the document fields are
// exact over the documents loaded, and the chunk fields come only from the
// "Read fields from a sample" button, which reads a few chunks and says so.
// No tool lists a collection's fields, so nothing else is claimed.
// =============================================================================

import React, { useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, LabelValue, Section } from 'shell';
import { useVectorEnv } from '../envContext';
import { collectionView } from '../vector/connections';
import { listingComplete } from '../vector/documents';
import { directoryView } from '../vector/filters';
import { documentFields, filterPhrase, mergeFields } from '../vector/fields';
import type { IFieldRow, IFieldsEstimate } from '../vector/fields';
import { CHUNKS_PER_DOCUMENT, SAMPLE_DOCUMENTS, readFieldsSample } from '../vector/fieldsRead';
import { formatCount } from '../vector/stats';
import { failureText } from '../vector/wording';
import type { IFailureText } from '../vector/wording';
import { styles } from '../styles';
import type { ICollectionPanelProps } from './workbenchProps';

const local = {
	scroll: { flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', padding: '0 12px 16px' } as CSSProperties,
	table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 } as CSSProperties,
	cell: { textAlign: 'left', verticalAlign: 'top', padding: '4px 8px', borderBottom: '1px solid var(--rr-border)', overflowWrap: 'anywhere' } as CSSProperties,
	head: { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--rr-border-input)', fontWeight: 600 } as CSSProperties,
	actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' } as CSSProperties,
};

/** Said while the fields are read. */
export const FIELDS_READING = 'Reading chunks…';

/**
 * What the fields table says it was read over.
 *
 * @param counted - How many documents the fields were counted over.
 * @param loaded - How many documents are loaded.
 * @param scoped - Whether a scope was applied to choose them (by the store or here: the count is of what it keeps).
 * @param complete - Whether the listing holds every document (it ended; not merely before the first page).
 * @param estimate - The chunk sample, when one was read and still current.
 * @param stale - A sample was read but documents were written since.
 * @returns The caption lines.
 */
export function fieldsCaption(counted: number, loaded: number, scoped: boolean, complete: boolean, estimate: IFieldsEstimate | null, stale = false): string[] {
	const noun = (n: number): string => (n === 1 ? 'document' : 'documents');
	const over = scoped ? `the ${formatCount(counted)} ${noun(counted)} the current scope keeps, of ${formatCount(loaded)} loaded` : `the ${formatCount(counted)} ${noun(counted)} loaded`;
	const lines = [`Document fields are exact over ${over}${complete ? '' : '; more are not loaded yet'}.`];
	if (estimate && estimate.chunksRead > 0) {
		lines.push(`Chunk fields are estimated: ${formatCount(estimate.chunksRead)} ${estimate.chunksRead === 1 ? 'chunk' : 'chunks'} read from ${formatCount(estimate.documentsRead)} ${estimate.documentsRead === 1 ? 'document' : 'documents'} at ${new Date(estimate.at).toLocaleTimeString()}. Types are guessed from those values and coverage is of those chunks, not of the collection.`);
	} else if (estimate) {
		lines.push(`No chunks came back from the ${formatCount(estimate.documentsRead)} ${estimate.documentsRead === 1 ? 'document' : 'documents'} read, so there are no chunk fields.`);
	} else if (stale) {
		lines.push('Documents were written since the chunk fields were read, so they are not shown. Read them again.');
	} else {
		lines.push('Chunk fields are not read yet. No store lists them, so they are read from a sample on request.');
	}
	return lines;
}

/**
 * The coverage cell: how many of the rows read have a value.
 *
 * @param field - The field.
 * @returns e.g. '12 of 20'.
 */
export function coverageText(field: Pick<IFieldRow, 'coverage' | 'of'>): string {
	return `${formatCount(field.coverage)} of ${formatCount(field.of)}`;
}

/**
 * The Collection tab.
 *
 * @param props - {@link ICollectionPanelProps}.
 * @returns The tab's panel.
 */
export function CollectionPanel({ entry, model, channels, actions, probe, console: state }: ICollectionPanelProps): React.ReactElement {
	const sections = collectionView(probe, state.stats.view);
	const writes = useSyncExternalStore(entry.writes.subscribe, entry.writes.get, entry.writes.get);
	const sampled = useSyncExternalStore(entry.fields.subscribe, entry.fields.get, entry.fields.get);
	// A write since the sample was read: its chunk fields describe documents that may have changed, so they are not shown.
	const documentsNow = state.stats.view?.documents ?? null;
	const stale = sampled !== null && ((sampled.writes ?? 0) !== writes || (sampled.documents != null && documentsNow !== null && sampled.documents !== documentsNow));
	const estimate = stale ? null : sampled;
	const [reading, setReading] = useState(false);
	const [failed, setFailed] = useState<IFailureText | null>(null);
	const run = useRef(0);
	const caller = channels.tools ?? channels.chat ?? channels.ingest;
	const scope = useSyncExternalStore(entry.scope.subscribe, entry.scope.get, entry.scope.get);
	const env = useVectorEnv();
	// The documents the fields are counted over: the loaded ones the scope keeps (matched here where the store did not
	// apply it), else every loaded one.
	const kept = scope === null ? null : directoryView(state.directory, scope, '', model.limits.scope_keys_max).scopeRows;
	const rows = kept ?? state.directory.rows;
	const listing = documentFields(rows);
	const fields = mergeFields(listing, estimate ? estimate.rows.filter((f) => f.source === 'chunks') : []);
	const blocked = caller === null ? 'No source of this pipeline is running, so chunks cannot be read.' : rows.length === 0 ? 'No documents are loaded, so there is nothing to sample.' : null;
	const read = async (): Promise<void> => {
		if (reading || blocked !== null || caller === null) return;
		const mine = (run.current += 1);
		setReading(true);
		setFailed(null);
		actions.announce(FIELDS_READING);
		try {
			const next = await readFieldsSample(caller, model.nodes.store, rows, entry.writes.get(), state.stats.view?.documents ?? null);
			if (mine !== run.current) return;
			entry.fields.set(next);
			actions.announce(`Read ${next.chunksRead} chunks from ${next.documentsRead} documents.`);
		} catch (error) {
			if (mine === run.current) setFailed(failureText(error) ?? { headline: 'The chunks could not be read.' });
		} finally {
			if (mine === run.current) setReading(false);
		}
	};
	return (
		<div style={local.scroll} data-collection-tab>
			{sections.length === 0 && <p style={{ ...styles.small, margin: '12px 0' }}>{`The store node has not answered its dialect, so there is nothing to show yet.${env.kind === 'local' ? ' Test connection on the Connections page asks again.' : ' Refresh the connection list to ask again.'}`}</p>}
			{sections.map((section) => (
				<Section key={section.label} label={section.label}>
					{section.rows.map((row) => (
						<LabelValue key={row.label} label={row.label}>
							{row.value}
						</LabelValue>
					))}
				</Section>
			))}
			<Section label="Metadata fields">
				{fields.length === 0 ? (
					<p style={{ ...styles.small, margin: '4px 0' }}>{rows.length === 0 ? 'No documents are loaded, so no fields have been read.' : 'No fields.'}</p>
				) : (
					<table style={local.table} aria-label="Metadata fields">
						<thead>
							<tr>
								<th scope="col" style={local.head}>Field</th>
								<th scope="col" style={local.head}>Type</th>
								<th scope="col" style={local.head}>Coverage</th>
								<th scope="col" style={local.head}>Example</th>
								<th scope="col" style={local.head}>Filterable</th>
							</tr>
						</thead>
						<tbody>
							{fields.map((field) => (
								<tr key={`${field.source}:${field.name}`}>
									<th scope="row" style={{ ...local.cell, fontWeight: 600 }}>{field.name}</th>
									<td style={local.cell}>{field.source === 'chunks' ? `${field.type} (estimated)` : field.type}</td>
									<td style={local.cell}>{coverageText(field)}{field.source === 'chunks' ? ' chunks' : ' documents'}</td>
									<td style={local.cell}>{field.example ?? '—'}</td>
									<td style={local.cell}>{filterPhrase(field)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<div style={local.actions}>
					<Button variant="secondary" aria-disabled={reading || blocked !== null} title={blocked ?? `Reads the first ${CHUNKS_PER_DOCUMENT} chunks of up to ${SAMPLE_DOCUMENTS} documents spread over the loaded folders: at most ${SAMPLE_DOCUMENTS} calls.`} onClick={() => void read()}>
						{reading ? FIELDS_READING : estimate ? 'Read fields again' : 'Read fields from a sample'}
					</Button>
					{blocked !== null && <span style={styles.small}>{blocked}</span>}
				</div>
				{failed && <Banner variant="error">{failed.headline}</Banner>}
				{fieldsCaption(rows.length, state.directory.rows.length, scope !== null && kept !== null, listingComplete(state.directory), estimate, stale).map((line) => (
					<p key={line} style={{ ...styles.small, margin: '4px 0' }}>{line}</p>
				))}
			</Section>
		</div>
	);
}

export default CollectionPanel;
