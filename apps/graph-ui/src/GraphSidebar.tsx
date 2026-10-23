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
// GRAPH-UI - SIDEBAR (navigation menu + the active connection's schema)
// =============================================================================
//
// The stock Explorer tree shows what the schema holds for the active connection:
// node labels and relationship types, each with its properties and observed types.
// Clicking a label or type is the user's request for the 25-row preview, which the
// connection's workbench shows and runs. The status line under the tree says how far
// the schema can be trusted (fresh, sampled, stale, an older format, or unreadable);
// an old node's snapshot is never presented as "the whole graph".
//
// It is mounted by the full app (in the shell's sidebar chrome) and, as a dev
// tool, by the CONTROLLER (devtool: true). Either way it reads the LOCAL
// GraphEnv of its realm; documents open only on a click.
//
//   full app   the "Connections" menu entry (it opens the landing document)
//   dev tool   Rod's list (the parity spec, S2-S6): an uppercase "Connections"
//              label with a Refresh header action, one hand-built row per
//              connection (icon, name, state dot and suffix, tooltip, Enter
//              or Space opens its workbench), and a line under the rows while
//              discovering or when nothing was found. There is no landing
//              document: the sidebar is the list, and the drawer (details,
//              Test connection) lives in the connection's documents.
// =============================================================================

import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { BxRefresh, Explorer, NOOP_VFS, SidebarMenu, commonStyles } from 'shell';
import type { ViewMenu } from 'shell';
import { panelStyles } from 'shared/tools/core/chrome/panelStyles';
import { useActiveConnection, useGraphEndpoints, useGraphEnv } from './env';
import type { IGraphEnv } from './env';
import { connectionRow, sidebarListLine } from './graph/connections';
import type { IBadge } from './graph/connections';
import { NO_SCHEMA, SAMPLED_NOTE, schemaStatusText } from './graph/schema';
import { buildSchemaTree } from './graph/schemaTree';
import type { ISchemaEntry } from './graph/schemaStore';
import { GraphIcon } from './icons';

/** Said when the schema listing was cut by the node's own bounds. */
export const TRUNCATED_NOTE = 'The node lists only part of a very large schema.';

/** A subscription that never fires. */
const NO_SUBSCRIBE = (): (() => void) => () => undefined;

/** The entry of a connection nothing was loaded for. */
const IDLE_ENTRY: ISchemaEntry = { status: 'idle', view: NO_SCHEMA, failure: null, loadedAt: 0 };

/** A row's state dot, by the card badge's variant (the suffix says the state in words). */
const DOT_COLOR: Record<IBadge['variant'], string> = {
	success: 'var(--rr-color-success)',
	muted: 'var(--rr-text-disabled)',
	error: 'var(--rr-color-error)',
	warning: 'var(--rr-color-warning)',
};

// =============================================================================
// STYLES (the list block is Rod's, from sql-ui's SqlSidebar)
// =============================================================================

const styles = {
	/** Section container padding (the SidebarMenu geometry). */
	section: {
		padding: '2px 6px',
	} as CSSProperties,

	/** The section's header row: its label and the hover-revealed actions. */
	sectionHeader: {
		display: 'flex',
		alignItems: 'center',
	} as CSSProperties,

	/** Uppercase section header. */
	sectionLabel: {
		flex: 1,
		padding: '6px 8px 4px',
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.5px',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** The platform's pane-header treatment (Explorer's): a hover-revealed cluster of 18px icon buttons. */
	headerActions: commonStyles.paneHeaderActions,
	headerAction: commonStyles.paneHeaderButton,
	/** The same action while it cannot run (aria-disabled: it keeps the keyboard focus). */
	headerActionBlocked: { ...commonStyles.paneHeaderButton, opacity: 0.4, cursor: 'default' } as CSSProperties,

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

	/** Row label (fills so the state right-aligns). */
	rowLabel: {
		flex: 1,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,

	/** The state in words, after the name (never colour alone). */
	rowStatus: {
		flexShrink: 0,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** The state dot (the panel vocabulary's 8px dot), where Rod's rows put their hover actions. */
	dot: (variant: IBadge['variant']): CSSProperties => panelStyles.dot(DOT_COLOR[variant]),

	/** Muted line under the list (discovering, nothing found). */
	empty: {
		padding: '2px 8px 4px 18px',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Failure line under the list. */
	error: {
		padding: '2px 8px 4px 18px',
		fontSize: 12,
		color: 'var(--rr-color-error)',
	} as CSSProperties,

	/** The schema status block under the tree. */
	status: {
		padding: '8px 14px',
		fontSize: 12,
		lineHeight: 1.45,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** One more line of the status block. */
	statusLine: {
		marginTop: 4,
	} as CSSProperties,

	/** The schema load failure (a warning). */
	statusWarning: {
		marginTop: 4,
		color: 'var(--rr-color-warning)',
	} as CSSProperties,

	/** The node's own error detail, as it wrote it. */
	statusDetail: {
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 11,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	} as CSSProperties,
};

/**
 * Follow one connection's full schema entry (the full app's and the controller's own store).
 *
 * @param env - The env.
 * @param key - The connection, or null.
 * @returns The entry.
 */
function useSchemaEntry(env: IGraphEnv, key: string | null): ISchemaEntry {
	const store = env.schemas;
	const get = (): ISchemaEntry => (store && key !== null ? store.get(key) : IDLE_ENTRY);
	return useSyncExternalStore(store ? store.subscribe : NO_SUBSCRIBE, get, get);
}

/** Props. */
export interface IGraphSidebarProps {
	/** The dev-tool sidebar (the controller): also lists the connections, each opening its workbench. */
	devtool?: boolean;
}

/** The sidebar: the navigation menu (as a dev tool, the connection list) plus the active connection's schema. */
const GraphSidebar: React.FC<IGraphSidebarProps> = ({ devtool = false }) => {
	const env = useGraphEnv();
	const isConnected = env.ready;
	const { status, endpoints, probes, error } = useGraphEndpoints();
	const [hoveredKey, setHoveredKey] = useState<string | null>(null);
	// The header's actions show while the pointer is over the list or focus is inside it (keyboard users reach them too).
	const [paneHovered, setPaneHovered] = useState(false);
	const [paneFocused, setPaneFocused] = useState(false);
	const activeKey = useActiveConnection();
	const entry = useSchemaEntry(env, activeKey);
	const endpoint = useMemo(() => endpoints.find((e) => e.key === activeKey) ?? null, [endpoints, activeKey]);
	const probe = activeKey ? probes[activeKey] : undefined;
	const tree = useMemo(() => buildSchemaTree(entry.view), [entry.view]);

	// Read the schema once when a connection becomes active and has answered its probe.
	useEffect(() => {
		if (isConnected && endpoint && endpoint.state === 'ready' && probe?.ok && entry.status === 'idle') void env.loadSchema(endpoint.key);
	}, [env, isConnected, endpoint, probe, entry.status]);

	// The full app's menu: one entry that opens the Connections landing.
	const menu: ViewMenu = useMemo(() => ({ entries: [{ id: 'connections', label: 'Connections', icon: <GraphIcon />, ...(endpoints.length > 0 ? { count: endpoints.length } : {}) }] }), [endpoints.length]);
	const line = sidebarListLine(status, endpoints, error);
	// Refresh cannot run while discovery runs or the realm is offline. It says so with aria-disabled and ignores the
	// activation: a `disabled` button would drop the keyboard focus to the page, and the header cluster would fade.
	const refreshBlocked = !isConnected || status === 'loading';

	const select = (id: string): void => {
		const chosen = id === 'connections' ? null : endpoints.find((e) => e.key === id) ?? null;
		env.openDocument(chosen ? { kind: 'workbench', endpoint: chosen } : { kind: 'connections' });
	};

	const open = (path: string): void => {
		const target = tree.target(path);
		if (!target || !endpoint) return;
		env.openDocument({ kind: 'workbench', endpoint });
		env.previews.request({ endpointKey: endpoint.key, action: target.kind === 'label' ? 'label-preview' : 'type-preview', name: target.name });
	};

	const showTree = activeKey !== null && endpoint !== null && (entry.status !== 'idle' || entry.view.labels.length > 0);
	const schemaStatus = entry.status === 'loading' ? 'Reading the schema\u2026' : schemaStatusText(entry.view, Date.now());

	return (
		<>
			{devtool ? (
				<div style={styles.section} onMouseEnter={() => setPaneHovered(true)} onMouseLeave={() => setPaneHovered(false)} onFocus={() => setPaneFocused(true)} onBlur={() => setPaneFocused(false)}>
					<div style={styles.sectionHeader}>
						<span style={styles.sectionLabel}>Connections</span>
						<div style={styles.headerActions(paneHovered || paneFocused)}>
							<button type="button" style={refreshBlocked ? styles.headerActionBlocked : styles.headerAction} title="Refresh connections" aria-label="Refresh connections" aria-disabled={refreshBlocked} onClick={() => { if (!refreshBlocked) void env.refresh(); }}>
								<BxRefresh size={18} />
							</button>
						</div>
					</div>
					{endpoints.map((e) => {
						const row = connectionRow(e, probes[e.key]);
						const active = e.key === activeKey;
						return (
							<div
								key={e.key}
								role="button"
								tabIndex={0}
								title={row.tooltip}
								aria-label={row.ariaLabel}
								style={styles.row(active, hoveredKey === e.key)}
								onClick={() => select(e.key)}
								onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(e.key); } }}
								onMouseEnter={() => setHoveredKey(e.key)}
								onMouseLeave={() => setHoveredKey(null)}
							>
								<span style={styles.rowIcon(active)}><GraphIcon /></span>
								<span style={styles.rowLabel}>{row.label}</span>
								{row.status !== null && <span style={styles.rowStatus}>{row.status}</span>}
								<span style={styles.dot(row.variant)} aria-hidden="true" />
							</div>
						);
					})}
					{line && <div style={line.tone === 'error' ? styles.error : styles.empty} title={line.detail ?? undefined}>{line.text}</div>}
				</div>
			) : (
				<SidebarMenu menu={menu} activeId={activeKey ? '' : 'connections'} onSelect={select} sectionLabel="Graph Explorer" />
			)}
			{showTree && (
				<>
					<Explorer
						vfs={NOOP_VFS}
						config={{
							title: entry.view.labels.length + entry.view.relationshipTypes.length === 0 ? 'Schema' : endpoint.nodeName || 'Schema',
							extensions: null,
							displayName: (filename) => tree.displayName(filename),
							emptyMessage: entry.status === 'loading' ? 'Reading the schema\u2026' : 'No labels or relationship types listed',
							allowFolders: false,
						}}
						entries={tree.entries}
						isConnected={isConnected}
						onOpenFile={open}
						onRefresh={() => {
							if (isConnected && endpoint) void env.loadSchema(endpoint.key, { fresh: true });
						}}
					/>
					<div style={styles.status}>
						<div>{schemaStatus}</div>
						{entry.failure && entry.failure.headline !== '' && (
							<div style={styles.statusWarning}>
								{entry.failure.headline}
								{entry.failure.hint ? ` ${entry.failure.hint}` : ''}
							</div>
						)}
						{entry.view.error && entry.view.error.headline !== '' && (
							<div style={styles.statusLine}>
								<div>{entry.view.error.headline}</div>
								{entry.view.error.detail !== '' && <div style={styles.statusDetail}>{entry.view.error.detail}</div>}
							</div>
						)}
						{entry.view.sampled && entry.view.labels.length > 0 && <div style={styles.statusLine}>{SAMPLED_NOTE}</div>}
						{entry.view.truncated && <div style={styles.statusLine}>{TRUNCATED_NOTE}</div>}
						{tree.entries.length > 0 && <div style={styles.statusLine}>Click a label or type to preview 25 of its rows.</div>}
					</div>
				</>
			)}
		</>
	);
};

export default GraphSidebar;
