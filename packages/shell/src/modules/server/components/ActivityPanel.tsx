// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// ACTIVITY GRID — Live server event stream (CardDataGrid, host-agnostic)
// =============================================================================

/**
 * ActivityPanel — the Activity Stream CardDataGrid shared by every
 * server-monitor host (admin-ui, monitor-ui, rocket-ui, the VSCode webview).
 *
 * Always LOCAL mode (data-in, callbacks-out; no shell imports): the host
 * hands down the accumulated activity events, and each new array applies
 * silently in place. The event display derivation ({@link getEventDisplay})
 * is exported for the Overview surfaces, which render the same events in
 * card-feed form.
 *
 * Layout persistence rides the grid config channel via the stable
 * 'server-activity' tableId — the hosting shell (web workspace prefs or the
 * VSCode extension bridge) answers it; no persistence prop is threaded.
 */

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { CellComponent } from 'tabulator-tables';
import { Card } from '../../../components/card/Card';
import { CardDataGrid } from '../../../components/data-grid/CardDataGrid';
import { badgeEl, mutedEl } from '../../../components/data-grid/defaults';
import type { CellBadgeVariant, GridColumnDefinition } from '../../../components/data-grid/defaults';
import type { ActivityEvent, DashboardEvent, TaskEvent } from '../types';
import { formatTime } from '../util';

// =============================================================================
// TYPES
// =============================================================================

/** Semantic tone of an event, keyed off what happened (not who reported it). */
export type EventTone = 'connection' | 'task' | 'warning' | 'system';

/** Display form of one activity event: tone, category label, and message. */
export interface IEventDisplay {
	/** Semantic tone (drives the badge / feed color). */
	tone: EventTone;
	/** Short category label (connect, disconnect, task, security, system). */
	label: string;
	/** Human-readable one-line summary. */
	message: string;
	/** Epoch-milliseconds arrival time of the event at this client. */
	timestamp: number;
}

/** Flattened grid row: one activity event, pre-rendered to display fields. */
interface ActivityRow extends Record<string, unknown> {
	/** Epoch-milliseconds arrival time (sortable raw value). */
	time: number;
	/** Event category label (the Type cell). */
	kind: string;
	/** Human-readable event summary. */
	message: string;
	/** Semantic tone backing the Type badge variant. */
	tone: EventTone;
}

/** Props for the {@link ActivityPanel} component. */
export interface IActivityPanelProps {
	/** Accumulated activity events (newest first, as delivered by the host). */
	events: ActivityEvent[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Badge variant per event tone (Type column pill colors). */
const TONE_VARIANTS: Record<EventTone, CellBadgeVariant> = {
	connection: 'success',
	task: 'info',
	warning: 'warning',
	system: 'muted',
};

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Muted count annotation in the card header's action slot.
	headerCount: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// EVENT DISPLAY (shared with the Overview surfaces' Recent Activity feeds)
// =============================================================================

/**
 * Compose the client identity string used in connection event messages.
 *
 * @param clientName - Client display name from the auth handshake, if any.
 * @param clientVersion - Client version from the auth handshake, if any.
 * @param connectionId - Monotonic connection identifier.
 * @returns "name version:#id", "name:#id", or "#id" depending on what is known.
 */
function formatClient(clientName?: string, clientVersion?: string, connectionId?: number): string {
	if (clientName) {
		return clientVersion ? `${clientName} ${clientVersion}:#${connectionId}` : `${clientName}:#${connectionId}`;
	}
	return `#${connectionId}`;
}

/**
 * Describe an apaevt_task event body: tone, category label, and message.
 *
 * @param body - Task event body (discriminated on `action`).
 * @returns The display fields for the event.
 */
function getTaskEventDisplay(body: TaskEvent): { tone: EventTone; label: string; message: string } {
	switch (body.action) {
		case 'running':
			return { tone: 'task', label: 'task', message: `${body.tasks.length} task(s) running` };
		case 'begin':
			return { tone: 'task', label: 'task', message: `Task ${body.name} started` };
		case 'end':
			return { tone: 'warning', label: 'task', message: `Task ${body.name} stopped` };
		case 'restart':
			return { tone: 'task', label: 'task', message: `Task ${body.name} restarted` };
	}
	// An action outside the known lifecycle set (a newer server) — render
	// it generically rather than returning undefined display fields.
	const unknown = body as { action?: string; name?: string };
	return { tone: 'task', label: 'task', message: `Task ${unknown.name ?? ''} ${unknown.action ?? 'event'}`.replace(/\s+/g, ' ').trim() };
}

/**
 * Describe an apaevt_dashboard event body: tone, category label, and message.
 *
 * @param body - Dashboard event body (discriminated on `action`).
 * @returns The display fields for the event.
 */
function getDashboardEventDisplay(body: DashboardEvent): { tone: EventTone; label: string; message: string } {
	switch (body.action) {
		case 'connection_added':
			return { tone: 'connection', label: 'connect', message: `${formatClient(body.clientName ?? undefined, body.clientVersion ?? undefined, body.connectionId)} connected` };
		case 'connection_removed':
			return { tone: 'connection', label: 'disconnect', message: `${formatClient(body.clientName ?? undefined, body.clientVersion ?? undefined, body.connectionId)} disconnected` };
		case 'task_removed':
			return { tone: 'system', label: 'system', message: `Task ${body.taskId} removed` };
		case 'task_error':
			return { tone: 'warning', label: 'task', message: `Task ${body.taskId} failed (exit ${body.exitCode})${body.exitMessage ? `: ${body.exitMessage}` : ''}` };
		case 'auth_failed':
			return { tone: 'warning', label: 'security', message: `Auth rejected for #${body.connectionId}: ${body.reason}` };
		case 'monitor_changed':
			return { tone: 'system', label: 'system', message: `${formatClient(body.clientName ?? undefined, body.clientVersion ?? undefined, body.connectionId)} ${body.change} to ${body.key}` };
		default:
			return { tone: 'system', label: 'unknown', message: `Unknown event: ${(body as DashboardEvent).action}` };
	}
}

/**
 * Describe one activity event from either channel (task / dashboard) as its
 * display fields. Exported for the Overview surfaces' Recent Activity feeds,
 * which render the same events in card form.
 *
 * @param event - The wrapped activity event.
 * @returns Tone, label, message, and the arrival timestamp (epoch ms).
 */
export function getEventDisplay(event: ActivityEvent): IEventDisplay {
	if (event.source === 'task') {
		return { ...getTaskEventDisplay(event.body), timestamp: event.receivedAt };
	}
	return { ...getDashboardEventDisplay(event.body), timestamp: event.receivedAt };
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Activity grid — live stream of server events (connections, task lifecycle,
 * errors) as a CardDataGrid fed by the host's event feed (LOCAL mode: each
 * poll / push hands down a new events array, applied silently).
 *
 * @param props - {@link IActivityPanelProps}.
 * @returns The card-hosted grid.
 */
export const ActivityPanel: React.FC<IActivityPanelProps> = ({ events }) => {
	// Flatten each event into a display row (newest first, as delivered).
	const rows = useMemo<ActivityRow[]>(
		() =>
			events.map((event) => {
				const display = getEventDisplay(event);
				return { time: display.timestamp, kind: display.label, message: display.message, tone: display.tone };
			}),
		[events]
	);

	/**
	 * Event stream column definitions — DOM formatters from the stock cell
	 * factories. `rrDefault` marks the default view (array order = display
	 * order); `rrDefaultSort` on time keeps the stream newest-first.
	 */
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{
				title: 'Time',
				field: 'time',
				rrType: 'date',
				rrDefault: true,
				rrDefaultSort: 'desc',
				rrDescription: 'When the event arrived at this client (epoch milliseconds recorded on receipt), shown as a local time of day; drives the newest-first default sort.',
				width: 110,
				headerSort: true,
				sorter: 'number',
				// formatTime takes Unix SECONDS; receivedAt is epoch milliseconds.
				formatter: (cell: CellComponent) => mutedEl(formatTime((cell.getValue() as number) / 1000)),
			},
			{
				title: 'Type',
				field: 'kind',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: 'Event category derived from the wire action: connect / disconnect (connection lifecycle), task (task lifecycle), security (rejected auth), system (registry and monitor changes).',
				width: 130,
				headerSort: true,
				// Badge tinted by the event tone (success / info / warning / muted).
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as ActivityRow;
					return badgeEl(TONE_VARIANTS[row.tone], String(cell.getValue() ?? ''));
				},
			},
			{
				title: 'Message',
				field: 'message',
				rrType: 'string',
				rrDefault: true,
				rrDescription: 'One-line event summary assembled from the wire body: client name/version and connection number, or task name with exit code and message.',
				headerSort: true,
			},
		],
		[]
	);

	return (
		<>
			{/* ── Activity stream ──────────────────────────────────────────
			    The grid IS the card: its header carries the title, the live
			    event count (`actions`), and the search box — the stream can
			    grow to 200 events, so search stays on. */}
			<Card noBodyPadding>
				<CardDataGrid<ActivityRow> title="Activity Stream" actions={<span style={styles.headerCount}>{events.length} events</span>} columns={columns} data={rows} tableId="server-activity" emptyTitle="No activity yet" emptyDescription="Events will appear here as connections and tasks change." />
			</Card>
		</>
	);
};
