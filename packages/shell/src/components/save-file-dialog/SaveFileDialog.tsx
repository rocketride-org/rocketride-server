// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SaveFileDialog — the platform's stock "Save As" dialog over a virtual
 * file system.
 *
 * One dialog for every host and every file kind: the browser saves pipelines
 * into the server project store, the VS Code webviews save into the workspace
 * folder, and the App Builder saves .ts/.css/etc — each host only supplies an
 * {@link IVirtualFileSystem} and a list of {@link ISaveFileType}s (the Windows
 * Save-As "type" vocabulary: label + extension).
 *
 * Behavior contract:
 *  - The tree root renders as `rootLabel` (default "$/") using the SAME row
 *    treatment as every other folder — no invented "root" vocabulary.
 *  - `defaultDir` is preselected on open and is rendered EVEN WHEN it does not
 *    exist yet (a dimmed "ghost" row marked "new"); any missing segments are
 *    created via `vfs.mkdir` only when the save is confirmed.
 *  - Folders can be created inline (New folder button) without leaving the
 *    dialog.
 *  - Row click selects; ONLY the chevron toggles expansion — selecting a
 *    folder never surprise-collapses it.
 *  - Files matching the active type are shown dimmed for context (like the OS
 *    dialogs), and saving onto one routes through an explicit overwrite
 *    confirm.
 *  - Name entry is forgiving: the name field accepts a bare base name OR a
 *    full filename. A typed extension that matches the active type is not
 *    doubled, and typing a different known type's extension switches the type
 *    picker — the OS Save-As behavior.
 *  - The live result path (root label + folder + name + extension) is always
 *    visible under the name input — the one source of truth for what Save
 *    will write.
 */

import React, { CSSProperties, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commonStyles } from '../../themes/styles';
import { Modal } from '../modal/Modal';
import { ConfirmDialog } from '../modal/ConfirmDialog';
import { BxChevronRight, BxFile, BxFolderOpen, BxFolderPlus } from '../BoxIcon';
import type { IVirtualFileSystem } from '../../modules/explorer/types';

// =============================================================================
// TYPES
// =============================================================================

/** One selectable file type — the OS Save-dialog "Save as type" vocabulary. */
export interface ISaveFileType {
	/** Human-readable type label, e.g. "RocketRide Pipeline". */
	label: string;
	/** Extension appended to the typed name, WITH the leading dot, e.g. ".pipe". */
	extension: string;
}

/** Props for the {@link SaveFileDialog} component. */
export interface ISaveFileDialogProps {
	/** Dialog title, e.g. "Save Pipeline As". */
	title: string;
	/** File system the dialog browses — only `list` and `mkdir` are called. */
	vfs: IVirtualFileSystem;
	/**
	 * Selectable file types. The FIRST entry is the initial selection; a
	 * single-entry list hides the type picker (the extension still shows as the
	 * name input's suffix).
	 */
	fileTypes: ISaveFileType[];
	/** Label rendered for the tree root row. Default "$/". */
	rootLabel?: string;
	/**
	 * Directory preselected on open — relative to the VFS root, '/'-separated.
	 * Rendered as a dimmed ghost row when it does not exist yet; the missing
	 * segments are created on save.
	 */
	defaultDir?: string;
	/** Initial value of the name input (no extension). */
	initialName?: string;
	/**
	 * Called with the chosen path (relative to the VFS root, extension
	 * included) AFTER any missing directories were created. The caller
	 * performs the actual write.
	 */
	onConfirm: (path: string) => void;
	/** Called when the dialog is dismissed (Cancel or Escape). */
	onCancel: () => void;
}

/** A directory node in the dialog's tree (ghost = does not exist on disk yet). */
interface SaveDirNode {
	type: 'dir';
	name: string;
	/** Path relative to the VFS root, '/'-separated. */
	path: string;
	/** True for the synthesized not-yet-created defaultDir segments. */
	ghost: boolean;
	children: SaveTreeNode[];
}

/** A file node — context only (dimmed, non-selectable), drives overwrite. */
interface SaveFileNode {
	type: 'file';
	name: string;
	/** Path relative to the VFS root, '/'-separated. */
	path: string;
}

type SaveTreeNode = SaveDirNode | SaveFileNode;

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Characters allowed in file and folder names. Dots are permitted so a user
 * can type a full filename (e.g. "flow.pipe") — the redundant extension is
 * stripped before the active type's extension is appended.
 */
const NAME_REGEX = /^[a-zA-Z0-9 ._-]+$/;

/** The user-facing explanation of {@link NAME_REGEX}, shown on invalid input. */
const NAME_RULE_MESSAGE = 'Names may use letters, numbers, spaces, dots, hyphens and underscores.';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Joins two relative path segments, tolerating an empty parent (the root).
 *
 * @param parent - Parent directory path ('' for root).
 * @param child  - Child segment or sub-path.
 * @returns The joined relative path.
 */
function joinPath(parent: string, child: string): string {
	return parent ? `${parent}/${child}` : child;
}

/**
 * Strips a trailing occurrence of `extension` (case-insensitive) from `name`,
 * so a user who types the extension does not get it doubled by the append.
 *
 * @param name      - The trimmed raw name the user typed.
 * @param extension - The active type's extension, WITH the leading dot.
 * @returns The base name with any redundant extension removed.
 */
function stripExtension(name: string, extension: string): string {
	if (extension && name.toLowerCase().endsWith(extension.toLowerCase())) {
		return name.slice(0, name.length - extension.length).trim();
	}
	return name;
}

/**
 * Recursively lists a VFS directory into {@link SaveTreeNode}s, folders
 * first, each group sorted case-insensitively — the stable presentation
 * order of every OS save dialog.
 *
 * @param vfs - The virtual file system to walk.
 * @param rel - Relative directory to list ('' for root).
 * @returns The directory's children as tree nodes.
 */
async function listRecursive(vfs: IVirtualFileSystem, rel: string): Promise<SaveTreeNode[]> {
	const entries = await vfs.list(rel);
	// Folders first, then files, both alphabetical (case-insensitive).
	const sorted = [...entries].sort((a, b) => {
		if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
	});
	// Fan out sibling directories in parallel — each list is a server round
	// trip in the browser host, so a sequential walk would hold the dialog in
	// "Loading folders..." for the sum of every directory's latency.
	return Promise.all(
		sorted.map(async (entry): Promise<SaveTreeNode> => {
			const childPath = joinPath(rel, entry.name);
			if (entry.type === 'dir') {
				return { type: 'dir', name: entry.name, path: childPath, ghost: false, children: await listRecursive(vfs, childPath) };
			}
			return { type: 'file', name: entry.name, path: childPath };
		})
	);
}

/**
 * Collects the paths of every REAL (non-ghost) directory in the tree — the
 * set consulted when deciding which segments `mkdir` must create.
 *
 * @param nodes - Tree to walk.
 * @param into  - Accumulator set of relative paths.
 * @returns The accumulator, for chaining.
 */
function collectRealDirs(nodes: SaveTreeNode[], into: Set<string>): Set<string> {
	for (const node of nodes) {
		if (node.type === 'dir' && !node.ghost) {
			into.add(node.path);
			collectRealDirs(node.children, into);
		}
	}
	return into;
}

/**
 * Collects the paths of every file in the tree — the overwrite-confirm set.
 *
 * @param nodes - Tree to walk.
 * @param into  - Accumulator set of relative paths.
 * @returns The accumulator, for chaining.
 */
function collectFiles(nodes: SaveTreeNode[], into: Set<string>): Set<string> {
	for (const node of nodes) {
		if (node.type === 'file') into.add(node.path);
		else collectFiles(node.children, into);
	}
	return into;
}

/**
 * Returns a copy of `tree` guaranteed to contain a directory chain for
 * `dirPath`, synthesizing dimmed ghost nodes for any missing segment — this
 * is how a not-yet-created defaultDir stays visible and selectable.
 *
 * @param tree    - The real tree loaded from the VFS.
 * @param dirPath - The directory chain to guarantee ('' is a no-op).
 * @returns The tree with ghost segments appended where needed.
 */
function withGhostChain(tree: SaveTreeNode[], dirPath: string): SaveTreeNode[] {
	if (!dirPath) return tree;
	const segments = dirPath.split('/');

	/** Recursive step: ensure `segments[index]` exists among `nodes`. */
	const ensure = (nodes: SaveTreeNode[], index: number, parent: string): SaveTreeNode[] => {
		if (index >= segments.length) return nodes;
		const path = joinPath(parent, segments[index]);
		const existing = nodes.find((n): n is SaveDirNode => n.type === 'dir' && n.path === path);
		if (existing) {
			// Segment exists — recurse into it; replace the node only when a
			// deeper segment actually changed its children.
			const children = ensure(existing.children, index + 1, path);
			if (children === existing.children) return nodes;
			return nodes.map((n) => (n === existing ? { ...existing, children } : n));
		}
		// Segment missing — synthesize the remaining chain as ghost nodes.
		let chain: SaveDirNode | null = null;
		for (let i = segments.length - 1; i >= index; i--) {
			const chainPath = segments.slice(0, i + 1).join('/');
			chain = { type: 'dir', name: segments[i], path: chainPath, ghost: true, children: chain ? [chain] : [] };
		}
		return chain ? [...nodes, chain] : nodes;
	};

	return ensure(tree, 0, '');
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Slim toolbar between the Modal header and the tree: hosts New folder.
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		padding: '6px 12px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,
	toolbarButton: {
		...commonStyles.buttonSecondary,
		display: 'inline-flex',
		alignItems: 'center',
		gap: 6,
		fontSize: 12,
		padding: '4px 10px',
	} as CSSProperties,
	// The scrolling folder tree.
	treeArea: {
		flex: 1,
		overflowY: 'auto',
		padding: '6px 8px',
		minHeight: 200,
		maxHeight: 280,
		background: 'var(--rr-bg-default)',
	} as CSSProperties,
	treeNotice: {
		padding: '8px 10px',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	// One tree row; the SAME geometry at every depth (root included).
	row: (selected: boolean, indent: number): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		paddingLeft: indent,
		paddingRight: 8,
		paddingTop: 4,
		paddingBottom: 4,
		borderRadius: 5,
		cursor: 'pointer',
		fontSize: 13,
		userSelect: 'none',
		background: selected ? 'var(--rr-bg-list-active)' : 'transparent',
		color: selected ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
	}),
	// Chevron slot — its OWN hit target so expanding never re-selects.
	chevron: (visible: boolean, expanded: boolean): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 14,
		height: 14,
		flexShrink: 0,
		opacity: visible ? 1 : 0,
		pointerEvents: visible ? 'auto' : 'none',
		transform: expanded ? 'rotate(90deg)' : 'none',
		transition: 'transform 100ms ease',
	}),
	rowIcon: (selected: boolean): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		width: 16,
		height: 16,
		flexShrink: 0,
		color: selected ? 'inherit' : 'var(--rr-text-secondary)',
	}),
	rowName: {
		flex: 1,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,
	// Ghost (not-yet-created) directory treatment.
	ghostName: {
		fontStyle: 'italic',
		opacity: 0.7,
	} as CSSProperties,
	ghostTag: {
		fontSize: 10,
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
		flexShrink: 0,
	} as CSSProperties,
	// Context files — visible but explicitly not selectable.
	fileRow: (indent: number): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		paddingLeft: indent,
		paddingRight: 8,
		paddingTop: 4,
		paddingBottom: 4,
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		opacity: 0.6,
		userSelect: 'none',
	}),
	// Inline new-folder editor row.
	inlineInput: {
		...commonStyles.inputField,
		flex: 1,
		height: 24,
		padding: '0 8px',
		fontSize: 13,
	} as CSSProperties,
	// Footer form: name, optional type picker, live result path.
	form: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		padding: '12px 16px 0',
		borderTop: '1px solid var(--rr-border)',
	} as CSSProperties,
	formRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
	} as CSSProperties,
	formLabel: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		minWidth: 48,
		textAlign: 'right',
	} as CSSProperties,
	nameWrap: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
	} as CSSProperties,
	nameInput: {
		...commonStyles.inputField,
		// Override inputField's width:100% — inside the flex nameWrap the input
		// grows via flex:1, and minWidth:0 lets it actually shrink/grow instead
		// of being pushed to zero by the fixed suffix.
		flex: 1,
		width: 'auto',
		minWidth: 0,
		height: 30,
		padding: '0 10px',
		borderTopRightRadius: 0,
		borderBottomRightRadius: 0,
	} as CSSProperties,
	// Fixed extension adornment — the full filename is always visible. It must
	// size to its content (".pipe") and never shrink; without width:auto it
	// inherits inputField's width:100% and swallows the whole row.
	nameSuffix: {
		...commonStyles.inputField,
		width: 'auto',
		flexShrink: 0,
		height: 30,
		display: 'inline-flex',
		alignItems: 'center',
		padding: '0 8px',
		borderLeft: 'none',
		borderTopLeftRadius: 0,
		borderBottomLeftRadius: 0,
		color: 'var(--rr-text-secondary)',
		background: 'var(--rr-bg-widget-header)',
		fontSize: 12,
	} as CSSProperties,
	typeSelect: {
		...commonStyles.inputField,
		flex: 1,
		height: 30,
		padding: '0 8px',
		fontSize: 13,
	} as CSSProperties,
	// Live result path / inline validation line under the form.
	resultPath: (isError: boolean): CSSProperties => ({
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: isError ? 'var(--rr-color-error)' : 'var(--rr-text-secondary)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		paddingLeft: 58,
	}),
	saveButton: (enabled: boolean): CSSProperties => ({
		...commonStyles.buttonPrimary,
		fontWeight: 600,
		...(enabled ? {} : commonStyles.buttonDisabled),
	}),
};

// =============================================================================
// FOLDER TREE (internal)
// =============================================================================

/** Props for the recursive {@link FolderTree} renderer. */
interface FolderTreeProps {
	nodes: SaveTreeNode[];
	depth: number;
	activeExtension: string;
	selectedDir: string;
	expandedDirs: Set<string>;
	/** Directory whose inline new-folder editor is open, or null. */
	creatingIn: string | null;
	newFolderEditor: ReactNode;
	onSelect: (path: string) => void;
	onToggle: (path: string) => void;
}

/**
 * Renders the folder rows (and dimmed context files) of one tree level.
 *
 * @param props - {@link FolderTreeProps}.
 * @returns The level's rows.
 */
const FolderTree: React.FC<FolderTreeProps> = ({ nodes, depth, activeExtension, selectedDir, expandedDirs, creatingIn, newFolderEditor, onSelect, onToggle }) => {
	const indent = 8 + depth * 16;
	// Extension matching is case-insensitive (mirrors stripExtension): a file
	// stored as "flow.PIPE" still counts as the active type.
	const lowerExt = activeExtension.toLowerCase();

	return (
		<>
			{nodes.map((node) => {
				// Context files: dimmed, non-interactive, filtered to the active type.
				if (node.type === 'file') {
					if (!node.name.toLowerCase().endsWith(lowerExt)) return null;
					return (
						<div key={node.path} style={styles.fileRow(indent + 14 + 4)}>
							<span style={styles.rowIcon(false)}>
								<BxFile size={14} />
							</span>
							<span style={styles.rowName}>{node.name}</span>
						</div>
					);
				}

				const isExpanded = expandedDirs.has(node.path);
				const isSelected = selectedDir === node.path;
				const hasChildren = node.children.some((c) => c.type === 'dir' || c.name.toLowerCase().endsWith(lowerExt));
				return (
					<React.Fragment key={node.path}>
						<div
							style={styles.row(isSelected, indent)}
							onClick={() => onSelect(node.path)}
							// Keyboard access: rows act as buttons (Enter/Space = select,
							// ArrowRight/ArrowLeft = expand/collapse — the tree-view keys).
							role="button"
							tabIndex={0}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									onSelect(node.path);
								} else if (e.key === 'ArrowRight' && hasChildren && !isExpanded) {
									e.preventDefault();
									onToggle(node.path);
								} else if (e.key === 'ArrowLeft' && hasChildren && isExpanded) {
									e.preventDefault();
									onToggle(node.path);
								}
							}}
						>
							{/* Chevron is its own hit target: expanding never re-selects.
							    Focusable in its own right so expansion is reachable by
							    keyboard even when tabbing straight to it. */}
							<span
								style={styles.chevron(hasChildren, isExpanded)}
								role="button"
								tabIndex={hasChildren ? 0 : -1}
								aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
								aria-expanded={isExpanded}
								onClick={(e) => {
									e.stopPropagation();
									onToggle(node.path);
								}}
								onKeyDown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										e.stopPropagation();
										onToggle(node.path);
									}
								}}
							>
								<BxChevronRight size={12} />
							</span>
							<span style={styles.rowIcon(isSelected)}>
								<BxFolderOpen size={14} />
							</span>
							<span style={{ ...styles.rowName, ...(node.ghost ? styles.ghostName : {}) }}>{node.name}</span>
							{node.ghost && <span style={styles.ghostTag}>new</span>}
						</div>
						{/* Inline new-folder editor renders as the first child row. */}
						{creatingIn === node.path && isExpanded && newFolderEditor}
						{isExpanded && (
							<FolderTree nodes={node.children} depth={depth + 1} activeExtension={activeExtension} selectedDir={selectedDir} expandedDirs={expandedDirs} creatingIn={creatingIn} newFolderEditor={newFolderEditor} onSelect={onSelect} onToggle={onToggle} />
						)}
					</React.Fragment>
				);
			})}
		</>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the stock Save-As dialog over a virtual file system.
 *
 * @param props - {@link ISaveFileDialogProps}.
 * @returns The dialog element.
 */
export function SaveFileDialog({ title, vfs, fileTypes, rootLabel = '$/', defaultDir = '', initialName = '', onConfirm, onCancel }: ISaveFileDialogProps): React.ReactElement {
	// --- Form state ----------------------------------------------------------
	const [name, setName] = useState(initialName);
	const [typeIndex, setTypeIndex] = useState(0);
	const [selectedDir, setSelectedDir] = useState(defaultDir);
	// Expand the whole default chain so the preselected folder is visible.
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
		const expanded = new Set<string>();
		if (defaultDir) {
			const segments = defaultDir.split('/');
			for (let i = 0; i < segments.length; i++) expanded.add(segments.slice(0, i + 1).join('/'));
		}
		return expanded;
	});

	// --- Tree state ----------------------------------------------------------
	const [tree, setTree] = useState<SaveTreeNode[]>([]);
	const [treeLoaded, setTreeLoaded] = useState(false);
	const [treeError, setTreeError] = useState<string | null>(null);
	// Monotonic load counter: only the newest load may commit its result.
	const loadSeq = useRef(0);

	// --- Dialog flow state ---------------------------------------------------
	// Path awaiting overwrite confirmation, or null.
	const [overwritePath, setOverwritePath] = useState<string | null>(null);
	// Directory whose inline new-folder editor is open ('' = root), or null.
	const [creatingIn, setCreatingIn] = useState<string | null>(null);
	const [newFolderName, setNewFolderName] = useState('');
	// Inline failure line (mkdir/list errors) under the form.
	const [actionError, setActionError] = useState<string | null>(null);
	// True while a confirm's ensureDir round trip is in flight — blocks the
	// Save button AND the name input's Enter key from re-entering the save.
	const [saving, setSaving] = useState(false);

	const nameInputRef = useRef<HTMLInputElement>(null);
	const newFolderInputRef = useRef<HTMLInputElement>(null);

	/** Reloads the folder tree from the VFS (newest call wins). */
	const refreshTree = useCallback(() => {
		const mine = ++loadSeq.current;
		listRecursive(vfs, '')
			.then((nodes) => {
				if (mine !== loadSeq.current) return;
				setTree(nodes);
				setTreeError(null);
				setTreeLoaded(true);
			})
			.catch((err) => {
				if (mine !== loadSeq.current) return;
				setTreeError(err instanceof Error ? err.message : String(err));
				setTreeLoaded(true);
			});
	}, [vfs]);

	useEffect(() => {
		refreshTree();
		// Unmount: invalidate any in-flight load.
		return () => {
			loadSeq.current++;
		};
	}, [refreshTree]);

	useEffect(() => {
		nameInputRef.current?.focus();
	}, []);

	// Focus the inline editor whenever it opens.
	useEffect(() => {
		if (creatingIn !== null) newFolderInputRef.current?.focus();
	}, [creatingIn]);

	// --- Derived data ----------------------------------------------------------
	// A host may pass an empty fileTypes list (nothing stops it at the shell
	// API boundary) — fall back to an extension-less type instead of crashing
	// on `activeType.extension`.
	const activeType: ISaveFileType = fileTypes[Math.min(typeIndex, fileTypes.length - 1)] ?? { label: 'All Files', extension: '' };
	const rawName = name.trim();
	// A typed name is valid on characters alone; the base (after stripping any
	// redundant active extension) must still be non-empty, so a bare ".pipe"
	// is rejected.
	const nameCharsValid = rawName.length > 0 && NAME_REGEX.test(rawName);
	const baseName = stripExtension(rawName, activeType.extension);
	const nameValid = nameCharsValid && baseName.length > 0;
	// The tree with the (possibly missing) default chain ghosted in.
	const displayTree = useMemo(() => withGhostChain(tree, defaultDir), [tree, defaultDir]);
	const realDirs = useMemo(() => collectRealDirs(tree, new Set<string>()), [tree]);
	// Lower-cased: on a case-insensitive store "flow.PIPE" IS "flow.pipe", so
	// the overwrite confirm must catch the match regardless of typed casing (a
	// false warning on a case-sensitive store beats a silent overwrite).
	const existingFiles = useMemo(() => new Set(Array.from(collectFiles(tree, new Set<string>()), (p) => p.toLowerCase())), [tree]);
	// The one source of truth for what Save writes.
	const fileName = `${baseName}${activeType.extension}`;
	const resultPath = selectedDir ? `${selectedDir}/${fileName}` : fileName;
	const resultLabel = `${rootLabel}${selectedDir ? `${selectedDir}/` : ''}${baseName || 'name'}${activeType.extension}`;

	// --- Actions ---------------------------------------------------------------

	/**
	 * Updates the name and, when the typed value ends with a KNOWN type's
	 * extension, switches the type picker to match — so typing "flow.json"
	 * selects the JSON type instead of appending a second extension.
	 *
	 * @param value - The raw name input value.
	 */
	const handleNameChange = useCallback(
		(value: string) => {
			setName(value);
			const typed = value.trim().toLowerCase();
			// Require MORE than just the extension so a bare ".pipe" is ignored.
			const match = fileTypes.findIndex((ft) => typed.length > ft.extension.length && typed.endsWith(ft.extension.toLowerCase()));
			if (match >= 0 && match !== typeIndex) setTypeIndex(match);
		},
		[fileTypes, typeIndex]
	);

	/**
	 * Creates every missing segment of `dirPath` via `vfs.mkdir`, shallowest
	 * first — covers both ghost defaultDir chains and new-folder parents.
	 *
	 * @param dirPath - Directory chain to materialize ('' is a no-op).
	 */
	const ensureDir = useCallback(
		async (dirPath: string): Promise<void> => {
			if (!dirPath) return;
			const segments = dirPath.split('/');
			for (let i = 0; i < segments.length; i++) {
				const prefix = segments.slice(0, i + 1).join('/');
				if (!realDirs.has(prefix)) await vfs.mkdir(prefix);
			}
		},
		[vfs, realDirs]
	);

	/** Validates + routes the save: overwrite confirm or direct confirm. */
	const handleConfirm = useCallback(() => {
		if (!nameValid || saving) return;
		if (existingFiles.has(resultPath.toLowerCase())) {
			setOverwritePath(resultPath);
			return;
		}
		setSaving(true);
		ensureDir(selectedDir)
			.then(() => onConfirm(resultPath))
			.catch((err) => setActionError(`Could not create folder: ${err instanceof Error ? err.message : String(err)}`))
			.finally(() => setSaving(false));
	}, [nameValid, saving, existingFiles, resultPath, ensureDir, selectedDir, onConfirm]);

	/** Commits the inline new-folder editor: mkdir, refresh, select. */
	const commitNewFolder = useCallback(() => {
		const folderName = newFolderName.trim();
		const parent = creatingIn ?? '';
		setCreatingIn(null);
		setNewFolderName('');
		if (!folderName || !NAME_REGEX.test(folderName)) return;
		const fullPath = joinPath(parent, folderName);
		// Parent may itself be a ghost chain — materialize it first.
		ensureDir(parent)
			.then(() => vfs.mkdir(fullPath))
			.then(() => {
				setSelectedDir(fullPath);
				setExpandedDirs((prev) => new Set(prev).add(parent).add(fullPath));
				refreshTree();
			})
			.catch((err) => setActionError(`Could not create folder: ${err instanceof Error ? err.message : String(err)}`));
	}, [newFolderName, creatingIn, ensureDir, vfs, refreshTree]);

	/** Opens the inline editor inside the currently selected directory. */
	const startNewFolder = useCallback(() => {
		setActionError(null);
		setNewFolderName('');
		setCreatingIn(selectedDir);
		// The editor renders under the parent only when the parent is expanded.
		if (selectedDir) setExpandedDirs((prev) => new Set(prev).add(selectedDir));
	}, [selectedDir]);

	const toggleDir = useCallback((path: string) => {
		setExpandedDirs((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const selectDir = useCallback((path: string) => {
		setActionError(null);
		setSelectedDir(path);
	}, []);

	// --- Render ----------------------------------------------------------------

	// The inline new-folder row (rendered by FolderTree under its parent, or
	// directly under the root row when creating at root).
	const newFolderEditor = (
		<div style={{ ...styles.row(false, 8 + (creatingIn ? (creatingIn.split('/').length + 1) * 16 : 16)), cursor: 'default' }}>
			<span style={styles.chevron(false, false)}>
				<BxChevronRight size={12} />
			</span>
			<span style={styles.rowIcon(false)}>
				<BxFolderOpen size={14} />
			</span>
			<input
				ref={newFolderInputRef}
				style={styles.inlineInput}
				value={newFolderName}
				onChange={(e) => setNewFolderName(e.target.value)}
				onKeyDown={(e) => {
					// Enter commits, Escape cancels — standard inline-edit keys.
					if (e.key === 'Enter') {
						e.preventDefault();
						commitNewFolder();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						e.stopPropagation();
						setCreatingIn(null);
						setNewFolderName('');
					}
				}}
				// Blur CANCELS (Enter is the only commit) — same rule as the
				// Explorer's inline rename, and it keeps a stray click from
				// creating half-typed folders.
				onBlur={() => {
					setCreatingIn(null);
					setNewFolderName('');
				}}
				placeholder="Folder name"
			/>
		</div>
	);

	// Inline message line: validation first, then action failures.
	const message = rawName.length > 0 && !nameValid ? NAME_RULE_MESSAGE : actionError;

	return (
		<>
			<Modal
				title={title}
				onClose={onCancel}
				noBodyPadding
				width={540}
				footer={
					<>
						<button type="button" style={commonStyles.buttonSecondary} onClick={onCancel}>
							Cancel
						</button>
						<button type="button" style={styles.saveButton(nameValid && !saving)} disabled={!nameValid || saving} onClick={handleConfirm}>
							Save
						</button>
					</>
				}
			>
				{/* Toolbar: folder creation lives inside the dialog. */}
				<div style={styles.toolbar}>
					<button type="button" style={styles.toolbarButton} onClick={startNewFolder} title="Create a folder inside the selected folder">
						<BxFolderPlus size={14} />
						New folder
					</button>
				</div>

				{/* Folder tree — root row uses the SAME row treatment (depth 0). */}
				<div style={styles.treeArea}>
					{!treeLoaded && <div style={styles.treeNotice}>Loading folders...</div>}
					{treeLoaded && treeError && <div style={styles.treeNotice}>Could not list folders: {treeError}</div>}
					{treeLoaded && !treeError && (
						<>
							<div
								style={styles.row(selectedDir === '', 8)}
								onClick={() => selectDir('')}
								role="button"
								tabIndex={0}
								onKeyDown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										selectDir('');
									}
								}}
							>
								<span style={styles.chevron(false, true)}>
									<BxChevronRight size={12} />
								</span>
								<span style={styles.rowIcon(selectedDir === '')}>
									<BxFolderOpen size={14} />
								</span>
								<span style={styles.rowName}>{rootLabel}</span>
							</div>
							{creatingIn === '' && newFolderEditor}
							<FolderTree nodes={displayTree} depth={1} activeExtension={activeType.extension} selectedDir={selectedDir} expandedDirs={expandedDirs} creatingIn={creatingIn} newFolderEditor={newFolderEditor} onSelect={selectDir} onToggle={toggleDir} />
						</>
					)}
				</div>

				{/* Name + type + live result path. */}
				<div style={styles.form}>
					<div style={styles.formRow}>
						<span style={styles.formLabel}>Name:</span>
						<span style={styles.nameWrap}>
							<input
								ref={nameInputRef}
								style={styles.nameInput}
								value={name}
								onChange={(e) => handleNameChange(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') handleConfirm();
								}}
								placeholder="File name"
							/>
							<span style={styles.nameSuffix}>{activeType.extension}</span>
						</span>
					</div>
					{fileTypes.length > 1 && (
						<div style={styles.formRow}>
							<span style={styles.formLabel}>Type:</span>
							<select style={styles.typeSelect} value={typeIndex} onChange={(e) => setTypeIndex(Number(e.target.value))}>
								{fileTypes.map((ft, i) => (
									<option key={ft.extension} value={i}>
										{ft.label} (*{ft.extension})
									</option>
								))}
							</select>
						</div>
					)}
					{/* Live result path — or the inline validation/failure line. */}
					<div style={styles.resultPath(message != null)}>{message ?? resultLabel}</div>
				</div>
			</Modal>

			{/* Overwrite confirm — stacked above; only an explicit Overwrite proceeds. */}
			{overwritePath && (
				<ConfirmDialog
					title="Overwrite File"
					message={`"${fileName}" already exists - overwrite it?`}
					confirmLabel="Overwrite"
					destructive
					onConfirm={() => {
						setOverwritePath(null);
						onConfirm(overwritePath);
					}}
					onCancel={() => setOverwritePath(null)}
				/>
			)}
		</>
	);
}
