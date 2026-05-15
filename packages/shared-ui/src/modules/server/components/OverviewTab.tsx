// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React, { CSSProperties } from 'react';
import type { DashboardResponse, DashboardTask } from '../types';
import { StatCard } from './StatCard';
import { StatusPill } from './StatusPill';
import { formatUptime, formatTimeAgo, formatNumber } from '../util';
import { commonStyles } from '../../../themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	statsRow: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
		gap: 12,
		marginBottom: 20,
	} as CSSProperties,
	grid2col: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: 16,
	} as CSSProperties,
	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 13,
	} as CSSProperties,
	mono: {
		...commonStyles.fontMono,
		fontVariantNumeric: 'tabular-nums',
	} as CSSProperties,
	taskName: {
		fontWeight: 500,
		color: 'var(--rr-text-primary)',
		fontVariantNumeric: 'tabular-nums',
	} as CSSProperties,
	taskSecondary: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		marginTop: 2,
	} as CSSProperties,
	msgBadge: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 3,
		fontSize: 11,
		fontVariantNumeric: 'tabular-nums',
		marginRight: 6,
	} as CSSProperties,
	msgIn: { color: 'var(--rr-color-success)', fontSize: 8 } as CSSProperties,
	msgOut: { color: 'var(--rr-border-focus)', fontSize: 8 } as CSSProperties,
	miniBar: { width: 80 } as CSSProperties,
	miniBarLabel: {
		fontSize: 10,
		color: 'var(--rr-text-disabled)',
		marginBottom: 2,
		display: 'flex',
		justifyContent: 'space-between',
	} as CSSProperties,
	miniBarTrack: {
		height: 4,
		background: 'color-mix(in srgb, var(--rr-border) 30%, transparent)',
		borderRadius: 2,
		overflow: 'hidden',
	} as CSSProperties,
	miniBarFillCpu: {
		height: '100%',
		borderRadius: 2,
		background: 'var(--rr-border-focus)',
	} as CSSProperties,
	miniBarFillMem: {
		height: '100%',
		borderRadius: 2,
		background: 'var(--rr-accent)',
	} as CSSProperties,
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

function getTaskStatePill(task: DashboardTask) {
	if (task.completed) {
		return task.exitCode === 0 ? <StatusPill label="completed" variant="muted" /> : <StatusPill label={`exit ${task.exitCode}`} variant="error" />;
	}
	if (task.idleTime > 0 && task.ttl > 0 && task.idleTime > task.ttl * 0.8) {
		return <StatusPill label="idle (ttl)" variant="warning" />;
	}
	return <StatusPill label="running" variant="success" />;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const OverviewTab: React.FC<{ data: DashboardResponse }> = ({ data }) => {
	const { overview, connections, tasks } = data;
	const runningTasks = tasks.filter((t) => !t.completed);
	const completedTasks = tasks.filter((t) => t.completed);
	const agg = aggregateMetrics(tasks);

	return (
		<div>
			{/* Primary stats */}
			<div style={styles.statsRow}>
				<StatCard label="Active Connections" value={overview.totalConnections} colorClass="success" accentClass="green" subtitle={`${connections.length} active`} />
				<StatCard label="Active Tasks" value={overview.activeTasks} colorClass="accent" accentClass="blue" />
				<StatCard label="Uptime" value={formatUptime(overview.serverUptime)} colorClass="info" accentClass="cyan" />
			</div>

			{/* Aggregated resource metrics */}
			{runningTasks.length > 0 && (
				<div style={styles.statsRow}>
					<StatCard label="Total CPU" value={`${agg.totalCpu.toFixed(1)}%`} accentClass="blue" subtitle={`across ${runningTasks.length} task${runningTasks.length > 1 ? 's' : ''}`} />
					<StatCard label="Total Memory" value={`${agg.totalMem.toFixed(0)} MB`} accentClass="orange" />
					{agg.totalGpu > 0 && <StatCard label="GPU Memory" value={`${agg.totalGpu.toFixed(0)} MB`} accentClass="cyan" />}
					<StatCard label="Completions" value={formatNumber(agg.totalCompletions)} accentClass="green" />
				</div>
			)}

			<div style={styles.grid2col}>
				{/* Connections table */}
				<div style={commonStyles.card}>
					<div style={commonStyles.cardHeader}>
						<span>Connections</span>
						<span style={commonStyles.textMuted}>{connections.length} active</span>
					</div>
					<table style={styles.table}>
						<thead>
							<tr>
								<th style={commonStyles.tableHeader}>ID</th>
								<th style={commonStyles.tableHeader}>Account</th>
								<th style={commonStyles.tableHeader}>Connected</th>
								<th style={commonStyles.tableHeader}>Messages</th>
								<th style={commonStyles.tableHeader}>Tasks</th>
							</tr>
						</thead>
						<tbody>
							{connections.map((conn) => (
								<tr key={conn.id}>
									<td style={{ ...commonStyles.tableCell, ...styles.mono }}>#{conn.id}</td>
									<td style={commonStyles.tableCell}>{conn.clientInfo?.name || conn.clientId || `Conn #${conn.id}`}</td>
									<td style={{ ...commonStyles.tableCell, color: 'var(--rr-text-disabled)' }}>{formatTimeAgo(conn.connectedAt)}</td>
									<td style={commonStyles.tableCell}>
										<span style={styles.msgBadge}>
											<span style={styles.msgIn}>&#9660;</span> {formatNumber(conn.messagesIn)}
										</span>
										<span style={styles.msgBadge}>
											<span style={styles.msgOut}>&#9650;</span> {formatNumber(conn.messagesOut)}
										</span>
									</td>
									<td style={{ ...commonStyles.tableCell, ...styles.mono }}>{conn.attachedTasks.length}</td>
								</tr>
							))}
							{connections.length === 0 && (
								<tr>
									<td colSpan={5} style={{ ...commonStyles.tableCell, ...commonStyles.empty }}>
										No connections
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>

				{/* Tasks table */}
				<div style={commonStyles.card}>
					<div style={commonStyles.cardHeader}>
						<span>Tasks</span>
						<span style={commonStyles.textMuted}>{runningTasks.length} running</span>
					</div>
					<table style={styles.table}>
						<thead>
							<tr>
								<th style={commonStyles.tableHeader}>Task</th>
								<th style={commonStyles.tableHeader}>Elapsed</th>
								<th style={commonStyles.tableHeader}>CPU</th>
								<th style={commonStyles.tableHeader}>MEM</th>
								<th style={commonStyles.tableHeader}>Status</th>
							</tr>
						</thead>
						<tbody>
							{runningTasks.map((task) => {
								const m = task.metrics as Record<string, number> | null;
								const cpu = m?.cpu_percent ?? 0;
								const mem = m?.cpu_memory_mb ?? 0;
								return (
									<tr key={task.id}>
										<td style={commonStyles.tableCell}>
											<div style={styles.taskName}>{task.name || task.id}</div>
											<div style={styles.taskSecondary}>
												{task.provider} &middot; {task.projectId?.slice(0, 8)}
											</div>
										</td>
										<td style={{ ...commonStyles.tableCell, ...styles.mono }}>{formatUptime(task.elapsedTime)}</td>
										<td style={commonStyles.tableCell}>
											<div style={styles.miniBar}>
												<div style={styles.miniBarLabel}>
													<span></span>
													<span>{cpu.toFixed(0)}%</span>
												</div>
												<div style={styles.miniBarTrack}>
													<div style={{ ...styles.miniBarFillCpu, width: `${Math.min(cpu, 100)}%` }} />
												</div>
											</div>
										</td>
										<td style={commonStyles.tableCell}>
											<div style={styles.miniBar}>
												<div style={styles.miniBarLabel}>
													<span></span>
													<span>{mem.toFixed(0)}M</span>
												</div>
												<div style={styles.miniBarTrack}>
													<div style={{ ...styles.miniBarFillMem, width: `${Math.min((mem / 2048) * 100, 100)}%` }} />
												</div>
											</div>
										</td>
										<td style={commonStyles.tableCell}>{getTaskStatePill(task)}</td>
									</tr>
								);
							})}
							{runningTasks.length === 0 && (
								<tr>
									<td colSpan={5} style={{ ...commonStyles.tableCell, ...commonStyles.empty }}>
										No running tasks
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>

			{/* Recently completed */}
			{completedTasks.length > 0 && (
				<div style={{ ...commonStyles.card, marginTop: 16 }}>
					<div style={commonStyles.cardHeader}>
						<span>Recently Completed</span>
						<span style={commonStyles.textMuted}>{completedTasks.length}</span>
					</div>
					<table style={styles.table}>
						<thead>
							<tr>
								<th style={commonStyles.tableHeader}>Task</th>
								<th style={commonStyles.tableHeader}>Source</th>
								<th style={commonStyles.tableHeader}>Duration</th>
								<th style={commonStyles.tableHeader}>Exit</th>
								<th style={commonStyles.tableHeader}>Ended</th>
							</tr>
						</thead>
						<tbody>
							{completedTasks.slice(0, 5).map((task) => (
								<tr key={task.id}>
									<td style={commonStyles.tableCell}>
										<div style={styles.taskName}>{task.name || task.id}</div>
										<div style={styles.taskSecondary}>
											{task.provider} &middot; {task.projectId?.slice(0, 8)}
										</div>
									</td>
									<td style={commonStyles.tableCell}>{task.source}</td>
									<td style={{ ...commonStyles.tableCell, ...styles.mono }}>{formatUptime(task.elapsedTime)}</td>
									<td style={commonStyles.tableCell}>{task.exitCode === 0 ? <StatusPill label="0" variant="success" /> : <StatusPill label={String(task.exitCode ?? '?')} variant="error" />}</td>
									<td style={{ ...commonStyles.tableCell, color: 'var(--rr-text-disabled)' }}>{task.endTime ? formatTimeAgo(task.endTime) : '-'}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
};
