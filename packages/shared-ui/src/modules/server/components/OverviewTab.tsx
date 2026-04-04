// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React from 'react';
import type { DashboardResponse, DashboardTask } from '../types';
import { StatCard } from './StatCard';
import { StatusPill } from './StatusPill';
import { formatUptime, formatTimeAgo, formatNumber } from '../util';

// =============================================================================
// Types
// =============================================================================

interface OverviewTabProps {
	data: DashboardResponse;
}

// =============================================================================
// Helpers
// =============================================================================

/** Aggregate metrics across all running tasks. */
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
	return <StatusPill label="running" variant="success" pulse />;
}

// =============================================================================
// Component
// =============================================================================

export const OverviewTab: React.FC<OverviewTabProps> = ({ data }) => {
	const { overview, connections, tasks } = data;
	const runningTasks = tasks.filter((t) => !t.completed);
	const completedTasks = tasks.filter((t) => t.completed);
	const agg = aggregateMetrics(tasks);

	return (
		<div className="sm-overview">
			{/* Primary stats */}
			<div className="sm-stats-row">
				<StatCard label="Active Connections" value={overview.totalConnections} colorClass="sm-color-success" accentClass="sm-accent-green" subtitle={`${connections.length} active`} />
				<StatCard label="Active Tasks" value={overview.activeTasks} colorClass="sm-color-accent" accentClass="sm-accent-blue" />
				<StatCard label="Uptime" value={formatUptime(overview.serverUptime)} colorClass="sm-color-info" accentClass="sm-accent-cyan" />
			</div>

			{/* Aggregated resource metrics (only shown when tasks are running) */}
			{runningTasks.length > 0 && (
				<div className="sm-stats-row">
					<StatCard label="Total CPU" value={`${agg.totalCpu.toFixed(1)}%`} accentClass="sm-accent-blue" subtitle={`across ${runningTasks.length} task${runningTasks.length > 1 ? 's' : ''}`} />
					<StatCard label="Total Memory" value={`${agg.totalMem.toFixed(0)} MB`} accentClass="sm-accent-orange" />
					{agg.totalGpu > 0 && <StatCard label="GPU Memory" value={`${agg.totalGpu.toFixed(0)} MB`} accentClass="sm-accent-cyan" />}
					<StatCard label="Completions" value={formatNumber(agg.totalCompletions)} accentClass="sm-accent-green" />
				</div>
			)}

			<div className="sm-grid-2col">
				{/* Connections table with message counts */}
				<div className="sm-card">
					<div className="sm-card-header">
						<span>Connections</span>
						<span className="sm-text-muted">{connections.length} active</span>
					</div>
					<table className="sm-table">
						<thead>
							<tr>
								<th>ID</th>
								<th>Account</th>
								<th>Connected</th>
								<th>Messages</th>
								<th>Tasks</th>
							</tr>
						</thead>
						<tbody>
							{connections.map((conn) => (
								<tr key={conn.id}>
									<td className="sm-mono">#{conn.id}</td>
									<td>{conn.clientInfo?.name || conn.clientId || `Conn #${conn.id}`}</td>
									<td className="sm-text-muted">{formatTimeAgo(conn.connectedAt)}</td>
									<td>
										<span className="sm-msg-badge">
											<span className="sm-msg-in">&#9660;</span> {formatNumber(conn.messagesIn)}
										</span>
										<span className="sm-msg-badge">
											<span className="sm-msg-out">&#9650;</span> {formatNumber(conn.messagesOut)}
										</span>
									</td>
									<td className="sm-mono">{conn.attachedTasks.length}</td>
								</tr>
							))}
							{connections.length === 0 && (
								<tr>
									<td colSpan={5} className="sm-text-muted sm-text-center">
										No connections
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>

				{/* Tasks table with inline metrics */}
				<div className="sm-card">
					<div className="sm-card-header">
						<span>Tasks</span>
						<span className="sm-text-muted">{runningTasks.length} running</span>
					</div>
					<table className="sm-table">
						<thead>
							<tr>
								<th>Task</th>
								<th>Elapsed</th>
								<th>CPU</th>
								<th>MEM</th>
								<th>Status</th>
							</tr>
						</thead>
						<tbody>
							{runningTasks.map((task) => {
								const m = task.metrics as Record<string, number> | null;
								const cpu = m?.cpu_percent ?? 0;
								const mem = m?.cpu_memory_mb ?? 0;
								return (
									<tr key={task.id}>
										<td>
											<div className="sm-task-name">{task.name || task.id}</div>
											<div className="sm-task-secondary">
												{task.provider} &middot; {task.projectId?.slice(0, 8)}
											</div>
										</td>
										<td className="sm-mono">{formatUptime(task.elapsedTime)}</td>
										<td>
											<div className="sm-mini-bar">
												<div className="sm-mini-bar-label">
													<span></span>
													<span>{cpu.toFixed(0)}%</span>
												</div>
												<div className="sm-mini-bar-track">
													<div className="sm-mini-bar-fill sm-mini-bar-cpu" style={{ width: `${Math.min(cpu, 100)}%` }} />
												</div>
											</div>
										</td>
										<td>
											<div className="sm-mini-bar">
												<div className="sm-mini-bar-label">
													<span></span>
													<span>{mem.toFixed(0)}M</span>
												</div>
												<div className="sm-mini-bar-track">
													<div className="sm-mini-bar-fill sm-mini-bar-mem" style={{ width: `${Math.min((mem / 2048) * 100, 100)}%` }} />
												</div>
											</div>
										</td>
										<td>{getTaskStatePill(task)}</td>
									</tr>
								);
							})}
							{runningTasks.length === 0 && (
								<tr>
									<td colSpan={5} className="sm-text-muted sm-text-center">
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
				<div className="sm-card" style={{ marginTop: 16 }}>
					<div className="sm-card-header">
						<span>Recently Completed</span>
						<span className="sm-text-muted">{completedTasks.length}</span>
					</div>
					<table className="sm-table">
						<thead>
							<tr>
								<th>Task</th>
								<th>Source</th>
								<th>Duration</th>
								<th>Exit</th>
								<th>Ended</th>
							</tr>
						</thead>
						<tbody>
							{completedTasks.slice(0, 5).map((task) => (
								<tr key={task.id}>
									<td>
										<div className="sm-task-name">{task.name || task.id}</div>
										<div className="sm-task-secondary">
											{task.provider} &middot; {task.projectId?.slice(0, 8)}
										</div>
									</td>
									<td>{task.source}</td>
									<td className="sm-mono">{formatUptime(task.elapsedTime)}</td>
									<td>{task.exitCode === 0 ? <StatusPill label="0" variant="success" /> : <StatusPill label={String(task.exitCode ?? '?')} variant="error" />}</td>
									<td className="sm-text-muted">{task.endTime ? formatTimeAgo(task.endTime) : '-'}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
};
