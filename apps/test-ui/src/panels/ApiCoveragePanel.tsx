// MIT License
//
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
// ApiCoveragePanel — Table showing per-method stats
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { API_METHODS } from '../apiMethods';
import type { ApiTestResult, ApiMethodDef } from '../types';
import { styles } from '../styles';

// =============================================================================
// HELPERS
// =============================================================================

/** Compute a percentile from a sorted array. */
function percentile(sorted: number[], pct: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.floor(sorted.length * pct);
	return sorted[Math.min(idx, sorted.length - 1)];
}

/** Format ms for display. */
function fmtMs(ms: number): string {
	if (ms === 0) return '-';
	if (ms < 1) return '<1';
	if (ms < 1000) return String(Math.round(ms));
	return `${(ms / 1000).toFixed(1)}s`;
}

// =============================================================================
// STYLES
// =============================================================================

const t: Record<string, CSSProperties> = {
	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 11,
		fontFamily: 'var(--rr-font-mono, monospace)',
	},
	th: {
		textAlign: 'left',
		padding: '4px 8px',
		fontSize: 9,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.5px',
		color: 'var(--rr-text-disabled)',
		borderBottom: '1px solid var(--rr-border)',
		whiteSpace: 'nowrap',
	},
	thRight: {
		textAlign: 'right',
		padding: '4px 8px',
		fontSize: 9,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.5px',
		color: 'var(--rr-text-disabled)',
		borderBottom: '1px solid var(--rr-border)',
		whiteSpace: 'nowrap',
	},
	td: {
		padding: '3px 8px',
		borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 50%, transparent)',
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap',
	},
	tdRight: {
		padding: '3px 8px',
		borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 50%, transparent)',
		color: 'var(--rr-text-primary)',
		textAlign: 'right',
		whiteSpace: 'nowrap',
	},
	dot: {
		display: 'inline-block',
		width: 6,
		height: 6,
		borderRadius: '50%',
		marginRight: 6,
		verticalAlign: 'middle',
	},
	category: {
		padding: '6px 8px 3px',
		fontSize: 10,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.8px',
		color: 'var(--rr-brand)',
	},
	skipReason: {
		fontSize: 9,
		color: 'var(--rr-text-disabled)',
		fontStyle: 'italic',
		fontFamily: 'inherit',
	},
	error: {
		fontSize: 9,
		color: 'var(--rr-color-error)',
		maxWidth: 200,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

interface Props {
	results: ApiTestResult[];
}

const ApiCoveragePanel: React.FC<Props> = ({ results }) => {
	const resultMap = new Map<string, ApiTestResult>(results.map((r) => [r.method, r]));

	// Build unified method list: API_METHODS + any extra methods from monitor
	const seenMethods = new Set(API_METHODS.map((m) => m.method));
	const extraMethods: ApiMethodDef[] = [];
	for (const r of results) {
		if (!seenMethods.has(r.method)) {
			seenMethods.add(r.method);
			extraMethods.push({ method: r.method, category: r.category, mode: 'happy' });
		}
	}
	const allMethods = [...API_METHODS, ...extraMethods];

	const passed = results.filter((r) => r.status === 'passed').length;
	const failed = results.filter((r) => r.status === 'failed').length;
	const skipped = results.filter((r) => r.status === 'skipped').length;
	const totalMethods = allMethods.length;

	// Group methods by category
	const categories = new Map<string, ApiMethodDef[]>();
	for (const m of allMethods) {
		if (!categories.has(m.category)) categories.set(m.category, []);
		categories.get(m.category)!.push(m);
	}

	return (
		<div style={{ ...styles.card, ...styles.cardFullWidth }}>
			<div style={styles.cardHeader}>
				<span>API Coverage — {totalMethods} methods</span>
				<div style={{ display: 'flex', gap: 12, fontSize: 10 }}>
					<span style={{ color: 'var(--rr-color-success)' }}>passed ({passed})</span>
					<span style={{ color: 'var(--rr-color-error)' }}>failed ({failed})</span>
					{skipped > 0 && <span style={{ color: 'var(--rr-text-disabled)' }}>skipped ({skipped})</span>}
				</div>
			</div>
			<div style={{ ...styles.cardBody, padding: 0, overflowX: 'auto' }}>
				<table style={t.table}>
					<thead>
						<tr>
							<th style={t.th}>Method</th>
							<th style={t.thRight}>Completed</th>
							<th style={t.thRight}>Errors</th>
							<th style={t.thRight}>p50</th>
							<th style={t.thRight}>p95</th>
							<th style={t.thRight}>Max</th>
							<th style={t.th}>Notes</th>
						</tr>
					</thead>
					<tbody>
						{Array.from(categories.entries()).map(([category, methods]) => (
							<React.Fragment key={category}>
								<tr>
									<td colSpan={7} style={t.category}>
										{category}
									</td>
								</tr>
								{methods.map((m) => {
									const r = resultMap.get(m.method);
									const sorted = r ? [...r.latencies].sort((a, b) => a - b) : [];
									const p50 = percentile(sorted, 0.5);
									const p95 = percentile(sorted, 0.95);
									const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;

									// Status dot color
									const dotColor = !r || r.status === 'pending' ? 'var(--rr-text-disabled)' : r.status === 'passed' ? 'var(--rr-color-success)' : r.status === 'failed' ? 'var(--rr-color-error)' : r.status === 'running' ? 'var(--rr-color-warning)' : 'var(--rr-text-disabled)';

									// "never called" = no monitor data and no sweep data
									const hasCalls = r && r.issued > 0;
									const neverCalled = !hasCalls;

									return (
										<tr key={m.method} style={{ opacity: neverCalled ? 0.5 : 1 }}>
											{/* Method name with status dot */}
											<td style={t.td}>
												<span style={{ ...t.dot, backgroundColor: dotColor }} />
												{m.method}
												{m.mode === 'negative' && <span style={{ fontSize: 8, color: 'var(--rr-color-warning)', marginLeft: 4 }}>NEG</span>}
											</td>

											{/* Completed / Issued */}
											<td style={t.tdRight}>{hasCalls ? `${r.completed}/${r.issued}` : '-'}</td>

											{/* Errors */}
											<td
												style={{
													...t.tdRight,
													color: r && r.errors > 0 ? 'var(--rr-color-error)' : undefined,
												}}
											>
												{hasCalls ? r.errors : '-'}
											</td>

											{/* p50 */}
											<td style={t.tdRight}>{hasCalls ? fmtMs(p50) : '-'}</td>

											{/* p95 */}
											<td style={t.tdRight}>{hasCalls ? fmtMs(p95) : '-'}</td>

											{/* Max */}
											<td
												style={{
													...t.tdRight,
													color: max > 1000 ? 'var(--rr-color-error)' : max > 200 ? 'var(--rr-color-warning)' : undefined,
												}}
											>
												{hasCalls ? fmtMs(max) : '-'}
											</td>

											{/* Notes: skip reason (only when never called) or last error */}
											<td style={t.td}>
												{neverCalled && (r?.skipReason || m.skipReason) && (
													<span style={t.skipReason} title={r?.skipReason || m.skipReason}>
														{r?.skipReason || m.skipReason}
													</span>
												)}
												{hasCalls && r?.lastError && (
													<span style={t.error} title={r.lastError}>
														{r.lastError}
													</span>
												)}
											</td>
										</tr>
									);
								})}
							</React.Fragment>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
};

export default ApiCoveragePanel;
