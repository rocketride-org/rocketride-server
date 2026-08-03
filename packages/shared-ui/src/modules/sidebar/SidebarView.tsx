// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarView — Unified sidebar container for pipeline management.
 *
 * Composes the generic Explorer component (file tree) with pipeline-specific
 * UI: navigation buttons, unknown tasks section, and a footer slot.
 *
 * Column order: shared nav (host slot + Monitor), then the stock TabControl
 * mode tabs (Pipelines | Apps | Nodes — Apps when the host wires the app
 * builder, Nodes as the node-builder placeholder), then a stock TabPanel
 * holding the mode bodies, then the shared footer slot.
 *
 * The Explorer component handles all file tree rendering, inline rename/create,
 * context menus, status indicators, and child item actions.  SidebarView
 * just wraps it with app-specific chrome.
 */

import React, { useState, useCallback, CSSProperties } from 'react';
import { commonStyles } from 'shell/src/themes/styles';
import { BxPlus, BxDesktop, BxChevronRight, BxChevronDown, BxStop, BxGridAlt } from 'shell';
import { SidebarMenu, TabControl, TabPanel } from 'shell';
import { StatusBadge } from 'shell';
import type { StatusVariant } from 'shell';
import { Explorer, NOOP_VFS } from '../explorer';
import type { AppListItem, ISidebarViewProps } from './types';
import type { ViewMenu } from 'shell';
import type { ExplorerEntry, ExplorerStatus, ExplorerConfig } from '../explorer';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100vh',
		fontFamily: 'var(--rr-font-family, system-ui, sans-serif)',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		overflow: 'hidden',
	} as CSSProperties,
	// No horizontal padding: the SidebarMenu inside carries its own tree-list
	// padding (2px 6px), so adding more here would indent nav rows past the
	// Explorer rows and break the sidebar's shared left rhythm.
	navSection: {
		padding: '8px 0 12px',
		flexShrink: 0,
	} as CSSProperties,
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		padding: '1px 8px',
		borderRadius: 5,
		fontSize: 13,
		lineHeight: '22px',
		cursor: 'pointer',
		userSelect: 'none' as const,
		position: 'relative' as const,
	} as CSSProperties,
	rowName: {
		...commonStyles.textEllipsis,
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	spacer: { flex: 1 } as CSSProperties,
	dot: (color: string): CSSProperties => ({
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: color,
		flexShrink: 0,
	}),
	actionBtn: (color: string): CSSProperties => ({
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: '2px 4px',
		borderRadius: 3,
		color,
		flexShrink: 0,
		display: 'flex',
		alignItems: 'center',
	}),
	// Wrapper giving the TabPanel stack the remaining column height (the
	// stock TabPanel sizes itself to 100% of its parent).
	panelStack: {
		flex: 1,
		minHeight: 0,
	} as CSSProperties,
	// One mode body inside the TabPanel stack — its own full-height column
	// so the Explorer / apps list keep their internal flex scrolling.
	panelColumn: {
		display: 'flex',
		flexDirection: 'column' as const,
		height: '100%',
	} as CSSProperties,
	// MY APPS header — the Explorer's section-header treatment (same label
	// style and left offset). The 24px line height reproduces the row height
	// the Explorer's header gets from its 16px+4px-padding action buttons, so
	// the two labels sit at the same vertical position across the mode tabs.
	appsLabel: {
		...commonStyles.labelUppercase,
		padding: '6px 12px 4px',
		lineHeight: '24px',
		flexShrink: 0,
	} as CSSProperties,
	// MY APPS list — the Explorer's tree-list padding, so app rows align
	// with pipeline rows across the mode tabs.
	appsList: {
		padding: '2px 6px',
		flex: 1,
		minHeight: 0,
		overflowY: 'auto' as const,
	} as CSSProperties,
	// Placeholder body for not-yet-built modes (the Explorer empty-state
	// treatment: centered muted text).
	comingSoon: {
		...commonStyles.textMuted,
		padding: 16,
		fontSize: 12,
		textAlign: 'center' as const,
	} as CSSProperties,
};

// StatusBadge variant + label per app lifecycle state ('pending' reads
// "in review" — the mockup's vocabulary).
const APP_BADGE: Record<AppListItem['status'], { variant: StatusVariant; label: string }> = {
	local: { variant: 'muted', label: 'local' },
	dev: { variant: 'warning', label: 'dev' },
	draft: { variant: 'muted', label: 'draft' },
	pending: { variant: 'warning', label: 'in review' },
	approved: { variant: 'success', label: 'approved' },
	rejected: { variant: 'error', label: 'rejected' },
	live: { variant: 'info', label: 'live' },
};

const HOVER_BG = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))';

// =============================================================================
// DEFAULT EXPLORER CONFIG
// =============================================================================

/** Default configuration for the pipeline Explorer panel. */
const PIPELINE_CONFIG: ExplorerConfig = {
	title: 'Pipelines',
	extensions: ['.pipe', '.pipe.json'],
	displayName: (name: string) => name.replace(/\.pipe(?:\.json)?$/, '') || name,
	createPlaceholder: 'pipeline name',
	emptyMessage: 'No pipeline files',
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * SidebarView — pipeline sidebar container that composes Explorer with
 * navigation buttons, unknown tasks, and a footer slot.
 *
 * Maps ISidebarViewProps (pipeline-specific) to IExplorerProps (generic).
 * The Explorer component handles all file tree rendering internally.
 */
export const SidebarView: React.FC<ISidebarViewProps> = ({ connection, isSubscribed = true, entries, activeTasks, unknownTasks, headerSlot, onNavigate, onOpenFile, onFileManage, fileActions, onSourceAction, onRefresh, footerSlot, onOpenUnknownTask, activeFilePath, appBuilder, showModeStrip = false, sidebarMode = 'pipelines', onSidebarModeChange }) => {
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const [unknownExpanded, setUnknownExpanded] = useState(true);

	const isConnected = connection.state === 'connected';
	const hasUnknown = (unknownTasks?.length ?? 0) > 0;
	// The Apps tab exists only when the host wires it; the Nodes tab exists
	// whenever the mode tabs render at all. A requested mode is only honored
	// when its tab actually exists — anything else falls back to Pipelines.
	const hasAppBuilder = Boolean(appBuilder);
	const tabsVisible = hasAppBuilder || showModeStrip;
	const mode = (sidebarMode === 'apps' && hasAppBuilder) || (sidebarMode === 'nodes' && tabsVisible) ? sidebarMode : 'pipelines';
	// --- Static nav menus ----------------------------------------------------

	// Monitor sits ABOVE the mode tabs — it is mode-independent chrome shared
	// by both tabs. Disabled while disconnected; there is no persistent
	// selection, so activeId is empty. Icons match the shell nav sizing (16px).
	const monitorMenu: ViewMenu = {
		entries: [{ id: 'monitor', label: 'Monitor', icon: <BxDesktop size={16} />, disabled: !isConnected }],
	};

	// "+ New pipeline" belongs to the Pipelines tab body only.
	const pipelinesNavMenu: ViewMenu = {
		entries: [{ id: 'new', label: 'New pipeline', icon: <BxPlus size={16} /> }],
	};

	// The mode tabs — the stock TabControl menu. The Apps entry only exists
	// when the host wires the app-builder sidebar content; Nodes (the
	// node-builder placeholder) rides along whenever the tabs render.
	const modeMenu: ViewMenu = {
		entries: [
			{ id: 'pipelines', label: 'Pipelines' },
			...(hasAppBuilder ? [{ id: 'apps', label: 'Apps' }] : []),
			{ id: 'nodes', label: 'Nodes' },
		],
	};

	// --- Map pipeline entries → Explorer entries -----------------------------

	const explorerEntries: ExplorerEntry[] = entries.map((e) => ({
		path: e.path,
		type: e.type,
		documentId: e.projectId,
		children: e.sources?.map((s) => ({ id: s.id, name: s.name, provider: s.provider })),
	}));

	// --- Map activeTasks → Explorer statuses ---------------------------------

	const explorerStatuses = activeTasks as Map<string, ExplorerStatus>;

	// --- Child action handler (run/stop sources) -----------------------------

	const handleChildAction = useCallback(
		(action: 'run' | 'stop', filePath: string, childId: string, documentId?: string) => {
			onSourceAction(action, filePath, childId, documentId);
		},
		[onSourceAction]
	);

	// --- Nav hover helpers ---------------------------------------------------

	const hoverBg = (id: string): CSSProperties => (hoveredRow === id ? { background: HOVER_BG } : {});

	// --- Render --------------------------------------------------------------

	// --- MY APPS nav (App Builder mode) --------------------------------------

	// "+ New app" as a stock SidebarMenu entry, mirroring "New pipeline".
	const appsNavMenu: ViewMenu = {
		entries: [{ id: 'newApp', label: 'New app', icon: <BxPlus size={16} /> }],
	};

	// --- Mode bodies ---------------------------------------------------------

	// Pipelines tab body: + New pipeline nav, the Explorer tree, and the
	// ad-hoc (unknown-task) section.
	const pipelinesPanel = (
		<div style={S.panelColumn}>
			{/* ── Navigation ──────────────────────────────────────────── */}
			<div style={S.navSection}>
				{/* "+ New pipeline" as a stock SidebarMenu. No persistent selection
				    (activeId=''); the id-narrowing guard keeps onNavigate's union
				    contract without a cast. SidebarMenu reads the collapsed flag
				    from context, so no explicit collapsed prop is wired here. */}
				<SidebarMenu
					menu={pipelinesNavMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'new') onNavigate(id);
					}}
				/>
			</div>

			{/* ── Explorer (file tree) ────────────────────────────────── */}
			{/* vfs must be passed (frozen shell-contract shape) but is unused —
			    the typed no-op replaces the old `null as any` cast. */}
			<Explorer vfs={NOOP_VFS} config={PIPELINE_CONFIG} entries={explorerEntries} statuses={explorerStatuses} isConnected={isConnected} showChildActions={isSubscribed} activeFilePath={activeFilePath} onOpenFile={onOpenFile} onFileManage={onFileManage} fileActions={fileActions} onChildAction={handleChildAction} onRefresh={onRefresh} />

			{/* ── Unknown tasks (AD-HOC) — server tasks with no .pipe file */}
			{hasUnknown && (
				<div style={{ padding: '2px 6px', flexShrink: 0 }}>
					<div style={{ ...S.row, marginTop: 4, ...hoverBg('unknown-root') }} onMouseEnter={() => setHoveredRow('unknown-root')} onMouseLeave={() => setHoveredRow(null)} onClick={() => setUnknownExpanded((p) => !p)}>
						{unknownExpanded ? <BxChevronDown size={14} /> : <BxChevronRight size={14} />}
						<span style={{ ...S.rowName, ...commonStyles.labelUppercase, color: 'var(--rr-text-secondary)' }}>Ad-hoc</span>
						<span style={S.spacer} />
						<span style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>{unknownTasks!.length} running</span>
					</div>
					{unknownExpanded &&
						unknownTasks!.map((ut) => {
							const utKey = `ut:${ut.projectId}:${ut.sourceId}`;
							return (
								<div key={utKey} style={{ ...S.row, paddingLeft: 28, ...hoverBg(utKey) }} onMouseEnter={() => setHoveredRow(utKey)} onMouseLeave={() => setHoveredRow(null)} onClick={() => onOpenUnknownTask?.(ut.projectId, ut.sourceId, ut.displayName)} title={`Project: ${ut.projectId}\nSource: ${ut.sourceId}\nRunning (no local .pipe file)`}>
									<div style={S.dot('var(--rr-color-success)')} />
									<span style={S.rowName}>{ut.displayName}</span>
									<span style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginLeft: 4 }}>{ut.projectLabel}</span>
									<span style={S.spacer} />
									{hoveredRow === utKey && isConnected && (
										<button
											style={S.actionBtn('var(--rr-color-error)')}
											title="Stop"
											onClick={(e) => {
												e.stopPropagation();
												onSourceAction('stop', '', ut.sourceId, ut.projectId);
											}}
										>
											<BxStop size={16} />
										</button>
									)}
								</div>
							);
						})}
				</div>
			)}
		</div>
	);

	// Apps tab body: + New app nav and the MY APPS list.
	const appsPanel = appBuilder ? (
		<div style={S.panelColumn}>
			<div style={S.navSection}>
				<SidebarMenu
					menu={appsNavMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'newApp') appBuilder.onNewApp();
					}}
				/>
			</div>
			<div style={S.appsLabel}>My Apps</div>
			<div style={S.appsList}>
				{appBuilder.apps.length === 0 && (
					<div style={{ padding: '4px 10px', fontSize: 12, color: 'var(--rr-text-secondary)' }}>
						No apps yet — create one with New app.
					</div>
				)}
				{appBuilder.apps.map((app) => {
					const rowKey = `app:${app.id}`;
					const active = app.id === appBuilder.activeAppId;
					const badge = APP_BADGE[app.status] ?? APP_BADGE.local;
					return (
						<div
							key={app.id}
							style={{ ...S.row, ...(active ? { background: HOVER_BG } : hoverBg(rowKey)) }}
							onMouseEnter={() => setHoveredRow(rowKey)}
							onMouseLeave={() => setHoveredRow(null)}
							onClick={() => appBuilder.onOpenApp(app.id)}
							title={app.folder ? `${app.id}\n${app.folder}` : app.id}
						>
							{/* Mirror the Explorer file-row anatomy — 14px chevron slot
							    (apps don't expand) + 16px leading icon — so app icons and
							    names align column-for-column with the pipeline rows. */}
							<span style={{ width: 14, flexShrink: 0 }} />
							<BxGridAlt size={16} color="var(--rr-text-secondary)" />
							<span style={S.rowName}>{app.name}</span>
							<span style={S.spacer} />
							<StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>
						</div>
					);
				})}
			</div>
		</div>
	) : null;

	// Nodes tab body: node-builder placeholder until the real surface lands.
	const nodesPanel = (
		<div style={S.panelColumn}>
			<div style={S.comingSoon}>Coming soon...</div>
		</div>
	);

	return (
		<div style={S.container}>
			{/* ── Shared nav above the mode tabs: host slot + Monitor ─── */}
			<div style={S.navSection}>
				{/* Host-injected nav (e.g. rocket-ui's Home button). Bare render so an
				    omitted slot adds zero DOM/spacing — VS Code passes nothing. */}
				{headerSlot}
				<SidebarMenu
					menu={monitorMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'monitor') onNavigate(id);
					}}
				/>
			</div>

			{/* ── Mode tabs — the stock TabControl strip: Apps tab when
			    wired, Nodes placeholder always; strip alone forced by the
			    web host (future modes land here) ──────────────────────── */}
			{tabsVisible && (
				<TabControl
					menu={modeMenu}
					activeId={mode}
					onSelect={(id) => {
						if (id === 'pipelines' || id === 'apps' || id === 'nodes') onSidebarModeChange?.(id);
					}}
				/>
			)}

			{/* ── Mode bodies — the stock TabPanel stack keeps all modes
			    mounted, so Explorer scroll/expand state survives switches */}
			<div style={S.panelStack}>
				<TabPanel activeId={mode} panels={{ pipelines: { content: pipelinesPanel }, ...(appsPanel ? { apps: { content: appsPanel } } : {}), nodes: { content: nodesPanel } }} />
			</div>

			{/* ── Footer slot (shared by both modes) ──────────────────── */}
			{footerSlot}
		</div>
	);
};
