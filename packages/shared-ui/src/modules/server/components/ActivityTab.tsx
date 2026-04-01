// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React from 'react';
import type { ActivityEvent, DashboardEvent, TaskEvent } from '../types';
import { formatTime } from '../util';

interface ActivityTabProps {
	events: ActivityEvent[];
}

function formatClient(clientName?: string, clientVersion?: string, connectionId?: number): string {
	if (clientName) {
		return clientVersion ? `${clientName} ${clientVersion}:#${connectionId}` : `${clientName}:#${connectionId}`;
	}
	return `#${connectionId}`;
}

function getTaskEventDisplay(body: TaskEvent): { color: string; label: string; message: string } {
	switch (body.action) {
		case 'running':
			return { color: 'sm-feed-task', label: 'task', message: `${body.tasks.length} task(s) running` };
		case 'begin':
			return { color: 'sm-feed-task', label: 'task', message: `Task ${body.name} started` };
		case 'end':
			return { color: 'sm-feed-warning', label: 'task', message: `Task ${body.name} stopped` };
		case 'restart':
			return { color: 'sm-feed-task', label: 'task', message: `Task ${body.name} restarted` };
	}
}

function getDashboardEventDisplay(body: DashboardEvent): { color: string; label: string; message: string } {
	switch (body.action) {
		case 'connection_added':
			return { color: 'sm-feed-connection', label: 'connect', message: `${formatClient(body.clientName, body.clientVersion, body.connectionId)} connected` };
		case 'connection_removed':
			return { color: 'sm-feed-connection', label: 'disconnect', message: `${formatClient(body.clientName, body.clientVersion, body.connectionId)} disconnected` };
		case 'task_removed':
			return { color: 'sm-feed-system', label: 'system', message: `Task ${body.taskId} removed` };
		case 'task_error':
			return { color: 'sm-feed-warning', label: 'task', message: `Task ${body.taskId} failed (exit ${body.exitCode})${body.exitMessage ? `: ${body.exitMessage}` : ''}` };
		case 'auth_failed':
			return { color: 'sm-feed-warning', label: 'security', message: `Auth rejected for #${body.connectionId}: ${body.reason}` };
		case 'monitor_changed':
			return { color: 'sm-feed-system', label: 'system', message: `${formatClient(body.clientName, body.clientVersion, body.connectionId)} ${body.change} to ${body.key}` };
	}
}

function getEventDisplay(event: ActivityEvent): { color: string; label: string; message: string; timestamp: number } {
	if (event.source === 'task') {
		const display = getTaskEventDisplay(event.body);
		return { ...display, timestamp: Date.now() / 1000 };
	}
	const display = getDashboardEventDisplay(event.body);
	return { ...display, timestamp: event.body.timestamp };
}

export const ActivityTab: React.FC<ActivityTabProps> = ({ events }) => (
	<div className="sm-card">
		<div className="sm-card-header">
			<span>Activity Stream</span>
			<span className="sm-text-muted">{events.length} events</span>
		</div>
		<div className="sm-feed">
			{events.map((event, i) => {
				const { color, label, message, timestamp } = getEventDisplay(event);
				return (
					<div key={i} className="sm-feed-item">
						<div className="sm-feed-time sm-mono">{formatTime(timestamp)}</div>
						<div className={`sm-feed-type ${color}`}>{label}</div>
						<div className="sm-feed-msg">{message}</div>
					</div>
				);
			})}
			{events.length === 0 && <div className="sm-feed-empty sm-text-muted">No activity yet. Events will appear here as connections and tasks change.</div>}
		</div>
	</div>
);
