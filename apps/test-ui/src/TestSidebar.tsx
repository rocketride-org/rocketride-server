// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// TEST SIDEBAR — Connections + sub-navigation (matches models-ui pattern)
// =============================================================================

import React, { useCallback } from 'react';
import type { CSSProperties } from 'react';
import { NavButton, BxGridAlt, BxDesktop, BxCog, BxListUl, BxStop, BxPlay, useSidebarCollapsed } from 'shell';
import { useSavedConnections, type SavedConnection } from './connections';
import { getDocs } from './docs';
import { openConnection } from './TestApp';
import { useView, useHasActiveTab, requestView } from './navigation';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minHeight: 0,
		overflow: 'hidden',
	} as CSSProperties,

	connectionsSection: {
		display: 'flex',
		flexDirection: 'column',
		gap: 1,
		padding: '8px 0',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	sectionLabel: {
		padding: '4px 16px',
		fontSize: 10,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.05em',
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,

	connItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '6px 16px',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		cursor: 'pointer',
		border: 'none',
		background: 'transparent',
		width: '100%',
		textAlign: 'left',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	connName: {
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		flex: 1,
	} as CSSProperties,

	connPort: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		fontFamily: 'var(--rr-font-family-mono)',
	} as CSSProperties,

	connItemCollapsed: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '6px 0',
		cursor: 'pointer',
		border: 'none',
		background: 'transparent',
		width: '100%',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	navSection: {
		display: 'flex',
		flexDirection: 'column',
		gap: 2,
		padding: '8px 0',
	} as CSSProperties,

	actionsSection: {
		display: 'flex',
		flexDirection: 'column',
		gap: 6,
		padding: '10px 12px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	launchBtn: {
		width: '100%',
		padding: '8px 12px',
		borderRadius: 6,
		border: 'none',
		fontSize: 12,
		fontWeight: 700,
		cursor: 'pointer',
		background: 'linear-gradient(135deg, var(--rr-color-success), #2d8a4e)',
		color: '#fff',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	actionRow: {
		display: 'flex',
		gap: 4,
	} as CSSProperties,

	actionBtn: {
		flex: 1,
		padding: '5px 8px',
		borderRadius: 4,
		border: '1px solid var(--rr-border)',
		background: 'transparent',
		color: 'var(--rr-text-primary)',
		fontSize: 11,
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	abortBtn: {
		flex: 1,
		padding: '5px 8px',
		borderRadius: 4,
		border: '1px solid var(--rr-color-error)',
		background: 'transparent',
		color: 'var(--rr-color-error)',
		fontSize: 11,
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

const TestSidebar: React.FC = () => {
	// Collapse flag from the sidebar context (the node renders inside the
	// shell sidebar's collapse provider).
	const collapsed = useSidebarCollapsed();
	const connections = useSavedConnections();
	const currentView = useView();
	const hasActiveTab = useHasActiveTab();

	const handleOpenConnection = useCallback((conn: SavedConnection) => {
		const docs = getDocs();
		if (docs) openConnection(docs, conn);
	}, []);

	return (
		<div style={styles.container}>
			{/* Saved connections */}
			<div style={styles.connectionsSection}>
				{!collapsed && <div style={styles.sectionLabel}>Connections</div>}

				{connections.map((conn) =>
					collapsed ? (
						<button key={conn.id} style={styles.connItemCollapsed} onClick={() => handleOpenConnection(conn)} title={`${conn.name} (${conn.url})`}>
							<BxDesktop size={18} />
						</button>
					) : (
						<button key={conn.id} style={styles.connItem} onClick={() => handleOpenConnection(conn)} title={conn.url}>
							<BxDesktop size={16} color="var(--rr-text-secondary)" />
							<span style={styles.connName}>{conn.name}</span>
							<span style={styles.connPort}>{conn.url}</span>
						</button>
					)
				)}
			</div>

			{/* Sub-navigation (only when a tab is active) */}
			{hasActiveTab && (
				<div style={styles.navSection}>
					{!collapsed && <div style={styles.sectionLabel}>Views</div>}

					<NavButton icon={BxGridAlt} label="Dashboard" collapsed={collapsed} isActive={currentView === 'dashboard'} onClick={() => requestView('dashboard')} />
					<NavButton icon={BxCog} label="Settings" collapsed={collapsed} isActive={currentView === 'settings'} onClick={() => requestView('settings')} />
					<NavButton icon={BxListUl} label="Events" collapsed={collapsed} isActive={currentView === 'events'} onClick={() => requestView('events')} />
					<NavButton icon={BxStop} label="Errors" collapsed={collapsed} isActive={currentView === 'errors'} onClick={() => requestView('errors')} />
					<NavButton icon={BxPlay} label="Scenarios" collapsed={collapsed} isActive={currentView === 'scenarios'} onClick={() => requestView('scenarios')} />
				</div>
			)}
		</div>
	);
};

export default TestSidebar;
