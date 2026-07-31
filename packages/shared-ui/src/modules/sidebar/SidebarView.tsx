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
 * The Explorer component handles all file tree rendering, inline rename/create,
 * context menus, status indicators, and child item actions.  SidebarView
 * just wraps it with app-specific chrome.
 */

import React, { useState, useCallback, CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import { BxPlus, BxDesktop, BxChevronRight, BxChevronDown, BxStop } from '../../components/BoxIcon';
import { SidebarMenu } from '../../components/sidebar-menu/SidebarMenu';
import { StatusBadge } from '../../components/status-badge/StatusBadge';
import type { StatusVariant } from '../../components/status-badge/StatusBadge';
import { Explorer, NOOP_VFS } from '../explorer';
import type { AppListItem, ISidebarViewProps } from './types';
import type { ViewMenu } from '../../types/viewMenu';
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
	navSection: {
		padding: '8px 6px 12px',
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
	// Mode strip — the TabControl idiom applied to the sidebar top:
	// uppercase labels, active = text-primary + 2px brand underline.
	modeStrip: {
		display: 'flex',
		gap: 2,
		padding: '0 10px',
		borderBottom: '1px solid var(--rr-border)',
		flexShrink: 0,
	} as CSSProperties,
	modeTab: {
		padding: '9px 12px 7px',
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: '0.06em',
		textTransform: 'uppercase' as const,
		color: 'var(--rr-text-secondary)',
		borderBottom: '2px solid transparent',
		cursor: 'pointer',
		userSelect: 'none' as const,
	} as CSSProperties,
	modeTabActive: {
		color: 'var(--rr-text-primary)',
		borderBottomColor: 'var(--rr-brand)',
	} as CSSProperties,
	appsSection: {
		padding: '6px 6px 2px',
		flex: 1,
		minHeight: 0,
		overflowY: 'auto' as const,
	} as CSSProperties,
	appsLabel: {
		padding: '8px 10px 4px',
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: '0.08em',
		textTransform: 'uppercase' as const,
		color: 'var(--rr-text-secondary)',
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
export const SidebarView: React.FC<ISidebarViewProps> = ({ connection, isSubscribed = true, entries, activeTasks, unknownTasks, headerSlot, onNavigate, onOpenFile, onFileManage, fileActions, onSourceAction, onRefresh, footerSlot, onOpenUnknownTask, activeFilePath, appBuilder, sidebarMode = 'pipelines', onSidebarModeChange }) => {
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const [unknownExpanded, setUnknownExpanded] = useState(true);

	const isConnected = connection.state === 'connected';
	const hasUnknown = (unknownTasks?.length ?? 0) > 0;
	// The mode strip exists only when the host wires the App Builder; the
	// apps mode is only honored when it can actually render something.
	const hasAppBuilder = Boolean(appBuilder);
	const mode = hasAppBuilder ? sidebarMode : 'pipelines';
	// --- Static top-nav menu (New pipeline / Monitor) ------------------------

	// The fixed nav actions rendered above the Explorer as a stock SidebarMenu.
	// Monitor is disabled while disconnected; there is no persistent selection,
	// so activeId is empty. Icons match the shell nav sizing (16px).
	const navMenu: ViewMenu = {
		entries: [
			{ id: 'new', label: 'New pipeline', icon: <BxPlus size={16} /> },
			{ id: 'monitor', label: 'Monitor', icon: <BxDesktop size={16} />, disabled: !isConnected },
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

	return (
		<div style={S.container}>
			{/* ── Mode strip (only when the host wires the App Builder) ── */}
			{hasAppBuilder && (
				<div style={S.modeStrip}>
					<div
						style={mode === 'pipelines' ? { ...S.modeTab, ...S.modeTabActive } : S.modeTab}
						onClick={() => onSidebarModeChange?.('pipelines')}
					>Pipelines</div>
					<div
						style={mode === 'apps' ? { ...S.modeTab, ...S.modeTabActive } : S.modeTab}
						onClick={() => onSidebarModeChange?.('apps')}
					>App Builder</div>
				</div>
			)}

			{/* ── APP BUILDER MODE — + New app / MY APPS list ─────────── */}
			{mode === 'apps' && appBuilder && (
				<>
					<div style={S.navSection}>
						<SidebarMenu
							menu={appsNavMenu}
							activeId=""
							onSelect={(id) => {
								if (id === 'newApp') appBuilder.onNewApp();
							}}
						/>
					</div>
					<div style={S.appsSection}>
						<div style={S.appsLabel}>My Apps</div>
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
									<span style={S.rowName}>{app.name}</span>
									<span style={S.spacer} />
									<StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>
								</div>
							);
						})}
					</div>
					{footerSlot}
				</>
			)}

			{/* ── PIPELINES MODE — the existing layout, untouched ─────── */}
			{mode === 'pipelines' && (
				<>
			{/* ── Navigation ──────────────────────────────────────────── */}
			<div style={S.navSection}>
				{/* Host-injected nav (e.g. rocket-ui's Home button). Bare render so an
				    omitted slot adds zero DOM/spacing — VS Code passes nothing. */}
				{headerSlot}
				{/* Fixed nav actions as a stock SidebarMenu. No persistent selection
				    (activeId=''); the id-narrowing guard keeps onNavigate's union
				    contract without a cast. SidebarMenu reads the collapsed flag
				    from context, so no explicit collapsed prop is wired here. */}
				<SidebarMenu
					menu={navMenu}
					activeId=""
					onSelect={(id) => {
						if (id === 'new' || id === 'monitor') onNavigate(id);
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

			{/* ── Footer slot ─────────────────────────────────────────── */}
			{footerSlot}
				</>
			)}
		</div>
	);
};
