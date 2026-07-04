// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Explorer — Generic file tree panel (like VS Code's EXPLORER).
 *
 * Renders a hierarchical or flat file tree with:
 *   - Directory expand/collapse
 *   - File selection and active highlight
 *   - Optional child items under files (sources, layers, tracks, etc.)
 *   - Status dots per entry/child (running/error/warning)
 *   - Inline rename and create (when onFileManage provided)
 *   - Context menus (rename/delete)
 *   - Tree/flat view toggle
 *   - Collapse all / refresh buttons
 *   - Keyboard navigation (Enter/Escape for inline edits)
 *
 * Does NOT know about pipelines, sources, run/stop — those concepts are
 * handled by the hosting container via callbacks.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef, CSSProperties } from 'react';
import { Tooltip } from '@mui/material';
import { commonStyles } from '../../themes/styles';
import { BxFile, BxFolderOpen, BxChevronRight, BxChevronDown, BxRefresh, BxPlay, BxStop, BxListUl, BxGridAlt, BxCollapseAll, BxFilePlus, BxFolderPlus, BxDotsHorizontal, BxEditAlt, BxTrash } from '../../components/BoxIcon';
import type { IExplorerProps, ExplorerEntry, ExplorerStatus, DirNode } from './types';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minHeight: 0,
		fontFamily: 'var(--rr-font-family, system-ui, sans-serif)',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		overflow: 'hidden',
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
	spacer: { flex: 1 } as CSSProperties,
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
	submenu: {
		position: 'absolute' as const,
		right: 15,
		top: '100%',
		zIndex: 101,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		padding: '4px 0',
		boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
		minWidth: 160,
	} as CSSProperties,
	submenuTrigger: {
		position: 'relative' as const,
	} as CSSProperties,
	submenuArrow: {
		marginLeft: 'auto',
		fontSize: 10,
		opacity: 0.6,
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

const HOVER_BG = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Derives children of a given parent path from the flat entries array.
 * Directories are synthesized when a path segment contains a '/'.
 */
function deriveChildren(entries: ExplorerEntry[], parent: string | undefined): (ExplorerEntry | DirNode)[] {
	const prefix = parent ? parent + '/' : '';
	const result: (ExplorerEntry | DirNode)[] = [];
	const seenDirs = new Set<string>();

	for (const entry of entries) {
		if (entry.type === 'dir') {
			if (!prefix && entry.path.indexOf('/') === -1) {
				if (!seenDirs.has(entry.path)) {
					seenDirs.add(entry.path);
					result.push({ name: fileName(entry.path), path: entry.path, type: 'dir' });
				}
			} else if (prefix && entry.path.startsWith(prefix)) {
				const remainder = entry.path.substring(prefix.length);
				if (remainder.indexOf('/') === -1) {
					if (!seenDirs.has(remainder)) {
						seenDirs.add(remainder);
						result.push({ name: remainder, path: entry.path, type: 'dir' });
					}
				} else {
					const dirName = remainder.substring(0, remainder.indexOf('/'));
					if (!seenDirs.has(dirName)) {
						seenDirs.add(dirName);
						result.push({ name: dirName, path: prefix + dirName, type: 'dir' });
					}
				}
			} else if (!prefix && entry.path.indexOf('/') >= 0) {
				const dirName = entry.path.substring(0, entry.path.indexOf('/'));
				if (!seenDirs.has(dirName)) {
					seenDirs.add(dirName);
					result.push({ name: dirName, path: dirName, type: 'dir' });
				}
			}
			continue;
		}

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

/** Returns aggregate status for a file entry from the statuses map. */
function entryStatus(entry: ExplorerEntry, statuses: Map<string, ExplorerStatus>): { running: boolean; errorCount: number; warningCount: number } {
	let running = false,
		errorCount = 0,
		warningCount = 0;
	if (entry.documentId && entry.children) {
		for (const child of entry.children) {
			const ts = statuses.get(`${entry.documentId}.${child.id}`);
			if (ts?.running) running = true;
			errorCount += ts?.errors.length ?? 0;
			warningCount += ts?.warnings.length ?? 0;
		}
	}
	return { running, errorCount, warningCount };
}

/** Returns status dot color based on aggregate state. */
function statusDotColor(status: { running: boolean; errorCount: number; warningCount: number }): string | null {
	if (status.errorCount > 0) return 'var(--rr-color-error)';
	if (status.warningCount > 0) return 'var(--rr-color-warning)';
	if (status.running) return 'var(--rr-color-success)';
	return null;
}

/** Returns aggregate status for all descendant files under a directory. */
function dirStatus(dirPath: string, entries: ExplorerEntry[], statuses: Map<string, ExplorerStatus>): { running: boolean; errorCount: number; warningCount: number } {
	const prefix = dirPath + '/';
	let running = false,
		errorCount = 0,
		warningCount = 0;
	for (const entry of entries) {
		if (!entry.path.startsWith(prefix)) continue;
		const s = entryStatus(entry, statuses);
		if (s.running) running = true;
		errorCount += s.errorCount;
		warningCount += s.warningCount;
	}
	return { running, errorCount, warningCount };
}

/** Builds a tooltip for a child item. */
function childTooltip(child: { id: string; name: string; provider?: string }, taskState?: ExplorerStatus): string {
	const lines: string[] = [child.name];
	lines.push(`Status: ${taskState?.running ? 'Running' : 'Stopped'}`);
	if (child.provider) lines.push(`Type: ${child.provider}`);
	lines.push(`ID: ${child.id}`);
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

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Explorer — a generic file tree panel like VS Code's EXPLORER.
 *
 * Renders a hierarchical file tree from a flat entries array.  Supports
 * inline rename/create, context menus, status indicators, child items
 * with action buttons, and tree/flat view toggle.
 *
 * The component is fully generic — it knows nothing about pipelines,
 * sources, or any app-specific concepts.  The hosting container provides
 * entries, statuses, and callbacks.
 */
export const Explorer: React.FC<IExplorerProps> = ({ vfs, config, entries, statuses = new Map(), isConnected, showChildActions = true, activeFilePath, onOpenFile, onFileManage, onChildAction, fileActions, onRefresh, onMove, onUpload }) => {
	const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
	const [hoveredRow, setHoveredRow] = useState<string | null>(null);
	const [hoveredAction, setHoveredAction] = useState<string | null>(null);
	const [selectedPath, setSelectedPath] = useState<string>(activeFilePath ?? '');
	const [menuPath, setMenuPath] = useState<string | null>(null);
	const [submenuId, setSubmenuId] = useState<string | null>(null);
	const [renamePath, setRenamePath] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const [createState, setCreateState] = useState<{ type: 'file' | 'folder'; parentDir: string; name: string } | null>(null);

	// Drag-drop state
	const [dragPath, setDragPath] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const canDrag = !!onMove;
	const canDrop = !!onMove || !!onUpload;

	const menuRef = useRef<HTMLDivElement>(null);
	const hasFileManage = !!onFileManage;

	// --- Display name formatter -----------------------------------------------

	const getDisplayName = useCallback(
		(path: string): string => {
			const name = fileName(path);
			if (config.displayName) return config.displayName(name);
			// Default: strip known extensions
			if (config.extensions) {
				for (const ext of config.extensions) {
					if (name.endsWith(ext)) return name.slice(0, -ext.length) || name;
				}
			}
			return name;
		},
		[config]
	);

	// --- Sync selection with host active file ---------------------------------

	useEffect(() => {
		if (activeFilePath) setSelectedPath(activeFilePath);
	}, [activeFilePath]);

	// --- Click outside to close menu ------------------------------------------

	useEffect(() => {
		if (!menuPath) return;
		const handler = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuPath(null);
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [menuPath]);

	// --- getChildren via useMemo ----------------------------------------------

	const getChildren = useMemo(() => {
		return (parent?: string) => {
			if (viewMode === 'flat') return entries.filter((e) => e.type !== 'dir');
			return deriveChildren(entries, parent);
		};
	}, [entries, viewMode]);

	// --- Toggle helpers -------------------------------------------------------

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

	// --- Inline rename --------------------------------------------------------

	const startRename = useCallback(
		(path: string) => {
			setMenuPath(null);
			setRenamePath(path);
			setRenameValue(getDisplayName(path));
		},
		[getDisplayName]
	);

	const confirmRename = useCallback(() => {
		if (!renamePath || !onFileManage) return;
		const trimmed = renameValue.trim().replace(/[^a-zA-Z0-9\-_. ]/g, '');
		if (trimmed) onFileManage('rename', renamePath, trimmed);
		setRenamePath(null);
		setRenameValue('');
	}, [renamePath, renameValue, onFileManage]);

	const cancelRename = useCallback(() => {
		setRenamePath(null);
		setRenameValue('');
	}, []);

	// --- Inline create --------------------------------------------------------

	const startCreate = useCallback(
		(type: 'file' | 'folder') => {
			let parentDir = '';
			if (selectedPath) {
				const selectedEntry = entries.find((e) => e.path === selectedPath);
				if (selectedEntry?.type === 'dir') {
					parentDir = selectedPath;
				} else if (selectedEntry) {
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
			// Append default extension for files if configured
			const ext = createState.type === 'file' && config.extensions?.length ? config.extensions[0] : '';
			const fullPath = createState.parentDir ? `${createState.parentDir}/${trimmed}${ext}` : `${trimmed}${ext}`;
			onFileManage(createState.type === 'file' ? 'createFile' : 'createFolder', fullPath);
		}
		setCreateState(null);
	}, [createState, onFileManage, config.extensions]);

	const cancelCreate = useCallback(() => setCreateState(null), []);

	// --- Hover helpers --------------------------------------------------------

	const hoverBg = (id: string): CSSProperties => (hoveredRow === id ? { background: HOVER_BG } : {});
	const actionHoverBg = (id: string): CSSProperties => (hoveredAction === id ? { background: 'var(--rr-bg-toolbar-hover)' } : {});

	// --- Drag-drop handlers ---------------------------------------------------

	const handleDragStart = useCallback((e: React.DragEvent, path: string) => {
		setDragPath(path);
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', path);
	}, []);

	const handleDragOver = useCallback((e: React.DragEvent, dirPath: string) => {
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = dragPath ? 'move' : 'copy';
		// Don't allow dropping onto self or own descendant
		if (dragPath && (dragPath === dirPath || dirPath.startsWith(dragPath + '/'))) return;
		setDropTarget(dirPath);
	}, [dragPath]);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.stopPropagation();
		setDropTarget(null);
	}, []);

	const handleDrop = useCallback((e: React.DragEvent, dirPath: string) => {
		e.preventDefault();
		e.stopPropagation();
		setDropTarget(null);
		setDragPath(null);

		// OS file drop
		if (e.dataTransfer.files.length > 0 && onUpload) {
			onUpload(Array.from(e.dataTransfer.files), dirPath);
			return;
		}

		// Internal move
		const sourcePath = e.dataTransfer.getData('text/plain');
		if (sourcePath && onMove && sourcePath !== dirPath) {
			// Prevent moving a directory into itself or its own descendant
			if (dirPath === sourcePath || dirPath.startsWith(sourcePath + '/')) return;
			onMove(sourcePath, dirPath);
		}
	}, [onMove, onUpload]);

	const handleDragEnd = useCallback(() => {
		setDragPath(null);
		setDropTarget(null);
	}, []);

	// --- Render tree recursively ----------------------------------------------

	const renderChildren = useCallback(
		(parent?: string, depth: number = 0): React.ReactNode[] => {
			const children = getChildren(parent);
			const nodes: React.ReactNode[] = [];
			const indent = 8 + depth * 16;

			for (const child of children) {
				if ('type' in child && child.type === 'dir') {
					// ── Directory row ─────────────────────────────────────────
					const dir = child as DirNode;
					const isExpanded = expandedDirs.has(dir.path);
					const isSelected = hasFileManage && selectedPath === dir.path;
					const rowKey = `dir:${dir.path}`;
					const dirDot = !isExpanded ? statusDotColor(dirStatus(dir.path, entries, statuses)) : null;
					const isRenaming = renamePath === dir.path;

					nodes.push(
						<div
							key={rowKey}
							style={{ ...S.row, paddingLeft: indent, ...hoverBg(rowKey), ...(isSelected ? { background: 'var(--rr-bg-list-active)', color: 'var(--rr-fg-list-active)' } : {}), ...(dropTarget === dir.path ? { outline: '2px solid var(--rr-brand)', outlineOffset: -2 } : {}) }}
							onMouseEnter={() => setHoveredRow(rowKey)}
							onMouseLeave={() => setHoveredRow(null)}
							onClick={() => {
								toggleDir(dir.path);
								if (hasFileManage) setSelectedPath(dir.path);
							}}
							draggable={canDrag}
							onDragStart={(e) => handleDragStart(e, dir.path)}
							onDragOver={(e) => handleDragOver(e, dir.path)}
							onDragLeave={handleDragLeave}
							onDrop={(e) => handleDrop(e, dir.path)}
							onDragEnd={handleDragEnd}
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
							{dirDot && <div style={S.dot(dirDot)} />}
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

					if (isExpanded) nodes.push(...renderChildren(dir.path, depth + 1));
				} else {
					// ── File row ──────────────────────────────────────────────
					const file = child as ExplorerEntry;
					const name = fileName(file.path);
					const displayName = getDisplayName(file.path);
					const hasChildren = (file.children?.length ?? 0) > 0;
					const isFileExpanded = expandedFiles.has(file.path);
					const isFileSelected = selectedPath === file.path;
					const status = entryStatus(file, statuses);
					const dotColor = statusDotColor(status);
					const rowKey = `file:${file.path}`;
					const isRenaming = renamePath === file.path;

					nodes.push(
						<div
							key={rowKey}
							style={{ ...S.row, paddingLeft: indent, ...hoverBg(rowKey), ...(isFileSelected ? { background: 'var(--rr-bg-list-active)', color: 'var(--rr-fg-list-active)' } : {}) }}
							onMouseEnter={() => setHoveredRow(rowKey)}
							onMouseLeave={() => setHoveredRow(null)}
							onClick={() => {
								onOpenFile(file.path);
								if (hasChildren) toggleFile(file.path);
								if (hasFileManage) setSelectedPath(file.path);
							}}
							title={file.path}
							draggable={canDrag}
							onDragStart={(e) => handleDragStart(e, file.path)}
							onDragEnd={handleDragEnd}
						>
							{hasChildren ? isFileExpanded ? <BxChevronDown size={14} /> : <BxChevronRight size={14} /> : <span style={{ width: 14 }} />}
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
								<span style={S.rowName}>{displayName}</span>
							)}
							<span style={S.spacer} />
							{dotColor && <div style={S.dot(dotColor)} />}
							{hasFileManage && hoveredRow === rowKey && !isRenaming && (
								<button
									style={{ ...S.menuBtn, ...(isFileSelected ? { color: 'var(--rr-fg-list-active)' } : {}) }}
									onClick={(e) => {
										e.stopPropagation();
										setMenuPath(menuPath === file.path ? null : file.path); setSubmenuId(null);
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
									{fileActions?.map((a) => {
										const children = typeof a.children === 'function' ? a.children(file.path) : a.children;
										return children ? (
											<div
												key={a.id}
												style={S.submenuTrigger}
												onMouseEnter={() => setSubmenuId(a.id)}
												onMouseLeave={() => setSubmenuId(null)}
												onFocus={() => setSubmenuId(a.id)}
												onBlur={(e) => {
													if (!e.currentTarget.contains(e.relatedTarget as Node)) setSubmenuId(null);
												}}
											>
												<button
													style={S.popupRow}
													role="menuitem"
													aria-haspopup="true"
													aria-expanded={submenuId === a.id}
													tabIndex={0}
													onMouseEnter={(e) => ((e.target as HTMLElement).style.background = HOVER_BG)}
													onMouseLeave={(e) => ((e.target as HTMLElement).style.background = 'none')}
													onClick={(e) => {
														e.stopPropagation();
														setSubmenuId(submenuId === a.id ? null : a.id);
													}}
												>
													{a.icon} {a.label} <span style={S.submenuArrow}>&#x25B8;</span>
												</button>
												{submenuId === a.id && (
													<div style={S.submenu}>
														{children.map((ch) => (
															<button
																key={ch.id}
																style={S.popupRow}
																onMouseEnter={(e) => ((e.target as HTMLElement).style.background = HOVER_BG)}
																onMouseLeave={(e) => ((e.target as HTMLElement).style.background = 'none')}
																onClick={(e) => {
																	e.stopPropagation();
																	setMenuPath(null);
																	setSubmenuId(null);
																	ch.onSelect?.(file.path);
																}}
															>
																{ch.icon} {ch.label}
															</button>
														))}
													</div>
												)}
											</div>
										) : (
											<button
												key={a.id}
												style={S.popupRow}
												onMouseEnter={(e) => ((e.target as HTMLElement).style.background = HOVER_BG)}
												onMouseLeave={(e) => ((e.target as HTMLElement).style.background = 'none')}
												onClick={(e) => {
													e.stopPropagation();
													setMenuPath(null);
													a.onSelect?.(file.path);
												}}
											>
												{a.icon} {a.label}
											</button>
										);
									})}
								</div>
							)}
						</div>
					);

					// ── Child rows under expanded file ────────────────────────
					if (hasChildren && isFileExpanded) {
						for (const ch of file.children!) {
							const taskKey = file.documentId ? `${file.documentId}.${ch.id}` : '';
							const taskState = taskKey ? statuses.get(taskKey) : undefined;
							const chRunning = taskState?.running ?? false;
							const errCount = taskState?.errors.length ?? 0;
							const warnCount = taskState?.warnings.length ?? 0;
							const chRowKey = `child:${file.path}:${ch.id}`;

							nodes.push(
								<div key={chRowKey} style={{ ...S.row, paddingLeft: indent + 20, ...hoverBg(chRowKey) }} onMouseEnter={() => setHoveredRow(chRowKey)} onMouseLeave={() => setHoveredRow(null)} onClick={() => onOpenFile(file.path)} title={childTooltip(ch, taskState)}>
									<div style={S.dot(chRunning ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)')} />
									<span style={S.rowName}>{ch.name}</span>
									{errCount > 0 && <span style={S.badge('var(--rr-color-error)')}>&#10006; {errCount}</span>}
									{warnCount > 0 && <span style={S.badge('var(--rr-color-warning)')}>&#9888; {warnCount}</span>}
									<span style={S.spacer} />
									{hoveredRow === chRowKey && isConnected && showChildActions && onChildAction && file.documentId && (
										<button
											style={S.actionBtn(chRunning ? 'var(--rr-color-error)' : 'var(--rr-color-success)')}
											title={chRunning ? 'Stop' : 'Run'}
											onClick={(e) => {
												e.stopPropagation();
												onChildAction(chRunning ? 'stop' : 'run', file.path, ch.id, file.documentId);
											}}
										>
											{chRunning ? <BxStop size={14} /> : <BxPlay size={14} />}
										</button>
									)}
								</div>
							);
						}
					}
				}
			}

			// ── Inline create input ───────────────────────────────────────────
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
							placeholder={createState.type === 'folder' ? 'folder name' : (config.createPlaceholder ?? 'file name')}
						/>
					</div>
				);
			}

			return nodes;
		},
		[getChildren, expandedDirs, expandedFiles, hoveredRow, statuses, isConnected, showChildActions, onOpenFile, onFileManage, onChildAction, toggleDir, toggleFile, entries, hasFileManage, selectedPath, menuPath, renamePath, renameValue, confirmRename, cancelRename, startRename, createState, confirmCreate, cancelCreate, getDisplayName, config.createPlaceholder, canDrag, handleDragStart, handleDragOver, handleDragLeave, handleDrop, handleDragEnd, dropTarget]
	);

	// --- Render ---------------------------------------------------------------

	return (
		<div style={S.container}>
			{/* ── Header ──────────────────────────────────────────────── */}
			<div style={S.sectionHeader}>
				<span style={S.sectionLabel}>{config.title}</span>
				{hasFileManage && (
					<>
						<Tooltip title={`New ${config.title.replace(/s$/, '')}`} arrow placement="top">
							<button aria-label={`New ${config.title.replace(/s$/, '')}`} style={{ ...S.headerAction, ...actionHoverBg('newFile') }} onClick={() => startCreate('file')} onMouseEnter={() => setHoveredAction('newFile')} onMouseLeave={() => setHoveredAction(null)}>
								<BxFilePlus size={16} />
							</button>
						</Tooltip>
						{config.allowFolders !== false && (
							<Tooltip title="New folder" arrow placement="top">
								<button aria-label="New folder" style={{ ...S.headerAction, ...actionHoverBg('newFolder') }} onClick={() => startCreate('folder')} onMouseEnter={() => setHoveredAction('newFolder')} onMouseLeave={() => setHoveredAction(null)}>
									<BxFolderPlus size={16} />
								</button>
							</Tooltip>
						)}
					</>
				)}
				<Tooltip title={viewMode === 'tree' ? 'Switch to flat view' : 'Switch to tree view'} arrow placement="top">
					<button aria-label={viewMode === 'tree' ? 'Switch to flat view' : 'Switch to tree view'} style={{ ...S.headerAction, ...actionHoverBg('viewMode') }} onClick={() => setViewMode((m) => (m === 'tree' ? 'flat' : 'tree'))} onMouseEnter={() => setHoveredAction('viewMode')} onMouseLeave={() => setHoveredAction(null)}>
						{viewMode === 'tree' ? <BxListUl size={16} /> : <BxGridAlt size={16} />}
					</button>
				</Tooltip>
				<Tooltip title="Collapse all" arrow placement="top">
					<button aria-label="Collapse all" style={{ ...S.headerAction, ...actionHoverBg('collapse') }} onClick={collapseAll} onMouseEnter={() => setHoveredAction('collapse')} onMouseLeave={() => setHoveredAction(null)}>
						<BxCollapseAll size={16} />
					</button>
				</Tooltip>
				<Tooltip title="Refresh" arrow placement="top">
					<button aria-label="Refresh" style={{ ...S.headerAction, ...actionHoverBg('refresh') }} onClick={onRefresh} onMouseEnter={() => setHoveredAction('refresh')} onMouseLeave={() => setHoveredAction(null)}>
						<BxRefresh size={16} />
					</button>
				</Tooltip>
			</div>

			{/* ── File tree ───────────────────────────────────────────── */}
			{/* When the tree is empty we still need to render the inline create
			    input if the user just clicked +File / +Folder at the root, since
			    that input lives inside renderChildren(). */}
			<div
				style={{ ...S.treeList, ...(dropTarget === '' ? { outline: '2px solid var(--rr-brand)', outlineOffset: -2 } : {}) }}
				onDragOver={canDrop ? (e) => handleDragOver(e, '') : undefined}
				onDragLeave={canDrop ? handleDragLeave : undefined}
				onDrop={canDrop ? (e) => handleDrop(e, '') : undefined}
			>
				{entries.length === 0 && !(createState && createState.parentDir === '') && (
					<div style={S.emptyState}>{config.emptyMessage ?? 'No files'}</div>
				)}
				{(entries.length > 0 || (createState && createState.parentDir === '')) && renderChildren()}
			</div>
		</div>
	);
};
