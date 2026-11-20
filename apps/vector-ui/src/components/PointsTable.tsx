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
// VECTOR-UI — PointsTable (the accessible alternative to the canvas)
// =============================================================================
//
// Every point the map shows as a table row, 100 rows a page: document, chunk,
// length, density, similarity to the active query, its cluster when the map
// has clusters, and flags (duplicate with its group number, outlier, pinned).
// Rows can be sorted by query similarity when there is a query. Hidden points
// (a removed document, outside an isolation) are left out, as on the map.
// Choosing a row selects the point, exactly like a click on the map.
// =============================================================================

import React, { useMemo, useState } from 'react';
import type { PointsTableProps as ContractPointsTableProps } from '../contract/types';
import { clusterLabel, clusterOf } from '../map/clusters';
import type { IClusterView } from '../map/clusters';
import { hiddenMask } from '../map/model';
import { MAP_STYLES } from '../map/styles';
import { num } from '../map/wording';

/** Props: the frozen ones plus the page size. */
export interface PointsTableProps extends ContractPointsTableProps {
	/** Rows per page (default 100). */
	pageSize?: number;
	/** The points not shown (removed documents and an isolation); absent: the removed documents only. */
	hidden?: ArrayLike<number> | null;
	/** The folded clusters: adds the Cluster column. */
	clusters?: IClusterView | null;
	/** Each point's near-duplicate group (-1: none), for the Notes column. */
	duplicateGroups?: ArrayLike<number> | null;
}

/**
 * The points table.
 *
 * @param props - Sample, query similarities, selection, select handler.
 * @returns The table with paging.
 */
export function PointsTable(props: PointsTableProps): React.ReactElement {
	const result = props.sample.result;
	const pageSize = props.pageSize ?? 100;
	const [page, setPage] = useState(0);
	const [byQuery, setByQuery] = useState(false);
	const flags = useMemo(() => {
		const dup = new Set<number>();
		for (const d of result.duplicates) {
			dup.add(d.a);
			dup.add(d.b);
		}
		return { dup, outliers: new Set(result.outliers) };
	}, [result]);
	const order = useMemo(() => {
		const hidden = props.hidden !== undefined ? props.hidden : hiddenMask(props.sample);
		const rows = Array.from({ length: result.n }, (_, i) => i).filter((i) => !(hidden && hidden[i]));
		if (byQuery && props.querySims) {
			const sims = props.querySims;
			rows.sort((a, b) => (sims[b] as number) - (sims[a] as number) || a - b);
		}
		return rows;
	}, [result, props.sample, props.hidden, byQuery, props.querySims]);
	const clusters = props.clusters ?? null;
	const dupGroups = props.duplicateGroups ?? null;
	const pages = Math.max(1, Math.ceil(order.length / pageSize));
	const current = Math.min(page, pages - 1);
	const rows = order.slice(current * pageSize, current * pageSize + pageSize);
	const first = order.length === 0 ? 0 : current * pageSize + 1;
	const last = current * pageSize + rows.length;
	return (
		<div>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 }}>
				<span style={MAP_STYLES.small}>
					Rows {num(first)}–{num(last)} of {num(order.length)}
				</span>
				<button type="button" style={MAP_STYLES.button} disabled={current === 0} onClick={() => setPage(current - 1)}>
					Previous
				</button>
				<button type="button" style={MAP_STYLES.button} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
					Next
				</button>
				{props.querySims ? (
					<button type="button" style={{ ...MAP_STYLES.button, ...(byQuery ? MAP_STYLES.buttonPressed : {}) }} aria-pressed={byQuery} onClick={() => setByQuery(!byQuery)}>
						Sort by query similarity
					</button>
				) : null}
			</div>
			<table style={MAP_STYLES.table}>
				<caption style={{ ...MAP_STYLES.small, textAlign: 'left', marginBottom: 4 }}>Points of the sample (the map as a table)</caption>
				<thead>
					<tr>
						<th scope="col" style={MAP_STYLES.th}>
							#
						</th>
						<th scope="col" style={MAP_STYLES.th}>
							Document
						</th>
						<th scope="col" style={MAP_STYLES.th}>
							Chunk
						</th>
						<th scope="col" style={MAP_STYLES.th}>
							Length
						</th>
						<th scope="col" style={MAP_STYLES.th}>
							Density
						</th>
						{props.querySims ? (
							<th scope="col" style={MAP_STYLES.th}>
								Query similarity
							</th>
						) : null}
						{clusters ? (
							<th scope="col" style={MAP_STYLES.th}>
								Cluster
							</th>
						) : null}
						<th scope="col" style={MAP_STYLES.th}>
							Notes
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((i) => {
						const doc = result.docs[result.points.doc[i] as number];
						const group = dupGroups ? (dupGroups[i] ?? -1) : -1;
						const duplicate = group >= 0 ? `duplicate group ${group + 1}` : flags.dup.has(i) ? 'duplicate' : '';
						const notes = [duplicate, flags.outliers.has(i) ? 'outlier' : '', result.points.pinned[i] ? 'pinned' : ''].filter(Boolean).join(', ');
						const cluster = clusters ? clusterOf(clusters, i) : -1;
						const selected = props.selected === i;
						return (
							<tr key={i} aria-selected={selected} style={selected ? { outline: '2px solid var(--rr-border-focus)' } : undefined}>
								<td style={MAP_STYLES.td}>
									<button type="button" style={MAP_STYLES.linkButton} onClick={() => props.onSelect(i)} aria-label={`Inspect point ${i + 1}`}>
										{num(i + 1)}
									</button>
								</td>
								<td style={MAP_STYLES.td}>{doc?.path ?? '?'}</td>
								<td style={MAP_STYLES.td}>{num(result.points.chunk[i] ?? 0)}</td>
								<td style={MAP_STYLES.td}>{num(result.points.len[i] ?? 0)}</td>
								<td style={MAP_STYLES.td}>{(result.density[i] ?? 0).toFixed(3)}</td>
								{props.querySims ? <td style={MAP_STYLES.td}>{(props.querySims[i] ?? 0).toFixed(3)}</td> : null}
								{clusters ? <td style={MAP_STYLES.td}>{cluster >= 0 ? `${cluster + 1}: ${clusterLabel(clusters, cluster)}` : 'none'}</td> : null}
								<td style={MAP_STYLES.td}>{notes}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

export default PointsTable;
