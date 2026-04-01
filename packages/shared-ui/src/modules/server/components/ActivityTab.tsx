// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React from 'react';
import type { DashboardEvent } from '../types';
import { formatTime } from '../util';

interface ActivityTabProps {
	events: DashboardEvent[];
}

function getEventColor(action: string): string {
	if (action.startsWith('connection')) return 'sm-feed-connection';
	if (action === 'task_started') return 'sm-feed-task';
	if (action === 'task_stopped') return 'sm-feed-warning';
	if (action === 'task_removed') return 'sm-feed-system';
	return 'sm-feed-system';
}

function getEventLabel(action: string): string {
	switch (action) {
		case 'connection_added':
			return 'connect';
		case 'connection_removed':
			return 'disconnect';
		case 'task_started':
			return 'task';
		case 'task_stopped':
			return 'task';
		case 'task_removed':
			return 'system';
		default:
			return action;
	}
}

function getEventMessage(event: DashboardEvent): string {
	switch (event.action) {
		case 'connection_added':
			return `Connection #${event.connectionId} opened`;
		case 'connection_removed':
			return `Connection #${event.connectionId} disconnected`;
		case 'task_started':
			return `Task ${event.taskId} started`;
		case 'task_stopped':
			return `Task ${event.taskId} stopped`;
		case 'task_removed':
			return `Task ${event.taskId} removed (cleanup)`;
		default:
			return event.action;
	}
}

export const ActivityTab: React.FC<ActivityTabProps> = ({ events }) => (
	<div className="sm-card">
		<div className="sm-card-header">
			<span>Activity Stream</span>
			<span className="sm-text-muted">{events.length} events</span>
		</div>
		<div className="sm-feed">
			{events.map((event, i) => (
				<div key={i} className="sm-feed-item">
					<div className="sm-feed-time sm-mono">{formatTime(event.timestamp)}</div>
					<div className={`sm-feed-type ${getEventColor(event.action)}`}>{getEventLabel(event.action)}</div>
					<div className="sm-feed-msg">{getEventMessage(event)}</div>
				</div>
			))}
			{events.length === 0 && <div className="sm-feed-empty sm-text-muted">No activity yet. Events will appear here as connections and tasks change.</div>}
		</div>
	</div>
);
