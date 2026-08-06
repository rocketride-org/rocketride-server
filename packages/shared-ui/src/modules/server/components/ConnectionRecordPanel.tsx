// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CONNECTION RECORD PANEL — DetailPanel slide-out for one active connection
// =============================================================================

import React, { useRef } from 'react';
import type { CSSProperties } from 'react';
import { DetailPanel, Section, LabelValue } from 'shell';
import type { DashboardConnection } from '../types';
import { commonStyles } from 'shell/src/themes/styles';
import { formatNumber, formatTime } from '../util';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ConnectionRecordPanel} component. */
export interface IConnectionRecordPanelProps {
	/** Id of the connection to inspect; null keeps the panel closed. */
	connectionId: number | null;
	/**
	 * The CURRENT connection rows (latest fetched page or dashboard snapshot).
	 * The panel re-resolves its record from this list on every render, so each
	 * poll refresh updates the open panel in place.
	 */
	connections: DashboardConnection[];
	/** Fired when the user dismisses the panel (close glyph or Escape). */
	onClose: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Avatar background palette — the six categorical chart tokens, cycled by
 * connection id so avatars stay theme-aware (no raw hex).
 */
const AVATAR_COLORS = ['var(--rr-chart-blue)', 'var(--rr-chart-green)', 'var(--rr-chart-yellow)', 'var(--rr-chart-purple)', 'var(--rr-chart-orange)', 'var(--rr-chart-red)'];

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/**
	 * 42px avatar circle showing the connection number on an id-hashed
	 * chart-token background.
	 *
	 * @param color - Avatar background colour token.
	 */
	avatar: (color: string): CSSProperties => ({
		width: 42,
		height: 42,
		borderRadius: '50%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontWeight: 700,
		fontSize: 12,
		color: 'var(--rr-fg-button)',
		background: color,
	}),

	// One monitor subscription row: key + its event-flag tags.
	monitorRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginBottom: 6,
		fontSize: 12,
	} as CSSProperties,

	// Monitor key — monospace, kept on one line beside the flag tags.
	monitorKey: {
		...commonStyles.fontMono,
		fontVariantNumeric: 'tabular-nums',
		flexShrink: 0,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	// Wrapping group of event-flag tags after a monitor key.
	flagList: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 3,
	} as CSSProperties,

	// Small dim tag for one monitor event flag.
	flagTag: {
		display: 'inline-block',
		padding: '1px 6px',
		borderRadius: 3,
		fontSize: 10,
		fontWeight: 500,
		background: 'color-mix(in srgb, var(--rr-border) 30%, transparent)',
		color: 'var(--rr-text-secondary)',
		letterSpacing: '0.3px',
	} as CSSProperties,

	// Wrapping group of attached-task tags.
	tagList: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 4,
	} as CSSProperties,

	// Tinted tag for one attached task name.
	tag: {
		display: 'inline-block',
		padding: '2px 8px',
		borderRadius: 4,
		fontSize: 11,
		background: 'var(--rr-bg-widget-hover)',
		color: 'var(--rr-border-focus)',
		border: '1px solid var(--rr-border)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Connection record panel — the DetailPanel slide-out a row click opens for an
 * active connection (record-panel standard: row click opens a record panel;
 * centered modals are only for confirmations and flows).
 *
 * Liveness: the caller stores only the connection id; the record is re-resolved
 * from the caller's CURRENT rows on every render, so poll refreshes update the
 * open panel in place. When the row is temporarily absent from those rows (it
 * paged out of the fetched page, or the connection dropped), the panel keeps
 * rendering its last-known snapshot instead of auto-closing — dismissal stays
 * the user's call.
 *
 * @param props - {@link IConnectionRecordPanelProps}.
 * @returns The record panel, or null while closed.
 */
export const ConnectionRecordPanel: React.FC<IConnectionRecordPanelProps> = ({ connectionId, connections, onClose }) => {
	// Step 1: live record resolution — look the stored id up in the CURRENT
	// rows so every parent re-render (each 3s poll) refreshes the open panel.
	const lastKnownRef = useRef<DashboardConnection | null>(null);
	const live = connectionId != null ? connections.find((conn) => conn.id === connectionId) : undefined;
	if (live != null) {
		// Cache the latest resolved snapshot (a plain memo write; the ref is
		// only read by this component's own render).
		lastKnownRef.current = live;
	}

	// Step 2: fall back to the last-known snapshot when the row is absent from
	// the current rows — the id guard ensures a stale cache from a previously
	// inspected connection can never render.
	const record = live ?? (lastKnownRef.current?.id === connectionId ? lastKnownRef.current : null);
	if (record == null) {
		return null;
	}

	// Step 3: header identity — handshake client name, falling back to the
	// account id, then the connection number.
	const clientName = record.clientInfo?.name || record.clientId || `Conn #${record.id}`;

	// Step 4: API key masked to its first and last 4 characters.
	const maskedKey = record.apikey ? `${record.apikey.slice(0, 4)}${'•'.repeat(8)}${record.apikey.slice(-4)}` : '—';

	return (
		<DetailPanel persistKey="panelDetailConnectionWidth" open onClose={onClose} avatar={<div style={styles.avatar(AVATAR_COLORS[record.id % AVATAR_COLORS.length])}>#{record.id}</div>} title={`#${record.id} — ${clientName}`} subtitle={record.clientId ?? undefined}>
			{/* ── Connection Info ──────────────────────────────────────────── */}
			<Section label="Connection Info">
				<LabelValue label="Connected at" mono>
					{formatTime(record.connectedAt)}
				</LabelValue>
				{/* User identity resolved server-side; '--' = not authenticated.
				    Name only — the raw userId is redundant next to it. */}
				<LabelValue label="User">{record.userName ?? '--'}</LabelValue>
				{/* Org membership resolved server-side; '--' = unauthenticated or no org. */}
				<LabelValue label="Organization">{record.orgName ?? '--'}</LabelValue>
				<LabelValue label="API Key" mono>
					{maskedKey}
				</LabelValue>
				{record.clientInfo?.name && (
					<LabelValue label="Client">
						{record.clientInfo.name} {record.clientInfo.version ?? ''}
					</LabelValue>
				)}
			</Section>

			{/* ── Monitors — key + event-flag tags per subscription ────────── */}
			<Section label={`Monitors (${record.monitors.length})`}>
				{record.monitors.length === 0 && <span style={commonStyles.textMuted}>none</span>}
				{record.monitors.map((monitor) => (
					<div key={monitor.key} style={styles.monitorRow}>
						<span style={styles.monitorKey}>{monitor.key}</span>
						<span style={styles.flagList}>
							{monitor.flags.map((flag) => (
								<span key={flag} style={styles.flagTag}>
									{flag}
								</span>
							))}
						</span>
					</div>
				))}
			</Section>

			{/* ── Attached Tasks — one tag per monitored task name ─────────── */}
			<Section label={`Attached Tasks (${record.attachedTasks.length})`}>
				<div style={styles.tagList}>
					{record.attachedTasks.map((task) => (
						<span key={task} style={styles.tag}>
							{task}
						</span>
					))}
					{record.attachedTasks.length === 0 && <span style={commonStyles.textMuted}>none</span>}
				</div>
			</Section>

			{/* ── Traffic counters ─────────────────────────────────────────── */}
			<Section label="Traffic">
				<LabelValue label="Messages In" mono>
					{formatNumber(record.messagesIn)}
				</LabelValue>
				<LabelValue label="Messages Out" mono>
					{formatNumber(record.messagesOut)}
				</LabelValue>
			</Section>
		</DetailPanel>
	);
};
