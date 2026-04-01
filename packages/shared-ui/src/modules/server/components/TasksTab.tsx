// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React from 'react';
import type { DashboardTask } from '../types';
import { StatusPill } from './StatusPill';
import { formatUptime, formatNumber } from '../util';

interface TasksTabProps {
	tasks: DashboardTask[];
}

function getStatePill(task: DashboardTask) {
	if (task.completed) {
		return task.exitCode === 0 ? <StatusPill label="completed" variant="success" /> : <StatusPill label={`failed (${task.exitCode})`} variant="error" />;
	}
	if (task.idleTime > 0 && task.ttl > 0 && task.idleTime > task.ttl * 0.8) {
		return <StatusPill label="idle (ttl)" variant="warning" />;
	}
	return <StatusPill label={task.status ?? 'running'} variant="success" pulse />;
}

function getTtlDisplay(task: DashboardTask) {
	if (task.completed) return <span className="sm-text-muted">-</span>;
	if (task.ttl === 0) return <span className="sm-text-muted">none</span>;
	const pct = task.idleTime / task.ttl;
	const variant = pct > 0.8 ? 'sm-color-warning' : '';
	return (
		<span className={`sm-mono ${variant}`}>
			{formatUptime(task.idleTime)} / {formatUptime(task.ttl)}
		</span>
	);
}

export const TasksTab: React.FC<TasksTabProps> = ({ tasks }) => (
	<div className="sm-card">
		<div className="sm-card-header">
			<span>All Tasks ({tasks.length})</span>
			<span className="sm-text-muted">
				{tasks.filter((t) => !t.completed).length} running &middot; {tasks.filter((t) => t.completed).length} completed
			</span>
		</div>
		<table className="sm-table">
			<thead>
				<tr>
					<th>Task</th>
					<th>Source</th>
					<th>Elapsed</th>
					<th>CPU</th>
					<th>MEM</th>
					<th>Completions</th>
					<th>TTL / Idle</th>
					<th>Status</th>
				</tr>
			</thead>
			<tbody>
				{tasks.map((task) => {
					const m = task.metrics as Record<string, number> | null;
					const cpu = m?.cpu_percent ?? 0;
					const mem = m?.cpu_memory_mb ?? 0;
					return (
						<tr key={task.id}>
							<td>
								<div className="sm-task-name">{task.name || task.id}</div>
								<div className="sm-task-secondary">
									{task.provider} &middot; {task.launchType} &middot; {task.projectId?.slice(0, 8)}
								</div>
							</td>
							<td>{task.source}</td>
							<td className="sm-mono">{formatUptime(task.elapsedTime)}</td>
							<td>
								{!task.completed ? (
									<div className="sm-mini-bar">
										<div className="sm-mini-bar-label">
											<span></span>
											<span>{cpu.toFixed(0)}%</span>
										</div>
										<div className="sm-mini-bar-track">
											<div className="sm-mini-bar-fill sm-mini-bar-cpu" style={{ width: `${Math.min(cpu, 100)}%` }} />
										</div>
									</div>
								) : (
									<span className="sm-text-muted">-</span>
								)}
							</td>
							<td>
								{!task.completed ? (
									<div className="sm-mini-bar">
										<div className="sm-mini-bar-label">
											<span></span>
											<span>{mem.toFixed(0)}M</span>
										</div>
										<div className="sm-mini-bar-track">
											<div className="sm-mini-bar-fill sm-mini-bar-mem" style={{ width: `${Math.min((mem / 2048) * 100, 100)}%` }} />
										</div>
									</div>
								) : (
									<span className="sm-text-muted">-</span>
								)}
							</td>
							<td className="sm-mono">{task.completedCount > 0 ? formatNumber(task.completedCount) : <span className="sm-text-muted">-</span>}</td>
							<td>{getTtlDisplay(task)}</td>
							<td>{getStatePill(task)}</td>
						</tr>
					);
				})}
				{tasks.length === 0 && (
					<tr>
						<td colSpan={8} className="sm-text-muted sm-text-center">
							No tasks
						</td>
					</tr>
				)}
			</tbody>
		</table>
	</div>
);
