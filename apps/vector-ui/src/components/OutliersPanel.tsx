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
// VECTOR-UI — OutliersPanel (the map's outlier review)
// =============================================================================
//
// The sample's sparsest points: OCR noise, a stray table, a document unlike
// everything else. A percentile select (1 %, 2 %, 5 %) picks them in the
// browser from the sample's density, so changing it sends nothing; 1 % is
// the node's own list. Each row says why (density against the sample's
// median, nearest neighbour in the sample) and offers Show neighbours, Mark
// reviewed and Move to trash (the console confirms; without writes the
// button is disabled with the reason as text). A reviewed outlier is its
// chunk, kept in the registry's reviewed cache under the connection's
// outliers scope, apart from the documents the duplicates queue marks.
// =============================================================================

import React, { useCallback, useMemo, useState } from 'react';
import type { Availability, OutliersPanelProps as ContractOutliersPanelProps } from '../contract/types';
import { reviewedDocuments } from '../adapters/connections';
import { markReviewed, reviewedOf, unmarkReviewed } from '../map/dedupe';
import type { ReviewedCache } from '../map/dedupe';
import { OUTLIER_PERCENTILES, outlierKey, outlierRows, outliersScope } from '../map/outliers';
import type { IOutlierRow, OutlierPercentile } from '../map/outliers';
import { OUTLIERS_NONE, OUTLIERS_NOTE, outliersStatus } from '../map/reviewWording';
import { MAP_STYLES } from '../map/styles';

/** Props: the frozen ones, plus the starting percentile and the reviewed cache. */
export interface OutliersPanelProps extends ContractOutliersPanelProps {
	/** The starting percentile (a host restoring it; the tests). */
	initial?: { percentile?: OutlierPercentile };
	/** The reviewed cache (default: the registry's; outliers live under outliersScope(connectionKey)). */
	reviewedCache?: ReviewedCache;
}

/** What the review's body is drawn from. */
export interface OutliersBodyProps {
	rows: readonly IOutlierRow[];
	percentile: OutlierPercentile;
	/** Writes on this connection; absent: closed. */
	writes?: Availability;
	/** The host gave a remove handler. */
	canRemove: boolean;
	/** The host gave a Show neighbours handler. */
	canShowNeighbours: boolean;
	onPercentile(pct: OutlierPercentile): void;
	onSelect(index: number): void;
	/** Mark or unmark one outlier (its outlierKey). */
	onReview(key: string, reviewed: boolean): void;
	onRemove(objectId: string): void;
	onShowNeighbours(index: number): void;
}

/**
 * The review's body: a plain function of its rows (no hooks), so the tests
 * can call it and press its buttons.
 *
 * @param props - The rows and the handlers.
 * @returns The body.
 */
export function OutliersBody(props: OutliersBodyProps): React.ReactElement {
	const writes = props.writes ?? { enabled: false, reason: null };
	const reviewedCount = props.rows.filter((r) => r.reviewed).length;
	return (
		<section aria-label="Outlier review" data-component="OutliersPanel" data-percentile={props.percentile} data-rows={props.rows.length}>
			<p style={MAP_STYLES.note}>{OUTLIERS_NOTE}</p>
			<label style={{ ...MAP_STYLES.label, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
				<span>Lowest density</span>
				<select style={MAP_STYLES.select} value={String(props.percentile)} aria-label="Which share of the sample to review, by lowest density" onChange={(event) => props.onPercentile(Number(event.currentTarget.value) as OutlierPercentile)}>
					{OUTLIER_PERCENTILES.map((pct) => (
						<option key={pct} value={String(pct)}>
							{pct} %
						</option>
					))}
				</select>
			</label>
			<p style={MAP_STYLES.note} role="status">
				{outliersStatus(props.rows.length, props.percentile, reviewedCount)}
			</p>
			{props.canRemove && !writes.enabled && writes.reason ? <p style={MAP_STYLES.note}>{writes.reason}</p> : null}
			<ul aria-label="Outliers" style={MAP_STYLES.list}>
				{props.rows.map((row) => (
					<li key={row.index} style={{ ...MAP_STYLES.row, opacity: row.reviewed ? 0.8 : 1 }} data-point={row.index}>
						<button type="button" style={MAP_STYLES.linkButton} onClick={() => props.onSelect(row.index)}>
							{row.path} #{row.chunk}
						</button>
						{row.reviewed ? <span style={MAP_STYLES.tag}>reviewed</span> : null}
						<div style={MAP_STYLES.small}>{row.why}</div>
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
							{props.canShowNeighbours ? (
								<button type="button" style={MAP_STYLES.button} onClick={() => props.onShowNeighbours(row.index)}>
									Show neighbours
								</button>
							) : null}
							<button type="button" style={MAP_STYLES.button} onClick={() => props.onReview(outlierKey(row), !row.reviewed)}>
								{row.reviewed ? 'Review again' : 'Mark reviewed'}
							</button>
							{props.canRemove ? (
								<button type="button" style={MAP_STYLES.button} disabled={!writes.enabled} title={writes.enabled ? undefined : (writes.reason ?? undefined)} onClick={() => props.onRemove(row.objectId)}>
									Move to trash
								</button>
							) : null}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

/**
 * The outlier review.
 *
 * @param props - Sample, handlers, writes, the connection.
 * @returns The panel.
 */
export function OutliersPanel(props: OutliersPanelProps): React.ReactElement {
	const [percentile, setPercentile] = useState<OutlierPercentile>(props.initial?.percentile ?? 1);
	const cache = props.reviewedCache ?? reviewedDocuments;
	const [local, setLocal] = useState<ReadonlySet<string>>(() => new Set());
	const [tick, setTick] = useState(0);
	const scope = props.connectionKey ? outliersScope(props.connectionKey) : null;
	const reviewed = scope !== null ? reviewedOf(cache, scope) : local;
	const result = props.sample.result;
	const removed = props.sample.removed;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const rows = useMemo(() => outlierRows(result, percentile, removed, reviewed), [result, percentile, removed, reviewed, tick]);

	const onReview = useCallback(
		(key: string, value: boolean): void => {
			if (scope !== null) {
				if (value) markReviewed(cache, scope, [key]);
				else unmarkReviewed(cache, scope, [key]);
				setTick((t) => t + 1);
				return;
			}
			setLocal((prev) => {
				const next = new Set(prev);
				if (value) next.add(key);
				else next.delete(key);
				return next;
			});
		},
		[cache, scope]
	);

	if (result.outliers.length === 0) return <p style={MAP_STYLES.note}>{OUTLIERS_NONE}</p>;
	return <OutliersBody rows={rows} percentile={percentile} writes={props.writes} canRemove={props.onRemoveDocument !== undefined} canShowNeighbours={props.onShowNeighbours !== undefined} onPercentile={setPercentile} onSelect={(index) => props.onSelect(index)} onReview={onReview} onRemove={(objectId) => props.onRemoveDocument?.(objectId)} onShowNeighbours={(index) => props.onShowNeighbours?.(index)} />;
}

export default OutliersPanel;
