// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ApiKeysPanel — the API Keys tab within AccountView.
 *
 * Renders the user's API keys as the stock DataTable (sortable columns,
 * pagination) inside a stock Card. Each row shows the key name, status badge,
 * team scope, last-used timestamp, expiry date, and (for active non-session
 * keys) a Revoke action. All server interactions are delegated to the host via
 * callback props.
 */

import React, { useMemo } from 'react';
import { Card } from '../../../components/card/Card';
import { Button } from '../../../components/button/Button';
import { DataTable } from '../../../components/data-table/DataTable';
import type { DataTableColumn } from '../../../components/data-table/DataTable';
import { createArrayDataSource } from '../../../components/data-table/dataSource';
import type { ApiKeyRecord } from '../types';
import { Badge, relativeTime } from './shared';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Flattened row shape fed to the API keys DataTable. Sortable / searchable
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
 * @returns The Badge variant carrying the current color treatment.
 */
function statusBadgeVariant(status: string): 'active' | 'expired' | 'member' {
	if (status === 'Interactive login') return 'member';
	return status === 'Active' ? 'active' : 'expired';
}

// =============================================================================
// API KEYS PANEL
// =============================================================================

/**
 * The API Keys tab panel.
 *
 * Renders a Card headed "API Keys — N keys" with a "+ New Key" action and a
 * DataTable body listing every key with status / team badges, usage and expiry
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

	// Client-side data source — sort / pagination run in memory.
	const source = useMemo(() => createArrayDataSource<KeyRow>(rows), [rows]);

	// Column definitions; cell renderings keep the existing badge treatments.
	const columns = useMemo<DataTableColumn<KeyRow>[]>(
		() => [
			{ key: 'name', label: 'Name', sortable: true },
			{
				key: 'status',
				label: 'Status',
				sortable: true,
				render: (row) => <Badge variant={statusBadgeVariant(row.status)}>{row.status}</Badge>,
			},
			{
				key: 'team',
				label: 'Team',
				sortable: true,
				// Session keys show no team badge; named teams keep the amber badge,
				// the org-wide scope keeps the neutral badge.
				render: (row) => (row.team === '' ? null : <Badge variant={row.team === 'All Teams' ? 'member' : 'pending'}>{row.team}</Badge>),
			},
			{
				key: 'lastUsedAt',
				label: 'Last Used',
				sortable: true,
				render: (row) => (row.lastUsedAt ? `Used ${relativeTime(row.lastUsedAt)}` : 'Never used'),
			},
			{
				key: 'expiresAt',
				label: 'Expires',
				sortable: true,
				render: (row) => (row.expiresAt ? `Exp. ${new Date(row.expiresAt).toLocaleDateString()}` : 'No expiry'),
			},
		],
		[]
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
				<DataTable<KeyRow>
					columns={columns}
					source={source}
					// Revoke is only offered on active non-session keys.
					actions={(row) =>
						row.status === 'Active' ? (
							<Button variant="ghost" small onClick={() => handleRevoke(row)}>
								Revoke
							</Button>
						) : null
					}
					emptyState={{ title: 'No API keys yet', description: 'Create a key for programmatic access.' }}
				/>
			</Card>
		</section>
	);
};
