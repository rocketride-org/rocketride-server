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

import React, { useState, useCallback, useMemo, CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import { BxPlus, BxDesktop, BxChevronRight, BxChevronDown, BxStop } from '../../components/BoxIcon';
import { TabControl } from '../../components/tab-control/TabControl';
import { SidebarMenu } from '../../components/sidebar-menu/SidebarMenu';
import { Explorer, NOOP_VFS } from '../explorer';
import type { ISidebarViewProps, SidebarDeployment } from './types';
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

/** Configuration for the deployments Explorer panel (same stock control). */
const DEPLOYMENTS_CONFIG: ExplorerConfig = {
	title: 'Deployments',
	extensions: null,
	emptyMessage: 'No deployments yet — publish from a pipeline\u2019s DEPLOY tab',
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
export const SidebarView: React.FC<ISidebarViewProps> = ({ connection, isSubscribed = true, entries, activeTasks, unknownTasks, deployments, headerSlot, onNavigate, onOpenFile, onFileManage, fileActions, onSourceAction, onRefresh, footerSlot, onOpenUnknownTask, onOpenDeployment, onRefreshDeployments, activeDeploymentKey, activeFilePath }) => {
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const [unknownExpanded, setUnknownExpanded] = useState(true);
	// Which tree the sidebar shows — the TabControl strip switches it.
	const [treeMode, setTreeMode] = useState<'pipelines' | 'deployments'>('pipelines');

	const isConnected = connection.state === 'connected';
	const hasUnknown = (unknownTasks?.length ?? 0) > 0;
	// The strip renders whenever the host SUPPLIES deployments (even empty)
	// — discoverability without an edition check.
	const hasDeployments = deployments !== undefined;

	// Deployments as STOCK Explorer entries: '{team}/{pipeline}' paths give
	// the team grouping for free (the Explorer derives dirs from paths);
	// one team collapses to flat names — cardinality-driven.
	const multiTeam = useMemo(() => new Set((deployments ?? []).map((dep) => dep.teamId)).size > 1, [deployments]);
	const deploymentEntries: ExplorerEntry[] = useMemo(
		() =>
			(deployments ?? []).map((dep) => ({
				path: multiTeam ? `${dep.teamName}/${dep.pipelineName}` : dep.pipelineName,
				type: 'file' as const,
				documentId: `${dep.teamId}:${dep.projectId}`,
			})),
		[deployments, multiTeam]
	);
	// Path -> deployment lookup for open/status resolution.
	const deploymentByPath = useMemo(() => {
		const map = new Map<string, SidebarDeployment>();
		for (const dep of deployments ?? []) map.set(multiTeam ? `${dep.teamName}/${dep.pipelineName}` : dep.pipelineName, dep);
		return map;
	}, [deployments, multiTeam]);
	// State dots through the Explorer's own status channel.
	const deploymentStatuses = useMemo(() => {
		const map = new Map<string, ExplorerStatus>();
		for (const [path, dep] of deploymentByPath) {
			map.set(path, { running: Boolean(dep.running), errors: dep.state === 'errored' ? ['errored'] : [], warnings: dep.state === 'paused' ? ['paused'] : [] });
		}
		return map;
	}, [deploymentByPath]);

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

	return (
		<div style={S.container}>
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

			{/* ── Tree switch (stock TabControl) ─────────────────── */}
			{hasDeployments && (
				<TabControl
					menu={{
						entries: [
							{ id: 'pipelines', label: 'Pipelines' },
							{ id: 'deployments', label: 'Deployments' },
						],
					}}
					activeId={treeMode}
					onSelect={(id) => setTreeMode(id as 'pipelines' | 'deployments')}
				/>
			)}

			{/* ── Explorer (file tree) ────────────────────────────────── */}
			{/* vfs must be passed (frozen shell-contract shape) but is unused —
			    the typed no-op replaces the old `null as any` cast. */}
			{treeMode === 'pipelines' && <Explorer vfs={NOOP_VFS} config={PIPELINE_CONFIG} entries={explorerEntries} statuses={explorerStatuses} isConnected={isConnected} showChildActions={isSubscribed} activeFilePath={activeFilePath} onOpenFile={onOpenFile} onFileManage={onFileManage} fileActions={fileActions} onChildAction={handleChildAction} onRefresh={onRefresh} />}

			{/* ── Deployments (the SAME stock Explorer) ───────────────── */}
			{treeMode === 'deployments' && (
				<Explorer
					vfs={NOOP_VFS}
					config={DEPLOYMENTS_CONFIG}
					entries={deploymentEntries}
					statuses={deploymentStatuses}
					isConnected={isConnected}
					activeFilePath={activeDeploymentKey ? [...deploymentByPath.entries()].find(([, dep]) => `${dep.teamId}:${dep.projectId}` === activeDeploymentKey)?.[0] : undefined}
					onOpenFile={(path) => {
						const dep = deploymentByPath.get(path);
						if (dep) onOpenDeployment?.(dep.teamId, dep.projectId, multiTeam ? `${dep.teamName} / ${dep.pipelineName}` : dep.pipelineName);
					}}
					onRefresh={() => onRefreshDeployments?.()}
				/>
			)}

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
		</div>
	);
};
