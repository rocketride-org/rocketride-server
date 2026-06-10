// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React, { useState, CSSProperties } from 'react';
import type { DashboardResponse, DashboardTask, DashboardConnection, ActivityEvent, DashboardEvent, TaskEvent } from '../types';
import { StatusPill } from './StatusPill';
import { ConnectionDetailModal } from './ConnectionsTab';
import { formatUptime, formatTime, formatTimeAgo, formatNumber } from '../util';
import { commonStyles } from '../../../themes/styles';

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

	// ── Unified table ───────────────────────────────────────────────────────
	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 13,
	} as CSSProperties,
	clickableRow: {} as CSSProperties,
	completedRow: {
		opacity: 0.6,
	} as CSSProperties,
	mono: {
		...commonStyles.fontMono,
		fontVariantNumeric: 'tabular-nums',
	} as CSSProperties,
	taskName: {
		fontWeight: 500,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	taskSub: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		marginTop: 1,
	} as CSSProperties,
	typeLabel: (color: string): CSSProperties => ({
		fontSize: 11,
		color,
	}),
	msgGroup: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 3,
		fontSize: 11,
		fontVariantNumeric: 'tabular-nums',
		marginRight: 6,
	} as CSSProperties,
	msgIn: { color: 'var(--rr-color-success)', fontSize: 9 } as CSSProperties,
	msgOut: { color: 'var(--rr-border-focus)', fontSize: 9 } as CSSProperties,

	// ── Inline gauge bars ───────────────────────────────────────────────────
	gaugeInline: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		minWidth: 100,
	} as CSSProperties,
	gaugeBar: {
		flex: 1,
		height: 6,
		background: 'color-mix(in srgb, var(--rr-border) 30%, transparent)',
		borderRadius: 3,
		overflow: 'hidden',
	} as CSSProperties,
	gaugeFillCpu: {
		height: '100%',
		borderRadius: 3,
		background: 'var(--rr-border-focus)',
	} as CSSProperties,
	gaugeFillMem: {
		height: '100%',
		borderRadius: 3,
		background: 'var(--rr-accent)',
	} as CSSProperties,
	gaugeLabel: {
		fontSize: 11,
		fontVariantNumeric: 'tabular-nums',
		color: 'var(--rr-text-secondary)',
		minWidth: 40,
		textAlign: 'right',
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

const feedColors: Record<string, CSSProperties> = {
	connection: { color: 'var(--rr-color-success)' },
	task: { color: 'var(--rr-border-focus)' },
	warning: { color: 'var(--rr-color-warning)' },
	system: { color: 'var(--rr-text-disabled)' },
};

// =============================================================================
// HELPERS
// =============================================================================

function aggregateMetrics(tasks: DashboardTask[]) {
	let totalCpu = 0;
	let totalMem = 0;
	let totalGpu = 0;
	let totalCompletions = 0;

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

function getTaskPill(task: DashboardTask) {
	if (task.completed) {
		return task.exitCode === 0 ? <StatusPill label={`exit ${task.exitCode}`} variant="muted" /> : <StatusPill label={`exit ${task.exitCode}`} variant="error" />;
	}
	if (task.idleTime > 0 && task.ttl > 0 && task.idleTime > task.ttl * 0.8) {
		return <StatusPill label="idle (ttl)" variant="warning" />;
	}
	return <StatusPill label="running" variant="success" />;
}

// ── Event display (shared logic with ActivityTab) ───────────────────────

function formatClient(clientName?: string, clientVersion?: string, connectionId?: number): string {
	if (clientName) return clientVersion ? `${clientName} ${clientVersion}:#${connectionId}` : `${clientName}:#${connectionId}`;
	return `#${connectionId}`;
}

function getTaskEventDisplay(body: TaskEvent): { color: string; label: string; message: string } {
	switch (body.action) {
		case 'running':
			return { color: 'task', label: 'task', message: `${body.tasks.length} task(s) running` };
		case 'begin':
			return { color: 'task', label: 'task', message: `Task ${body.name} started` };
		case 'end':
			return { color: 'warning', label: 'task', message: `Task ${body.name} stopped` };
		case 'restart':
			return { color: 'task', label: 'task', message: `Task ${body.name} restarted` };
	}
}

function getDashboardEventDisplay(body: DashboardEvent): { color: string; label: string; message: string } {
	switch (body.action) {
		case 'connection_added':
			return { color: 'connection', label: 'connect', message: `${formatClient(body.clientName ?? undefined, body.clientVersion ?? undefined, body.connectionId)} connected` };
		case 'connection_removed':
			return { color: 'connection', label: 'disconnect', message: `${formatClient(body.clientName ?? undefined, body.clientVersion ?? undefined, body.connectionId)} disconnected` };
		case 'task_removed':
			return { color: 'system', label: 'system', message: `Task ${body.taskId} removed` };
		case 'task_error':
			return { color: 'warning', label: 'task', message: `Task ${body.taskId} failed (exit ${body.exitCode})${body.exitMessage ? `: ${body.exitMessage}` : ''}` };
		case 'auth_failed':
			return { color: 'warning', label: 'security', message: `Auth rejected for #${body.connectionId}: ${body.reason}` };
		case 'monitor_changed':
			return { color: 'system', label: 'system', message: `${formatClient(body.clientName ?? undefined, body.clientVersion ?? undefined, body.connectionId)} ${body.change} to ${body.key}` };
		default:
			return { color: 'system', label: 'unknown', message: `Unknown event: ${(body as DashboardEvent).action}` };
	}
}

function getEventDisplay(event: ActivityEvent): { color: string; label: string; message: string; timestamp: number } {
	if (event.source === 'task') return { ...getTaskEventDisplay(event.body), timestamp: event.receivedAt };
	return { ...getDashboardEventDisplay(event.body), timestamp: event.receivedAt };
}

/** Short summary for the ticker (just the key info, no prefix). */
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

interface OverviewTabProps {
	data: DashboardResponse;
	events: ActivityEvent[];
	onRefresh?: () => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({ data, events, onRefresh }) => {
	const { overview, connections, tasks } = data;
	const runningTasks = tasks.filter((t) => !t.completed);
	const completedTasks = tasks.filter((t) => t.completed);
	const agg = aggregateMetrics(tasks);
	const recentEvents = events.slice(0, 5);
	const tickerEvents = events.slice(0, 4);
	const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
	const selectedConn = connections.find((c) => c.id === selectedConnId);

	return (
		<div>
			{/* Pulse animation keyframe */}
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
						{runningTasks.length} running{completedTasks.length > 0 ? ` \u00b7 ${completedTasks.length} completed` : ''}
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

			{/* ── Unified Connections & Tasks Table ───────────────────── */}
			<div style={commonStyles.card}>
				<div style={commonStyles.cardHeader}>
					<span>Connections &amp; Tasks</span>
					<div style={{ display: 'flex', gap: 8 }}>
						{onRefresh && (
							<button type="button" style={commonStyles.buttonSecondarySmall} onClick={onRefresh}>
								Refresh
							</button>
						)}
					</div>
				</div>
				<table style={S.table}>
					<thead>
						<tr>
							<th style={commonStyles.tableHeader}>Name</th>
							<th style={commonStyles.tableHeader}>Type</th>
							<th style={commonStyles.tableHeader}>CPU</th>
							<th style={commonStyles.tableHeader}>Memory</th>
							<th style={commonStyles.tableHeader}>Elapsed</th>
							<th style={commonStyles.tableHeader}>Status</th>
						</tr>
					</thead>
					<tbody>
						{/* Connection rows */}
						{connections.map((conn: DashboardConnection) => (
							<tr key={`conn-${conn.id}`} style={S.clickableRow} tabIndex={0} onClick={() => setSelectedConnId(conn.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedConnId(conn.id); } }}>
								<td style={commonStyles.tableCell}>
									<div style={S.taskName}>{conn.clientInfo?.name || conn.clientId || `Conn #${conn.id}`}</div>
									<div style={S.taskSub}>
										Connection #{conn.id} &middot;{' '}
										<span style={S.msgGroup}>
											<span style={S.msgIn}>&#9660;</span>
											{formatNumber(conn.messagesIn)}
										</span>
										<span style={S.msgGroup}>
											<span style={S.msgOut}>&#9650;</span>
											{formatNumber(conn.messagesOut)}
										</span>
									</div>
								</td>
								<td style={commonStyles.tableCell}>
									<span style={S.typeLabel('var(--rr-color-success)')}>client</span>
								</td>
								<td style={{ ...commonStyles.tableCell, color: 'var(--rr-text-disabled)' }}>&mdash;</td>
								<td style={{ ...commonStyles.tableCell, color: 'var(--rr-text-disabled)' }}>&mdash;</td>
								<td style={{ ...commonStyles.tableCell, ...S.mono }}>{formatTimeAgo(conn.connectedAt)}</td>
								<td style={commonStyles.tableCell}>
									<StatusPill label="connected" variant="success" />
								</td>
							</tr>
						))}

						{/* Running task rows */}
						{runningTasks.map((task: DashboardTask) => {
							const m = task.metrics as Record<string, number> | null;
							const cpu = m?.cpu_percent ?? 0;
							const mem = m?.cpu_memory_mb ?? 0;
							return (
								<tr key={`task-${task.id}`} style={S.clickableRow}>
									<td style={commonStyles.tableCell}>
										<div style={S.taskName}>{task.name || task.id}</div>
										<div style={S.taskSub}>
											{task.provider} &middot; {task.projectId?.slice(0, 8)}
											{task.source ? ` \u00b7 ${task.source}` : ''}
										</div>
									</td>
									<td style={commonStyles.tableCell}>
										<span style={S.typeLabel('var(--rr-border-focus)')}>task</span>
									</td>
									<td style={commonStyles.tableCell}>
										<div style={S.gaugeInline}>
											<div style={S.gaugeBar}>
												<div style={{ ...S.gaugeFillCpu, width: `${Math.min(cpu, 100)}%` }} />
											</div>
											<span style={S.gaugeLabel}>{cpu.toFixed(0)}%</span>
										</div>
									</td>
									<td style={commonStyles.tableCell}>
										<div style={S.gaugeInline}>
											<div style={S.gaugeBar}>
												<div style={{ ...S.gaugeFillMem, width: `${Math.min((mem / 2048) * 100, 100)}%` }} />
											</div>
											<span style={S.gaugeLabel}>{mem.toFixed(0)}M</span>
										</div>
									</td>
									<td style={{ ...commonStyles.tableCell, ...S.mono }}>{formatUptime(task.elapsedTime)}</td>
									<td style={commonStyles.tableCell}>{getTaskPill(task)}</td>
								</tr>
							);
						})}

						{/* Completed task rows (dimmed) */}
						{completedTasks.slice(0, 5).map((task: DashboardTask) => (
							<tr key={`task-${task.id}`} style={{ ...S.clickableRow, ...S.completedRow }}>
								<td style={commonStyles.tableCell}>
									<div style={S.taskName}>{task.name || task.id}</div>
									<div style={S.taskSub}>
										{task.provider} &middot; {task.projectId?.slice(0, 8)}
										{task.source ? ` \u00b7 ${task.source}` : ''}
									</div>
								</td>
								<td style={commonStyles.tableCell}>
									<span style={S.typeLabel('var(--rr-text-disabled)')}>task</span>
								</td>
								<td style={{ ...commonStyles.tableCell, color: 'var(--rr-text-disabled)' }}>&mdash;</td>
								<td style={{ ...commonStyles.tableCell, color: 'var(--rr-text-disabled)' }}>&mdash;</td>
								<td style={{ ...commonStyles.tableCell, ...S.mono }}>{formatUptime(task.elapsedTime)}</td>
								<td style={commonStyles.tableCell}>{getTaskPill(task)}</td>
							</tr>
						))}

						{/* Empty state */}
						{connections.length === 0 && tasks.length === 0 && (
							<tr>
								<td colSpan={6} style={{ ...commonStyles.tableCell, ...commonStyles.empty }}>
									No connections or tasks
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

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
							const { color, label, message, timestamp } = getEventDisplay(event);
							return (
								<div key={i} style={S.feedItem}>
									<div style={S.feedTime}>{formatTime(timestamp)}</div>
									<div style={{ ...S.feedType, ...feedColors[color] }}>{label}</div>
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
						<span style={commonStyles.textMuted}>{runningTasks.length} task{runningTasks.length !== 1 ? 's' : ''}</span>
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
			{selectedConn && <ConnectionDetailModal connection={selectedConn} onClose={() => setSelectedConnId(null)} />}
		</div>
	);
};
