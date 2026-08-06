// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * OverviewPanel — the Monitor Overview page: hero stat strip, live activity
 * ticker, the unified Connections & Tasks grid, recent activity feed, and
 * resource summary.
 *
 * The table is the shared {@link OverviewGrid} (CardDataGrid with record
 * panels and persisted layout); the surrounding chrome — stat tiles, ticker,
 * feed, and resources card — stays here. Data arrives entirely by props
 * (data-in, callbacks-out): the host owns polling and event subscription.
 */

import React, { CSSProperties } from 'react';
import type { DashboardResponse, DashboardTask, ActivityEvent, DashboardEvent } from '../types';
import { OverviewGrid } from './OverviewGrid';
import { getEventDisplay } from './ActivityPanel';
import type { EventTone } from './ActivityPanel';
import { formatUptime, formatTime, formatNumber } from '../util';
import { commonStyles } from 'shell/src/themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	// ── Hero stat strip ─────────────────────────────────────────────────────
	heroStrip: {
		...commonStyles.card,
		display: 'flex',
		borderRadius: 12,
		marginBottom: 16,
	} as CSSProperties,
	heroCell: {
		flex: 1,
		padding: '18px 22px',
		position: 'relative',
	} as CSSProperties,
	heroCellBorder: {
		borderLeft: '1px solid color-mix(in srgb, var(--rr-border) 40%, transparent)',
	} as CSSProperties,
	heroLabel: {
		...commonStyles.labelUppercase,
		fontSize: 10,
		letterSpacing: '1.2px',
		color: 'var(--rr-text-disabled)',
		marginBottom: 6,
	} as CSSProperties,
	heroValue: {
		fontSize: 28,
		fontWeight: 700,
		fontVariantNumeric: 'tabular-nums',
		lineHeight: 1.1,
	} as CSSProperties,
	heroSub: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		marginTop: 4,
	} as CSSProperties,

	// ── Live activity ticker ────────────────────────────────────────────────
	ticker: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '8px 16px',
		marginBottom: 16,
		borderRadius: 8,
		background: 'color-mix(in srgb, var(--rr-brand) 6%, transparent)',
		border: '1px solid color-mix(in srgb, var(--rr-brand) 15%, transparent)',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		overflow: 'hidden',
	} as CSSProperties,
	tickerDot: {
		width: 7,
		height: 7,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-color-success)',
		flexShrink: 0,
		animation: 'rr-pulse 2s infinite',
	} as CSSProperties,
	tickerItems: {
		display: 'flex',
		gap: 20,
		overflow: 'hidden',
		flex: 1,
	} as CSSProperties,
	tickerItem: {
		whiteSpace: 'nowrap',
		color: 'var(--rr-text-muted)',
	} as CSSProperties,
	tickerHighlight: {
		color: 'var(--rr-text-primary)',
		fontWeight: 500,
	} as CSSProperties,
	tickerTime: {
		marginLeft: 'auto',
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		...commonStyles.fontMono,
		fontVariantNumeric: 'tabular-nums',
		flexShrink: 0,
	} as CSSProperties,

	// ── Bottom grid ─────────────────────────────────────────────────────────
	bottomGrid: {
		display: 'grid',
		gridTemplateColumns: '1fr 340px',
		gap: 16,
		marginTop: 16,
	} as CSSProperties,

	// ── Activity feed (mini) ────────────────────────────────────────────────
	feedItem: {
		display: 'grid',
		gridTemplateColumns: '60px 70px 1fr',
		gap: 10,
		alignItems: 'center',
		padding: '8px 16px',
		fontSize: 12,
		borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)',
	} as CSSProperties,
	feedTime: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		...commonStyles.fontMono,
		fontVariantNumeric: 'tabular-nums',
	} as CSSProperties,
	feedType: {
		...commonStyles.labelUppercase,
		fontSize: 10,
	} as CSSProperties,
	feedMsg: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// ── Resource summary ────────────────────────────────────────────────────
	resourceSummary: {
		padding: 16,
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	} as CSSProperties,
	resHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		marginBottom: 6,
	} as CSSProperties,
	resLabel: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	resValue: {
		fontSize: 13,
		fontWeight: 600,
		fontVariantNumeric: 'tabular-nums',
	} as CSSProperties,
	resBarTrack: {
		height: 8,
		background: 'color-mix(in srgb, var(--rr-border) 30%, transparent)',
		borderRadius: 4,
		overflow: 'hidden',
	} as CSSProperties,
	/**
	 * Resource bar fill in the given color.
	 *
	 * @param color - CSS color of the fill.
	 */
	resBarFill: (color: string): CSSProperties => ({
		height: '100%',
		borderRadius: 4,
		background: color,
		transition: 'width 0.4s ease',
	}),
	resDivider: {
		marginTop: 'auto',
		paddingTop: 16,
		borderTop: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)',
	} as CSSProperties,
};

/** Feed label color per event tone (Recent Activity card). */
const feedColors: Record<EventTone, CSSProperties> = {
	connection: { color: 'var(--rr-color-success)' },
	task: { color: 'var(--rr-border-focus)' },
	warning: { color: 'var(--rr-color-warning)' },
	system: { color: 'var(--rr-text-disabled)' },
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Sum the live resource metrics across running tasks (completed tasks are
 * excluded; their metrics are stale).
 *
 * @param tasks - All dashboard tasks.
 * @returns Aggregate CPU percent, CPU/GPU memory MB, and completion count.
 */
function aggregateMetrics(tasks: DashboardTask[]) {
	let totalCpu = 0;
	let totalMem = 0;
	let totalGpu = 0;
	let totalCompletions = 0;

	// Walk running tasks only; each contributes its current metric snapshot.
	for (const t of tasks) {
		if (t.completed) continue;
		const m = t.metrics as Record<string, number> | null;
		if (m) {
			totalCpu += m.cpu_percent ?? 0;
			totalMem += m.cpu_memory_mb ?? 0;
			totalGpu += m.gpu_memory_mb ?? 0;
		}
		totalCompletions += t.completedCount ?? 0;
	}

	return { totalCpu, totalMem, totalGpu, totalCompletions };
}

/**
 * Short ticker summary of an event (just the key info, no prefix).
 *
 * @param event - The wrapped activity event.
 * @returns Highlighted subject plus the trailing verb phrase.
 */
function getTickerSummary(event: ActivityEvent): { highlight: string; rest: string } {
	if (event.source === 'task') {
		const body = event.body;
		switch (body.action) {
			case 'begin':
				return { highlight: body.name ?? 'task', rest: 'started' };
			case 'end':
				return { highlight: body.name ?? 'task', rest: 'completed' };
			case 'restart':
				return { highlight: body.name ?? 'task', rest: 'restarted' };
			case 'running':
				return { highlight: `${body.tasks.length} task(s)`, rest: 'running' };
		}
		// An action outside the known lifecycle set (a newer server) must
		// never fall through to the dashboard-event shape below.
		const unknown = body as { action?: string; name?: string };
		return { highlight: unknown.name ?? 'task', rest: unknown.action ?? 'event' };
	}
	const body = event.body as DashboardEvent;
	switch (body.action) {
		case 'connection_added':
			return { highlight: body.clientName ?? `#${body.connectionId}`, rest: 'connected' };
		case 'connection_removed':
			return { highlight: body.clientName ?? `#${body.connectionId}`, rest: 'disconnected' };
		case 'task_error':
			return { highlight: body.taskId ?? 'task', rest: `failed (exit ${body.exitCode})` };
		default:
			return { highlight: body.action?.replace(/_/g, ' ') ?? 'event', rest: '' };
	}
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for the {@link OverviewPanel} component. */
export interface IOverviewPanelProps {
	/** Full dashboard snapshot (the hosting view gates on it being loaded). */
	data: DashboardResponse;
	/** Activity events pushed from the server (newest first). */
	events: ActivityEvent[];
	/** Callback to request a manual data refresh from the host. */
	onRefresh?: () => void;
}

/**
 * The Overview page body: stat tiles, ticker, the shared unified grid, and
 * the activity / resources cards.
 *
 * @param props - {@link IOverviewPanelProps}.
 * @returns The overview page content.
 */
export const OverviewPanel: React.FC<IOverviewPanelProps> = ({ data, events, onRefresh }) => {
	// Snapshot-derived slices (small arrays; recomputed per poll).
	const { overview, connections, tasks } = data;
	const runningTasks = tasks.filter((t) => !t.completed);
	const completedTasks = tasks.filter((t) => t.completed);
	const agg = aggregateMetrics(tasks);
	const recentEvents = events.slice(0, 5);
	const tickerEvents = events.slice(0, 4);

	return (
		<div>
			{/* Pulse animation keyframe for the ticker dot. */}
			<style>{`@keyframes rr-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>

			{/* ── Hero Stat Strip ─────────────────────────────────────── */}
			<div style={S.heroStrip}>
				<div style={S.heroCell}>
					<div style={S.heroLabel}>Connections</div>
					<div style={{ ...S.heroValue, color: 'var(--rr-color-success)' }}>{overview.totalConnections}</div>
					<div style={S.heroSub}>{connections.length} active</div>
				</div>
				<div style={{ ...S.heroCell, ...S.heroCellBorder }}>
					<div style={S.heroLabel}>Tasks</div>
					<div style={{ ...S.heroValue, color: 'var(--rr-border-focus)' }}>{overview.activeTasks}</div>
					<div style={S.heroSub}>
						{runningTasks.length} running{completedTasks.length > 0 ? ` · ${completedTasks.length} completed` : ''}
					</div>
				</div>
				<div style={{ ...S.heroCell, ...S.heroCellBorder }}>
					<div style={S.heroLabel}>Uptime</div>
					<div style={{ ...S.heroValue, color: 'var(--rr-color-info)' }}>{formatUptime(overview.serverUptime)}</div>
					<div style={S.heroSub}>since {formatTime(Date.now() / 1000 - overview.serverUptime)}</div>
				</div>
				<div style={{ ...S.heroCell, ...S.heroCellBorder }}>
					<div style={S.heroLabel}>Completions</div>
					<div style={{ ...S.heroValue, color: 'var(--rr-accent)' }}>{formatNumber(agg.totalCompletions)}</div>
					{runningTasks.length > 0 && (
						<div style={S.heroSub}>
							across {runningTasks.length} task{runningTasks.length > 1 ? 's' : ''}
						</div>
					)}
				</div>
			</div>

			{/* ── Live Activity Ticker ────────────────────────────────── */}
			{tickerEvents.length > 0 && (
				<div style={S.ticker}>
					<div style={S.tickerDot} />
					<div style={S.tickerItems}>
						{tickerEvents.map((evt, i) => {
							const { highlight, rest } = getTickerSummary(evt);
							return (
								<div key={i} style={S.tickerItem}>
									<span style={S.tickerHighlight}>{highlight}</span> {rest}
								</div>
							);
						})}
					</div>
					<div style={S.tickerTime}>{formatTime(Date.now() / 1000)}</div>
				</div>
			)}

			{/* ── Unified Connections & Tasks grid (shared, with record panels) ── */}
			<OverviewGrid data={data} onRefresh={onRefresh} />

			{/* ── Bottom Grid: Activity + Resources ──────────────────── */}
			<div style={S.bottomGrid}>
				{/* Recent activity feed */}
				<div style={commonStyles.card}>
					<div style={commonStyles.cardHeader}>
						<span>Recent Activity</span>
						<span style={commonStyles.textMuted}>{events.length} events</span>
					</div>
					<div>
						{recentEvents.map((event, i) => {
							const { tone, label, message, timestamp } = getEventDisplay(event);
							return (
								<div key={i} style={S.feedItem}>
									{/* formatTime takes Unix seconds; timestamps arrive as epoch ms. */}
									<div style={S.feedTime}>{formatTime(timestamp / 1000)}</div>
									<div style={{ ...S.feedType, ...feedColors[tone] }}>{label}</div>
									<div style={S.feedMsg}>{message}</div>
								</div>
							);
						})}
						{recentEvents.length === 0 && <div style={commonStyles.empty}>No activity yet</div>}
					</div>
				</div>

				{/* Resource summary */}
				<div style={commonStyles.card}>
					<div style={commonStyles.cardHeader}>
						<span>Resources</span>
						<span style={commonStyles.textMuted}>
							{runningTasks.length} task{runningTasks.length !== 1 ? 's' : ''}
						</span>
					</div>
					<div style={S.resourceSummary}>
						<div>
							<div style={S.resHeader}>
								<span style={S.resLabel}>CPU (total)</span>
								<span style={S.resValue}>{agg.totalCpu.toFixed(1)}%</span>
							</div>
							<div style={S.resBarTrack}>
								<div style={{ ...S.resBarFill('var(--rr-border-focus)'), width: `${Math.min(agg.totalCpu, 100)}%` }} />
							</div>
						</div>
						<div>
							<div style={S.resHeader}>
								<span style={S.resLabel}>Memory (total)</span>
								<span style={S.resValue}>{agg.totalMem.toFixed(0)} MB</span>
							</div>
							<div style={S.resBarTrack}>
								<div style={{ ...S.resBarFill('var(--rr-accent)'), width: `${Math.min((agg.totalMem / 2048) * 100, 100)}%` }} />
							</div>
						</div>
						{agg.totalGpu > 0 && (
							<div>
								<div style={S.resHeader}>
									<span style={S.resLabel}>GPU Memory</span>
									<span style={S.resValue}>{agg.totalGpu.toFixed(0)} MB</span>
								</div>
								<div style={S.resBarTrack}>
									<div style={{ ...S.resBarFill('var(--rr-color-info)'), width: `${Math.min((agg.totalGpu / 8192) * 100, 100)}%` }} />
								</div>
							</div>
						)}
						<div style={S.resDivider}>
							<div style={S.resHeader}>
								<span style={S.resLabel}>Completions</span>
								<span style={{ ...S.resValue, color: 'var(--rr-accent)' }}>{formatNumber(agg.totalCompletions)}</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
