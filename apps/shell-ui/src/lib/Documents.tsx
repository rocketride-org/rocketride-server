// MIT License
//
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
// DOCUMENTS — VS Code-style document model (instantiable class)
// =============================================================================
//
// An app-owned store for managing documents, editors, and editor groups
// following the VS Code document model:
//
//   Document    — one per URI, holds content in memory, dirty/version tracking
//   Editor      — view onto a Document, independent viewport state
//   EditorGroup — pane container with ordered editors and split orientation
//
// Usage:
//   const docs = new Documents(vfs);
//   docs.openDocument('myfile.pipe');
//   docs.useStore();  // React hook — subscribes to state changes
//
// The app creates the instance, owns it, passes it wherever needed.
// The shell never sees it.
// =============================================================================

import { useSyncExternalStore } from 'react';
import type { IVirtualFileSystem } from 'shared/modules/explorer/types';

// =============================================================================
// TYPES
// =============================================================================

/**
 * A single open document. One per URI. Content held in memory.
 * Only disposed when no editors reference it and it is clean.
 */
export interface Document {
	/** Unique file path / identifier. */
	uri: string;
	/** In-memory content — any serializable value, stored and returned as-is. */
	content: unknown;
	/** True if the document has unsaved changes. */
	dirty: boolean;
	/** Monotonically increasing version counter, bumped on every content change. */
	version: number;
	/** Number of editors currently viewing this document. */
	editorCount: number;
	/** True if the document has never been saved to disk. */
	isNew: boolean;
	/**
	 * True for documents that are not backed by the VFS (e.g. monitor, webview).
	 * Static documents skip VFS read/write and are never marked dirty.
	 */
	static?: boolean;
}

/**
 * An editor — a view onto a Document. Each editor has independent viewport
 * state so the same document can be viewed at different scroll positions in
 * different editor groups.
 */
export interface Editor {
	/** Unique editor instance ID. */
	id: string;
	/** URI of the document this editor views. */
	documentUri: string;
	/** Scroll position (pixels from top). */
	scrollTop: number;
	/** Scroll position (pixels from left). */
	scrollLeft: number;
	/** Cursor line number (1-based). */
	cursorLine: number;
	/** Cursor column number (1-based). */
	cursorColumn: number;
	/** Display label for the tab (derived from URI by default). */
	label: string;
	/** Per-editor view state (active tab, viewport, flow mode). Opaque to Documents — the app casts at the boundary. */
	viewState?: Record<string, unknown>;
}

/** Split orientation for layout containers. */
export type SplitOrientation = 'horizontal' | 'vertical';

/**
 * An editor group — a pane container that holds an ordered list of editors.
 */
export interface EditorGroup {
	/** Unique group ID. */
	id: string;
	/** Ordered list of editor IDs in this group. */
	editorIds: string[];
	/** Index of the currently active editor in this group. */
	activeEditorIndex: number;
}

// =============================================================================
// LAYOUT TREE
// =============================================================================

/**
 * A leaf node in the layout tree — contains a single editor group.
 */
export interface LayoutLeaf {
	readonly type: 'leaf';
	/** Unique node ID (same as the EditorGroup ID it wraps). */
	id: string;
	/** ID of the EditorGroup rendered in this leaf. */
	groupId: string;
}

/**
 * A split container node in the layout tree — has exactly two children
 * split in a direction.
 */
export interface LayoutSplit {
	readonly type: 'split';
	/** Unique node ID (auto-generated). */
	id: string;
	/** Direction: 'horizontal' = children side-by-side, 'vertical' = stacked. */
	orientation: SplitOrientation;
	/** Exactly two child nodes. */
	children: [LayoutNode, LayoutNode];
	/** Pixel sizes from the last allotment onChange, or undefined for equal split. */
	sizes?: [number, number];
}

/** A node in the layout tree — either a leaf (editor group) or a split container. */
export type LayoutNode = LayoutLeaf | LayoutSplit;

/** Complete documents model state. */
export interface DocumentsState {
	/** All open documents keyed by URI. */
	documents: Record<string, Document>;
	/** All editor instances keyed by editor ID. */
	editors: Record<string, Editor>;
	/** All editor groups keyed by group ID. */
	groups: Record<string, EditorGroup>;
	/** Root of the recursive layout tree. */
	rootNode: LayoutNode;
	/** ID of the currently focused group. */
	activeGroupId: string;
}

export type { IVirtualFileSystem } from 'shared/modules/explorer/types';

// =============================================================================
// WORKSPACE BINDING
// =============================================================================

/** Key under which Documents state is stored in Workspace's opaque appState. */
const APPSTATE_KEY = 'documents';

/** Debounce interval for workspace persistence writes. */
const PERSIST_DEBOUNCE_MS = 500;

/**
 * Optional binding to the shell's workspace persistence.
 *
 * When provided, Documents automatically restores state on creation and
 * debounce-saves state on every change.  When omitted, Documents works
 * purely in-memory.
 *
 * @example
 * ```typescript
 * const { appState, updateAppState } = useWorkspace();
 * const docs = new Documents(vfs, { appState, updateAppState });
 * ```
 */
export interface WorkspaceBinding {
	/** The current opaque app state from WorkspaceContext. */
	appState: Record<string, unknown>;
	/** Functional updater to write back to workspace appState. */
	updateAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
}

// =============================================================================
// LAYOUT TREE UTILITIES
// =============================================================================

/**
 * Finds a node by ID in the layout tree (depth-first).
 *
 * @param root   - Root of the layout tree to search.
 * @param nodeId - The node ID to find.
 * @returns The matching node, or undefined if not found.
 */
function findNode(root: LayoutNode, nodeId: string): LayoutNode | undefined {
	if (root.id === nodeId) return root;
	if (root.type === 'split') {
		return findNode(root.children[0], nodeId) ?? findNode(root.children[1], nodeId);
	}
	return undefined;
}

/**
 * Finds the parent split of a node by its ID.
 *
 * @param root   - Root of the layout tree to search.
 * @param nodeId - The child node ID to find the parent of.
 * @returns A tuple of [parentSplit, childIndex] or undefined if the node is root.
 */
function findParent(root: LayoutNode, nodeId: string): [LayoutSplit, 0 | 1] | undefined {
	if (root.type !== 'split') return undefined;
	if (root.children[0].id === nodeId) return [root, 0];
	if (root.children[1].id === nodeId) return [root, 1];
	return findParent(root.children[0], nodeId) ?? findParent(root.children[1], nodeId);
}

/**
 * Finds the leaf node that contains a given groupId.
 *
 * @param root    - Root of the layout tree to search.
 * @param groupId - The EditorGroup ID to find the leaf for.
 * @returns The matching LayoutLeaf, or undefined if not found.
 */
function findLeafByGroupId(root: LayoutNode, groupId: string): LayoutLeaf | undefined {
	if (root.type === 'leaf') return root.groupId === groupId ? root : undefined;
	return findLeafByGroupId(root.children[0], groupId) ?? findLeafByGroupId(root.children[1], groupId);
}

/**
 * Immutably replaces a node in the tree by its ID.
 *
 * @param root        - Root of the layout tree.
 * @param targetId    - The ID of the node to replace.
 * @param replacement - The new node to insert in its place.
 * @returns A new tree root with the replacement applied.
 */
function replaceNode(root: LayoutNode, targetId: string, replacement: LayoutNode): LayoutNode {
	if (root.id === targetId) return replacement;
	if (root.type === 'split') {
		const left = replaceNode(root.children[0], targetId, replacement);
		const right = replaceNode(root.children[1], targetId, replacement);
		// Short-circuit if nothing changed
		if (left === root.children[0] && right === root.children[1]) return root;
		return { ...root, children: [left, right] };
	}
	return root;
}

/**
 * Collects all group IDs from leaf nodes via in-order traversal.
 *
 * @param root - Root of the layout tree.
 * @returns Ordered array of groupIds from all leaf nodes.
 */
function collectGroupIds(root: LayoutNode): string[] {
	if (root.type === 'leaf') return [root.groupId];
	return [...collectGroupIds(root.children[0]), ...collectGroupIds(root.children[1])];
}

/**
 * Migrates a flat groupOrder array (legacy format) into a layout tree.
 * Builds a left-leaning binary tree with horizontal splits.
 *
 * @param groupOrder - Legacy flat array of group IDs.
 * @returns A LayoutNode tree representing the same layout.
 */
function migrateGroupOrderToTree(groupOrder: string[]): LayoutNode {
	if (groupOrder.length === 0) {
		return { type: 'leaf', id: 'group-1', groupId: 'group-1' };
	}
	if (groupOrder.length === 1) {
		return { type: 'leaf', id: groupOrder[0]!, groupId: groupOrder[0]! };
	}
	// Build left-leaning tree: ((g1 | g2) | g3) | g4 ...
	let node: LayoutNode = { type: 'leaf', id: groupOrder[0]!, groupId: groupOrder[0]! };
	for (let i = 1; i < groupOrder.length; i++) {
		const right: LayoutLeaf = { type: 'leaf', id: groupOrder[i]!, groupId: groupOrder[i]! };
		node = { type: 'split', id: `migrated-split-${i}`, orientation: 'horizontal', children: [node, right] };
	}
	return node;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Creates a fresh empty state with one default group. */
function makeDefaultState(): DocumentsState {
	return {
		documents: {},
		editors: {},
		groups: {
			'group-1': { id: 'group-1', editorIds: [], activeEditorIndex: -1 },
		},
		rootNode: { type: 'leaf', id: 'group-1', groupId: 'group-1' },
		activeGroupId: 'group-1',
	};
}

/**
 * Collapses an empty group from the layout tree.  If the group has a parent
 * split, replaces the parent with the sibling.  If it's the root leaf,
 * returns the state unchanged (nothing to collapse).
 *
 * @param state   - The current DocumentsState.
 * @param groupId - The empty group to collapse.
 * @returns Updated state with the group removed from the tree.
 */
function collapseEmptyGroup(state: DocumentsState, groupId: string): DocumentsState {
	const parentInfo = findParent(state.rootNode, groupId);
	if (!parentInfo) return state;

	const [parentSplit, childIndex] = parentInfo;
	const sibling = parentSplit.children[childIndex === 0 ? 1 : 0];
	const newRoot = replaceNode(state.rootNode, parentSplit.id, sibling);

	// Remove the group from the groups map
	const { [groupId]: _, ...remainingGroups } = state.groups;

	// Pick a new active group if the collapsed one was active
	const allGroupIds = collectGroupIds(newRoot);
	const newActiveGroup = allGroupIds.includes(state.activeGroupId)
		? state.activeGroupId
		: allGroupIds[allGroupIds.length - 1]!;

	return { ...state, groups: remainingGroups, rootNode: newRoot, activeGroupId: newActiveGroup };
}

/**
 * Extracts the highest numeric suffix from a list of prefixed IDs
 * (e.g. ["editor-1", "editor-3"] → 3).  Returns 0 if the list is empty.
 *
 * @param ids - Array of IDs with a "prefix-N" pattern.
 * @returns The highest numeric suffix found.
 */
function maxNumericSuffix(ids: string[]): number {
	let max = 0;
	for (const id of ids) {
		const n = parseInt(id.split('-').pop() ?? '0', 10);
		if (n > max) max = n;
	}
	return max;
}

/**
 * Collects all split node IDs from the layout tree.
 *
 * @param root - Root of the layout tree.
 * @returns Array of split node IDs.
 */
function collectSplitIds(root: LayoutNode): string[] {
	if (root.type === 'leaf') return [];
	return [root.id, ...collectSplitIds(root.children[0]), ...collectSplitIds(root.children[1])];
}

/** Derives a tab label from a URI by extracting the filename. */
function labelFromUri(uri: string): string {
	const parts = uri.split('/');
	const name = parts[parts.length - 1] ?? uri;
	return name.endsWith('.pipe') ? name.slice(0, -5) : name;
}

// =============================================================================
// DOCUMENTS CLASS
// =============================================================================

/**
 * VS Code-style document model.
 *
 * Create an instance in your app, pass it to your components.  The shell
 * never sees this — it's entirely app-owned.
 *
 * ```typescript
 * const docs = new Documents(vfs);
 * docs.openDocument('myfile.pipe');
 *
 * // In a React component:
 * const state = docs.useStore();
 * ```
 */
export class Documents {
	private _state: DocumentsState;
	private _vfs: IVirtualFileSystem | null;
	private _workspace: WorkspaceBinding | null;
	private _persistTimer: ReturnType<typeof setTimeout> | undefined;
	private _listeners = new Set<() => void>();
	private _notifyScheduled = false;
	private _editorCounter = 0;
	private _groupCounter = 1;
	private _splitCounter = 0;

	/**
	 * Creates a new Documents instance.
	 *
	 * @param vfs       - Virtual file system for reading/writing document content.
	 * @param workspace - Optional workspace binding for automatic persistence.
	 *                    When provided, state is restored from appState on creation
	 *                    and debounce-saved back on every change.
	 */
	constructor(vfs?: IVirtualFileSystem | null, workspace?: WorkspaceBinding) {
		this._vfs = vfs ?? null;
		this._workspace = workspace ?? null;

		// Restore from workspace persistence if available
		const persisted = workspace?.appState?.[APPSTATE_KEY] as Record<string, any> | undefined;
		if (persisted?.documents && persisted?.groups) {
			if (persisted.rootNode) {
				// Current format — use directly
				this._state = persisted as unknown as DocumentsState;
			} else if (persisted.groupOrder) {
				// Legacy format — migrate flat groupOrder to tree
				const migrated = { ...persisted, rootNode: migrateGroupOrderToTree(persisted.groupOrder) } as unknown as DocumentsState;
				delete (migrated as any).groupOrder;
				this._state = migrated;
			} else {
				this._state = makeDefaultState();
			}
			// Seed counters past the highest existing IDs to avoid collisions
			this._editorCounter = maxNumericSuffix(Object.keys(this._state.editors));
			this._groupCounter = maxNumericSuffix(Object.keys(this._state.groups));
			this._splitCounter = maxNumericSuffix(collectSplitIds(this._state.rootNode));
		} else {
			this._state = makeDefaultState();
		}
	}

	// --- Internal helpers ----------------------------------------------------

	/** Generates a unique editor ID by incrementing the editor counter. */
	private _nextEditorId(): string {
		return `editor-${++this._editorCounter}`;
	}

	/** Generates a unique group ID by incrementing the group counter. */
	private _nextGroupId(): string {
		return `group-${++this._groupCounter}`;
	}

	/** Generates a unique split node ID by incrementing the split counter. */
	private _nextSplitId(): string {
		return `split-${++this._splitCounter}`;
	}

	/**
	 * Applies an immutable state update, notifies React subscribers, and
	 * debounce-saves to workspace persistence if bound.
	 *
	 * @param updater - Pure function that receives current state and returns next state.
	 */
	private _update(updater: (prev: DocumentsState) => DocumentsState): void {
		const next = updater(this._state);
		if (next === this._state) return;
		this._state = next;
		// Defer notification so React's current commit completes first
		if (!this._notifyScheduled) {
			this._notifyScheduled = true;
			queueMicrotask(() => {
				this._notifyScheduled = false;
				this._listeners.forEach((fn) => fn());
			});
		}
		// Debounce-save to workspace persistence if bound
		if (this._workspace) {
			clearTimeout(this._persistTimer);
			this._persistTimer = setTimeout(() => {
				this._workspace?.updateAppState((prev) => ({ ...prev, [APPSTATE_KEY]: this._state }));
			}, PERSIST_DEBOUNCE_MS);
		}
	}

	// --- State access --------------------------------------------------------

	/**
	 * Returns the current state snapshot without subscribing.
	 *
	 * @returns The current DocumentsState.
	 */
	getState(): DocumentsState {
		return this._state;
	}

	/**
	 * Returns a single document by URI, or undefined.
	 *
	 * @param uri - The document URI.
	 * @returns The Document or undefined.
	 */
	getDocument(uri: string): Document | undefined {
		return this._state.documents[uri];
	}

	// --- Subscription --------------------------------------------------------

	/**
	 * Register a listener that fires on every state change.
	 *
	 * @param listener - Callback invoked after each state update.
	 * @returns An unsubscribe function.
	 */
	subscribe(listener: () => void): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	// --- React hook ----------------------------------------------------------

	/**
	 * React hook that subscribes to this Documents instance.
	 * Uses `useSyncExternalStore` for tear-free reads.
	 *
	 * @returns The current DocumentsState. Re-renders on any state change.
	 */
	useStore(): DocumentsState {
		// Bind subscribe/getSnapshot to this instance
		// eslint-disable-next-line react-hooks/rules-of-hooks
		return useSyncExternalStore(
			(listener) => {
				this._listeners.add(listener);
				return () => this._listeners.delete(listener);
			},
			() => this._state,
		);
	}

	// --- Document operations -------------------------------------------------

	/**
	 * Opens a document by URI. If already open, activates the existing editor.
	 * If not, reads from disk via VFS.
	 *
	 * @param uri     - File path to open.
	 * @param groupId - Target editor group (defaults to active group).
	 */
	async openDocument(uri: string, groupId?: string): Promise<void> {
		const s = this._state;
		const targetGroup = groupId ?? s.activeGroupId;

		// Check if an editor for this URI already exists in the target group
		const existingEditorId = s.groups[targetGroup]?.editorIds.find((eid) => {
			return s.editors[eid]?.documentUri === uri;
		});
		if (existingEditorId) {
			this._update((prev) => {
				const group = prev.groups[targetGroup];
				if (!group) return prev;
				const idx = group.editorIds.indexOf(existingEditorId);
				return {
					...prev,
					groups: { ...prev.groups, [targetGroup]: { ...group, activeEditorIndex: idx } },
					activeGroupId: targetGroup,
				};
			});
			return;
		}

		// Load content if document not yet open
		let doc = s.documents[uri];
		if (!doc) {
			let content: unknown = '';
			let loadedOk = false;
			if (this._vfs) {
				try {
					const raw = await this._vfs.read(uri);
					if (raw !== null && raw !== undefined) { content = raw; loadedOk = true; }
				} catch { /* read failed */ }
			}
			doc = { uri, content, dirty: false, version: 1, editorCount: 0, isNew: !loadedOk };
		}

		const editorId = this._nextEditorId();
		const editor: Editor = {
			id: editorId, documentUri: uri,
			scrollTop: 0, scrollLeft: 0, cursorLine: 1, cursorColumn: 1,
			label: labelFromUri(uri),
		};

		const finalDoc = doc;
		this._update((prev) => {
			const updatedDoc = { ...(prev.documents[uri] ?? finalDoc), editorCount: (prev.documents[uri]?.editorCount ?? 0) + 1 };
			const group = prev.groups[targetGroup];
			if (!group) return prev;
			const newEditorIds = [...group.editorIds, editorId];
			return {
				...prev,
				documents: { ...prev.documents, [uri]: updatedDoc },
				editors: { ...prev.editors, [editorId]: editor },
				groups: { ...prev.groups, [targetGroup]: { ...group, editorIds: newEditorIds, activeEditorIndex: newEditorIds.length - 1 } },
				activeGroupId: targetGroup,
			};
		});
	}

	/**
	 * Opens a static document — one not backed by the VFS.
	 *
	 * Static documents (e.g. monitor, webview) have a fixed URI and label,
	 * skip VFS read/write, and are never marked dirty.  If an editor for
	 * the URI already exists in any group, it is focused instead of creating
	 * a duplicate.
	 *
	 * @param uri     - Unique identifier for the document (e.g. "monitor", "webview:https://...").
	 * @param label   - Display label for the tab.
	 * @param content - Optional content payload (opaque to Documents).
	 * @param groupId - Target editor group (defaults to active group).
	 */
	openStaticDocument(uri: string, label: string, content?: unknown, groupId?: string): void {
		const s = this._state;
		const targetGroup = groupId ?? s.activeGroupId;

		// If an editor for this URI already exists in ANY group, just focus it
		for (const gid of Object.keys(s.groups)) {
			const group = s.groups[gid]!;
			const idx = group.editorIds.findIndex((eid) => s.editors[eid]?.documentUri === uri);
			if (idx !== -1) {
				this._update((prev) => {
					const g = prev.groups[gid];
					if (!g) return prev;
					return {
						...prev,
						groups: { ...prev.groups, [gid]: { ...g, activeEditorIndex: idx } },
						activeGroupId: gid,
					};
				});
				return;
			}
		}

		// Create the static document and editor
		const doc: Document = { uri, content: content ?? null, dirty: false, version: 1, editorCount: 1, isNew: false, static: true };
		const editorId = this._nextEditorId();
		const editor: Editor = {
			id: editorId, documentUri: uri,
			scrollTop: 0, scrollLeft: 0, cursorLine: 1, cursorColumn: 1,
			label,
		};

		this._update((prev) => {
			const group = prev.groups[targetGroup];
			if (!group) return prev;
			const newEditorIds = [...group.editorIds, editorId];
			return {
				...prev,
				documents: { ...prev.documents, [uri]: doc },
				editors: { ...prev.editors, [editorId]: editor },
				groups: { ...prev.groups, [targetGroup]: { ...group, editorIds: newEditorIds, activeEditorIndex: newEditorIds.length - 1 } },
				activeGroupId: targetGroup,
			};
		});
	}

	/**
	 * Creates a new untitled document with optional initial content.
	 *
	 * @param groupId        - Target editor group (defaults to active group).
	 * @param initialContent - Optional initial content (any serializable value).
	 * @returns The URI assigned to the new document.
	 */
	createDocument(groupId?: string, initialContent?: unknown): string {
		const s = this._state;
		let n = 1;
		while (s.documents[`Untitled-${n}`]) n++;
		const uri = `Untitled-${n}`;
		const targetGroup = groupId ?? s.activeGroupId;

		const doc: Document = { uri, content: initialContent ?? '', dirty: false, version: 1, editorCount: 1, isNew: true };
		const editorId = this._nextEditorId();
		const editor: Editor = {
			id: editorId, documentUri: uri,
			scrollTop: 0, scrollLeft: 0, cursorLine: 1, cursorColumn: 1,
			label: uri,
		};

		this._update((prev) => {
			const group = prev.groups[targetGroup];
			if (!group) return prev;
			const newEditorIds = [...group.editorIds, editorId];
			return {
				...prev,
				documents: { ...prev.documents, [uri]: doc },
				editors: { ...prev.editors, [editorId]: editor },
				groups: { ...prev.groups, [targetGroup]: { ...group, editorIds: newEditorIds, activeEditorIndex: newEditorIds.length - 1 } },
				activeGroupId: targetGroup,
			};
		});

		return uri;
	}

	/**
	 * Closes an editor. Disposes the document if this was the last editor
	 * referencing a clean document.  If the group becomes empty and is not
	 * the root leaf, the group is auto-collapsed from the layout tree.
	 *
	 * @param editorId - The editor to close.
	 */
	closeEditor(editorId: string): void {
		this._update((prev) => {
			const editor = prev.editors[editorId];
			if (!editor) return prev;

			let newGroups = { ...prev.groups };
			let emptyGroupId: string | null = null;

			// Remove editor from its group
			for (const gid of Object.keys(newGroups)) {
				const group = newGroups[gid]!;
				const idx = group.editorIds.indexOf(editorId);
				if (idx !== -1) {
					const newIds = group.editorIds.filter((id) => id !== editorId);
					let newActiveIdx = group.activeEditorIndex;
					if (newActiveIdx >= newIds.length) newActiveIdx = Math.max(0, newIds.length - 1);
					if (newActiveIdx > idx) newActiveIdx--;
					newGroups[gid] = { ...group, editorIds: newIds, activeEditorIndex: newActiveIdx };
					// Track if the group is now empty for auto-collapse
					if (newIds.length === 0) emptyGroupId = gid;
					break;
				}
			}

			const { [editorId]: _, ...remainingEditors } = prev.editors;

			// Clean up document reference count
			const doc = prev.documents[editor.documentUri];
			let newDocs = prev.documents;
			if (doc) {
				const newCount = doc.editorCount - 1;
				if (newCount <= 0 && !doc.dirty) {
					const { [editor.documentUri]: __, ...rest } = prev.documents;
					newDocs = rest;
				} else {
					newDocs = { ...prev.documents, [editor.documentUri]: { ...doc, editorCount: newCount } };
				}
			}

			let state: DocumentsState = { ...prev, documents: newDocs, editors: remainingEditors, groups: newGroups };

			// Auto-collapse empty group if it's not the root leaf
			if (emptyGroupId) {
				state = collapseEmptyGroup(state, emptyGroupId);
			}

			return state;
		});
	}

	/**
	 * Force-remove a document and all its editors from state, regardless of
	 * dirty status. Used when the backing file has been deleted from disk —
	 * any unsaved content is discarded.
	 *
	 * @param uri - The document URI to discard.
	 */
	discardDocument(uri: string): void {
		this._update((prev) => {
			const doc = prev.documents[uri];
			if (!doc) return prev;

			// Find and remove all editors for this document
			const editorIdsToRemove = Object.entries(prev.editors)
				.filter(([, ed]) => ed.documentUri === uri)
				.map(([id]) => id);

			const { [uri]: _, ...remainingDocs } = prev.documents;
			let remainingEditors = prev.editors;
			for (const eid of editorIdsToRemove) {
				const { [eid]: __, ...rest } = remainingEditors;
				remainingEditors = rest;
			}

			// Remove editor IDs from groups
			let newGroups = prev.groups;
			for (const gid of Object.keys(newGroups)) {
				const group = newGroups[gid]!;
				const filtered = group.editorIds.filter((id) => !editorIdsToRemove.includes(id));
				if (filtered.length !== group.editorIds.length) {
					let newActiveIdx = group.activeEditorIndex;
					if (newActiveIdx >= filtered.length) newActiveIdx = Math.max(0, filtered.length - 1);
					newGroups = { ...newGroups, [gid]: { ...group, editorIds: filtered, activeEditorIndex: newActiveIdx } };
				}
			}

			return { ...prev, documents: remainingDocs, editors: remainingEditors, groups: newGroups };
		});
	}

	/**
	 * Updates the in-memory content of a document and marks it dirty.
	 * No-op if content hasn't changed (prevents infinite render loops).
	 *
	 * @param uri     - The document URI.
	 * @param content - The new content (any serializable value).
	 */
	updateContent(uri: string, content: unknown): void {
		this._update((prev) => {
			const doc = prev.documents[uri];
			if (!doc) return prev;
			if (doc.content === content) return prev;
			// Static documents update content but never become dirty
			const dirty = doc.static ? false : true;
			return {
				...prev,
				documents: { ...prev.documents, [uri]: { ...doc, content, dirty, version: doc.version + 1 } },
			};
		});
	}

	/**
	 * Saves a document's content to disk via VFS and marks it clean.
	 *
	 * @param uri - The document URI to save.
	 */
	async saveDocument(uri: string): Promise<void> {
		const doc = this._state.documents[uri];
		if (!doc) return;
		// Static documents are not backed by VFS — nothing to write
		if (doc.static) return;
		// New (untitled) documents should not be written to disk — the caller
		// must provide a real filename via save-as before any disk write.
		if (doc.isNew) return;
		if (this._vfs) {
			await this._vfs.write(uri, doc.content);
		}
		this._update((prev) => {
			const d = prev.documents[uri];
			if (!d) return prev;
			return { ...prev, documents: { ...prev.documents, [uri]: { ...d, dirty: false, isNew: false } } };
		});
	}

	/**
	 * Re-reads a document from disk via VFS and replaces in-memory content.
	 * Marks the document as clean.
	 *
	 * @param uri - The document URI to revert.
	 */
	async revertDocument(uri: string): Promise<void> {
		const existingDoc = this._state.documents[uri];
		if (existingDoc?.static) return;
		let newContent: unknown = null;
		if (this._vfs) {
			try { newContent = await this._vfs.read(uri); } catch { /* read failed */ }
		}
		if (newContent === null || newContent === undefined) return;
		this._update((prev) => {
			const doc = prev.documents[uri];
			if (!doc) return prev;
			return {
				...prev,
				documents: { ...prev.documents, [uri]: { ...doc, content: newContent!, dirty: false, version: doc.version + 1 } },
			};
		});
	}

	// --- Editor group operations ---------------------------------------------

	/**
	 * Splits an editor group, creating a new empty group beside it in the
	 * layout tree.  The original leaf is replaced by a LayoutSplit containing
	 * the original leaf and a new leaf.
	 *
	 * @param groupId     - The group to split.
	 * @param orientation - Split direction ('horizontal' = side-by-side, 'vertical' = stacked).
	 * @returns The new group's ID.
	 */
	splitGroup(groupId: string, orientation: SplitOrientation): string {
		const newGroupId = this._nextGroupId();
		const splitNodeId = this._nextSplitId();
		this._update((prev) => {
			const group = prev.groups[groupId];
			if (!group) return prev;

			// Find the leaf that wraps this group
			const leaf = findLeafByGroupId(prev.rootNode, groupId);
			if (!leaf) return prev;

			// Create the new empty group and its leaf
			const newGroup: EditorGroup = { id: newGroupId, editorIds: [], activeEditorIndex: -1 };
			const newLeaf: LayoutLeaf = { type: 'leaf', id: newGroupId, groupId: newGroupId };

			// Replace the original leaf with a split containing both
			const splitNode: LayoutSplit = {
				type: 'split', id: splitNodeId, orientation,
				children: [leaf, newLeaf],
			};

			return {
				...prev,
				groups: { ...prev.groups, [newGroupId]: newGroup },
				rootNode: replaceNode(prev.rootNode, leaf.id, splitNode),
				activeGroupId: newGroupId,
			};
		});
		return newGroupId;
	}

	/**
	 * Splits a group and opens the same document as the active editor in the
	 * new pane.  If the source group has no active editor, creates an empty split.
	 * This mimics VS Code's split behavior where the current document appears
	 * in both the original and new pane.
	 *
	 * @param groupId     - The group to split.
	 * @param orientation - Split direction ('horizontal' = side-by-side, 'vertical' = stacked).
	 * @returns The new group's ID.
	 */
	splitGroupWithDocument(groupId: string, orientation: SplitOrientation): string {
		const newGroupId = this._nextGroupId();
		const splitNodeId = this._nextSplitId();
		const editorId = this._nextEditorId();
		this._update((prev) => {
			const group = prev.groups[groupId];
			if (!group) return prev;

			// Find the leaf that wraps this group
			const leaf = findLeafByGroupId(prev.rootNode, groupId);
			if (!leaf) return prev;

			// Find the active editor's document URI
			const activeEditorId = group.editorIds[group.activeEditorIndex];
			const activeEditor = activeEditorId ? prev.editors[activeEditorId] : undefined;
			const activeDocUri = activeEditor?.documentUri;

			// Create the new group (possibly with an editor for the active document)
			let newGroup: EditorGroup;
			let newEditors = prev.editors;
			let newDocs = prev.documents;

			if (activeDocUri && prev.documents[activeDocUri]) {
				// Open the same document in the new group
				const newEditor: Editor = {
					id: editorId, documentUri: activeDocUri,
					scrollTop: 0, scrollLeft: 0, cursorLine: 1, cursorColumn: 1,
					label: activeEditor!.label,
				};
				newGroup = { id: newGroupId, editorIds: [editorId], activeEditorIndex: 0 };
				newEditors = { ...prev.editors, [editorId]: newEditor };
				const doc = prev.documents[activeDocUri]!;
				newDocs = { ...prev.documents, [activeDocUri]: { ...doc, editorCount: doc.editorCount + 1 } };
			} else {
				// No active document — just create an empty group
				newGroup = { id: newGroupId, editorIds: [], activeEditorIndex: -1 };
			}

			const newLeaf: LayoutLeaf = { type: 'leaf', id: newGroupId, groupId: newGroupId };
			const splitNode: LayoutSplit = {
				type: 'split', id: splitNodeId, orientation,
				children: [leaf, newLeaf],
			};

			return {
				...prev,
				documents: newDocs,
				editors: newEditors,
				groups: { ...prev.groups, [newGroupId]: newGroup },
				rootNode: replaceNode(prev.rootNode, leaf.id, splitNode),
				activeGroupId: newGroupId,
			};
		});
		return newGroupId;
	}

	/**
	 * Moves an editor from its current group to a different group.
	 *
	 * @param editorId      - The editor to move.
	 * @param targetGroupId - The destination group.
	 */
	moveEditor(editorId: string, targetGroupId: string): void {
		this._update((prev) => {
			const editor = prev.editors[editorId];
			if (!editor) return prev;
			const newGroups = { ...prev.groups };

			// Remove from source group
			for (const gid of Object.keys(newGroups)) {
				const group = newGroups[gid]!;
				const idx = group.editorIds.indexOf(editorId);
				if (idx !== -1) {
					const newIds = group.editorIds.filter((id) => id !== editorId);
					let newActive = group.activeEditorIndex;
					if (newActive >= newIds.length) newActive = Math.max(0, newIds.length - 1);
					newGroups[gid] = { ...group, editorIds: newIds, activeEditorIndex: newActive };
					break;
				}
			}

			// Add to target group
			const target = newGroups[targetGroupId];
			if (!target) return prev;
			const newIds = [...target.editorIds, editorId];
			newGroups[targetGroupId] = { ...target, editorIds: newIds, activeEditorIndex: newIds.length - 1 };

			return { ...prev, groups: newGroups, activeGroupId: targetGroupId };
		});
	}

	/**
	 * Closes all editors in a group and removes it from the layout tree.
	 * If the group has a parent split, the parent is replaced by the sibling.
	 * If this was the last group (root leaf), a new empty default group is created.
	 *
	 * @param groupId - The group to close.
	 */
	closeGroup(groupId: string): void {
		this._update((prev) => {
			const group = prev.groups[groupId];
			if (!group) return prev;

			// Clean up editors and documents owned by this group
			let newDocs = { ...prev.documents };
			let newEditors = { ...prev.editors };
			for (const eid of group.editorIds) {
				const editor = newEditors[eid];
				if (editor) {
					const doc = newDocs[editor.documentUri];
					if (doc) {
						const newCount = doc.editorCount - 1;
						if (newCount <= 0 && !doc.dirty) {
							const { [editor.documentUri]: _, ...rest } = newDocs;
							newDocs = rest;
						} else {
							newDocs = { ...newDocs, [editor.documentUri]: { ...doc, editorCount: newCount } };
						}
					}
					const { [eid]: _, ...rest } = newEditors;
					newEditors = rest;
				}
			}

			let state: DocumentsState = { ...prev, documents: newDocs, editors: newEditors };

			// Collapse the tree using the shared helper
			const collapsed = collapseEmptyGroup(state, groupId);
			if (collapsed !== state) return collapsed;

			// Was the root leaf — create a fresh default group
			const { [groupId]: _, ...remainingGroups } = state.groups;
			const newId = this._nextGroupId();
			const freshGroup: EditorGroup = { id: newId, editorIds: [], activeEditorIndex: -1 };
			return {
				...state,
				groups: { ...remainingGroups, [newId]: freshGroup },
				rootNode: { type: 'leaf', id: newId, groupId: newId },
				activeGroupId: newId,
			};
		});
	}

	/**
	 * Updates the remembered pixel sizes on a layout split node.
	 * Called by the layout component after an allotment resize.
	 *
	 * @param splitNodeId - The split node whose sizes changed.
	 * @param sizes       - The new pixel sizes for the two children.
	 */
	updateSplitSizes(splitNodeId: string, sizes: [number, number]): void {
		this._update((prev) => {
			const node = findNode(prev.rootNode, splitNodeId);
			if (!node || node.type !== 'split') return prev;
			const updated: LayoutSplit = { ...node, sizes };
			return { ...prev, rootNode: replaceNode(prev.rootNode, splitNodeId, updated) };
		});
	}

	/**
	 * Sets the active editor within a group.
	 *
	 * @param groupId     - The group containing the editor.
	 * @param editorIndex - The index of the editor to activate.
	 */
	setActiveEditor(groupId: string, editorIndex: number): void {
		this._update((prev) => {
			const group = prev.groups[groupId];
			if (!group) return prev;
			return { ...prev, groups: { ...prev.groups, [groupId]: { ...group, activeEditorIndex: editorIndex } }, activeGroupId: groupId };
		});
	}

	/**
	 * Sets the active (focused) group.
	 *
	 * @param groupId - The group to focus.
	 */
	setActiveGroup(groupId: string): void {
		this._update((prev) => ({ ...prev, activeGroupId: groupId }));
	}

	/**
	 * Updates the viewport state of an editor (scroll position, cursor).
	 *
	 * @param editorId - The editor to update.
	 * @param patch    - Partial editor fields to merge.
	 */
	updateEditorViewport(editorId: string, patch: Partial<Pick<Editor, 'scrollTop' | 'scrollLeft' | 'cursorLine' | 'cursorColumn'>>): void {
		this._update((prev) => {
			const editor = prev.editors[editorId];
			if (!editor) return prev;
			return { ...prev, editors: { ...prev.editors, [editorId]: { ...editor, ...patch } } };
		});
	}

	/**
	 * Updates the opaque view state of an editor (active tab, viewport, etc.).
	 * The Documents model treats viewState as opaque — the app is responsible
	 * for casting to/from its own ViewState type at the boundary.
	 *
	 * @param editorId  - The editor to update.
	 * @param viewState - The new view state to store.
	 */
	updateEditorViewState(editorId: string, viewState: Record<string, unknown>): void {
		this._update((prev) => {
			const editor = prev.editors[editorId];
			if (!editor) return prev;
			return { ...prev, editors: { ...prev.editors, [editorId]: { ...editor, viewState } } };
		});
	}

	/**
	 * Destroys this instance — clears state and listeners.
	 */
	destroy(): void {
		// Flush any pending persistence write before destroying
		if (this._workspace && this._persistTimer) {
			clearTimeout(this._persistTimer);
			this._workspace.updateAppState((prev) => ({ ...prev, [APPSTATE_KEY]: this._state }));
		}
		this._vfs = null;
		this._workspace = null;
		this._persistTimer = undefined;
		this._state = makeDefaultState();
		this._listeners.forEach((fn) => fn());
		this._listeners.clear();
	}
}
