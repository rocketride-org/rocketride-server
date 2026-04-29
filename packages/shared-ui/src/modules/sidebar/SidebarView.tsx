// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarView — Unified sidebar component for pipeline management.
 *
 * Shared between VS Code webview and rocket-ui.  All data flows in via
 * props; all user actions flow out via callbacks.  The host is responsible
 * for finding/parsing pipeline files, tracking task events, and handling
 * all actions.
 *
 * The component stores only files in a flat array and derives directory
 * hierarchy on the fly via path parsing (S3-style).  A flat/tree toggle
 * lets the user switch views.
 *
 * File management features (context menu, inline rename/create) are
 * enabled when the optional `onFileManage` callback is provided.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef, CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import { BxPlus, BxDesktop, BxCloudUpload, BxComponent, BxFile, BxFolderOpen, BxChevronRight, BxChevronDown, BxRefresh, BxPlay, BxStop, BxListUl, BxGridAlt, BxCollapseAll, BxFilePlus, BxFolderPlus, BxDotsHorizontal, BxEditAlt, BxTrash } from '../../components/BoxIcon';
import type { ISidebarViewProps, ProjectEntry, DirEntry, ActiveTaskState } from './types';

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
		gap: 0,
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
		padding: 4,
		borderRadius: 5,
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
		position: 'relative' as const,
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
	menuBtn: {
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: '2px 4px',
		borderRadius: 3,
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
		display: 'flex',
		alignItems: 'center',
		opacity: 0.6,
	} as CSSProperties,
	popup: {
		position: 'absolute' as const,
		right: 0,
		top: '100%',
		zIndex: 100,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		padding: '4px 0',
		boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
		minWidth: 120,
	} as CSSProperties,
	popupRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '5px 12px',
		fontSize: 13,
		cursor: 'pointer',
		color: 'var(--rr-text-primary)',
		background: 'none',
		border: 'none',
		width: '100%',
		textAlign: 'left' as const,
	} as CSSProperties,
	inlineInput: {
		flex: 1,
		minWidth: 0,
		fontSize: 13,
		lineHeight: '20px',
		padding: '0 4px',
		border: '1px solid var(--rr-brand)',
		borderRadius: 4,
		outline: 'none',
		background: 'var(--rr-bg-input, var(--rr-bg-paper))',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	emptyState: {
		...commonStyles.textMuted,
		padding: 16,
		fontSize: 12,
		textAlign: 'center' as const,
	} as CSSProperties,
};

// =============================================================================
// CONSTANTS
// =============================================================================

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
		// Explicit dir entries from the host (e.g. empty dirs in rocket-ui)
		if (entry.type === 'dir') {
			if (!prefix && entry.path.indexOf('/') === -1) {
				// Top-level dir
				if (!seenDirs.has(entry.path)) {
					seenDirs.add(entry.path);
					result.push({ name: fileName(entry.path), path: entry.path, type: 'dir' });
				}
			} else if (prefix && entry.path.startsWith(prefix)) {
				const remainder = entry.path.substring(prefix.length);
				if (remainder.indexOf('/') === -1) {
					// Direct child dir
					if (!seenDirs.has(remainder)) {
						seenDirs.add(remainder);
						result.push({ name: remainder, path: entry.path, type: 'dir' });
					}
				} else {
					// Nested — synthesize intermediate dir
					const dirName = remainder.substring(0, remainder.indexOf('/'));
					if (!seenDirs.has(dirName)) {
						seenDirs.add(dirName);
						result.push({ name: dirName, path: prefix + dirName, type: 'dir' });
					}
				}
			} else if (!prefix && entry.path.indexOf('/') >= 0) {
				// Nested dir at root level — synthesize top-level parent
				const dirName = entry.path.substring(0, entry.path.indexOf('/'));
				if (!seenDirs.has(dirName)) {
					seenDirs.add(dirName);
					result.push({ name: dirName, path: dirName, type: 'dir' });
				}
			}
			continue;
		}

		// File entries
		if (prefix && !entry.path.startsWith(prefix)) continue;
		if (!prefix && entry.path.indexOf('/') === -1) {
			result.push(entry);
			continue;
		}
		if (!prefix && entry.path.indexOf('/') >= 0) {
			const dirName = entry.path.substring(0, entry.path.indexOf('/'));
			if (!seenDirs.has(dirName)) {
				seenDirs.add(dirName);
				result.push({ name: dirName, path: dirName, type: 'dir' });
			}
			continue;
		}

		const remainder = entry.path.substring(prefix.length);
		const slashIdx = remainder.indexOf('/');
		if (slashIdx >= 0) {
			const dirName = remainder.substring(0, slashIdx);
			if (!seenDirs.has(dirName)) {
				seenDirs.add(dirName);
				result.push({ name: dirName, path: prefix + dirName, type: 'dir' });
			}
		} else {
			result.push(entry);
		}
	}

	return result;
}

/** Gets the filename from a full path. */
function fileName(p: string): string {
	const idx = p.lastIndexOf('/');
	return idx >= 0 ? p.substring(idx + 1) : p;
}

/** Strips the .pipe or .pipe.json extension for display. */
function fileStem(p: string): string {
	const name = fileName(p);
	return name.replace(/\.pipe(?:\.json)?$/, '') || name;
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

/** Returns the status dot color based on aggregate state. */
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

export const SidebarView: React.FC<ISidebarViewProps> = ({ connection, entries, activeTasks, unknownTasks, onNavigate, onOpenFile, onFileManage, onSourceAction, onRefresh, footerSlot, onOpenUnknownTask, activeFilePath }) => {
	const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const [hoveredNav, setHoveredNav] = useState<string | null>(null);
	const [hoveredAction, setHoveredAction] = useState<string | null>(null);
	const [unknownExpanded, setUnknownExpanded] = useState(true);

	// ── Selection state ─────────────────────────────────────────────────────
	const [selectedPath, setSelectedPath] = useState<string>(activeFilePath ?? '');
	const [menuPath, setMenuPath] = useState<string | null>(null);
	const [renamePath, setRenamePath] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const [createState, setCreateState] = useState<{ type: 'file' | 'folder'; parentDir: string; name: string } | null>(null);

	const menuRef = useRef<HTMLDivElement>(null);

	// Sync selection when host changes active file (e.g. user switched editor tabs)
	useEffect(() => {
		if (activeFilePath) setSelectedPath(activeFilePath);
	}, [activeFilePath]);

	const isConnected = connection.state === 'connected';
	const hasFileManage = !!onFileManage;

	// ── Click outside to close menu ────────────────────────────────────────

	useEffect(() => {
		if (!menuPath) return;
		const handler = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuPath(null);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [menuPath]);

	// ── getChildren via useMemo ────────────────────────────────────────────

	const getChildren = useMemo(() => {
		return (parent?: string) => {
			if (viewMode === 'flat') return entries.filter((e) => e.type !== 'dir');
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

	const collapseAll = useCallback(() => {
		setExpandedDirs(new Set());
		setExpandedFiles(new Set());
	}, []);

	// ── Inline rename ──────────────────────────────────────────────────────

	const startRename = useCallback((path: string) => {
		setMenuPath(null);
		setRenamePath(path);
		setRenameValue(fileStem(path));
	}, []);

	const confirmRename = useCallback(() => {
		if (!renamePath || !onFileManage) return;
		const trimmed = renameValue.trim().replace(/[^a-zA-Z0-9\-_. ]/g, '');
		if (trimmed) {
			onFileManage('rename', renamePath, trimmed);
		}
		setRenamePath(null);
		setRenameValue('');
	}, [renamePath, renameValue, onFileManage]);

	const cancelRename = useCallback(() => {
		setRenamePath(null);
		setRenameValue('');
	}, []);

	// ── Inline create ──────────────────────────────────────────────────────

	const startCreate = useCallback(
		(type: 'file' | 'folder') => {
			let parentDir = '';
			if (selectedPath) {
				// If selected is a directory, create inside it
				const isDir = entries.some((e) => e.type === 'dir' && e.path === selectedPath);
				if (isDir) {
					parentDir = selectedPath;
				} else {
					// Selected is a file — use its parent directory
					parentDir = selectedPath.includes('/') ? selectedPath.substring(0, selectedPath.lastIndexOf('/')) : '';
				}
			}
			if (parentDir)
				setExpandedDirs((prev) => {
					const next = new Set(prev);
					next.add(parentDir);
					return next;
				});
			setCreateState({ type, parentDir, name: '' });
		},
		[selectedPath, entries]
	);

	const confirmCreate = useCallback(() => {
		if (!createState || !onFileManage) return;
		const trimmed = createState.name.trim().replace(/[^a-zA-Z0-9\-_.]/g, '');
		if (trimmed) {
			const fullPath = createState.parentDir ? `${createState.parentDir}/${trimmed}${createState.type === 'file' ? '.pipe' : ''}` : `${trimmed}${createState.type === 'file' ? '.pipe' : ''}`;
			onFileManage(createState.type === 'file' ? 'createFile' : 'createFolder', fullPath);
		}
		setCreateState(null);
	}, [createState, onFileManage]);

	const cancelCreate = useCallback(() => setCreateState(null), []);

	// ── Hover helpers ──────────────────────────────────────────────────────

	const hoverBg = (id: string): CSSProperties => (hoveredRow === id ? { background: HOVER_BG } : {});
	const navHoverBg = (id: string): CSSProperties => (hoveredNav === id ? { background: HOVER_BG } : {});
	const actionHoverBg = (id: string): CSSProperties => (hoveredAction === id ? { background: 'var(--rr-bg-toolbar-hover)' } : {});

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
					const isSelected = hasFileManage && selectedPath === dir.path;
					const rowKey = `dir:${dir.path}`;
					const dirDotColor = !isExpanded ? fileDotColor(dirStatus(dir.path, entries, activeTasks)) : null;
					const isRenaming = renamePath === dir.path;

					nodes.push(
						<div
							key={rowKey}
							style={{
								...S.row,
								paddingLeft: indent,
								...hoverBg(rowKey),
								...(isSelected ? { background: 'var(--rr-bg-list-active)', color: 'var(--rr-fg-list-active)' } : {}),
							}}
							onMouseEnter={() => setHoveredRow(rowKey)}
							onMouseLeave={() => setHoveredRow(null)}
							onClick={() => {
								toggleDir(dir.path);
								if (hasFileManage) setSelectedPath(dir.path);
							}}
						>
							{isExpanded ? <BxChevronDown size={14} /> : <BxChevronRight size={14} />}
							<BxFolderOpen size={16} color="var(--rr-text-secondary)" />
							{isRenaming ? (
								<input
									style={S.inlineInput}
									value={renameValue}
									onChange={(e) => setRenameValue(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') confirmRename();
										if (e.key === 'Escape') cancelRename();
									}}
									onBlur={cancelRename}
									autoFocus
									onClick={(e) => e.stopPropagation()}
								/>
							) : (
								<span style={S.rowName}>{dir.name}</span>
							)}
							<span style={S.spacer} />
							{dirDotColor && <div style={S.dot(dirDotColor)} />}
							{hasFileManage && hoveredRow === rowKey && !isRenaming && (
								<button
									style={S.menuBtn}
									onClick={(e) => {
										e.stopPropagation();
										setMenuPath(menuPath === dir.path ? null : dir.path);
									}}
								>
									<BxDotsHorizontal size={16} />
								</button>
							)}
							{menuPath === dir.path && (
								<div ref={menuRef} style={S.popup}>
									<button
										style={S.popupRow}
										onMouseEnter={(e) => ((e.target as HTMLElement).style.background = HOVER_BG)}
										onMouseLeave={(e) => ((e.target as HTMLElement).style.background = 'none')}
										onClick={(e) => {
											e.stopPropagation();
											startRename(dir.path);
										}}
									>
										<BxEditAlt size={16} /> Rename
									</button>
									<button
										style={S.popupRow}
										onMouseEnter={(e) => ((e.target as HTMLElement).style.background = HOVER_BG)}
										onMouseLeave={(e) => ((e.target as HTMLElement).style.background = 'none')}
										onClick={(e) => {
											e.stopPropagation();
											setMenuPath(null);
											onFileManage!('delete', dir.path);
										}}
									>
										<BxTrash size={16} /> Delete
									</button>
								</div>
							)}
						</div>
					);

					if (isExpanded) {
						nodes.push(...renderChildren(dir.path, depth + 1));
					}
				} else {
					// ── File row ────────────────────────────────────────────
					const file = child as ProjectEntry;
					const name = fileName(file.path);
					const hasSources = (file.sources?.length ?? 0) > 0;
					const isFileExpanded = expandedFiles.has(file.path);
					const isFileSelected = selectedPath === file.path;
					const status = fileStatus(file, activeTasks);
					const dotColor = fileDotColor(status);
					const rowKey = `file:${file.path}`;
					const isRenaming = renamePath === file.path;

					nodes.push(
						<div
							key={rowKey}
							style={{
								...S.row,
								paddingLeft: indent,
								...hoverBg(rowKey),
								...(isFileSelected ? { background: 'var(--rr-bg-list-active)', color: 'var(--rr-fg-list-active)' } : {}),
							}}
							onMouseEnter={() => setHoveredRow(rowKey)}
							onMouseLeave={() => setHoveredRow(null)}
							onClick={() => {
								onOpenFile(file.path);
								if (hasSources) toggleFile(file.path);
								if (hasFileManage) setSelectedPath(file.path);
							}}
							title={file.path}
						>
							{hasSources ? isFileExpanded ? <BxChevronDown size={14} /> : <BxChevronRight size={14} /> : <span style={{ width: 14 }} />}
							<BxFile size={16} color="var(--rr-text-secondary)" />
							{isRenaming ? (
								<input
									style={S.inlineInput}
									value={renameValue}
									onChange={(e) => setRenameValue(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') confirmRename();
										if (e.key === 'Escape') cancelRename();
									}}
									onBlur={cancelRename}
									autoFocus
									onClick={(e) => e.stopPropagation()}
								/>
							) : (
								<span style={S.rowName}>{name}</span>
							)}
							<span style={S.spacer} />
							{dotColor && <div style={S.dot(dotColor)} />}
							{hasFileManage && hoveredRow === rowKey && !isRenaming && (
								<button
									style={S.menuBtn}
									onClick={(e) => {
										e.stopPropagation();
										setMenuPath(menuPath === file.path ? null : file.path);
									}}
								>
									<BxDotsHorizontal size={16} />
								</button>
							)}
							{menuPath === file.path && (
								<div ref={menuRef} style={S.popup}>
									<button
										style={S.popupRow}
										onMouseEnter={(e) => ((e.target as HTMLElement).style.background = HOVER_BG)}
										onMouseLeave={(e) => ((e.target as HTMLElement).style.background = 'none')}
										onClick={(e) => {
											e.stopPropagation();
											startRename(file.path);
										}}
									>
										<BxEditAlt size={16} /> Rename
									</button>
									<button
										style={S.popupRow}
										onMouseEnter={(e) => ((e.target as HTMLElement).style.background = HOVER_BG)}
										onMouseLeave={(e) => ((e.target as HTMLElement).style.background = 'none')}
										onClick={(e) => {
											e.stopPropagation();
											setMenuPath(null);
											onFileManage!('delete', file.path);
										}}
									>
										<BxTrash size={16} /> Delete
									</button>
								</div>
							)}
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
								<div key={srcRowKey} style={{ ...S.row, paddingLeft: indent + 20, ...hoverBg(srcRowKey) }} onMouseEnter={() => setHoveredRow(srcRowKey)} onMouseLeave={() => setHoveredRow(null)} onClick={() => onOpenFile(file.path)} title={sourceTooltip(source, taskState)}>
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

			// ── Inline create input (inserted at end of parent's children) ──
			if (createState && createState.parentDir === (parent ?? '')) {
				const createKey = `create:${createState.parentDir}:${createState.type}`;
				nodes.push(
					<div key={createKey} style={{ ...S.row, paddingLeft: indent }}>
						{createState.type === 'folder' ? <BxFolderOpen size={16} color="var(--rr-text-secondary)" /> : <BxFile size={16} color="var(--rr-text-secondary)" />}
						<input
							style={S.inlineInput}
							value={createState.name}
							onChange={(e) => setCreateState((prev) => (prev ? { ...prev, name: e.target.value } : null))}
							onKeyDown={(e) => {
								if (e.key === 'Enter') confirmCreate();
								if (e.key === 'Escape') cancelCreate();
							}}
							onBlur={cancelCreate}
							autoFocus
							placeholder={createState.type === 'folder' ? 'folder name' : 'pipeline name'}
						/>
					</div>
				);
			}

			return nodes;
		},
		[getChildren, expandedDirs, expandedFiles, hoveredRow, activeTasks, isConnected, onOpenFile, onFileManage, onSourceAction, toggleDir, toggleFile, entries, hasFileManage, selectedPath, menuPath, renamePath, renameValue, confirmRename, cancelRename, startRename, createState, confirmCreate, cancelCreate]
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
				{hasFileManage && (
					<>
						<button style={{ ...S.headerAction, ...actionHoverBg('newFile') }} title="New Pipeline" onClick={() => startCreate('file')} onMouseEnter={() => setHoveredAction('newFile')} onMouseLeave={() => setHoveredAction(null)}>
							<BxFilePlus size={16} />
						</button>
						<button style={{ ...S.headerAction, ...actionHoverBg('newFolder') }} title="New Folder" onClick={() => startCreate('folder')} onMouseEnter={() => setHoveredAction('newFolder')} onMouseLeave={() => setHoveredAction(null)}>
							<BxFolderPlus size={16} />
						</button>
					</>
				)}
				<button style={{ ...S.headerAction, ...actionHoverBg('viewMode') }} title={viewMode === 'tree' ? 'Switch to flat view' : 'Switch to tree view'} onClick={() => setViewMode((m) => (m === 'tree' ? 'flat' : 'tree'))} onMouseEnter={() => setHoveredAction('viewMode')} onMouseLeave={() => setHoveredAction(null)}>
					{viewMode === 'tree' ? <BxListUl size={16} /> : <BxGridAlt size={16} />}
				</button>
				<button style={{ ...S.headerAction, ...actionHoverBg('collapse') }} title="Collapse All" onClick={collapseAll} onMouseEnter={() => setHoveredAction('collapse')} onMouseLeave={() => setHoveredAction(null)}>
					<BxCollapseAll size={16} />
				</button>
				<button style={{ ...S.headerAction, ...actionHoverBg('refresh') }} title="Refresh" onClick={onRefresh} onMouseEnter={() => setHoveredAction('refresh')} onMouseLeave={() => setHoveredAction(null)}>
					<BxRefresh size={16} />
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
					</>
				)}
			</div>

			{/* ── Footer slot (host-provided) ── */}
			{footerSlot}
		</div>
	);
};
