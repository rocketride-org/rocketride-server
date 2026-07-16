// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ApiKeysPanel — the API Keys tab within AccountView.
 *
 * Renders the user's API keys as the stock DataGrid (sortable columns,
 * pagination) inside a stock Card. Each row shows the key name, status badge,
 * team scope, last-used timestamp, expiry date, and (for active non-session
 * keys) a Revoke action. All server interactions are delegated to the host via
 * callback props.
 */

import React, { useMemo, useRef } from 'react';
import type { CellComponent } from 'tabulator-tables';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { DataGrid } from '../../../components/data-grid/DataGrid';
import { buttonEl } from '../../../components/data-grid/defaults';
import type { GridColumnDefinition } from '../../../components/data-grid/defaults';
import type { ApiKeyRecord } from '../types';
import { relativeTime } from './shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Status / team badge shape (commonStyles.badge values + surface fill); text color set per variant. */
	badge: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		padding: '2px 8px',
		fontSize: '11px',
		fontWeight: '600',
		borderRadius: '10px',
		letterSpacing: '0.3px',
		background: 'var(--rr-bg-surface-alt)',
	} as Partial<CSSStyleDeclaration>,

	/** Glowing green dot inside the 'active' badge (commonStyles.indicatorSuccess clone). */
	activeDot: {
		width: '8px',
		height: '8px',
		borderRadius: '50%',
		backgroundColor: 'var(--rr-color-success)',
		boxShadow: '0 0 4px var(--rr-color-success)',
	} as Partial<CSSStyleDeclaration>,
};

// =============================================================================
// TYPES
// =============================================================================

/**
 * Flattened row shape fed to the API keys DataGrid. Sortable / searchable
 * values are primitives; `status` and `team` are pre-computed display strings
 * so client-side sort and search operate on what the user sees.
 */
interface KeyRow extends Record<string, unknown> {
	/** Key id — used to resolve the original record for callbacks. */
	id: string;
	/** Key display name. */
	name: string;
	/** Display status: 'Active' | 'Expired' | 'Interactive login'. */
	status: string;
	/** Team scope display string ('' for session keys). */
	team: string;
	/** ISO last-used timestamp, or null if never used. */
	lastUsedAt: string | null;
	/** ISO expiry timestamp, or null for no expiry. */
	expiresAt: string | null;
}

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the ApiKeysPanel component. */
export interface ApiKeysPanelProps {
	/** The list of API key records to display. */
	keys: ApiKeyRecord[];
	/** Opens the Create API Key modal. */
	onCreateKey: () => void;
	/** Opens the Revoke confirmation modal for the given key. */
	onRevokeKey: (k: ApiKeyRecord) => void;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Derives the display status string for an API key record.
 *
 * @param k - The API key record.
 * @returns 'Interactive login' for session keys, else 'Active' / 'Expired'.
 */
function keyStatus(k: ApiKeyRecord): string {
	if (k.isSession) return 'Interactive login';
	return k.active ? 'Active' : 'Expired';
}

/**
 * Maps a display status string back to its badge variant.
 *
 * @param status - Display status produced by {@link keyStatus}.
 * @returns The badge variant carrying the current color treatment.
 */
function statusBadgeVariant(status: string): 'active' | 'expired' | 'member' {
	if (status === 'Interactive login') return 'member';
	return status === 'Active' ? 'active' : 'expired';
}

/** Per-variant badge text colors — mirrors the shared Badge's overrides. */
const BADGE_COLORS: Record<'active' | 'expired' | 'member' | 'pending', string> = {
	active: 'var(--rr-color-success)',
	expired: 'var(--rr-color-error)',
	member: 'var(--rr-text-secondary)',
	pending: 'var(--rr-color-warning)',
};

/**
 * Builds a status / team badge (DOM clone of the shared Badge component):
 * surface fill, variant text color, and the glowing green dot on 'active'.
 *
 * @param variant - Badge variant determining the text color.
 * @param label - Badge label text.
 * @returns The badge element.
 */
function keyBadgeEl(variant: 'active' | 'expired' | 'member' | 'pending', label: string): HTMLElement {
	const el = document.createElement('span');
	Object.assign(el.style, styles.badge);
	el.style.color = BADGE_COLORS[variant];
	// The active variant carries the glowing success dot before its label.
	if (variant === 'active') {
		const dot = document.createElement('span');
		Object.assign(dot.style, styles.activeDot);
		el.appendChild(dot);
	}
	el.appendChild(document.createTextNode(label));
	return el;
}

// =============================================================================
// API KEYS PANEL
// =============================================================================

/**
 * The API Keys tab panel.
 *
 * Renders a Card headed "API Keys — N keys" with a "+ New Key" action and a
 * DataGrid body listing every key with status / team badges, usage and expiry
 * columns, and a Revoke action for active non-session keys.
 */
export const ApiKeysPanel: React.FC<ApiKeysPanelProps> = ({ keys, onCreateKey, onRevokeKey }) => {
	// Flatten records into sortable / searchable table rows.
	const rows = useMemo<KeyRow[]>(
		() =>
			keys.map((k) => ({
				id: k.id,
				name: k.name,
				status: keyStatus(k),
				// Team scope keys off teamId (the source of truth), not teamName:
				//  - session keys carry no team scope -> '';
				//  - teamId null -> genuinely org-wide -> 'All Teams';
				//  - teamId set but name unresolved -> 'Unknown team' (NOT 'All Teams',
				//    which would wrongly imply org-wide access).
				team: k.isSession ? '' : k.teamId == null ? 'All Teams' : k.teamName ?? 'Unknown team',
				lastUsedAt: k.lastUsedAt,
				expiresAt: k.expiresAt,
			})),
		[keys]
	);

	/**
	 * Resolves a table row back to its API key record and opens the Revoke
	 * confirmation. No-ops if the record has vanished from the prop between
	 * render and click.
	 *
	 * @param row - The clicked table row.
	 */
	const handleRevoke = (row: KeyRow): void => {
		const record = keys.find((k) => k.id === row.id);
		if (record) onRevokeKey(record);
	};

	// Live action router — the actions column's cellClick is baked into the
	// memoized column definition, so it dispatches through this ref to always
	// reach the latest key records.
	const actionRef = useRef<(action: string, row: KeyRow) => void>(() => undefined);
	actionRef.current = (action, row) => {
		// Revoke is the only action this panel offers.
		if (action === 'revoke') handleRevoke(row);
	};

	// Column definitions; cell renderings keep the existing badge treatments.
	const columns = useMemo<GridColumnDefinition[]>(
		() => [
			{ title: 'Name', field: 'name', headerSort: true },
			{
				title: 'Status',
				field: 'status',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const status = cell.getValue() as string;
					return keyBadgeEl(statusBadgeVariant(status), status);
				},
			},
			{
				title: 'Team',
				field: 'team',
				headerSort: true,
				// Session keys show no team badge; named teams keep the amber badge,
				// the org-wide scope keeps the neutral badge.
				formatter: (cell: CellComponent) => {
					const team = cell.getValue() as string;
					return team === '' ? '' : keyBadgeEl(team === 'All Teams' ? 'member' : 'pending', team);
				},
			},
			{
				title: 'Last Used',
				field: 'lastUsedAt',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const iso = cell.getValue() as string | null;
					return iso ? `Used ${relativeTime(iso)}` : 'Never used';
				},
			},
			{
				title: 'Expires',
				field: 'expiresAt',
				headerSort: true,
				formatter: (cell: CellComponent) => {
					const iso = cell.getValue() as string | null;
					return iso ? `Exp. ${new Date(iso).toLocaleDateString()}` : 'No expiry';
				},
			},
			// Trailing Actions column — Revoke is only offered on active
			// non-session keys. Built by hand instead of createActionsColumn
			// because the button renders conditionally per row.
			{
				title: 'Actions',
				field: '__rrActions',
				width: 120,
				hozAlign: 'right',
				headerSort: false,
				// Popup-exempt actions column (no header popup, no toggle-list
				// entry); the marker is stripped before reaching Tabulator.
				rrNoPopup: true,
				resizable: false,
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as KeyRow;
					const wrap = document.createElement('span');
					wrap.dataset.rrActions = 'true';
					wrap.className = 'rr-cell-actions';
					if (row.status === 'Active') wrap.appendChild(buttonEl('ghost', 'Revoke', 'revoke'));
					return wrap;
				},
				// Route clicks on the button to the live action router by key.
				cellClick: (e: UIEvent, cell: CellComponent) => {
					const target = (e.target as HTMLElement).closest('button[data-action]');
					if (!target) return;
					actionRef.current((target as HTMLElement).dataset.action ?? '', cell.getRow().getData() as KeyRow);
				},
			},
		],
		[]
	);

	return (
		<section>
			<Card
				header={`API Keys — ${keys.length} key${keys.length !== 1 ? 's' : ''}`}
				headerActions={
					<Button variant="primary" small onClick={onCreateKey}>
						+ New Key
					</Button>
				}
				noBodyPadding
			>
				<DataGrid<KeyRow> columns={columns} data={rows} emptyTitle="No API keys yet" emptyDescription="Create a key for programmatic access." />
			</Card>
		</section>
	);
};
