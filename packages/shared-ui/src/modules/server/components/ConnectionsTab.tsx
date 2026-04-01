// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React, { useState } from 'react';
import type { DashboardConnection } from '../types';
import { formatTime, formatTimeAgo, formatNumber } from '../util';

interface ConnectionsTabProps {
	connections: DashboardConnection[];
}

export const ConnectionsTab: React.FC<ConnectionsTabProps> = ({ connections }) => {
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const selected = connections.find((c) => c.id === selectedId);

	return (
		<div className="sm-connections-layout">
			<div className="sm-card sm-connections-list">
				<div className="sm-card-header">
					<span>Active Connections ({connections.length})</span>
					<span className="sm-text-muted">click a row for details</span>
				</div>
				<table className="sm-table">
					<thead>
						<tr>
							<th>ID</th>
							<th>Account</th>
							<th>Connected</th>
							<th>Tasks</th>
							<th>Monitors</th>
							<th>Msgs In/Out</th>
							<th>Last Active</th>
						</tr>
					</thead>
					<tbody>
						{connections.map((conn) => (
							<tr key={conn.id} className={selectedId === conn.id ? 'sm-row-selected' : ''} onClick={() => setSelectedId(conn.id === selectedId ? null : conn.id)}>
								<td className="sm-mono">#{conn.id}</td>
								<td>{conn.clientInfo?.name || conn.clientId || `Conn #${conn.id}`}</td>
								<td className="sm-mono">{formatTime(conn.connectedAt)}</td>
								<td className="sm-mono">{conn.attachedTasks.length}</td>
								<td className="sm-mono">{conn.monitors.length}</td>
								<td>
									<span className="sm-msg-badge">
										<span className="sm-msg-in">&#9660;</span> {formatNumber(conn.messagesIn)}
									</span>
									<span className="sm-msg-badge">
										<span className="sm-msg-out">&#9650;</span> {formatNumber(conn.messagesOut)}
									</span>
								</td>
								<td className="sm-text-muted">{formatTimeAgo(conn.lastActivity)}</td>
							</tr>
						))}
						{connections.length === 0 && (
							<tr>
								<td colSpan={7} className="sm-text-muted sm-text-center">
									No connections
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

			{selected && (
				<div className="sm-card sm-detail-panel">
					<div className="sm-card-header">
						<span>
							#{selected.id} &mdash; {selected.clientInfo?.name || selected.clientId || `Conn #${selected.id}`}
						</span>
						<span className="sm-detail-close" onClick={() => setSelectedId(null)}>
							&times;
						</span>
					</div>

					<div className="sm-detail-section">
						<div className="sm-detail-label">Connection Info</div>
						<div className="sm-detail-row">
							<span className="sm-text-secondary">Connected at</span>
							<span className="sm-mono">{formatTime(selected.connectedAt)}</span>
						</div>
						<div className="sm-detail-row">
							<span className="sm-text-secondary">API Key</span>
							<span className="sm-mono">{selected.apikey}</span>
						</div>
						{selected.clientInfo.name && (
							<div className="sm-detail-row">
								<span className="sm-text-secondary">Client</span>
								<span>
									{selected.clientInfo.name} {selected.clientInfo.version ?? ''}
								</span>
							</div>
						)}
					</div>

					<div className="sm-detail-section">
						<div className="sm-detail-label">Monitors ({selected.monitors.length})</div>
						<div className="sm-tag-list">
							{selected.monitors.map((m) => (
								<span key={m} className="sm-tag">
									{m}
								</span>
							))}
							{selected.monitors.length === 0 && <span className="sm-text-muted">none</span>}
						</div>
					</div>

					<div className="sm-detail-section">
						<div className="sm-detail-label">Attached Tasks ({selected.attachedTasks.length})</div>
						<div className="sm-tag-list">
							{selected.attachedTasks.map((t) => (
								<span key={t} className="sm-tag">
									{t}
								</span>
							))}
							{selected.attachedTasks.length === 0 && <span className="sm-text-muted">none</span>}
						</div>
					</div>

					<div className="sm-detail-section">
						<div className="sm-detail-label">Traffic</div>
						<div className="sm-detail-row">
							<span className="sm-text-secondary">Messages In</span>
							<span className="sm-mono">{formatNumber(selected.messagesIn)}</span>
						</div>
						<div className="sm-detail-row">
							<span className="sm-text-secondary">Messages Out</span>
							<span className="sm-mono">{formatNumber(selected.messagesOut)}</span>
						</div>
					</div>
				</div>
			)}
		</div>
	);
};
