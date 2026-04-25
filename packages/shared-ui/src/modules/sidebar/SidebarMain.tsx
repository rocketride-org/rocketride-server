// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarMain — Unified sidebar component for pipeline management.
 *
 * Shared between VS Code webview and rocket-ui.  All data flows in via
 * props; all user actions flow out via callbacks.  The host is responsible
 * for finding/parsing pipeline files, tracking task events, and handling
 * all actions.
 *
 * The component stores only files in a flat array and derives directory
 * hierarchy on the fly via path parsing (S3-style).  A flat/tree toggle
 * lets the user switch views.
 */

import React, { useState, useCallback, useMemo, CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import { BxPlus, BxDesktop, BxCloudUpload, BxComponent, BxFile, BxFolderOpen, BxChevronRight, BxChevronDown, BxRefresh, BxBookOpen, BxCog, BxPlay, BxStop, BxListUl, BxGridAlt } from '../../components/BoxIcon';
import type { ISidebarMainProps, ProjectEntry, DirEntry, ActiveTaskState } from './types';

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
	sectionHeader: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '6px 12px 4px',
		flexShrink: 0,
		borderTop: '1px solid var(--rr-border)',
	} as CSSProperties,
	sectionLabel: {
		...commonStyles.labelUppercase,
		flex: 1,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	headerAction: {
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: 2,
		borderRadius: 3,
		color: 'var(--rr-text-secondary)',
		display: 'flex',
		alignItems: 'center',
	} as CSSProperties,
	treeList: {
		flex: 1,
		overflowY: 'auto' as const,
		padding: '2px 6px',
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
	} as CSSProperties,
	rowName: {
		...commonStyles.textEllipsis,
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	spacer: {
		flex: 1,
	} as CSSProperties,
	dot: (color: string): CSSProperties => ({
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: color,
		flexShrink: 0,
	}),
	badge: (color: string): CSSProperties => ({
		fontSize: 10,
		color,
		flexShrink: 0,
		marginLeft: 2,
	}),
	connectionDot: (connected: boolean): CSSProperties => ({
		width: 10,
		height: 10,
		borderRadius: '50%',
		backgroundColor: connected ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)',
		flexShrink: 0,
		margin: '0 3px',
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
	emptyState: {
		...commonStyles.textMuted,
		padding: 16,
		fontSize: 12,
		textAlign: 'center' as const,
	} as CSSProperties,
	footer: {
		flexShrink: 0,
		borderTop: '1px solid var(--rr-border)',
		padding: '12px 6px',
	} as CSSProperties,
	footerBtn: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '3px 8px',
		cursor: 'pointer',
		borderRadius: 5,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		border: 'none',
		background: 'none',
		width: '100%',
		textAlign: 'left' as const,
	} as CSSProperties,
};

// =============================================================================
// CONSTANTS
// =============================================================================

const MODE_LABELS: Record<string, string> = {
	cloud: 'Cloud',
	docker: 'Docker',
	service: 'Service',
	onprem: 'On-prem',
	local: 'Local',
};

const HOVER_BG = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Derives children of a given parent path from the flat entries array.
 * Directories are synthesized when a path segment contains a '/'.
 */
function deriveChildren(entries: ProjectEntry[], parent: string | undefined): (ProjectEntry | DirEntry)[] {
	const prefix = parent ? parent + '/' : '';
	const result: (ProjectEntry | DirEntry)[] = [];
	const seenDirs = new Set<string>();

	for (const entry of entries) {
		// Skip entries that don't belong under this parent
		if (prefix && !entry.path.startsWith(prefix)) continue;
		if (!prefix && entry.path.indexOf('/') === -1) {
			// Root-level file
			result.push(entry);
			continue;
		}
		if (!prefix && entry.path.indexOf('/') >= 0) {
			// Root-level: synthesize top-level directory
			const dirName = entry.path.substring(0, entry.path.indexOf('/'));
			if (!seenDirs.has(dirName)) {
				seenDirs.add(dirName);
				result.push({ name: dirName, path: dirName, type: 'dir' });
			}
			continue;
		}

		// Under a prefix
		const remainder = entry.path.substring(prefix.length);
		const slashIdx = remainder.indexOf('/');
		if (slashIdx >= 0) {
			// Synthesize subdirectory
			const dirName = remainder.substring(0, slashIdx);
			if (!seenDirs.has(dirName)) {
				seenDirs.add(dirName);
				result.push({ name: dirName, path: prefix + dirName, type: 'dir' });
			}
		} else {
			// Direct child file
			result.push(entry);
		}
	}

	return result;
}

/** Gets the filename from a full path. */
function fileName(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx >= 0 ? path.substring(idx + 1) : path;
}

/** Builds a tooltip for a source component. */
function sourceTooltip(source: { id: string; name: string; provider?: string }, taskState?: ActiveTaskState): string {
	const lines: string[] = [source.name];
	lines.push(`Status: ${taskState?.running ? 'Running' : 'Stopped'}`);
	if (source.provider) lines.push(`Node: ${source.provider}`);
	lines.push(`Component ID: ${source.id}`);
	if (taskState?.errors.length) {
		lines.push('', `Errors (${taskState.errors.length}):`);
		taskState.errors.forEach((e) => lines.push(`  - ${e}`));
	}
	if (taskState?.warnings.length) {
		lines.push('', `Warnings (${taskState.warnings.length}):`);
		taskState.warnings.forEach((w) => lines.push(`  - ${w}`));
	}
	return lines.join('\n');
}

/** Returns the aggregate file status from activeTasks for a given entry. */
function fileStatus(entry: ProjectEntry, activeTasks: Map<string, ActiveTaskState>): { running: boolean; errorCount: number; warningCount: number } {
	let running = false;
	let errorCount = 0;
	let warningCount = 0;
	if (entry.projectId && entry.sources) {
		for (const src of entry.sources) {
			const ts = activeTasks.get(`${entry.projectId}.${src.id}`);
			if (ts?.running) running = true;
			errorCount += ts?.errors.length ?? 0;
			warningCount += ts?.warnings.length ?? 0;
		}
	}
	return { running, errorCount, warningCount };
}

/** Returns the status dot color for a file based on aggregate state. */
function fileDotColor(status: { running: boolean; errorCount: number; warningCount: number }): string | null {
	if (status.errorCount > 0) return 'var(--rr-color-error)';
	if (status.warningCount > 0) return 'var(--rr-color-warning)';
	if (status.running) return 'var(--rr-color-success)';
	return null;
}

/** Returns the aggregate status for all descendant files under a directory path. */
function dirStatus(dirPath: string, entries: ProjectEntry[], activeTasks: Map<string, ActiveTaskState>): { running: boolean; errorCount: number; warningCount: number } {
	const prefix = dirPath + '/';
	let running = false;
	let errorCount = 0;
	let warningCount = 0;
	for (const entry of entries) {
		if (!entry.path.startsWith(prefix)) continue;
		const s = fileStatus(entry, activeTasks);
		if (s.running) running = true;
		errorCount += s.errorCount;
		warningCount += s.warningCount;
	}
	return { running, errorCount, warningCount };
}

// =============================================================================
// COMPONENT
// =============================================================================

export const SidebarMain: React.FC<ISidebarMainProps> = ({ connection, entries, activeTasks, unknownTasks, onNavigate, onFileAction, onSourceAction, onRefresh, onOpenSettings, onOpenDocs, onToggleConnection, footerSlot, activeFilePath }) => {
	const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const [hoveredNav, setHoveredNav] = useState<string | null>(null);
	const [unknownExpanded, setUnknownExpanded] = useState(true);

	const isConnected = connection.state === 'connected';
	const isConnecting = connection.state === 'connecting';

	// ── getChildren via useMemo ────────────────────────────────────────────

	const getChildren = useMemo(() => {
		return (parent?: string) => {
			if (viewMode === 'flat') {
				return entries.map((e) => e);
			}
			return deriveChildren(entries, parent);
		};
	}, [entries, viewMode]);

	// ── Toggle helpers ─────────────────────────────────────────────────────

	const toggleDir = useCallback((dirPath: string) => {
		setExpandedDirs((prev) => {
			const next = new Set(prev);
			if (next.has(dirPath)) next.delete(dirPath);
			else next.add(dirPath);
			return next;
		});
	}, []);

	const toggleFile = useCallback((filePath: string) => {
		setExpandedFiles((prev) => {
			const next = new Set(prev);
			if (next.has(filePath)) next.delete(filePath);
			else next.add(filePath);
			return next;
		});
	}, []);

	// ── Hover helpers ──────────────────────────────────────────────────────

	const hoverBg = (id: string): CSSProperties => (hoveredRow === id ? { background: HOVER_BG } : {});
	const navHoverBg = (id: string): CSSProperties => (hoveredNav === id ? { background: HOVER_BG } : {});

	// ── Render tree recursively ────────────────────────────────────────────

	const renderChildren = useCallback(
		(parent?: string, depth: number = 0): React.ReactNode[] => {
			const children = getChildren(parent);
			const nodes: React.ReactNode[] = [];
			const indent = 8 + depth * 16;

			for (const child of children) {
				if ('type' in child && child.type === 'dir') {
					// ── Directory row ───────────────────────────────────────
					const dir = child as DirEntry;
					const isExpanded = expandedDirs.has(dir.path);
					const rowKey = `dir:${dir.path}`;

					// Show aggregate status dot when collapsed and descendants have status
					const dirDotColor = !isExpanded ? fileDotColor(dirStatus(dir.path, entries, activeTasks)) : null;

					nodes.push(
						<div key={rowKey} style={{ ...S.row, paddingLeft: indent, ...hoverBg(rowKey) }} onMouseEnter={() => setHoveredRow(rowKey)} onMouseLeave={() => setHoveredRow(null)} onClick={() => toggleDir(dir.path)}>
							{isExpanded ? <BxChevronDown size={14} /> : <BxChevronRight size={14} />}
							<BxFolderOpen size={16} color="var(--rr-text-secondary)" />
							<span style={S.rowName}>{dir.name}</span>
							<span style={S.spacer} />
							{dirDotColor && <div style={S.dot(dirDotColor)} />}
						</div>
					);

					// Render children if expanded
					if (isExpanded) {
						nodes.push(...renderChildren(dir.path, depth + 1));
					}
				} else {
					// ── File row ────────────────────────────────────────────
					const file = child as ProjectEntry;
					const name = fileName(file.path);
					const hasSources = (file.sources?.length ?? 0) > 0;
					const isFileExpanded = expandedFiles.has(file.path);
					const isActive = activeFilePath === file.path;
					const status = fileStatus(file, activeTasks);
					const dotColor = fileDotColor(status);
					const rowKey = `file:${file.path}`;

					nodes.push(
						<div
							key={rowKey}
							style={{
								...S.row,
								paddingLeft: indent,
								...hoverBg(rowKey),
								...(isActive ? { background: 'var(--rr-bg-list-active)', color: 'var(--rr-fg-list-active)' } : {}),
							}}
							onMouseEnter={() => setHoveredRow(rowKey)}
							onMouseLeave={() => setHoveredRow(null)}
							onClick={() => {
								onFileAction('open', file.path);
								if (hasSources) toggleFile(file.path);
							}}
							title={file.path}
						>
							{hasSources ? isFileExpanded ? <BxChevronDown size={14} /> : <BxChevronRight size={14} /> : <span style={{ width: 14 }} />}
							<BxFile size={16} color="var(--rr-text-secondary)" />
							<span style={S.rowName}>{name}</span>
							<span style={S.spacer} />
							{dotColor && <div style={S.dot(dotColor)} />}
						</div>
					);

					// ── Source rows under expanded file ─────────────────────
					if (hasSources && isFileExpanded) {
						for (const source of file.sources!) {
							const taskKey = file.projectId ? `${file.projectId}.${source.id}` : '';
							const taskState = taskKey ? activeTasks.get(taskKey) : undefined;
							const srcRunning = taskState?.running ?? false;
							const errCount = taskState?.errors.length ?? 0;
							const warnCount = taskState?.warnings.length ?? 0;
							const srcRowKey = `src:${file.path}:${source.id}`;

							nodes.push(
								<div key={srcRowKey} style={{ ...S.row, paddingLeft: indent + 20, ...hoverBg(srcRowKey) }} onMouseEnter={() => setHoveredRow(srcRowKey)} onMouseLeave={() => setHoveredRow(null)} onClick={() => onFileAction('open', file.path)} title={sourceTooltip(source, taskState)}>
									<div style={S.dot(srcRunning ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)')} />
									<span style={S.rowName}>{source.name}</span>
									{errCount > 0 && <span style={S.badge('var(--rr-color-error)')}>&#10006; {errCount}</span>}
									{warnCount > 0 && <span style={S.badge('var(--rr-color-warning)')}>&#9888; {warnCount}</span>}
									<span style={S.spacer} />
									{hoveredRow === srcRowKey && isConnected && file.projectId && (
										<button
											style={S.actionBtn(srcRunning ? 'var(--rr-color-error)' : 'var(--rr-color-success)')}
											title={srcRunning ? 'Stop' : 'Run'}
											onClick={(e) => {
												e.stopPropagation();
												onSourceAction(srcRunning ? 'stop' : 'run', file.path, source.id, file.projectId);
											}}
										>
											{srcRunning ? <BxStop size={14} /> : <BxPlay size={14} />}
										</button>
									)}
								</div>
							);
						}
					}
				}
			}

			return nodes;
		},
		[getChildren, expandedDirs, expandedFiles, hoveredRow, activeTasks, activeFilePath, isConnected, onFileAction, onSourceAction, toggleDir, toggleFile, entries]
	);

	// ── Unknown tasks ──────────────────────────────────────────────────────

	const hasUnknown = (unknownTasks?.length ?? 0) > 0;

	// ── Render ─────────────────────────────────────────────────────────────

	return (
		<div style={S.container}>
			{/* ── Navigation ──────────────────────────────────────────── */}
			<div style={S.navSection}>
				<button style={{ ...S.navBtn, ...navHoverBg('new') }} onMouseEnter={() => setHoveredNav('new')} onMouseLeave={() => setHoveredNav(null)} onClick={() => onNavigate('new')}>
					<BxPlus size={16} />
					New pipeline
				</button>
				<button style={{ ...S.navBtn, ...navHoverBg('monitor'), ...(isConnected ? {} : S.navBtnDisabled) }} onMouseEnter={() => setHoveredNav('monitor')} onMouseLeave={() => setHoveredNav(null)} onClick={() => isConnected && onNavigate('monitor')} disabled={!isConnected}>
					<BxDesktop size={16} />
					Monitor
				</button>
				<button style={{ ...S.navBtn, ...navHoverBg('deploy'), ...(isConnected ? {} : S.navBtnDisabled) }} onMouseEnter={() => setHoveredNav('deploy')} onMouseLeave={() => setHoveredNav(null)} onClick={() => isConnected && onNavigate('deploy')} disabled={!isConnected}>
					<BxCloudUpload size={16} />
					Deployments
				</button>
				<button style={{ ...S.navBtn, ...navHoverBg('templates'), ...(isConnected ? {} : S.navBtnDisabled) }} onMouseEnter={() => setHoveredNav('templates')} onMouseLeave={() => setHoveredNav(null)} onClick={() => isConnected && onNavigate('templates')} disabled={!isConnected}>
					<BxComponent size={16} />
					Templates
				</button>
			</div>

			{/* ── Pipelines header ────────────────────────────────────── */}
			<div style={S.sectionHeader}>
				<span style={S.sectionLabel}>Pipelines</span>
				<button style={S.headerAction} title={viewMode === 'tree' ? 'Switch to flat view' : 'Switch to tree view'} onClick={() => setViewMode((m) => (m === 'tree' ? 'flat' : 'tree'))}>
					{viewMode === 'tree' ? <BxListUl size={14} /> : <BxGridAlt size={14} />}
				</button>
				<button style={S.headerAction} title="Refresh" onClick={onRefresh}>
					<BxRefresh size={14} />
				</button>
			</div>

			{/* ── File tree ───────────────────────────────────────────── */}
			<div style={S.treeList}>
				{entries.length === 0 && <div style={S.emptyState}>No pipeline files</div>}
				{entries.length > 0 && renderChildren()}

				{/* ── Unknown tasks (Other) ───────────────────────────── */}
				{hasUnknown && (
					<>
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
									<div key={utKey} style={{ ...S.row, paddingLeft: 28, ...hoverBg(utKey) }} onMouseEnter={() => setHoveredRow(utKey)} onMouseLeave={() => setHoveredRow(null)} title={`Project: ${ut.projectId}\nSource: ${ut.sourceId}\nRunning (no local .pipe file)`}>
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
					</>
				)}
			</div>

			{/* ── Footer (anchored to bottom) ─────────────────────────── */}
			<div style={S.footer}>
				{onOpenDocs && (
					<button style={{ ...S.footerBtn, ...navHoverBg('docs') }} onMouseEnter={() => setHoveredNav('docs')} onMouseLeave={() => setHoveredNav(null)} onClick={onOpenDocs}>
						<BxBookOpen size={16} />
						Documentation
					</button>
				)}
				<div style={{ height: 10 }} />
				{onOpenSettings && (
					<button style={{ ...S.footerBtn, ...navHoverBg('settings') }} onMouseEnter={() => setHoveredNav('settings')} onMouseLeave={() => setHoveredNav(null)} onClick={onOpenSettings}>
						<BxCog size={16} />
						Settings
					</button>
				)}
				{onToggleConnection && (
					<button style={{ ...S.footerBtn, ...navHoverBg('connection') }} onMouseEnter={() => setHoveredNav('connection')} onMouseLeave={() => setHoveredNav(null)} onClick={onToggleConnection} title={isConnected ? 'Click to disconnect' : 'Click to connect'}>
						<div style={S.connectionDot(isConnected)} />
						<span>{isConnecting ? 'Connecting...' : isConnected ? `Connected (${MODE_LABELS[connection.mode ?? ''] ?? connection.mode ?? ''})` : 'Disconnected'}</span>
					</button>
				)}
				{footerSlot}
			</div>
		</div>
	);
};
