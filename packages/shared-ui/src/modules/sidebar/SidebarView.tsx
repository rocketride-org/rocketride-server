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
import { Explorer } from '../explorer';
import type { ISidebarViewProps } from './types';
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
	navBtn: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '3px 8px',
		cursor: 'pointer',
		borderRadius: 5,
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		border: 'none',
		background: 'none',
		width: '100%',
		textAlign: 'left' as const,
	} as CSSProperties,
	navBtnDisabled: {
		opacity: 0.45,
		cursor: 'default',
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
export const SidebarView: React.FC<ISidebarViewProps> = ({ connection, isSubscribed = true, entries, activeTasks, unknownTasks, headerSlot, onNavigate, onOpenFile, onFileManage, fileActions, onSourceAction, onRefresh, footerSlot, onOpenUnknownTask, activeFilePath }) => {
	const [hoveredNav, setHoveredNav] = useState<string | null>(null);
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const [unknownExpanded, setUnknownExpanded] = useState(true);

	const isConnected = connection.state === 'connected';
	const hasUnknown = (unknownTasks?.length ?? 0) > 0;

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

	const navHoverBg = (id: string): CSSProperties => (hoveredNav === id ? { background: HOVER_BG } : {});
	const hoverBg = (id: string): CSSProperties => (hoveredRow === id ? { background: HOVER_BG } : {});

	// --- Render --------------------------------------------------------------

	return (
		<div style={S.container}>
			{/* ── Navigation ──────────────────────────────────────────── */}
			<div style={S.navSection}>
				{/* Host-injected nav (e.g. rocket-ui's Home button). Bare render so an
				    omitted slot adds zero DOM/spacing — VS Code passes nothing. */}
				{headerSlot}
				<button style={{ ...S.navBtn, ...navHoverBg('new') }} onMouseEnter={() => setHoveredNav('new')} onMouseLeave={() => setHoveredNav(null)} onClick={() => onNavigate('new')}>
					<BxPlus size={16} /> New pipeline
				</button>
				<button style={{ ...S.navBtn, ...navHoverBg('monitor'), ...(isConnected ? {} : S.navBtnDisabled) }} onMouseEnter={() => setHoveredNav('monitor')} onMouseLeave={() => setHoveredNav(null)} onClick={() => isConnected && onNavigate('monitor')} disabled={!isConnected}>
					<BxDesktop size={16} /> Monitor
				</button>
			</div>

			{/* ── Explorer (file tree) ────────────────────────────────── */}
			<Explorer vfs={null as any} config={PIPELINE_CONFIG} entries={explorerEntries} statuses={explorerStatuses} isConnected={isConnected} showChildActions={isSubscribed} activeFilePath={activeFilePath} onOpenFile={onOpenFile} onFileManage={onFileManage} fileActions={fileActions} onChildAction={handleChildAction} onRefresh={onRefresh} />

			{/* ── Unknown tasks (Other) ───────────────────────────────── */}
			{hasUnknown && (
				<div style={{ padding: '2px 6px', flexShrink: 0 }}>
					<div style={{ ...S.row, marginTop: 4, ...hoverBg('unknown-root') }} onMouseEnter={() => setHoveredRow('unknown-root')} onMouseLeave={() => setHoveredRow(null)} onClick={() => setUnknownExpanded((p) => !p)}>
						{unknownExpanded ? <BxChevronDown size={14} /> : <BxChevronRight size={14} />}
						<span style={{ ...S.rowName, fontWeight: 600 }}>Other</span>
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
											<BxStop size={14} />
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
