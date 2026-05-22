// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React, { CSSProperties } from 'react';
import type { DashboardTask } from '../types';
import { StatusPill } from './StatusPill';
import { formatUptime, formatNumber } from '../util';
import { commonStyles } from '../../../themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 13,
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
	mono: {
		...commonStyles.fontMono,
		fontVariantNumeric: 'tabular-nums',
	} as CSSProperties,
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

function getStatePill(task: DashboardTask) {
	if (task.completed) {
		return task.exitCode === 0 ? <StatusPill label="completed" variant="success" /> : <StatusPill label={`failed (${task.exitCode})`} variant="error" />;
	}
	if (task.idleTime > 0 && task.ttl > 0 && task.idleTime > task.ttl * 0.8) {
		return <StatusPill label="idle (ttl)" variant="warning" />;
	}
	return <StatusPill label={task.status ?? 'running'} variant="success" />;
}

function getTtlDisplay(task: DashboardTask) {
	if (task.completed) return <span style={commonStyles.textMuted}>-</span>;
	if (task.ttl === 0) return <span style={commonStyles.textMuted}>none</span>;
	const pct = task.idleTime / task.ttl;
	return (
		<span style={{ ...styles.mono, ...(pct > 0.8 ? { color: 'var(--rr-color-warning)' } : {}) }}>
			{formatUptime(task.idleTime)} / {formatUptime(task.ttl)}
		</span>
	);
}

// =============================================================================
// COMPONENT
// =============================================================================

export const TasksTab: React.FC<{ tasks: DashboardTask[] }> = ({ tasks }) => (
	<div style={commonStyles.card}>
		<div style={commonStyles.cardHeader}>
			<span>All Tasks ({tasks.length})</span>
			<span style={commonStyles.textMuted}>
				{tasks.filter((t) => !t.completed).length} running &middot; {tasks.filter((t) => t.completed).length} completed
			</span>
		</div>
		<table style={styles.table}>
			<thead>
				<tr>
					<th style={commonStyles.tableHeader}>Task</th>
					<th style={commonStyles.tableHeader}>Source</th>
					<th style={commonStyles.tableHeader}>Elapsed</th>
					<th style={commonStyles.tableHeader}>CPU</th>
					<th style={commonStyles.tableHeader}>MEM</th>
					<th style={commonStyles.tableHeader}>Completions</th>
					<th style={commonStyles.tableHeader}>TTL / Idle</th>
					<th style={commonStyles.tableHeader}>Status</th>
				</tr>
			</thead>
			<tbody>
				{tasks.map((task) => {
					const m = task.metrics as Record<string, number> | null;
					const cpu = m?.cpu_percent ?? 0;
					const mem = m?.cpu_memory_mb ?? 0;
					return (
						<tr key={task.id}>
							<td style={commonStyles.tableCell}>
								<div style={styles.taskName}>{task.name || task.id}</div>
								<div style={styles.taskSecondary}>
									{task.provider} &middot; {task.launchType} &middot; {task.projectId?.slice(0, 8)}
								</div>
							</td>
							<td style={commonStyles.tableCell}>{task.source}</td>
							<td style={{ ...commonStyles.tableCell, ...styles.mono }}>{formatUptime(task.elapsedTime)}</td>
							<td style={commonStyles.tableCell}>
								{!task.completed ? (
									<div style={styles.miniBar}>
										<div style={styles.miniBarLabel}>
											<span></span>
											<span>{cpu.toFixed(0)}%</span>
										</div>
										<div style={styles.miniBarTrack}>
											<div style={{ ...styles.miniBarFillCpu, width: `${Math.min(cpu, 100)}%` }} />
										</div>
									</div>
								) : (
									<span style={commonStyles.textMuted}>-</span>
								)}
							</td>
							<td style={commonStyles.tableCell}>
								{!task.completed ? (
									<div style={styles.miniBar}>
										<div style={styles.miniBarLabel}>
											<span></span>
											<span>{mem.toFixed(0)}M</span>
										</div>
										<div style={styles.miniBarTrack}>
											<div style={{ ...styles.miniBarFillMem, width: `${Math.min((mem / 2048) * 100, 100)}%` }} />
										</div>
									</div>
								) : (
									<span style={commonStyles.textMuted}>-</span>
								)}
							</td>
							<td style={{ ...commonStyles.tableCell, ...styles.mono }}>{task.completedCount > 0 ? formatNumber(task.completedCount) : <span style={commonStyles.textMuted}>-</span>}</td>
							<td style={commonStyles.tableCell}>{getTtlDisplay(task)}</td>
							<td style={commonStyles.tableCell}>{getStatePill(task)}</td>
						</tr>
					);
				})}
				{tasks.length === 0 && (
					<tr>
						<td colSpan={8} style={{ ...commonStyles.tableCell, ...commonStyles.empty }}>
							No tasks
						</td>
					</tr>
				)}
			</tbody>
		</table>
	</div>
);
