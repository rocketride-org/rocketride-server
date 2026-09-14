// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// OVERVIEW GRID — Unified Connections & Tasks table (CardDataGrid, host-agnostic)
// =============================================================================

/**
 * OverviewGrid — the unified Connections & Tasks CardDataGrid shared by every
 * server-monitor overview surface (admin-ui's Dashboard, the Monitor
 * Overview tab in monitor-ui / rocket-ui / the VSCode webview).
 *
 * Always LOCAL mode (data-in, callbacks-out; no shell imports): the host
 * hands down the dashboard snapshot, and each new snapshot applies silently
 * in place (connections first, then running tasks, then the five most recent
 * completed ones). Clicking a client row opens the connection record panel;
 * clicking a task row opens the task record panel.
 *
 * Layout persistence rides the grid config channel via the stable
 * 'server-overview' tableId — the hosting shell (web workspace prefs or the
 * VSCode extension bridge) answers it; no persistence prop is threaded.
 */

import React, { useMemo, useState } from 'react';
import type { CellComponent } from 'tabulator-tables';
import { Button } from '../../../components/button/Button';
import { Card } from '../../../components/card/Card';
import { CardDataGrid } from '../../../components/data-grid/CardDataGrid';
import { badgeEl, monoEl, mutedEl } from '../../../components/data-grid/defaults';
import type { CellBadgeVariant, GridColumnDefinition } from '../../../components/data-grid/defaults';
import type { DashboardResponse, DashboardTask } from '../types';
import { formatNumber, formatTimeAgo, formatUptime } from '../util';
import { ConnectionRecordPanel } from './ConnectionRecordPanel';
import { TaskRecordPanel, taskStatusText } from './TaskRecordPanel';

// =============================================================================
// TYPES
// =============================================================================

/** Unified grid row: one connection or one task, pre-derived to display fields. */
interface ConnTaskRow extends Record<string, unknown> {
	/** Stable row key (conn-N / task-id). */
	key: string;
	/** Row kind: an authenticated client connection or a managed task. */
	kind: 'client' | 'task';
	/** Display name (client name, client id, or task name / id fallback). */
	name: string;
	/** Secondary identity line (connection number, or provider · project · source). */
	detail: string;
	/** Messages received from the client; null on task rows. */
	messagesIn: number | null;
	/** Messages sent to the client; null on task rows. */
	messagesOut: number | null;
	/** CPU percent of a running task; null for connections / completed tasks. */
	cpu: number | null;
	/** CPU memory MB of a running task; null for connections / completed tasks. */
	memory: number | null;
	/** Row age in seconds (sortable raw value behind elapsedText). */
	elapsed: number;
	/** Pre-rendered age text (relative age for clients, duration for tasks). */
	elapsedText: string;
	/** Derived state label (the Status cell / enum filter value). */
	status: string;
	/** Whether a task row has finished. */
	completed: boolean;
	/** Exit code of a completed task; null otherwise. */
	exitCode: number | null;
	/** Connection id for client rows (opens the record panel); null on tasks. */
	connId: number | null;
	/** Task id for task rows (opens the task record panel); null on clients. */
	taskId: string | null;
}

/** Props for the {@link OverviewGrid} component. */
export interface IOverviewGridProps {
	/** Full dashboard snapshot, or null while it has not loaded yet. */
	data: DashboardResponse | null;
	/** Optional manual refresh callback — renders the header's Refresh action. */
	onRefresh?: () => void;
}

// =============================================================================
// STYLES
// =============================================================================

/** DOM styles for the grid cell formatters (cells render outside React). */
const domStyles = {
	// Primary line of the two-line Name cell.
	cellTitle: {
		fontWeight: '500',
		color: 'var(--rr-text-primary)',
	} as Partial<CSSStyleDeclaration>,

	// Secondary identity line of the two-line Name cell.
	cellSub: {
		fontSize: '11px',
		color: 'var(--rr-text-disabled)',
		marginTop: '1px',
	} as Partial<CSSStyleDeclaration>,

	// In/out message counter group in a client row's identity line.
	msgGroup: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '3px',
		marginRight: '6px',
	} as Partial<CSSStyleDeclaration>,

	// Inbound message arrow tint.
	msgArrowIn: {
		color: 'var(--rr-color-success)',
		fontSize: '9px',
	} as Partial<CSSStyleDeclaration>,

	// Outbound message arrow tint.
	msgArrowOut: {
		color: 'var(--rr-border-focus)',
		fontSize: '9px',
	} as Partial<CSSStyleDeclaration>,

	// Small colored kind label in the Type cell.
	typeLabel: {
		fontSize: '11px',
	} as Partial<CSSStyleDeclaration>,

	// Inline gauge block (bar + trailing value label) for CPU / Memory cells.
	gaugeWrap: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '8px',
		width: '100%',
		minWidth: '100px',
	} as Partial<CSSStyleDeclaration>,

	// Gauge track (background).
	gaugeTrack: {
		flex: '1',
		height: '6px',
		background: 'color-mix(in srgb, var(--rr-border) 30%, transparent)',
		borderRadius: '3px',
		overflow: 'hidden',
	} as Partial<CSSStyleDeclaration>,

	// Gauge fill (width and color set per cell from the value).
	gaugeFill: {
		height: '100%',
		borderRadius: '3px',
	} as Partial<CSSStyleDeclaration>,

	// Trailing gauge value label.
	gaugeLabel: {
		fontSize: '11px',
		color: 'var(--rr-text-secondary)',
		minWidth: '40px',
		textAlign: 'right',
	} as Partial<CSSStyleDeclaration>,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Pick the status badge variant for a unified-table row: success for
 * connected clients and running tasks, warning near the idle timeout, muted
 * for a clean exit, error for a failed one.
 *
 * @param row - The unified grid row.
 * @returns The badge variant.
 */
function statusVariant(row: ConnTaskRow): CellBadgeVariant {
	if (row.completed) return row.exitCode === 0 ? 'muted' : 'error';
	if (row.status === 'idle (ttl)') return 'warning';
	return 'success';
}

// =============================================================================
// DOM CELL BUILDERS
// =============================================================================

/**
 * Build the two-line Name cell: the display name over a muted identity line.
 * Client rows append the message in/out counters with colored direction
 * arrows; task rows show provider · project · source.
 *
 * @param row - The unified grid row.
 * @returns The cell element.
 */
function nameCellEl(row: ConnTaskRow): HTMLElement {
	// Step 1: primary display name.
	const wrap = document.createElement('div');
	const title = document.createElement('div');
	Object.assign(title.style, domStyles.cellTitle);
	title.textContent = row.name;
	// Step 2: muted identity line.
	const sub = document.createElement('div');
	Object.assign(sub.style, domStyles.cellSub);
	if (row.kind === 'client') {
		// Connection number, then the in/out message counters with arrows.
		sub.append(`${row.detail} · `);
		const inGroup = document.createElement('span');
		Object.assign(inGroup.style, domStyles.msgGroup);
		const inArrow = document.createElement('span');
		Object.assign(inArrow.style, domStyles.msgArrowIn);
		inArrow.textContent = '▼';
		inGroup.append(inArrow, formatNumber(row.messagesIn ?? 0));
		const outGroup = document.createElement('span');
		Object.assign(outGroup.style, domStyles.msgGroup);
		const outArrow = document.createElement('span');
		Object.assign(outArrow.style, domStyles.msgArrowOut);
		outArrow.textContent = '▲';
		outGroup.append(outArrow, formatNumber(row.messagesOut ?? 0));
		sub.append(inGroup, outGroup);
	} else {
		sub.textContent = row.detail;
	}
	wrap.append(title, sub);
	return wrap;
}

/**
 * Build the Type cell: a small kind label tinted green for clients, focus
 * blue for running tasks, and dimmed for completed ones.
 *
 * @param row - The unified grid row.
 * @returns The cell element.
 */
function typeCellEl(row: ConnTaskRow): HTMLElement {
	const el = document.createElement('span');
	Object.assign(el.style, domStyles.typeLabel);
	el.style.color = row.kind === 'client' ? 'var(--rr-color-success)' : row.completed ? 'var(--rr-text-disabled)' : 'var(--rr-border-focus)';
	el.textContent = row.kind;
	return el;
}

/**
 * Build an inline gauge cell (tinted fill bar + trailing value label) for
 * the CPU and Memory columns of running tasks.
 *
 * @param pct - Fill percentage (clamped to 100).
 * @param label - Value label rendered after the bar.
 * @param color - CSS color of the fill.
 * @returns The gauge element.
 */
function gaugeEl(pct: number, label: string, color: string): HTMLElement {
	// Step 1: full-width flex block so the bar stretches with the column.
	const wrap = document.createElement('span');
	Object.assign(wrap.style, domStyles.gaugeWrap);
	// Step 2: track + clamped fill.
	const track = document.createElement('span');
	Object.assign(track.style, domStyles.gaugeTrack);
	track.style.display = 'block';
	const fill = document.createElement('span');
	Object.assign(fill.style, domStyles.gaugeFill);
	fill.style.display = 'block';
	fill.style.background = color;
	fill.style.width = `${Math.min(pct, 100)}%`;
	track.appendChild(fill);
	// Step 3: trailing numeric label.
	const text = document.createElement('span');
	Object.assign(text.style, domStyles.gaugeLabel);
	text.textContent = label;
	wrap.append(track, text);
	return wrap;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Overview grid — the unified Connections & Tasks CardDataGrid: connections
 * first, then running tasks, then the five most recent completed ones, with
 * CPU/Memory gauges and status badges. Clicking a client row opens the
 * connection record panel; clicking a task row opens the task record panel.
 *
 * @param props - {@link IOverviewGridProps}.
 * @returns The card-hosted grid plus both record panels.
 */
export const OverviewGrid: React.FC<IOverviewGridProps> = ({ data, onRefresh }) => {
	// Connection selected from a client row click; opens the record panel.
	const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
	// Task selected from a task row click; opens the task record panel.
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

	/**
	 * Flatten the snapshot into unified grid rows: connections first, then
	 * running tasks, then the five most recent completed tasks — the grid's
	 * default (unsorted) order.
	 */
	const rows = useMemo<ConnTaskRow[]>(() => {
		if (!data) return [];
		// Connection rows: identity + traffic counters, no metrics.
		const connRows = data.connections.map<ConnTaskRow>((conn) => ({
			key: `conn-${conn.id}`,
			kind: 'client',
			taskId: null,
			name: conn.clientInfo?.name || conn.clientId || `Conn #${conn.id}`,
			detail: `Connection #${conn.id}`,
			messagesIn: conn.messagesIn,
			messagesOut: conn.messagesOut,
			cpu: null,
			memory: null,
			elapsed: Math.max(0, Math.round(Date.now() / 1000 - conn.connectedAt)),
			elapsedText: formatTimeAgo(conn.connectedAt),
			status: 'connected',
			completed: false,
			exitCode: null,
			connId: conn.id,
		}));
		// Task rows: live metrics while running, dimmed exit state afterwards.
		const taskRow = (task: DashboardTask): ConnTaskRow => {
			const m = task.metrics as Record<string, number> | null;
			return {
				key: `task-${task.id}`,
				kind: 'task',
				taskId: task.id,
				name: task.name || task.id,
				detail: `${task.provider} · ${task.projectId?.slice(0, 8) ?? ''}${task.source ? ` · ${task.source}` : ''}`,
				messagesIn: null,
				messagesOut: null,
				cpu: task.completed ? null : (m?.cpu_percent ?? 0),
				memory: task.completed ? null : (m?.cpu_memory_mb ?? 0),
				elapsed: task.elapsedTime,
				elapsedText: formatUptime(task.elapsedTime),
				status: taskStatusText(task),
				completed: task.completed,
				exitCode: task.exitCode,
				connId: null,
			};
		};
		const running = data.tasks.filter((t) => !t.completed).map(taskRow);
		const completed = data.tasks
			.filter((t) => t.completed)
			.slice(0, 5)
			.map(taskRow);
		return [...connRows, ...running, ...completed];
	}, [data]);

	/**
	 * Unified table column definitions — DOM formatters from the stock cell
	 * factories plus the gauge / two-line builders. `rrDefault` marks the
	 * default view (array order = display order); no default sort, so the
	 * connections-then-tasks data order holds.
	 */
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{
				title: 'Name',
				field: 'name',
				rrType: 'string',
				rrDefault: true,
				rrDescription: 'Client or task display name; the second line carries the identity detail — connection number with message in/out counters for clients, provider · project · source for tasks.',
				headerSort: true,
				formatter: (cell: CellComponent) => nameCellEl(cell.getRow().getData() as ConnTaskRow),
			},
			{
				title: 'Type',
				field: 'kind',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: 'Row kind: client is an authenticated WebSocket connection, task is a managed task from the server registry.',
				width: 90,
				headerSort: true,
				formatter: (cell: CellComponent) => typeCellEl(cell.getRow().getData() as ConnTaskRow),
			},
			{
				title: 'CPU',
				field: 'cpu',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'CPU utilisation of a running task as a percentage of one core (the cpu_percent metric); connections and completed tasks report none.',
				headerSort: true,
				sorter: 'number',
				// Gauge for running tasks; muted placeholder elsewhere.
				formatter: (cell: CellComponent) => {
					const cpu = cell.getValue() as number | null;
					if (cpu === null) return mutedEl('--');
					return gaugeEl(cpu, `${cpu.toFixed(0)}%`, 'var(--rr-border-focus)');
				},
			},
			{
				title: 'Memory',
				field: 'memory',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Resident CPU memory of a running task in MB (the cpu_memory_mb metric); the gauge scales against a 2048 MB reference; connections and completed tasks report none.',
				headerSort: true,
				sorter: 'number',
				// Gauge for running tasks; muted placeholder elsewhere.
				formatter: (cell: CellComponent) => {
					const mem = cell.getValue() as number | null;
					if (mem === null) return mutedEl('--');
					return gaugeEl((mem / 2048) * 100, `${mem.toFixed(0)}M`, 'var(--rr-accent)');
				},
			},
			{
				title: 'Elapsed',
				field: 'elapsed',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Row age in seconds: time since the connection was established (shown as a relative age) or the task runtime duration (shown as a compact duration).',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => monoEl((cell.getRow().getData() as ConnTaskRow).elapsedText),
			},
			{
				title: 'Status',
				field: 'status',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: 'Live state: connected for clients; running or idle (ttl) for active tasks (idle when past 80% of the TTL); exit N once a task finishes (non-zero = failure).',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as ConnTaskRow;
					return badgeEl(statusVariant(row), String(cell.getValue() ?? ''));
				},
			},
		],
		[]
	);

	return (
		<>
			{/* ── Unified Connections & Tasks grid ─────────────────────
			    The grid IS the card: its header carries the title, the
			    magnifier search toggle (collapsed by default — search is
			    one glyph now, so even this small live table keeps it),
			    and the Refresh action. paginate={false}: the table
			    renders whole. Clicking a client row opens the record
			    panel. */}
			<Card noBodyPadding>
				<CardDataGrid<ConnTaskRow>
					title="Connections & Tasks"
					actions={
						onRefresh ? (
							<Button variant="ghost" small onClick={onRefresh}>
								Refresh
							</Button>
						) : undefined
					}
					columns={columns}
					data={rows}
					paginate={false}
					tableId="server-overview"
					emptyTitle="No connections or tasks"
					onRowClick={(row) => {
						if (row.kind === 'client' && row.connId !== null) setSelectedConnId(row.connId);
						else if (row.kind === 'task' && row.taskId !== null) setSelectedTaskId(row.taskId);
					}}
				/>
			</Card>

			{/* ── Connection record panel (client row click) ──────────────────── */}
			<ConnectionRecordPanel connectionId={selectedConnId} connections={data?.connections ?? []} onClose={() => setSelectedConnId(null)} />
			{/* Task record panel (task row click). */}
			<TaskRecordPanel taskId={selectedTaskId} tasks={data?.tasks ?? []} onClose={() => setSelectedTaskId(null)} />
		</>
	);
};
