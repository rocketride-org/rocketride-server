// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React, { CSSProperties } from 'react';
import type { ActivityEvent, DashboardEvent, TaskEvent } from '../types';
import { formatTime } from '../util';
import { commonStyles } from '../../../themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const feedColors: Record<string, CSSProperties> = {
	connection: { color: 'var(--rr-color-success)' },
	task: { color: 'var(--rr-border-focus)' },
	warning: { color: 'var(--rr-color-warning)' },
	system: { color: 'var(--rr-text-disabled)' },
};

const styles = {
	feed: {
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
	feedItem: {
		display: 'grid',
		gridTemplateColumns: '80px 90px 1fr',
		gap: 12,
		alignItems: 'center',
		padding: '9px 16px',
		fontSize: 13,
		borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)',
	} as CSSProperties,
	feedTime: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		fontVariantNumeric: 'tabular-nums',
	} as CSSProperties,
	feedType: {
		...commonStyles.labelUppercase,
		fontSize: 10,
	} as CSSProperties,
	feedMsg: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

function formatClient(clientName?: string, clientVersion?: string, connectionId?: number): string {
	if (clientName) {
		return clientVersion ? `${clientName} ${clientVersion}:#${connectionId}` : `${clientName}:#${connectionId}`;
	}
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
			return { color: 'system', label: 'unknown', message: `Unknown event: ${(body as any).action}` };
	}
}

function getEventDisplay(event: ActivityEvent): { color: string; label: string; message: string; timestamp: number } {
	if (event.source === 'task') {
		return { ...getTaskEventDisplay(event.body), timestamp: event.receivedAt };
	}
	return { ...getDashboardEventDisplay(event.body), timestamp: event.receivedAt };
}

// =============================================================================
// COMPONENT
// =============================================================================

export const ActivityTab: React.FC<{ events: ActivityEvent[] }> = ({ events }) => (
	<div style={commonStyles.card}>
		<div style={commonStyles.cardHeader}>
			<span>Activity Stream</span>
			<span style={commonStyles.textMuted}>{events.length} events</span>
		</div>
		<div style={styles.feed}>
			{events.map((event, i) => {
				const { color, label, message, timestamp } = getEventDisplay(event);
				return (
					<div key={i} style={styles.feedItem}>
						<div style={styles.feedTime}>{formatTime(timestamp)}</div>
						<div style={{ ...styles.feedType, ...feedColors[color] }}>{label}</div>
						<div style={styles.feedMsg}>{message}</div>
					</div>
				);
			})}
			{events.length === 0 && <div style={commonStyles.empty}>No activity yet. Events will appear here as connections and tasks change.</div>}
		</div>
	</div>
);
