// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CONNECTIONS GRID — Active server connections (CardDataGrid, host-agnostic)
// =============================================================================

/**
 * ConnectionsPanel — the Active Connections CardDataGrid shared by every
 * server-monitor host (admin-ui, monitor-ui, rocket-ui, the VSCode webview).
 *
 * Data modes follow the props (data-in, callbacks-out; no shell imports):
 *  - `listConnections` present — REMOTE: every page request (browse, sort,
 *    filter, search) goes through the fetcher, which the host binds to its
 *    client's `listConnections`; the host drives the quiet 3s refetch through
 *    `onRefetchReady`.
 *  - `listConnections` absent — LOCAL: rows come from the `connections`
 *    snapshot prop (the pushed dashboard snapshot), applied silently on each
 *    identity change.
 *
 * Layout persistence rides the grid config channel via the stable
 * 'server-connections' tableId — the hosting shell (web workspace prefs or
 * the VSCode extension bridge) answers it; no persistence prop is threaded.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CellComponent } from 'tabulator-tables';
import type { ListPageRequest, ListPageResponse } from 'rocketride';
import { Card } from '../../../components/card/Card';
import { CardDataGrid } from '../../../components/data-grid/CardDataGrid';
import { badgeEl, monoEl, mutedEl } from '../../../components/data-grid/defaults';
import type { GridColumnDefinition } from '../../../components/data-grid/defaults';
import type { IDataGridHandle, IDataGridPage, IDataGridPageRequest } from '../../../components/data-grid/DataGrid';
import type { DashboardConnection } from '../types';
import { formatNumber, formatTime, formatTimeAgo } from '../util';
import { ConnectionRecordPanel } from './ConnectionRecordPanel';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Grid row: one active connection, carrying exactly the dashboard snapshot
 * row keys (the list API returns the same shape), widened with the index
 * signature the DataGrid row constraint requires.
 */
type ConnectionRow = DashboardConnection & Record<string, unknown>;

/** Props for the {@link ConnectionsPanel} component. */
export interface IConnectionsPanelProps {
	/**
	 * Snapshot connection rows (the dashboard snapshot). LOCAL mode renders
	 * exactly these; with `listConnections` present the fetched pages take
	 * over and this prop is unused.
	 */
	connections?: DashboardConnection[];
	/**
	 * Optional server-paginated fetcher — presence switches the grid to
	 * REMOTE mode. Hosts bind it to their client's `listConnections`.
	 */
	listConnections?: (req: ListPageRequest) => Promise<ListPageResponse<DashboardConnection>>;
	/**
	 * Receives the grid's silent current-page refetch trigger (REMOTE mode
	 * only) so the HOST owns the polling cadence.
	 */
	onRefetchReady?: (refetch: () => void) => void;
}

// =============================================================================
// STYLES
// =============================================================================

/** DOM styles for the grid cell formatters (cells render outside React). */
const domStyles = {
	// Primary line of the two-line Connection cell.
	cellTitle: {
		fontWeight: '500',
		color: 'var(--rr-text-primary)',
	} as Partial<CSSStyleDeclaration>,

	// Secondary identity line of the two-line Connection cell.
	cellSub: {
		fontSize: '11px',
		color: 'var(--rr-text-disabled)',
		marginTop: '2px',
	} as Partial<CSSStyleDeclaration>,

	// Small tinted client label in the Client cell.
	typeLabel: {
		fontSize: '11px',
		color: 'var(--rr-color-success)',
	} as Partial<CSSStyleDeclaration>,

	// In/out message counter group (arrow glyph + formatted count).
	msgGroup: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '3px',
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
};

// =============================================================================
// DOM CELL BUILDERS
// =============================================================================

/**
 * Build the two-line Connection cell: the client display name from the auth
 * handshake (falling back to the account id, then the connection number) over
 * a muted connection-number identity line.
 *
 * @param row - The connection grid row.
 * @returns The cell element.
 */
function nameCellEl(row: ConnectionRow): HTMLElement {
	// Step 1: primary display name with the legacy fallback chain.
	const wrap = document.createElement('div');
	const title = document.createElement('div');
	Object.assign(title.style, domStyles.cellTitle);
	title.textContent = row.clientInfo?.name || row.clientId || `Conn #${row.id}`;
	// Step 2: muted connection-number identity line.
	const sub = document.createElement('div');
	Object.assign(sub.style, domStyles.cellSub);
	sub.textContent = `Connection #${row.id}`;
	wrap.append(title, sub);
	return wrap;
}

/**
 * Build the Client cell: a small tinted label with the client name and
 * version reported in the auth handshake, or a muted placeholder for
 * connections that have not identified themselves.
 *
 * @param row - The connection grid row.
 * @returns The cell element.
 */
function clientCellEl(row: ConnectionRow): HTMLElement {
	// Step 1: unidentified clients render as a muted placeholder.
	const name = row.clientInfo?.name;
	if (!name) return mutedEl('--');
	// Step 2: tinted client label, version appended when reported.
	const el = document.createElement('span');
	Object.assign(el.style, domStyles.typeLabel);
	const version = row.clientInfo?.version;
	el.textContent = version ? `${name} ${version}` : name;
	return el;
}

/**
 * Build a message counter cell: a direction arrow (down for received, up for
 * sent) followed by the formatted count.
 *
 * @param count - The message count.
 * @param direction - 'in' for messages received, 'out' for messages sent.
 * @returns The cell element.
 */
function msgCounterEl(count: number, direction: 'in' | 'out'): HTMLElement {
	// Step 1: inline group so the arrow and count sit on one baseline.
	const wrap = document.createElement('span');
	Object.assign(wrap.style, domStyles.msgGroup);
	// Step 2: direction arrow — success green inbound, focus blue outbound.
	const arrow = document.createElement('span');
	Object.assign(arrow.style, direction === 'in' ? domStyles.msgArrowIn : domStyles.msgArrowOut);
	arrow.textContent = direction === 'in' ? '▼' : '▲';
	wrap.append(arrow, formatNumber(count));
	return wrap;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Connections grid — every active client connection as a CardDataGrid with
 * identity, client label, traffic counters, subscription counts, and auth
 * status; clicking a row opens the connection record panel.
 *
 * @param props - {@link IConnectionsPanelProps}.
 * @returns The card-hosted grid plus its record panel.
 */
export const ConnectionsPanel: React.FC<IConnectionsPanelProps> = ({ connections, listConnections, onRefetchReady }) => {
	// ── Record panel state ────────────────────────────────────────────────
	// The latest fetched page (REMOTE), captured by the fetcher: the record
	// panel re-resolves its connection here on every render, so each poll
	// refresh keeps the open panel live (and the panel holds its last-known
	// snapshot if the row pages out rather than auto-closing).
	const [pageRows, setPageRows] = useState<ConnectionRow[]>([]);
	const [selectedId, setSelectedId] = useState<number | null>(null);

	// Imperative grid handle: the host's poll re-requests the current page.
	const gridRef = useRef<IDataGridHandle>(null);

	/**
	 * Fetch one page of connections for the grid (REMOTE mode). Browsing,
	 * header sorting, filtering, and the title-bar search all ride the host's
	 * `listConnections` fetcher, which resolves everything server-side and
	 * returns the filtered total. Captures the fetched rows for the record
	 * panel lookup.
	 *
	 * @param req - The grid page request (1-based page, like the list APIs).
	 * @returns The page of rows and the total row count.
	 */
	const fetchConnections = useCallback(
		async (req: IDataGridPageRequest): Promise<IDataGridPage<ConnectionRow>> => {
			// Step 1: LOCAL grids never call this; the guard keeps TS honest.
			if (!listConnections) return { rows: [], total: 0 };
			// Step 2: one server-paginated call. Sorters, filter values, and the
			// search term are forwarded verbatim — the server whitelists the row
			// keys, drops anything unknown, and matches across ALL pages.
			const resp = await listConnections({
				page: req.page,
				page_size: req.size,
				sort: req.sort,
				filters: req.filters,
				...(req.search !== undefined ? { search: req.search } : {}),
			});
			// Step 3: widen the wire rows (dashboard snapshot keys) to grid rows.
			const rows = (resp?.rows ?? []).map((row): ConnectionRow => ({ ...row }));
			const total = resp?.total ?? 0;
			setPageRows(rows);
			return { rows, total };
		},
		[listConnections]
	);

	// Hand the silent current-page refetch (no page reset) up to the host —
	// the host owns usePolling and calls it on each tick (REMOTE mode only;
	// LOCAL grids refresh through the `connections` prop instead).
	useEffect(() => {
		if (!listConnections || !onRefetchReady) return;
		onRefetchReady(() => {
			gridRef.current?.refetch();
		});
	}, [listConnections, onRefetchReady]);

	// LOCAL rows: the snapshot connections widened to grid rows (identity
	// change applies silently — scroll, page, and sort preserved).
	const localRows = useMemo<ConnectionRow[]>(() => (connections ?? []).map((row): ConnectionRow => ({ ...row })), [connections]);

	/**
	 * Connection list column definitions — DOM formatters from the stock cell
	 * factories plus the two-line / label / counter builders. `rrDefault`
	 * marks the default view (array order = display order); sorting is
	 * remote, so array- and object-valued columns declare `headerSort: false`
	 * (no scalar for the server to order by).
	 */
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{
				title: 'Connection',
				field: 'clientId',
				rrType: 'string',
				rrDefault: true,
				rrDescription: 'Account identifier of the authenticated client (null before auth completes); the cell shows the handshake client name — falling back to this id, then the connection number — over the connection number line.',
				headerSort: true,
				// Two-line cell: display name over the connection-number line.
				formatter: (cell: CellComponent) => nameCellEl(cell.getRow().getData() as ConnectionRow),
			},
			{
				title: 'Client',
				field: 'clientInfo',
				rrType: 'json',
				rrDefault: true,
				rrDescription: 'Name/version map the client reported in the auth handshake (empty until the client identifies itself), shown as a tinted client label.',
				// Object-valued column — not a sortable scalar on the server.
				headerSort: false,
				formatter: (cell: CellComponent) => clientCellEl(cell.getRow().getData() as ConnectionRow),
			},
			{
				title: 'User',
				field: 'userName',
				rrType: 'string',
				rrDefault: true,
				rrDescription: "Display name of the connection's user, resolved server-side from the account session (displayName, falling back to email); null means the connection has not authenticated.",
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const name = cell.getValue() as string | null | undefined;
					return name ? name : mutedEl('--');
				},
			},
			{
				title: 'Organization',
				field: 'orgName',
				rrType: 'string',
				rrDefault: true,
				rrDescription: "Display name of the user's organization, resolved server-side from the account session; null means the connection has not authenticated (or the user has no org membership).",
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const name = cell.getValue() as string | null | undefined;
					return name ? name : mutedEl('--');
				},
			},
			{
				title: 'Connected',
				field: 'connectedAt',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Unix timestamp (seconds) when the WebSocket connection was established, rendered as a local time of day.',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => monoEl(formatTime(cell.getValue() as number)),
			},
			{
				title: 'Tasks',
				field: 'attachedTasks',
				rrType: 'strings',
				rrDefault: true,
				rrDescription: 'Display names of the tasks this connection is monitoring (a JSON string array); the cell shows how many.',
				// Array-valued column — not a sortable scalar on the server.
				headerSort: false,
				hozAlign: 'right',
				headerHozAlign: 'right',
				formatter: (cell: CellComponent) => monoEl(String((cell.getValue() as string[] | undefined)?.length ?? 0)),
			},
			{
				title: 'Monitors',
				field: 'monitors',
				rrType: 'json',
				rrDefault: true,
				rrDescription: 'Active monitor subscriptions, each a key plus its event flags; the cell shows how many.',
				// Array-valued column — not a sortable scalar on the server.
				headerSort: false,
				hozAlign: 'right',
				headerHozAlign: 'right',
				formatter: (cell: CellComponent) => monoEl(String((cell.getValue() as unknown[] | undefined)?.length ?? 0)),
			},
			{
				title: 'Msgs In',
				field: 'messagesIn',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Total messages received from this client since it connected.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => msgCounterEl(cell.getValue() as number, 'in'),
			},
			{
				title: 'Msgs Out',
				field: 'messagesOut',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Total messages sent to this client since it connected.',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => msgCounterEl(cell.getValue() as number, 'out'),
			},
			{
				title: 'Last Active',
				field: 'lastActivity',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Unix timestamp (seconds) of the last message received from the client, rendered as a relative age.',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => mutedEl(formatTimeAgo(cell.getValue() as number)),
			},
			{
				title: 'Status',
				field: 'authenticated',
				// Boolean column: the Yes/No filter checklist is static, so it
				// stays a real selector on a remote grid with no distinct endpoint.
				rrType: 'boolean',
				rrDefault: true,
				rrDescription: 'Whether the connection has completed the auth handshake: connected once authenticated, pending before.',
				headerSort: true,
				formatter: (cell: CellComponent) => (cell.getValue() ? badgeEl('success', 'connected') : badgeEl('warning', 'pending')),
			},
			// Default-hidden DECLARED columns (no rrDefault flag): available from
			// the header popup / gear checklist without crowding the default view.
			{
				title: 'ID',
				field: 'id',
				rrType: 'number',
				rrDescription: 'Unique monotonic connection identifier assigned by the server (also shown on the Connection identity line).',
				hozAlign: 'right',
				headerHozAlign: 'right',
				headerSort: true,
				sorter: 'number',
				formatter: (cell: CellComponent) => monoEl(`#${cell.getValue() as number}`),
			},
			{
				title: 'User ID',
				field: 'userId',
				rrType: 'string',
				rrDescription: 'Stable user identifier of the authenticated account, resolved server-side from the session; null until the connection authenticates.',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const id = cell.getValue() as string | null | undefined;
					return id ? monoEl(id) : mutedEl('--');
				},
			},
			{
				title: 'Org ID',
				field: 'orgId',
				rrType: 'string',
				rrDescription: 'Organization identifier of the authenticated user, resolved server-side from the session; null when unauthenticated or without org membership.',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const id = cell.getValue() as string | null | undefined;
					return id ? monoEl(id) : mutedEl('--');
				},
			},
			{
				title: 'API Key',
				field: 'apikey',
				rrType: 'string',
				rrDescription: 'API key the connection authenticated with, masked to its first and last 4 characters.',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const key = cell.getValue() as string | undefined;
					return key ? monoEl(key) : mutedEl('--');
				},
			},
		],
		[]
	);

	// The record panel resolves against whichever rows the grid renders:
	// the latest fetched page (REMOTE) or the live snapshot (LOCAL).
	const panelRows = listConnections ? pageRows : localRows;

	return (
		<>
			{/* ── Active connections ────────────────────────────────────
			   The grid IS the card: its header carries the title and the
			   search box. REMOTE mode: fetchPage + remoteSort resolve
			   paging, sorting, filtering, and search server-side; the
			   host's 3s poll silently re-requests the current page.
			   LOCAL mode: the snapshot rows apply silently in place.
			   Clicking a row opens the connection record panel. */}
			<Card noBodyPadding>
				<CardDataGrid<ConnectionRow> ref={gridRef} title="Active Connections" columns={columns} {...(listConnections ? { fetchPage: fetchConnections, remoteSort: true } : { data: localRows })} tableId="server-connections" emptyTitle="No connections" onRowClick={(row) => setSelectedId(row.id)} />
			</Card>

			{/* ── Connection record panel (row click) ─────────────────────── */}
			<ConnectionRecordPanel connectionId={selectedId} connections={panelRows} onClose={() => setSelectedId(null)} />
		</>
	);
};
