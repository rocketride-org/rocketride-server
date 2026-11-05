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
// VECTOR-UI — ClustersPanel (the map's Clusters tab)
// =============================================================================
//
// One row per cluster of the sample's neighbour graph, largest first, with its
// colour, its label (the node's terms, or "group N"), its size and documents,
// and Show (isolate it on the map), Ask about these (scope the chat to its
// documents) and Export (the shared export menu, over that cluster's points);
// a Noise row lists the points in no group. The
// Minimum size select (2, 5 or 10) is applied in the browser by the view (it
// folds smaller groups into noise): changing it never calls the store. While
// the map is isolated the footer says how many points it shows, with Show all
// and Expand by neighbours.
//
// The clusters come with the sample from a node that computes them (contract
// section 4.4-C; capability `clusters`); an older node gets a sentence saying
// so. The tab is the text alternative of the cluster colours and labels.
// Hook-free: every state lives in the view.
// =============================================================================

import React from 'react';
import type { Availability, ClusterMinSize, ClustersPanelProps as ContractClustersPanelProps, IExportItem } from '../contract/types';
import { CLUSTER_MIN_SIZES, clusterRows, clusterSentence } from '../map/clusters';
import type { IClusterView } from '../map/clusters';
import { isolationLine } from '../map/isolate';
import { MAP_STYLES } from '../map/styles';
import { CLUSTERS_NOT_IN_SAMPLE, CLUSTERS_UNSUPPORTED, clustersNone, num } from '../map/wording';
import { ExportMenu } from './ExportMenu';

/** Props: the frozen ones plus what the view computed and the isolation's actions. */
export interface ClustersPanelProps extends ContractClustersPanelProps {
	/** The node's clusters folded by the minimum size (null: the sample has none). */
	view?: IClusterView | null;
	/** Colour per folded group (as the map draws them). */
	colours?: readonly string[];
	/** The noise colour. */
	noiseColour?: string;
	/** Points not shown (removed documents, an isolation): left out of the counts. */
	hidden?: ArrayLike<number> | null;
	/** The node computes clusters (capability `clusters`). */
	clustersOffered?: boolean;
	/** The most documents "Ask about these" may hand the chat (limits.scope_keys_max). */
	maxDocuments?: number;
	/** The map is isolated: points shown of the sample. */
	isolated?: { shown: number; n: number } | null;
	onShowAll?(): void;
	onExpand?(): void;
	/** One cluster's export item (its points; the rows are built only when chosen), for the row's Export menu. */
	exportItemOf?(cluster: number): IExportItem;
	/** The collection, for the export's file name. */
	collection?: string | null;
}

/** A swatch of a group's colour. */
function swatch(colour: string): React.ReactElement {
	return <span aria-hidden="true" style={MAP_STYLES.swatch(colour, false)} />;
}

/**
 * Why "Ask about these" is off for some documents, or null.
 *
 * @param chat - The chat's availability.
 * @param documents - Documents of the cluster.
 * @param max - The cap.
 * @returns The sentence, or null.
 */
function askReason(chat: Availability | undefined, documents: number, max: number | undefined): string | null {
	if (chat && !chat.enabled) return chat.reason ?? 'The chat is not available.';
	if (max !== undefined && documents > max) return `Too many documents to ask about (${num(documents)}; at most ${num(max)}).`;
	return null;
}

/**
 * The Clusters tab.
 *
 * @param props - The sample, the folded view, the minimum size and the actions.
 * @returns The tab body.
 */
export function ClustersPanel(props: ClustersPanelProps): React.ReactElement {
	const sample = props.sample.result;
	const minSize: ClusterMinSize = props.minSize ?? 5;
	const view = props.view ?? null;
	const clusters = sample.clusters ?? null;
	if (clusters === null || view === null) {
		return (
			<section aria-label="Clusters" data-component="ClustersPanel" data-clusters="unsupported">
				<p style={MAP_STYLES.note}>{props.clustersOffered ? CLUSTERS_NOT_IN_SAMPLE : CLUSTERS_UNSUPPORTED}</p>
			</section>
		);
	}
	const { rows, noise } = clusterRows(sample, view, props.hidden ?? null);
	const isolated = props.isolated ?? null;
	return (
		<section aria-label="Clusters" data-component="ClustersPanel" data-clusters={rows.length}>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '0 0 6px' }}>
				<label style={MAP_STYLES.group}>
					<span style={MAP_STYLES.label}>Minimum size</span>
					<select aria-label="Minimum size" style={MAP_STYLES.select} value={String(minSize)} onChange={(event) => props.onMinSize?.(Number(event.target.value) as ClusterMinSize)}>
						{CLUSTER_MIN_SIZES.map((size) => (
							<option key={size} value={String(size)}>
								{size}
							</option>
						))}
					</select>
				</label>
				<span role="status" style={MAP_STYLES.small}>
					{num(rows.length)} {rows.length === 1 ? 'cluster' : 'clusters'}, {num(noise.size)} unassigned {noise.size === 1 ? 'point' : 'points'}
				</span>
			</div>
			<p style={MAP_STYLES.note}>{clusterSentence(clusters, minSize)}</p>
			{rows.length === 0 ? <p style={MAP_STYLES.note}>{clustersNone(minSize)}</p> : null}
			{rows.length > 0 ? (
				<ol aria-label="Clusters by size" style={MAP_STYLES.list}>
					{rows.map((row) => {
						const reason = askReason(props.chat, row.documents.length, props.maxDocuments);
						return (
							<li key={row.cluster} style={{ ...MAP_STYLES.row, display: 'block' }} data-cluster={row.cluster}>
								<div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
									{swatch(props.colours?.[row.cluster] ?? 'var(--rr-text-secondary)')}
									<button type="button" style={MAP_STYLES.linkButton} onClick={() => props.onSelect?.(row.indices)} title="Highlight these points on the map">
										{row.label}
									</button>
									<span style={MAP_STYLES.small}>
										{num(row.size)} {row.size === 1 ? 'point' : 'points'} · {num(row.documents.length)} {row.documents.length === 1 ? 'document' : 'documents'}
									</span>
								</div>
								<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 2px' }}>
									<button type="button" style={MAP_STYLES.button} onClick={() => props.onShow?.(row.cluster)} aria-label={`Show only cluster ${row.cluster + 1}: ${row.label}`}>
										Show
									</button>
									<button type="button" style={MAP_STYLES.button} disabled={reason !== null} title={reason ?? undefined} onClick={() => props.onAskAbout?.(row.documents)} aria-label={`Ask about the documents of cluster ${row.cluster + 1}`}>
										Ask about these
									</button>
									{props.exportItemOf ? <ExportMenu items={[props.exportItemOf(row.cluster)]} collection={props.collection ?? null} label="Export" /> : null}
								</div>
								{reason !== null && props.chat?.enabled !== false ? <p style={MAP_STYLES.note}>{reason}</p> : null}
							</li>
						);
					})}
					<li key="noise" style={{ ...MAP_STYLES.row, display: 'block' }} data-cluster="noise">
						<div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
							{swatch(props.noiseColour ?? 'var(--rr-text-secondary)')}
							<button type="button" style={MAP_STYLES.linkButton} disabled={noise.size === 0} onClick={() => props.onSelect?.(noise.indices)} title="Highlight these points on the map">
								Noise
							</button>
							<span style={MAP_STYLES.small}>
								{num(noise.size)} {noise.size === 1 ? 'point' : 'points'} in no group · {num(noise.documents.length)} {noise.documents.length === 1 ? 'document' : 'documents'}
							</span>
						</div>
					</li>
				</ol>
			) : null}
			{props.chat && !props.chat.enabled && props.chat.reason ? <p style={MAP_STYLES.note}>{props.chat.reason}</p> : null}
			{isolated ? (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 8 }}>
					<span role="status" style={MAP_STYLES.small}>
						{isolationLine(isolated.shown, isolated.n)}
					</span>
					<button type="button" style={MAP_STYLES.button} onClick={props.onExpand}>
						Expand by neighbours
					</button>
					<button type="button" style={MAP_STYLES.button} onClick={props.onShowAll}>
						Show all
					</button>
				</div>
			) : null}
		</section>
	);
}

export default ClustersPanel;
