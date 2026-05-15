// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React, { useState, CSSProperties } from 'react';
import type { DashboardConnection } from '../types';
import { formatTime, formatTimeAgo, formatNumber } from '../util';
import { commonStyles } from '../../../themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	layout: {
		display: 'grid',
		gridTemplateColumns: '1fr 360px',
		gap: 16,
		alignItems: 'start',
	} as CSSProperties,
	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 13,
	} as CSSProperties,
	clickableRow: {
		cursor: 'pointer',
	} as CSSProperties,
	selectedRow: {
		backgroundColor: 'var(--rr-bg-list-hover)',
	} as CSSProperties,
	mono: {
		...commonStyles.fontMono,
		fontVariantNumeric: 'tabular-nums',
	} as CSSProperties,
	msgBadge: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 3,
		fontSize: 11,
		fontVariantNumeric: 'tabular-nums',
		marginRight: 6,
	} as CSSProperties,
	msgIn: { color: 'var(--rr-color-success)', fontSize: 8 } as CSSProperties,
	msgOut: { color: 'var(--rr-border-focus)', fontSize: 8 } as CSSProperties,

	// Detail panel
	detailPanel: {
		...commonStyles.card,
		maxHeight: 'calc(100vh - 140px)',
		overflowY: 'auto',
		position: 'sticky',
		top: 0,
	} as CSSProperties,
	detailClose: {
		cursor: 'pointer',
		color: 'var(--rr-text-disabled)',
		fontSize: 18,
		lineHeight: 1,
		padding: '0 2px',
		background: 'none',
		border: 'none',
	} as CSSProperties,
	detailSection: {
		padding: '14px 16px',
		borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)',
	} as CSSProperties,
	detailRow: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 6,
		fontSize: 13,
	} as CSSProperties,
	tagList: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 4,
	} as CSSProperties,
	tag: {
		display: 'inline-block',
		padding: '2px 8px',
		borderRadius: 4,
		fontSize: 11,
		background: 'var(--rr-bg-widget-hover)',
		color: 'var(--rr-border-focus)',
		border: '1px solid var(--rr-border)',
	} as CSSProperties,
	monitorRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginBottom: 6,
		fontSize: 12,
	} as CSSProperties,
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
};

// =============================================================================
// COMPONENT
// =============================================================================

export const ConnectionsTab: React.FC<{ connections: DashboardConnection[] }> = ({ connections }) => {
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const selected = connections.find((c) => c.id === selectedId);

	return (
		<div style={styles.layout}>
			<div style={commonStyles.card}>
				<div style={commonStyles.cardHeader}>
					<span>Active Connections ({connections.length})</span>
					<span style={commonStyles.textMuted}>click a row for details</span>
				</div>
				<table style={styles.table}>
					<thead>
						<tr>
							<th style={commonStyles.tableHeader}>ID</th>
							<th style={commonStyles.tableHeader}>Account</th>
							<th style={commonStyles.tableHeader}>Connected</th>
							<th style={commonStyles.tableHeader}>Tasks</th>
							<th style={commonStyles.tableHeader}>Monitors</th>
							<th style={commonStyles.tableHeader}>Msgs In/Out</th>
							<th style={commonStyles.tableHeader}>Last Active</th>
						</tr>
					</thead>
					<tbody>
						{connections.map((conn) => (
							<tr
								key={conn.id}
								style={{ ...styles.clickableRow, ...(selectedId === conn.id ? styles.selectedRow : {}) }}
								onClick={() => setSelectedId(conn.id === selectedId ? null : conn.id)}
								tabIndex={0}
								onKeyDown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										setSelectedId(conn.id === selectedId ? null : conn.id);
									}
								}}
							>
								<td style={{ ...commonStyles.tableCell, ...styles.mono }}>#{conn.id}</td>
								<td style={commonStyles.tableCell}>{conn.clientInfo?.name || conn.clientId || `Conn #${conn.id}`}</td>
								<td style={{ ...commonStyles.tableCell, ...styles.mono }}>{formatTime(conn.connectedAt)}</td>
								<td style={{ ...commonStyles.tableCell, ...styles.mono }}>{conn.attachedTasks.length}</td>
								<td style={{ ...commonStyles.tableCell, ...styles.mono }}>{conn.monitors.length}</td>
								<td style={commonStyles.tableCell}>
									<span style={styles.msgBadge}>
										<span style={styles.msgIn}>&#9660;</span> {formatNumber(conn.messagesIn)}
									</span>
									<span style={styles.msgBadge}>
										<span style={styles.msgOut}>&#9650;</span> {formatNumber(conn.messagesOut)}
									</span>
								</td>
								<td style={{ ...commonStyles.tableCell, color: 'var(--rr-text-disabled)' }}>{formatTimeAgo(conn.lastActivity)}</td>
							</tr>
						))}
						{connections.length === 0 && (
							<tr>
								<td colSpan={7} style={{ ...commonStyles.tableCell, ...commonStyles.empty }}>
									No connections
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

			{selected && (
				<div style={styles.detailPanel}>
					<div style={commonStyles.cardHeader}>
						<span>
							#{selected.id} &mdash; {selected.clientInfo?.name || selected.clientId || `Conn #${selected.id}`}
						</span>
						<button style={styles.detailClose} aria-label="Close details" onClick={() => setSelectedId(null)}>
							&times;
						</button>
					</div>

					<div style={styles.detailSection}>
						<div style={commonStyles.labelUppercase}>Connection Info</div>
						<div style={styles.detailRow}>
							<span style={commonStyles.textMuted}>Connected at</span>
							<span style={styles.mono}>{formatTime(selected.connectedAt)}</span>
						</div>
						<div style={styles.detailRow}>
							<span style={commonStyles.textMuted}>API Key</span>
							<span style={styles.mono}>{selected.apikey ? `${selected.apikey.slice(0, 4)}${'•'.repeat(8)}${selected.apikey.slice(-4)}` : '—'}</span>
						</div>
						{selected.clientInfo.name && (
							<div style={styles.detailRow}>
								<span style={commonStyles.textMuted}>Client</span>
								<span>
									{selected.clientInfo.name} {selected.clientInfo.version ?? ''}
								</span>
							</div>
						)}
					</div>

					<div style={styles.detailSection}>
						<div style={commonStyles.labelUppercase}>Monitors ({selected.monitors.length})</div>
						{selected.monitors.length === 0 && <span style={commonStyles.textMuted}>none</span>}
						{selected.monitors.map((m) => (
							<div key={m.key} style={styles.monitorRow}>
								<span style={{ ...styles.mono, flexShrink: 0, color: 'var(--rr-text-primary)' }}>{m.key}</span>
								<span style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
									{m.flags.map((f) => (
										<span key={f} style={styles.flagTag}>
											{f}
										</span>
									))}
								</span>
							</div>
						))}
					</div>

					<div style={styles.detailSection}>
						<div style={commonStyles.labelUppercase}>Attached Tasks ({selected.attachedTasks.length})</div>
						<div style={styles.tagList}>
							{selected.attachedTasks.map((t) => (
								<span key={t} style={styles.tag}>
									{t}
								</span>
							))}
							{selected.attachedTasks.length === 0 && <span style={commonStyles.textMuted}>none</span>}
						</div>
					</div>

					<div style={styles.detailSection}>
						<div style={commonStyles.labelUppercase}>Traffic</div>
						<div style={styles.detailRow}>
							<span style={commonStyles.textMuted}>Messages In</span>
							<span style={styles.mono}>{formatNumber(selected.messagesIn)}</span>
						</div>
						<div style={{ ...styles.detailRow, marginBottom: 0 }}>
							<span style={commonStyles.textMuted}>Messages Out</span>
							<span style={styles.mono}>{formatNumber(selected.messagesOut)}</span>
						</div>
					</div>
				</div>
			)}
		</div>
	);
};
