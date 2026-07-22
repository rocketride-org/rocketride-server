// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AnalyzePane — efficiency analysis over a source's run-log events.
 *
 * Computes timing facts client-side from the visible event window (the
 * run-log makes this possible: every event carries a server-stamped
 * eventTime, so durations are emission-accurate, not network-arrival
 * approximations):
 *
 * - Per-component latency: enter/leave deltas aggregated by component
 *   (count, total, mean, max).
 * - Per-document processing time: begin -> end deltas per document.
 * - Idle gaps: spans inside the window where no run was executing.
 *
 * The natural home of the earlier trace-analyze concept, now standing on a
 * real data substrate.
 */

import React, { CSSProperties, useMemo } from 'react';
import { EmptyState } from '../../../components/empty-state/EmptyState';
import type { TaskEventMessage } from '../hooks/useTaskEvents';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link AnalyzePane}. */
export interface IAnalyzePaneProps {
	/** The visible event window (from useTaskEvents). */
	events: TaskEventMessage[];
}

/** Aggregated timing for one pipeline component. */
interface ComponentStat {
	component: string;
	count: number;
	totalSeconds: number;
	maxSeconds: number;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		gap: 14,
	},
	sectionTitle: {
		fontSize: 12,
		fontWeight: 700,
		letterSpacing: '0.06em',
		textTransform: 'uppercase',
		color: 'var(--rr-text-secondary)',
		borderBottom: '1px solid var(--rr-border)',
		paddingBottom: 5,
	},
	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 12.5,
	},
	th: {
		textAlign: 'left',
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: '0.05em',
		textTransform: 'uppercase',
		color: 'var(--rr-text-secondary)',
		padding: '6px 10px',
		borderBottom: '1px solid var(--rr-border)',
	},
	td: {
		padding: '7px 10px',
		borderBottom: '1px solid var(--rr-bg-widget)',
	},
	tdNum: {
		padding: '7px 10px',
		borderBottom: '1px solid var(--rr-bg-widget)',
		textAlign: 'right',
		fontFamily: 'Consolas, "Courier New", monospace',
		fontSize: 12,
	},
	empty: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
	},
};

// =============================================================================
// HELPERS
// =============================================================================

/** Format seconds compactly (ms under 1s, 1 decimal above). */
function formatSeconds(value: number): string {
	if (value < 1) return `${Math.round(value * 1000)} ms`;
	return `${value.toFixed(1)} s`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Efficiency view over the visible window: component latency, document
 * durations, and idle gaps — all from server-stamped emission times.
 */
export const AnalyzePane: React.FC<IAnalyzePaneProps> = ({ events }) => {
	// --- Compute the three fact tables in one pass over the window ----------
	const { componentStats, documentDurations, idleGaps } = useMemo(() => {
		// Open enter frames by component, matched by identity (reentrancy-safe
		// the same way the trace fold matches leaves).
		const openEnters = new Map<string, number[]>();
		const perComponent = new Map<string, ComponentStat>();
		// Open documents by pipeline slot id.
		const openDocs = new Map<number, number>();
		const docDurations: number[] = [];
		// Run activity intervals (chapter begin/end) for idle-gap detection.
		const activity: Array<{ begin: number; end: number }> = [];
		let runBegin: number | null = null;

		for (const message of events) {
			const body = (message.body ?? {}) as Record<string, any>;

			if (message.event === 'apaevt_flow') {
				const op = String(body.op ?? '');
				const component = String(body.component ?? body.pipes?.[body.pipes.length - 1] ?? '');
				const slot = Number(body.id ?? 0);
				if (op === 'enter' && component) {
					const stack = openEnters.get(component) ?? [];
					stack.push(message.eventTime);
					openEnters.set(component, stack);
				} else if (op === 'leave' && component) {
					const stack = openEnters.get(component);
					const started = stack?.pop();
					if (started !== undefined) {
						const delta = Math.max(0, message.eventTime - started);
						const stat = perComponent.get(component) ?? {
							component,
							count: 0,
							totalSeconds: 0,
							maxSeconds: 0,
						};
						stat.count += 1;
						stat.totalSeconds += delta;
						stat.maxSeconds = Math.max(stat.maxSeconds, delta);
						perComponent.set(component, stat);
					}
				} else if (op === 'begin') {
					openDocs.set(slot, message.eventTime);
				} else if (op === 'end') {
					const started = openDocs.get(slot);
					if (started !== undefined) {
						docDurations.push(Math.max(0, message.eventTime - started));
						openDocs.delete(slot);
					}
				}
			} else if (message.event === 'apaevt_log_lifecycle') {
				const action = String(body.action ?? '');
				if (action === 'run-begin') runBegin = message.eventTime;
				if (action === 'run-end' && runBegin !== null) {
					activity.push({ begin: runBegin, end: message.eventTime });
					runBegin = null;
				}
			}
		}

		// Idle gaps: spans between consecutive activity intervals.
		const gaps: Array<{ from: number; to: number }> = [];
		for (let i = 1; i < activity.length; i++) {
			const gap = activity[i].begin - activity[i - 1].end;
			if (gap > 1) gaps.push({ from: activity[i - 1].end, to: activity[i].begin });
		}

		const stats = [...perComponent.values()].sort((a, b) => b.totalSeconds - a.totalSeconds);
		return { componentStats: stats, documentDurations: docDurations, idleGaps: gaps };
	}, [events]);

	// --- Document summary ----------------------------------------------------
	const docSummary = useMemo(() => {
		if (documentDurations.length === 0) return null;
		const total = documentDurations.reduce((sum, value) => sum + value, 0);
		return {
			count: documentDurations.length,
			mean: total / documentDurations.length,
			max: Math.max(...documentDurations),
		};
	}, [documentDurations]);

	if (events.length === 0) {
		return <EmptyState title="No events to analyze" description="Efficiency metrics appear here while the pipeline runs, when replaying a recorded run, or for a slice brushed on the play bar." />;
	}

	return (
		<div style={styles.container}>
			{/* Per-component latency */}
			<div>
				<div style={styles.sectionTitle}>Component latency (window)</div>
				{componentStats.length === 0 ? (
					<div style={styles.empty}>No completed component spans in this window.</div>
				) : (
					<table style={styles.table}>
						<thead>
							<tr>
								<th style={styles.th}>Component</th>
								<th style={{ ...styles.th, textAlign: 'right' }}>Calls</th>
								<th style={{ ...styles.th, textAlign: 'right' }}>Total</th>
								<th style={{ ...styles.th, textAlign: 'right' }}>Mean</th>
								<th style={{ ...styles.th, textAlign: 'right' }}>Max</th>
							</tr>
						</thead>
						<tbody>
							{componentStats.map((stat) => (
								<tr key={stat.component}>
									<td style={styles.td}>{stat.component}</td>
									<td style={styles.tdNum}>{stat.count}</td>
									<td style={styles.tdNum}>{formatSeconds(stat.totalSeconds)}</td>
									<td style={styles.tdNum}>{formatSeconds(stat.totalSeconds / stat.count)}</td>
									<td style={styles.tdNum}>{formatSeconds(stat.maxSeconds)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			{/* Documents */}
			<div>
				<div style={styles.sectionTitle}>Documents (window)</div>
				{docSummary === null ? (
					<div style={styles.empty}>No completed documents in this window.</div>
				) : (
					<table style={styles.table}>
						<tbody>
							<tr>
								<td style={styles.td}>Processed</td>
								<td style={styles.tdNum}>{docSummary.count}</td>
							</tr>
							<tr>
								<td style={styles.td}>Mean duration</td>
								<td style={styles.tdNum}>{formatSeconds(docSummary.mean)}</td>
							</tr>
							<tr>
								<td style={styles.td}>Max duration</td>
								<td style={styles.tdNum}>{formatSeconds(docSummary.max)}</td>
							</tr>
						</tbody>
					</table>
				)}
			</div>

			{/* Idle gaps */}
			<div>
				<div style={styles.sectionTitle}>Idle gaps between runs (window)</div>
				{idleGaps.length === 0 ? (
					<div style={styles.empty}>No idle gaps between runs in this window.</div>
				) : (
					<table style={styles.table}>
						<tbody>
							{idleGaps.map((gap) => (
								<tr key={gap.from}>
									<td style={styles.td}>
										{new Date(gap.from * 1000).toLocaleTimeString()} →{' '}
										{new Date(gap.to * 1000).toLocaleTimeString()}
									</td>
									<td style={styles.tdNum}>{formatSeconds(gap.to - gap.from)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
};
