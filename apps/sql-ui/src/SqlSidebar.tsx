// =============================================================================
// MIT License
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
// SQL-UI — SIDEBAR (the saved-connection list: the tool's CONTROLLER)
// =============================================================================
//
// The saved-connection list IS the whole sidebar: every connection the user
// has made renders as a row with hover edit/delete actions, "+ New
// Connection" opens the editor document, and clicking a row opens the
// connection's workbench document (direct mode materialises its temp tool
// pipeline). Deliberately NO schema tree here (2026-10-16) — tables belong
// to the workbench documents.
//
// All frame-owned effects (documents, overlays) go through the
// SqlSidebarBridge: straight calls in the full app, the tool channel in the
// host-mounted devToolSidebar (see sqlBridge.ts).
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ConnectionManager, useShellConnection } from 'shell';
import { SidebarMenu, BxPlus, BxCheck, BxEditAlt, BxTrash } from 'shell';
import type { DevToolProps, ViewMenu } from 'shell';
import { useSavedConnections, useSavedConnectionsStatus, endpointKeyForConnection } from './connect';
import type { SavedSqlConnection } from './connect';
import type { SqlSidebarBridge } from './sidebarBridge';
import { SQL_TOOL_PROTOCOL } from './sqlBridge';
import { attachSqlController } from './sqlController';
import type { SqlControllerMount } from './sqlController';
import { DatabaseIcon } from './icons';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/**
	 * Nav section above the Connections list — the app-builder sidebar's
	 * geometry. No horizontal padding: the SidebarMenu inside carries its own
	 * tree-list padding (2px 6px), so adding more here would indent the nav
	 * row past the connection rows and break the shared left rhythm.
	 */
	navSection: {
		padding: '8px 0 12px',
		flexShrink: 0,
	} as CSSProperties,

	/** Section container padding (the SidebarMenu geometry). */
	section: {
		padding: '2px 6px',
	} as CSSProperties,

	/** Uppercase section header. */
	sectionLabel: {
		padding: '6px 8px 4px',
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.5px',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** One connection row (the compact list-row family). */
	row: (active: boolean, hovered: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '1px 8px',
		paddingLeft: 18,
		borderRadius: 5,
		fontSize: 13,
		lineHeight: '22px',
		cursor: 'pointer',
		color: active ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
		...(active ? { background: 'var(--rr-bg-list-active)' } : null),
		...(!active && hovered ? { background: 'var(--rr-bg-list-hover)' } : null),
	}),

	/** Leading glyph slot. */
	rowIcon: (active: boolean): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 17,
		height: 17,
		flexShrink: 0,
		color: active ? 'inherit' : 'var(--rr-text-secondary)',
	}),

	/** Row label (fills so the actions right-align). */
	rowLabel: {
		flex: 1,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,

	/** Hover action button (edit / delete). */
	rowAction: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 20,
		height: 20,
		flexShrink: 0,
		border: 'none',
		borderRadius: 4,
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
		padding: 0,
	} as CSSProperties,

	/** Muted empty-list line. */
	empty: {
		padding: '2px 8px 4px 18px',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Open-failure line under the list. */
	error: {
		padding: '2px 8px 4px 18px',
		fontSize: 12,
		color: 'var(--rr-error, #f44747)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link SqlSidebar}. */
export interface SqlSidebarProps {
	/** The frame bridge (in-document calls in the full app; the channel in a tool mount). */
	bridge: SqlSidebarBridge;
	/**
	 * Host-tracked selection (DevToolProps.activeDocKey): the fronted SQL
	 * document's key — a saved connection id highlights that row and shows
	 * its schema; any other value (an editor doc, null for a non-SQL tab)
	 * clears both. undefined = the host cannot tell; the sidebar falls back
	 * to the frames' own active pushes.
	 */
	hostActiveDoc?: string | null;
}

/**
 * SQL Explorer sidebar: the saved-connection list (with add/edit/delete) on
 * top, and — while a connection document is active — the stock Explorer tree
 * showing that connection's tables. Clicking a table opens its record drawer
 * in the active workbench's Overview page.
 *
 * Two mounts, one sidebar: AppLayout's `sidebar` slot in the full app (local
 * bridge), and the host's sidebar panel as a devToolSidebar (peer bridge).
 */
const SqlSidebar: React.FC<SqlSidebarProps> = ({ bridge, hostActiveDoc }) => {
	const { isConnected } = useShellConnection();
	const connections = useSavedConnections();
	const connectionsStatus = useSavedConnectionsStatus();

	// Row hover + in-flight open (direct mode starts a pipeline — not instant).
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [openingId, setOpeningId] = useState<string | null>(null);
	const [openError, setOpenError] = useState('');
	// Two-step inline delete: the row's trash click arms it, check confirms.
	// Inline (not a dialog) so it works identically in every mount — drawers
	// and tool webviews have no overlay-safe place to raise a confirm.
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	// The connection document currently focused in the frame — from the
	// bridge: the navigation store in-app, the frame's pushes as a tool.
	const [peerActiveKey, setPeerActiveKey] = useState<string | null>(null);
	useEffect(() => bridge.subscribeActive((key) => {
		setPeerActiveKey(key);
		// Any focus change settles an in-flight open (success path).
		setOpeningId(null);
	}), [bridge]);

	// Open failures arrive from wherever the resolve ran (frame or local).
	useEffect(() => bridge.subscribeError((message) => {
		setOpenError(message);
		setOpeningId(null);
	}), [bridge]);

	// The selection this sidebar follows. The host's signal wins when it has
	// one: a saved connection's docKey maps to its endpoint key; anything
	// else fronted (an editor doc, another tool, a text file) clears the
	// selection outright — highlight AND schema tree.
	const hostConnection = useMemo(
		() => (typeof hostActiveDoc === 'string' ? connections.find((c) => c.id === hostActiveDoc) ?? null : null),
		[connections, hostActiveDoc],
	);
	const activeKey = hostActiveDoc === undefined
		? peerActiveKey
		: (hostConnection ? endpointKeyForConnection(hostConnection) : null);

	// A connection coming to front settles an in-flight open (host-signal path).
	useEffect(() => { if (activeKey) setOpeningId(null); }, [activeKey]);

	// ── Open a connection ────────────────────────────────────────────────────

	const openConnection = useCallback((conn: SavedSqlConnection) => {
		if (!isConnected) { setOpenError('Not connected to a server.'); return; }
		setOpenError('');
		setOpeningId(conn.id);
		bridge.openConnection(conn);
	}, [bridge, isConnected]);

	// "+ New Connection" as a stock SidebarMenu entry, mirroring the app-builder
	// sidebar's "+ New app" nav above its MY APPS list. No persistent selection
	// (activeId='').
	const navMenu: ViewMenu = {
		entries: [{ id: 'newConnection', label: 'New Connection', icon: <BxPlus size={16} /> }],
	};

	return (
		<>
			{/* ── Navigation ────────────────────────────────────────────────── */}
			<div style={styles.navSection}>
				<SidebarMenu
					menu={navMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'newConnection') bridge.openConnectionEditor(null);
					}}
				/>
			</div>

			{/* ── Saved connections ─────────────────────────────────────────── */}
			<div style={styles.section}>
				<div style={styles.sectionLabel}>Connections</div>

				{connections.length === 0 && (
					<div style={styles.empty}>{connectionsStatus === 'ready' ? 'No connections yet.' : 'Loading connections…'}</div>
				)}

				{connections.map((conn) => {
					const isActive = endpointKeyForConnection(conn) === activeKey;
					const isHovered = hoveredId === conn.id;
					const isOpening = openingId === conn.id;
					const isConfirming = confirmDeleteId === conn.id;
					return (
						<div
							key={conn.id}
							role="button"
							tabIndex={0}
							title={conn.mode === 'pipeline' ? `${conn.name} — pipeline: ${conn.pipelineName}` : `${conn.name} — direct (${conn.provider})`}
							style={styles.row(isActive, isHovered)}
							onClick={() => { if (!isOpening && !isConfirming) openConnection(conn); }}
							onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !isOpening && !isConfirming) { e.preventDefault(); openConnection(conn); } }}
							onMouseEnter={() => setHoveredId(conn.id)}
							onMouseLeave={() => setHoveredId(null)}
						>
							<span style={styles.rowIcon(isActive)}><DatabaseIcon /></span>
							{isConfirming ? (
								<>
									<span style={{ ...styles.rowLabel, color: 'var(--rr-error, #f44747)' }}>Delete {conn.name}?</span>
									<button
										type="button"
										style={styles.rowAction}
										title="Confirm delete"
										aria-label={`Confirm delete ${conn.name}`}
										onClick={(e) => {
											e.stopPropagation();
											// Best-effort stop of a direct connection's temp
											// pipeline (the idle TTL reaps it otherwise), then
											// the record goes.
											bridge.deleteConnection(conn);
											setConfirmDeleteId(null);
										}}
									>
										<BxCheck size={14} />
									</button>
									<button
										type="button"
										style={styles.rowAction}
										title="Cancel delete"
										aria-label="Cancel delete"
										onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
									>
										✕
									</button>
								</>
							) : (
								<>
									<span style={styles.rowLabel}>{isOpening ? `${conn.name}…` : conn.name}</span>
									{/* Hover actions: modify / delete. */}
									{isHovered && !isOpening && (
										<>
											<button
												type="button"
												style={styles.rowAction}
												title="Edit connection"
												aria-label={`Edit ${conn.name}`}
												onClick={(e) => { e.stopPropagation(); bridge.openConnectionEditor(conn); }}
											>
												<BxEditAlt size={14} />
											</button>
											<button
												type="button"
												style={styles.rowAction}
												title="Delete connection"
												aria-label={`Delete ${conn.name}`}
												onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(conn.id); }}
											>
												<BxTrash size={14} />
											</button>
										</>
									)}
								</>
							)}
						</div>
					);
				})}

				{openError && <div style={styles.error}>{openError}</div>}
			</div>

			{/* No schema tree here by design (2026-10-16): the sidebar is the
			    connection list alone — tables live in the workbench documents
			    (Overview, Query autocomplete, Diagram).

			    Add/edit opens the connection-editor DOCUMENT (a top-level tab);
			    delete confirms inline on the row. No overlays are raised from
			    this subtree — it has no overlay-safe host (compact drawer
			    transform in-app, a ~300px webview as a tool). */}
		</>
	);
};

// =============================================================================
// DEV-TOOL SIDEBAR — the same sidebar in the host's sidebar panel
// =============================================================================

/**
 * The sidebar as a host-mounted devToolSidebar — the tool's CONTROLLER: it
 * owns the saved-connection list (loads it with persistence, commits every
 * mutation, publishes it as retained channel state) and follows the host's
 * activeDocKey to highlight the fronted connection.
 */
export const SqlDevToolSidebar: React.FC<DevToolProps> = ({ peer, channel, documents, activeDocKey }) => {
	// The controller (sqlController.ts): its engine core, exactly one op
	// server (created after the channel), the retained state it publishes, and
	// the sidebar's bridge. Built in an EFFECT and disposed with it (R6): under
	// StrictMode that is mount -> dispose -> mount, which leaves one live op
	// server. It posts nothing and opens no document at mount (R7).
	const [mount, setMount] = useState<SqlControllerMount | null>(null);
	const activeDocKeyRef = useRef(activeDocKey);
	activeDocKeyRef.current = activeDocKey;
	// The host's documents API, read at call time: a host that hands a new
	// object on a re-render must not remount the controller (its op server).
	const documentsRef = useRef(documents);
	documentsRef.current = documents;
	useEffect(() => {
		const attached = attachSqlController({
			peer,
			...(channel ? { channel } : {}),
			documents: {
				open: (key, title) => documentsRef.current?.open(key, title),
				close: (key) => documentsRef.current?.close(key),
			},
			activeDocKey: activeDocKeyRef.current ?? null,
			cm: ConnectionManager.getInstance(),
			protocol: SQL_TOOL_PROTOCOL,
		});
		setMount(attached);
		return () => {
			attached.dispose();
			setMount((current) => (current === attached ? null : current));
		};
	}, [peer, channel]);
	// A non-null activeDocKey is an activation (R7).
	useEffect(() => { mount?.noteActiveDocKey(activeDocKey); }, [mount, activeDocKey]);

	if (!mount) return null;
	return <SqlSidebar bridge={mount.bridge} {...(activeDocKey !== undefined ? { hostActiveDoc: activeDocKey } : {})} />;
};

export default SqlSidebar;
