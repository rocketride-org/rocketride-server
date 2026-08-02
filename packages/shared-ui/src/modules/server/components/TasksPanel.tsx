// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// TASKS GRID — Running and completed pipeline tasks (CardDataGrid, host-agnostic)
// =============================================================================

/**
 * TasksPanel — the All Tasks CardDataGrid shared by every server-monitor host
 * (admin-ui, monitor-ui, rocket-ui, the VSCode webview).
 *
 * Data modes follow the props (data-in, callbacks-out; no shell imports):
 *  - `listTasks` present — REMOTE: every page request (browse, sort, filter,
 *    search) goes through the fetcher, which the host binds to its client's
 *    `listTasks`; the host drives the quiet 3s refetch through
 *    `onRefetchReady`. The `tasks` snapshot then feeds ONLY the header's
 *    running/completed counts.
 *  - `listTasks` absent — LOCAL: rows come from the `tasks` snapshot prop
 *    (the pushed dashboard snapshot), applied silently on each change.
 *
 * Layout persistence rides the grid config channel via the stable
 * 'server-tasks' tableId — the hosting shell (web workspace prefs or the
 * VSCode extension bridge) answers it; no persistence prop is threaded.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CellComponent } from 'tabulator-tables';
import type { ListPageRequest, ListPageResponse } from 'rocketride';
import { Card, CardDataGrid, badgeEl, monoEl, mutedEl } from 'shell';
import type { GridColumnDefinition, IDataGridHandle, IDataGridPage, IDataGridPageRequest } from 'shell';
import type { DashboardTask } from '../types';
import { formatNumber, formatUptime } from '../util';
import { TaskRecordPanel, taskStatusText, taskStatusVariant } from './TaskRecordPanel';

// =============================================================================
// TYPES
// =============================================================================

/** Flattened grid row: one dashboard task, pre-derived to display fields. */
interface TaskRow extends Record<string, unknown> {
	/** Internal task identifier (stable row key). */
	id: string;
	/** Display name (falls back to the task id when unnamed). */
	name: string;
	/** Secondary identity line: provider, launch type, project id prefix. */
	detail: string;
	/** Source component identifier. */
	source: string;
	/** Runtime duration in seconds. */
	elapsed: number;
	/** CPU utilisation percent of the running task; null when completed. */
	cpu: number | null;
	/** Resident CPU memory in MB of the running task; null when completed. */
	mem: number | null;
	/** Items completed so far. */
	completions: number;
	/** Seconds since last activity. */
	idle: number;
	/** Time-to-live in seconds (0 = no timeout). */
	ttl: number;
	/** Whether the task has finished. */
	completed: boolean;
	/** Exit code (completed tasks only). */
	exitCode: number | null;
	/** Derived state label (the Status cell / enum filter value). */
	status: string;
}

/** Props for the {@link TasksPanel} component. */
export interface ITasksPanelProps {
	/**
	 * Snapshot task rows (the dashboard snapshot): feeds the header's
	 * running/completed counts in both modes, and the grid rows plus record
	 * panel in LOCAL mode. Null while the snapshot has not loaded yet (the
	 * header counts stay hidden).
	 */
	tasks?: DashboardTask[] | null;
	/**
	 * Optional server-paginated fetcher — presence switches the grid to
	 * REMOTE mode. Hosts bind it to their client's `listTasks`.
	 */
	listTasks?: (req: ListPageRequest) => Promise<ListPageResponse<DashboardTask>>;
	/**
	 * Receives the grid's silent current-page refetch trigger (REMOTE mode
	 * only) so the HOST owns the polling cadence.
	 */
	onRefetchReady?: (refetch: () => void) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Muted running/completed counts in the card header's action slot.
	headerCount: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

/** DOM styles for the grid cell formatters (cells render outside React). */
const domStyles = {
	// Primary line of the two-line Task cell.
	cellTitle: {
		fontWeight: '500',
		color: 'var(--rr-text-primary)',
	} as Partial<CSSStyleDeclaration>,

	// Secondary identity line of the two-line Task cell.
	cellSub: {
		fontSize: '11px',
		color: 'var(--rr-text-disabled)',
		marginTop: '2px',
	} as Partial<CSSStyleDeclaration>,

	// Fixed-width gauge block (bar + trailing value label).
	gaugeWrap: {
		display: 'inline-flex',
		flexDirection: 'column',
		width: '80px',
	} as Partial<CSSStyleDeclaration>,

	// Right-aligned value label above the gauge bar.
	gaugeLabel: {
		fontSize: '10px',
		color: 'var(--rr-text-disabled)',
		marginBottom: '2px',
		textAlign: 'right',
	} as Partial<CSSStyleDeclaration>,

	// Gauge track (background).
	gaugeTrack: {
		height: '4px',
		background: 'color-mix(in srgb, var(--rr-border) 30%, transparent)',
		borderRadius: '2px',
		overflow: 'hidden',
	} as Partial<CSSStyleDeclaration>,

	// Gauge fill (width set per cell from the value).
	gaugeFill: {
		height: '100%',
		borderRadius: '2px',
	} as Partial<CSSStyleDeclaration>,

	// Warning tint for a TTL / Idle pair past 80% of its timeout.
	ttlWarning: {
		color: 'var(--rr-color-warning)',
	} as Partial<CSSStyleDeclaration>,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Flatten one task wire row (the dashboard snapshot keys the list API
 * returns) into its grid display row: derived identity line, live metrics
 * only while running, and the derived status label.
 *
 * @param task - The task wire row.
 * @returns The grid row.
 */
function taskRow(task: DashboardTask): TaskRow {
	// Metrics only exist while a task runs; completed rows show placeholders.
	const m = task.metrics as Record<string, number> | null;
	return {
		id: task.id,
		name: task.name || task.id,
		detail: `${task.provider} · ${task.launchType} · ${task.projectId?.slice(0, 8) ?? ''}`,
		source: task.source,
		elapsed: task.elapsedTime,
		cpu: task.completed ? null : (m?.cpu_percent ?? 0),
		mem: task.completed ? null : (m?.cpu_memory_mb ?? 0),
		completions: task.completedCount,
		idle: task.idleTime,
		ttl: task.ttl,
		completed: task.completed,
		exitCode: task.exitCode,
		status: taskStatusText(task),
	};
}

/**
 * Build a mini gauge cell (value label over a tinted fill bar) for the CPU
 * and Memory columns of running tasks.
 *
 * @param pct - Fill percentage (clamped to 100).
 * @param label - Value label rendered above the bar.
 * @param color - CSS color of the fill.
 * @returns The gauge element.
 */
function gaugeEl(pct: number, label: string, color: string): HTMLElement {
	// Step 1: fixed-width block so gauges align down the column.
	const wrap = document.createElement('span');
	Object.assign(wrap.style, domStyles.gaugeWrap);
	// Step 2: numeric label above the bar.
	const text = document.createElement('span');
	Object.assign(text.style, domStyles.gaugeLabel);
	text.textContent = label;
	// Step 3: track + clamped fill.
	const track = document.createElement('span');
	Object.assign(track.style, domStyles.gaugeTrack);
	track.style.display = 'block';
	const fill = document.createElement('span');
	Object.assign(fill.style, domStyles.gaugeFill);
	fill.style.display = 'block';
	fill.style.background = color;
	fill.style.width = `${Math.min(pct, 100)}%`;
	track.appendChild(fill);
	wrap.append(text, track);
	return wrap;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Tasks grid — all pipeline tasks as a CardDataGrid with CPU/Memory gauges,
 * elapsed time, completion counts, TTL/idle time, and status badges;
 * clicking a row opens the task record panel.
 *
 * @param props - {@link ITasksPanelProps}.
 * @returns The card-hosted grid plus its record panel.
 */
export const TasksPanel: React.FC<ITasksPanelProps> = ({ tasks, listTasks, onRefetchReady }) => {
	// Stable snapshot list (the fallback while the snapshot is still loading
	// would otherwise be a fresh [] every render).
	const snapshotTasks = useMemo<DashboardTask[]>(() => tasks ?? [], [tasks]);

	// ── Record panel state ────────────────────────────────────────────────
	// The latest fetched page of WIRE rows (REMOTE), captured by the fetcher:
	// the record panel re-resolves its task here on every render, so each
	// poll refresh keeps the open panel live (and the panel holds its
	// last-known snapshot if the row pages out rather than auto-closing).
	const [pageRows, setPageRows] = useState<DashboardTask[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	// Imperative grid handle: the host's poll re-requests the current page.
	const gridRef = useRef<IDataGridHandle>(null);

	/**
	 * Fetch one page of tasks for the grid (REMOTE mode). Browsing, header
	 * sorting, filtering, and the title-bar search all ride the host's
	 * `listTasks` fetcher, which resolves everything server-side and returns
	 * the filtered total.
	 *
	 * @param req - The grid page request (1-based page, like the list APIs).
	 * @returns The page of display rows and the total row count.
	 */
	const fetchTasks = useCallback(
		async (req: IDataGridPageRequest): Promise<IDataGridPage<TaskRow>> => {
			// Step 1: LOCAL grids never call this; the guard keeps TS honest.
			if (!listTasks) return { rows: [], total: 0 };
			// Step 2: one server-paginated call. Sorters, filter values, and the
			// search term are forwarded verbatim — the server whitelists the row
			// keys, drops anything unknown, and matches across ALL pages.
			const resp = await listTasks({
				page: req.page,
				page_size: req.size,
				sort: req.sort,
				filters: req.filters,
				...(req.search !== undefined ? { search: req.search } : {}),
			});
			// Step 3: capture the wire rows for the record panel lookup, then
			// flatten them (dashboard snapshot keys) for display.
			const wireRows = resp?.rows ?? [];
			setPageRows(wireRows);
			return { rows: wireRows.map(taskRow), total: resp?.total ?? 0 };
		},
		[listTasks]
	);

	// Hand the silent current-page refetch (no page reset) up to the host —
	// the host owns usePolling and calls it on each tick (REMOTE mode only;
	// LOCAL grids refresh through the `tasks` prop instead).
	useEffect(() => {
		if (!listTasks || !onRefetchReady) return;
		onRefetchReady(() => {
			gridRef.current?.refetch();
		});
	}, [listTasks, onRefetchReady]);

	// LOCAL rows: the snapshot tasks flattened to display rows (identity
	// change applies silently — scroll, page, and sort preserved).
	const localRows = useMemo<TaskRow[]>(() => snapshotTasks.map(taskRow), [snapshotTasks]);

	// Header counts: running vs completed split of the polled snapshot.
	const runningCount = snapshotTasks.filter((t) => !t.completed).length;
	const completedCount = snapshotTasks.length - runningCount;

	/**
	 * Task list column definitions — DOM formatters from the stock cell
	 * factories plus the mini gauge builder. `rrDefault` marks the default
	 * view (array order = display order); numeric columns declare
	 * `rrType: 'number'` (Min/Max filter, right-aligned); status is an enum
	 * with a declared `rrOptions` vocabulary (remote grids have no distinct
	 * endpoint to derive a checklist from). Sorting is remote: header clicks
	 * ride the page request to the server.
	 */
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{
				title: 'Task',
				field: 'name',
				rrType: 'string',
				rrDefault: true,
				rrDescription: 'Task display name (pipeline filename, config name, or source id — the internal task id when unnamed); the second line shows provider, launch type (launch or execute), and the first 8 characters of the project id.',
				headerSort: true,
				// Two-line cell: name over the provider / launch-type / project line.
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as TaskRow;
					const wrap = document.createElement('div');
					const title = document.createElement('div');
					Object.assign(title.style, domStyles.cellTitle);
					title.textContent = row.name;
					const sub = document.createElement('div');
					Object.assign(sub.style, domStyles.cellSub);
					sub.textContent = row.detail;
					wrap.append(title, sub);
					return wrap;
				},
			},
			{
				title: 'Source',
				field: 'source',
				rrType: 'string',
				rrDefault: true,
				rrDescription: 'Source component identifier the task was launched from (the source node id of the pipeline).',
				headerSort: true,
			},
			{
				title: 'Elapsed',
				field: 'elapsed',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Runtime duration in seconds since the task started, rendered as a compact duration (e.g. 4m 7s).',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => monoEl(formatUptime(cell.getValue() as number)),
			},
			{
				title: 'CPU',
				field: 'cpu',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'CPU utilisation of the running task as a percentage of one core (the cpu_percent metric); completed tasks report none.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				// Mini gauge while running; muted placeholder once completed.
				formatter: (cell: CellComponent) => {
					const cpu = cell.getValue() as number | null;
					if (cpu === null) return mutedEl('-');
					return gaugeEl(cpu, `${cpu.toFixed(0)}%`, 'var(--rr-border-focus)');
				},
			},
			{
				title: 'Memory',
				field: 'mem',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Resident CPU memory of the running task in MB (the cpu_memory_mb metric); the gauge scales against a 2048 MB reference; completed tasks report none.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				// Mini gauge while running; muted placeholder once completed.
				formatter: (cell: CellComponent) => {
					const mem = cell.getValue() as number | null;
					if (mem === null) return mutedEl('-');
					return gaugeEl((mem / 2048) * 100, `${mem.toFixed(0)}M`, 'var(--rr-accent)');
				},
			},
			{
				title: 'Completions',
				field: 'completions',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Items the task has completed so far (the completedCount progress counter); 0 renders as a muted placeholder.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => {
					const count = cell.getValue() as number;
					return count > 0 ? monoEl(formatNumber(count)) : mutedEl('-');
				},
			},
			{
				title: 'TTL / Idle',
				field: 'idle',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Seconds since the task last saw activity, over its time-to-live in seconds (0 TTL = no idle timeout); the pair turns warning-colored when idle time passes 80% of the TTL.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				// idle / ttl pair; '-' when completed, 'none' when no timeout is set.
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as TaskRow;
					if (row.completed) return mutedEl('-');
					if (row.ttl === 0) return mutedEl('none');
					const el = monoEl(`${formatUptime(row.idle)} / ${formatUptime(row.ttl)}`);
					if (row.idle / row.ttl > 0.8) Object.assign(el.style, domStyles.ttlWarning);
					return el;
				},
			},
			{
				title: 'Status',
				field: 'status',
				rrType: 'enum',
				rrDefault: true,
				// Declared filter vocabulary: the stable state families the status
				// derivation produces (failed cells additionally carry the exit
				// code). A remote grid has no distinct-value endpoint, so without
				// rrOptions the enum filter would fall back to a plain text input.
				rrOptions: ['running', 'completed', 'failed', 'idle (ttl)'],
				rrDescription: 'Task state: the live status message while running (falling back to running), idle (ttl) near the idle timeout, completed on a clean exit, failed (code) otherwise.',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as TaskRow;
					// Badge family shared with the record panel's Status section.
					return badgeEl(taskStatusVariant(row.completed, row.exitCode, row.status), String(cell.getValue() ?? ''));
				},
			},
		],
		[]
	);

	// The record panel resolves against whichever WIRE rows back the grid:
	// the latest fetched page (REMOTE) or the live snapshot (LOCAL).
	const panelRows = listTasks ? pageRows : snapshotTasks;

	return (
		<>
			{/* ── All tasks ─────────────────────────────────────────────
			   The grid IS the card: its header carries the title, the
			   running/completed counts (`actions`), and the search box.
			   REMOTE mode: fetchPage + remoteSort resolve paging, sorting,
			   filtering, and search server-side; the host's 3s poll
			   silently re-requests the current page. LOCAL mode: the
			   snapshot rows apply silently in place. Clicking a row opens
			   the task record panel. */}
			<Card noBodyPadding>
				<CardDataGrid<TaskRow>
					ref={gridRef}
					title="All Tasks"
					actions={
						tasks != null ? (
							<span style={styles.headerCount}>
								{runningCount} running · {completedCount} completed
							</span>
						) : undefined
					}
					columns={columns}
					{...(listTasks ? { fetchPage: fetchTasks, remoteSort: true } : { data: localRows })}
					tableId="server-tasks"
					emptyTitle="No tasks"
					onRowClick={(row) => setSelectedId(row.id)}
				/>
			</Card>

			{/* ── Task record panel (row click) ───────────────────────────── */}
			<TaskRecordPanel taskId={selectedId} tasks={panelRows} onClose={() => setSelectedId(null)} />
		</>
	);
};
