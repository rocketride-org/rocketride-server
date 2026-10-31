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
import type { IVirtualFileSystem } from '../../modules/explorer/types';
import { showChoiceDialog } from '../modal/confirmService';

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

/** Where the new group lands relative to the one being split. */
export type SplitPosition = 'before' | 'after';

/**
 * MIME type key for drag-and-drop editor transfers. Shared by the tab strip
 * (drag source / tab-bar drop target) and the pane drop zones (edge-split
 * drop target) so a dragged tab is recognised across both surfaces.
 */
export const EDITOR_DND_MIME = 'application/x-rr-editor';

/**
 * Transient descriptor of a tab drag in flight. Lives OUTSIDE DocumentsState
 * on purpose: HTML5 drag-and-drop hides the transfer payload until drop, so
 * hover-time validation (e.g. "don't offer an edge split to a group's only
 * tab") needs a side channel — and it must never reach workspace persistence.
 */
export interface EditorDragSession {
	/** The editor being dragged. */
	editorId: string;
	/** The group the drag started from. */
	sourceGroupId: string;
}

/**
 * In-flight tab drags keyed by Documents instance. Deliberately NOT methods
 * on the class: `Public<Documents>` appears in contravariant (props) positions
 * of the frozen shell-api contract, so adding required members to the class
 * would break structural conformance for older contract versions. Keying by
 * instance keeps parallel Documents instances from seeing each other's drags.
 */
const editorDragSessions = new WeakMap<object, EditorDragSession>();

/**
 * Marks a tab drag as in flight for a Documents instance. Called by the tab
 * strip on dragstart so drop targets can validate the gesture during hover.
 *
 * @param docs          - The Documents instance the drag belongs to.
 * @param editorId      - The editor being dragged.
 * @param sourceGroupId - The group the drag started from.
 */
export function beginEditorDrag(docs: object, editorId: string, sourceGroupId: string): void {
	editorDragSessions.set(docs, { editorId, sourceGroupId });
}

/**
 * Clears the in-flight tab drag for a Documents instance. Called by the tab
 * strip on dragend.
 *
 * @param docs - The Documents instance the drag belonged to.
 */
export function endEditorDrag(docs: object): void {
	editorDragSessions.delete(docs);
}

/**
 * Returns the in-flight tab drag for a Documents instance, or null.
 *
 * @param docs - The Documents instance to look up.
 * @returns The current drag session descriptor, or null.
 */
export function getEditorDrag(docs: object): EditorDragSession | null {
	return editorDragSessions.get(docs) ?? null;
}

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

/**
 * A structural, brand-free view of a class's PUBLIC surface — a homomorphic
 * mapped type over its public keys. Exposing `Documents` through `Public<Documents>`
 * instead of the concrete class keeps its nominal private brand OUT of the
 * shell-api contract, so structural conformance holds even in contravariant
 * (React FC prop) positions — where the concrete private-bearing class would
 * otherwise fail the frozen-vs-live comparison.
 */
export type Public<T> = { [K in keyof T]: T[K] };

/**
 * Methods added to {@link Documents} AFTER the shell-api contract froze.
 *
 * Keep this list current when adding a method: `Public<Documents>` sits in
 * contravariant (React FC prop) positions of the frozen contract, so a new
 * REQUIRED member makes every older contract version non-conformant — a
 * v5-era app's Documents instance would stop type-checking against the live
 * components. Listing it here makes it optional where that matters.
 */
export type LateDocumentsVerbs = 'requestCloseEditor' | 'requestCloseGroup' | 'saveActiveDocument' | 'flushPersistence';

/**
 * A Documents instance as components must ACCEPT one: everything the frozen
 * contract guaranteed, plus {@link LateDocumentsVerbs} as optional members.
 *
 * Components feature-detect the optional verbs and fall back to the
 * unconditional behavior — which is also exactly what an older app gets.
 */
export type DocumentsLike = Omit<Public<Documents>, LateDocumentsVerbs> & Partial<Pick<Public<Documents>, LateDocumentsVerbs>>;

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

export type { IVirtualFileSystem } from '../../modules/explorer/types';

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
	/**
	 * Optional: writes the workspace's own pending debounced state NOW.
	 *
	 * Documents debounces into appState and the workspace debounces appState
	 * to disk, so a flush that stops at the first stage still leaves the
	 * change in a timer. Supplying this pushes it down the whole chain.
	 *
	 * For a LIVE page only. This must NOT be wired to `pagehide`: the write
	 * rides the engine socket, and a reload closes it mid-flight — the
	 * server truncates the target file and never receives the body, which
	 * turned a workspace file into zero bytes. A half-second of debounce is
	 * worth losing; the workspace is not.
	 */
	flushNow?: () => void;
}

// =============================================================================
// DIRTY-CLOSE POLICY — the third collaborator
// =============================================================================
//
// Documents owns the VFS and the persisted state, so it already holds
// everything a save needs; what it lacked was permission to ASK. These
// hooks are that permission. The dialogs the shell falls back to mount
// their own React root (see confirmService), so a plain class can run the
// whole lifecycle without a host capability or an app callback.
//
// Each hook is TRI-STATE on purpose, because "nobody wired this" and
// "deliberately nothing" are different intentions and the unsafe one must
// be the explicit one:
//
//   omitted   → the shell's stock dialog (SAFE DEFAULT: the user decides)
//   function  → the app owns the decision (its own chrome, its own save-as)
//   null      → no prompt; unsaved changes are discarded (OPT-IN)
//
// Until this existed, absence meant silent discard — the fail-open default
// that lost edits in every app that renders DocTabs.
// =============================================================================

/** What a dirty-close decision can be. */
export type DirtyCloseChoice = 'save' | 'discard' | 'cancel';

/** One unsaved document a close is about to destroy. */
export interface DirtyDocInfo {
	/** The document URI. */
	uri: string;
	/** The tab label (the editor's label, or the URI). */
	label: string;
	/** True for a never-saved document — saving it needs a path first. */
	isNew: boolean;
	/** Whether this instance can save it without asking for a path. */
	canSave: boolean;
}

/** The UI policy hooks for a {@link Documents} instance (see file header). */
export interface DocumentsUi {
	/**
	 * Decides what happens to documents whose LAST view is closing with
	 * unsaved changes. Called once per close with every affected document,
	 * so a group close asks one question rather than one per tab.
	 *
	 * Omit for the shell's Save/Discard/Cancel dialog; pass null to discard
	 * without asking.
	 */
	confirmDirtyClose?: ((docs: readonly DirtyDocInfo[]) => Promise<DirtyCloseChoice>) | null;
	/**
	 * Supplies a path for a never-saved document, so "Save" can be offered
	 * when closing one. Resolve null to abandon the save (the close is then
	 * cancelled too — the user asked to save and we could not).
	 *
	 * The shell has NO default here: a save-as dialog needs the file types
	 * of the app's own documents, which Documents cannot know. Without it,
	 * "Save" is simply not offered for new documents.
	 */
	pickSavePath?: ((doc: DirtyDocInfo) => Promise<string | null>) | null;
}

/** Constructor options for {@link Documents}. */
export interface DocumentsOptions {
	/** Virtual file system for reading/writing document content. */
	vfs?: IVirtualFileSystem | null;
	/** Workspace binding for automatic persistence. */
	workspace?: WorkspaceBinding;
	/** Dirty-close and save-as policy (see {@link DocumentsUi}). */
	ui?: DocumentsUi;
}

// =============================================================================
// RESTORE HYGIENE
// =============================================================================

/**
 * Drops documents and editors nothing can reach, on restore.
 *
 * Earlier builds retained a dirty document when its last editor closed
 * (editorCount 0, no tab, unsaved content and all) and persisted it
 * forever, so a saved blob can carry orphans from any number of past
 * sessions. A document is reachable only through an editor that a group
 * lists; anything else is dead weight that cannot be opened, closed, or
 * saved by any user action.
 *
 * @param state - The restored state.
 * @returns The state, or a pruned copy when anything was unreachable.
 */
function pruneOrphans(state: DocumentsState): DocumentsState {
	const liveEditorIds = new Set<string>();
	for (const group of Object.values(state.groups)) {
		for (const eid of group?.editorIds ?? []) if (state.editors[eid]) liveEditorIds.add(eid);
	}

	const editors: Record<string, Editor> = {};
	const refCounts = new Map<string, number>();
	for (const eid of liveEditorIds) {
		const editor = state.editors[eid]!;
		editors[eid] = editor;
		refCounts.set(editor.documentUri, (refCounts.get(editor.documentUri) ?? 0) + 1);
	}

	// Rebuild editorCount from what actually references each document: a
	// restored count can disagree with the editors it survived alongside.
	const documents: Record<string, Document> = {};
	for (const [uri, doc] of Object.entries(state.documents)) {
		const count = refCounts.get(uri);
		if (!doc || count === undefined) continue;
		documents[uri] = doc.editorCount === count ? doc : { ...doc, editorCount: count };
	}

	const editorsChanged = Object.keys(editors).length !== Object.keys(state.editors).length;
	const docsChanged =
		Object.keys(documents).length !== Object.keys(state.documents).length ||
		Object.keys(documents).some((uri) => documents[uri] !== state.documents[uri]);
	if (!editorsChanged && !docsChanged) return state;
	return { ...state, documents, editors };
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
	const newActiveGroup = allGroupIds.includes(state.activeGroupId) ? state.activeGroupId : allGroupIds[allGroupIds.length - 1]!;

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
	private _ui: DocumentsUi | null = null;
	private _persistTimer: ReturnType<typeof setTimeout> | undefined;
	private _listeners = new Set<() => void>();
	private _notifyScheduled = false;
	private _editorCounter = 0;
	private _groupCounter = 1;
	private _splitCounter = 0;

	/**
	 * Creates a new Documents instance.
	 *
	 * Accepts either the positional form (kept verbatim — it is in the frozen
	 * shell contract) or a single options bag, which is the only way to pass
	 * the {@link DocumentsUi} policy. The two are told apart by `read`: every
	 * IVirtualFileSystem has one, no DocumentsOptions does.
	 *
	 * @param vfsOrOptions - A virtual file system, or {@link DocumentsOptions}.
	 * @param workspace    - Optional workspace binding for automatic persistence
	 *                       (positional form only). When provided, state is
	 *                       restored from appState on creation and debounce-saved
	 *                       back on every change.
	 */
	constructor(vfsOrOptions?: IVirtualFileSystem | null | DocumentsOptions, workspace?: WorkspaceBinding) {
		const asOptions =
			vfsOrOptions && typeof vfsOrOptions === 'object' && typeof (vfsOrOptions as IVirtualFileSystem).read !== 'function'
				? (vfsOrOptions as DocumentsOptions)
				: null;
		const vfs = asOptions ? asOptions.vfs : (vfsOrOptions as IVirtualFileSystem | null | undefined);
		this._vfs = vfs ?? null;
		this._workspace = (asOptions ? asOptions.workspace : workspace) ?? null;
		this._ui = (asOptions?.ui ?? null) as DocumentsUi | null;

		// Restore from workspace persistence if available. Read through the
		// resolved field, NOT the positional parameter — the options form
		// carries the binding in `vfsOrOptions`.
		const persisted = this._workspace?.appState?.[APPSTATE_KEY] as Record<string, any> | undefined;
		if (persisted?.documents && persisted?.groups) {
			if (persisted.rootNode) {
				// Current format — use directly
				this._state = pruneOrphans(persisted as unknown as DocumentsState);
			} else if (persisted.groupOrder) {
				// Legacy format — migrate flat groupOrder to tree
				const migrated = { ...persisted, rootNode: migrateGroupOrderToTree(persisted.groupOrder) } as unknown as DocumentsState;
				delete (migrated as any).groupOrder;
				this._state = pruneOrphans(migrated);
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
	 * EVERY change takes the debounce, structural ones included: each write
	 * is a server round trip, and opening/closing documents is frequent
	 * enough that per-mutation writes would be a real load. Teardown is
	 * covered by flushPersistence() instead of by writing eagerly.
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
		if (!this._workspace) return;
		clearTimeout(this._persistTimer);
		this._persistTimer = setTimeout(() => {
			this._workspace?.updateAppState((prev) => ({ ...prev, [APPSTATE_KEY]: this._state }));
		}, PERSIST_DEBOUNCE_MS);
	}

	/**
	 * Writes this instance's state through to persistence immediately,
	 * cancelling the pending debounce.
	 *
	 * Safe to call at any time and when nothing is pending: the write is an
	 * idempotent overwrite of the same value.
	 */
	flushPersistence(): void {
		if (!this._workspace) return;
		clearTimeout(this._persistTimer);
		this._persistTimer = undefined;
		this._workspace.updateAppState((prev) => ({ ...prev, [APPSTATE_KEY]: this._state }));
		// ...and on down: updateAppState only schedules the workspace's own
		// debounced disk write, which a teardown would kill in turn.
		this._workspace.flushNow?.();
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
			() => this._state
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
					if (raw !== null && raw !== undefined) {
						content = raw;
						loadedOk = true;
					}
				} catch {
					/* read failed */
				}
			}
			doc = { uri, content, dirty: false, version: 1, editorCount: 0, isNew: !loadedOk };
		}

		const editorId = this._nextEditorId();
		const editor: Editor = {
			id: editorId,
			documentUri: uri,
			scrollTop: 0,
			scrollLeft: 0,
			cursorLine: 1,
			cursorColumn: 1,
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
			id: editorId,
			documentUri: uri,
			scrollTop: 0,
			scrollLeft: 0,
			cursorLine: 1,
			cursorColumn: 1,
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
			id: editorId,
			documentUri: uri,
			scrollTop: 0,
			scrollLeft: 0,
			cursorLine: 1,
			cursorColumn: 1,
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

			// Clean up document reference count. The LAST view closing drops
			// the document whether or not it is dirty: retaining it left an
			// unreachable editorCount-0 entry (no tab, unsaved content, and
			// persisted forever). Anything that must not discard silently
			// asks FIRST — see requestCloseEditor.
			const doc = prev.documents[editor.documentUri];
			let newDocs = prev.documents;
			if (doc) {
				const newCount = doc.editorCount - 1;
				if (newCount <= 0) {
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

	// --- Policy-aware closing ------------------------------------------------

	/**
	 * Closes one editor, asking about unsaved changes first.
	 *
	 * The prompt happens ONLY when this is the last view of a dirty
	 * document: closing one of two split views of the same document
	 * destroys nothing, so asking would be both spurious and dangerous
	 * (a "discard" would throw away content still on screen).
	 *
	 * @param editorId - The editor to close.
	 * @returns True when the editor closed; false when the user cancelled.
	 */
	async requestCloseEditor(editorId: string): Promise<boolean> {
		const editor = this._state.editors[editorId];
		// Nothing to close is a satisfied request, not a refusal.
		if (!editor) return true;

		const info = this._dirtyInfo(editor.documentUri, 1);
		if (!info) {
			this.closeEditor(editorId);
			return true;
		}

		const resolved = await this._resolveDirtyClose([info]);
		if (!resolved) return false;
		this.closeEditor(editorId);
		return true;
	}

	/**
	 * Closes a group, asking once about every unsaved document it is the
	 * last home of ("3 files have unsaved changes").
	 *
	 * One aggregated question, never a loop: the dialog service allows one
	 * dialog at a time, so prompting per tab would ask about the first and
	 * silently refuse the rest.
	 *
	 * @param groupId - The group to close.
	 * @returns True when the group closed; false when the user cancelled.
	 */
	async requestCloseGroup(groupId: string): Promise<boolean> {
		const group = this._state.groups[groupId];
		if (!group) return true;

		// How many of each document's views live in THIS group — a document
		// also open elsewhere survives the group close, so it is not at risk.
		const viewsHere = new Map<string, number>();
		for (const eid of group.editorIds) {
			const uri = this._state.editors[eid]?.documentUri;
			if (uri) viewsHere.set(uri, (viewsHere.get(uri) ?? 0) + 1);
		}

		const atRisk: DirtyDocInfo[] = [];
		for (const [uri, views] of viewsHere) {
			const info = this._dirtyInfo(uri, views);
			if (info) atRisk.push(info);
		}

		if (atRisk.length > 0) {
			const resolved = await this._resolveDirtyClose(atRisk);
			if (!resolved) return false;
		}
		this.closeGroup(groupId);
		return true;
	}

	/**
	 * Saves the document in the active editor of the active group — the
	 * Ctrl+S verb, stated once instead of re-derived in every app's
	 * `tab:save` listener.
	 *
	 * @returns Resolves when the save completed (or there was nothing to do).
	 */
	async saveActiveDocument(): Promise<void> {
		const s = this._state;
		const group = s.groups[s.activeGroupId];
		const editorId = group?.editorIds[group.activeEditorIndex];
		const uri = editorId ? s.editors[editorId]?.documentUri : undefined;
		if (!uri) return;
		await this._saveOrSaveAs(uri);
	}

	// --- Dirty-close internals -----------------------------------------------

	/**
	 * Describes a document if closing `closingViews` of its views would
	 * destroy unsaved changes, else null.
	 *
	 * @param uri          - The document URI.
	 * @param closingViews - How many of its views are being closed.
	 * @returns The risk description, or null when nothing is at stake.
	 */
	private _dirtyInfo(uri: string, closingViews: number): DirtyDocInfo | null {
		const doc = this._state.documents[uri];
		// Static documents hold nothing to lose (they never go dirty).
		if (!doc || doc.static || !doc.dirty) return null;
		// Surviving views elsewhere keep the content reachable and editable.
		if (doc.editorCount > closingViews) return null;
		const label = Object.values(this._state.editors).find((e) => e?.documentUri === uri)?.label ?? uri;
		const canSave = !doc.isNew || typeof this._ui?.pickSavePath === 'function';
		return { uri, label, isNew: doc.isNew, canSave };
	}

	/**
	 * Applies the dirty-close policy to documents about to be destroyed.
	 *
	 * @param docs - The at-risk documents (non-empty).
	 * @returns True to proceed with the close; false to abandon it.
	 */
	private async _resolveDirtyClose(docs: readonly DirtyDocInfo[]): Promise<boolean> {
		const hook = this._ui?.confirmDirtyClose;

		// Explicit opt-out: discard without asking.
		if (hook === null) return true;

		const choice = hook ? await hook(docs) : await this._askDirtyClose(docs);
		if (choice === 'cancel') return false;
		if (choice === 'discard') return true;

		// 'save' — every document must land, or the close is abandoned: the
		// user asked to keep this work, so failing quietly and closing anyway
		// would destroy exactly what they tried to protect.
		for (const doc of docs) {
			const saved = await this._saveOrSaveAs(doc.uri);
			if (!saved) return false;
		}
		return true;
	}

	/**
	 * The shell's stock dirty-close dialog (used when no app hook is given).
	 *
	 * @param docs - The at-risk documents.
	 * @returns The user's choice; 'cancel' whenever no answer was obtained.
	 */
	private async _askDirtyClose(docs: readonly DirtyDocInfo[]): Promise<DirtyCloseChoice> {
		const many = docs.length > 1;
		const title = many ? 'Unsaved changes' : `Save changes to ${docs[0]!.label}?`;
		const message = many
			? `${docs.length} files have unsaved changes:\n\n${docs.map((d) => `• ${d.label}`).join('\n')}\n\nYour changes will be lost if you don't save them.`
			: "Your changes will be lost if you don't save them.";

		// Save is offered only when EVERY at-risk document can actually be
		// written — a mixed set would otherwise save some and silently skip
		// the new ones. An app that wants save-as here wires pickSavePath.
		const saveable = docs.every((d) => d.canSave);

		const choice = await showChoiceDialog({
			title,
			message,
			options: [
				{ id: 'cancel', label: 'Cancel' },
				{ id: 'discard', label: "Don't Save", destructive: true },
				...(saveable ? [{ id: 'save', label: many ? 'Save All' : 'Save', primary: true }] : []),
			],
			cancelId: 'cancel',
			...(many ? { width: 520 } : {}),
		});

		// A null means the dialog could not be shown at all — treat the
		// close as refused rather than guessing (never auto-discard).
		return choice === 'save' || choice === 'discard' ? choice : 'cancel';
	}

	/**
	 * Saves a document, routing a never-saved one through the app's
	 * save-as hook first.
	 *
	 * @param uri - The document URI.
	 * @returns True when the content reached the VFS.
	 */
	private async _saveOrSaveAs(uri: string): Promise<boolean> {
		const doc = this._state.documents[uri];
		if (!doc || doc.static) return false;

		if (!doc.isNew) {
			await this.saveDocument(uri);
			return this._state.documents[uri]?.dirty !== true;
		}

		const pick = this._ui?.pickSavePath;
		if (typeof pick !== 'function') return false;
		const info = this._dirtyInfo(uri, Number.MAX_SAFE_INTEGER) ?? { uri, label: uri, isNew: true, canSave: true };
		const path = await pick(info);
		// No path chosen: the save was abandoned, so the caller must not
		// proceed as though the content had been written.
		if (!path) return false;
		if (!this._vfs) return false;
		await this._vfs.write(path, doc.content);
		return true;
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
			try {
				newContent = await this._vfs.read(uri);
			} catch {
				/* read failed */
			}
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
	 * @param position    - Which side of the original the new group lands on
	 *                      ('before' = left/top, 'after' = right/bottom). Defaults to 'after'.
	 * @returns The new group's ID.
	 */
	splitGroup(groupId: string, orientation: SplitOrientation, position: SplitPosition = 'after'): string {
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

			// Replace the original leaf with a split containing both, the new
			// leaf on the side the position asks for
			const splitNode: LayoutSplit = {
				type: 'split',
				id: splitNodeId,
				orientation,
				children: position === 'before' ? [newLeaf, leaf] : [leaf, newLeaf],
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
					id: editorId,
					documentUri: activeDocUri,
					scrollTop: 0,
					scrollLeft: 0,
					cursorLine: 1,
					cursorColumn: 1,
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
				type: 'split',
				id: splitNodeId,
				orientation,
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
	 * If the move empties the source group, the group is auto-collapsed from
	 * the layout tree (VS Code parity, same behavior as closeEditor).
	 *
	 * @param editorId      - The editor to move.
	 * @param targetGroupId - The destination group.
	 */
	moveEditor(editorId: string, targetGroupId: string): void {
		this._update((prev) => {
			const editor = prev.editors[editorId];
			if (!editor) return prev;
			const newGroups = { ...prev.groups };
			let emptiedGroupId: string | null = null;

			// Remove from source group
			for (const gid of Object.keys(newGroups)) {
				const group = newGroups[gid]!;
				const idx = group.editorIds.indexOf(editorId);
				if (idx !== -1) {
					const newIds = group.editorIds.filter((id) => id !== editorId);
					let newActive = group.activeEditorIndex;
					if (newActive >= newIds.length) newActive = Math.max(0, newIds.length - 1);
					newGroups[gid] = { ...group, editorIds: newIds, activeEditorIndex: newActive };
					// Track an emptied source for auto-collapse — unless it IS
					// the target (same-group move re-adds the editor below)
					if (newIds.length === 0 && gid !== targetGroupId) emptiedGroupId = gid;
					break;
				}
			}

			// Add to target group
			const target = newGroups[targetGroupId];
			if (!target) return prev;
			const newIds = [...target.editorIds, editorId];
			newGroups[targetGroupId] = { ...target, editorIds: newIds, activeEditorIndex: newIds.length - 1 };

			let state: DocumentsState = { ...prev, groups: newGroups, activeGroupId: targetGroupId };

			// Auto-collapse the emptied source group (no-op if it's the root leaf)
			if (emptiedGroupId) {
				state = collapseEmptyGroup(state, emptiedGroupId);
			}

			return state;
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
						// Last view wins the same way as closeEditor: drop it
						// rather than orphan it. requestCloseGroup asks first.
						if (newCount <= 0) {
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
		this.flushPersistence();
		this._vfs = null;
		this._workspace = null;
		this._persistTimer = undefined;
		this._state = makeDefaultState();
		this._listeners.forEach((fn) => fn());
		this._listeners.clear();
	}
}
