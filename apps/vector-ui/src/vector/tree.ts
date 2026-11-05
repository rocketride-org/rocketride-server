// =============================================================================
// MIT License
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
// VECTOR - THE FOLDER TREE (pure): folders from the loaded documents' paths, and the tree's keys
// =============================================================================
//
// The Documents tab's folder rail is a WAI-ARIA tree built here from the
// documents the console has loaded (never a count the store did not give):
//
//   All documents        every loaded document
//     C:/demo/           a folder: its documents and those of every folder under it
//       handbooks/       ...
//       manual.pdf       a document (shown once its folder is expanded)
//     Uploaded           documents stored under a bare file name
//   Trash                the Trash tab
//
// A folder is everything up to a separator in a stored path, as the
// documents list has always grouped them (vector/documents.ts splitPath):
// `/` and `\` both separate, a drive letter, a network share or a POSIX root
// stays part of its first folder, and a folder that holds nothing but one
// other folder is shown as one ("C:/demo/" rather than "C:/" then "demo/").
// The flat view lists every folder that holds documents by its whole path,
// as the old directory's groups did.
//
// Clicking a folder narrows the list to the documents under it (a view of
// what is loaded, vector/tree.ts folderRows: the listing is not asked
// again and the scope does not change).
//
// The keys follow the APG tree: Up and Down move, Right opens a folder (then
// enters it), Left closes it (then goes to its parent), Home and End go to
// the first and last item, Enter acts, and typing a name's first letters
// moves to the next item that starts with them.
// =============================================================================

import type { IDocumentItem } from '../contract/types';
import { UPLOADED_LABEL, splitPath } from './documents';

/** One folder of the tree. */
export interface ITreeFolder {
	/** Its path prefix, separator included (the `path_prefix` that selects it). */
	prefix: string;
	/** What the rail shows: the part after its parent's prefix (the whole prefix at the top). */
	label: string;
	/** Loaded documents under it, those of its subfolders included. */
	documents: number;
	children: ITreeFolder[];
	/** The documents directly in it, by name. */
	files: IDocumentItem[];
}

/** The tree of the loaded documents. */
export interface IFolderTree {
	/** The top folders. */
	folders: ITreeFolder[];
	/** Documents stored under a bare name. */
	uploaded: IDocumentItem[];
	/** Every loaded document. */
	total: number;
}

/** What the rail can narrow the list to: a folder (by prefix) or the documents stored under a bare name. */
export type FolderView = { kind: 'folder'; prefix: string } | { kind: 'uploaded' };

/** Code-point comparison, lower case first, so the order is the same in every browser and locale. */
function compareText(a: string, b: string): number {
	const la = a.toLowerCase();
	const lb = b.toLowerCase();
	if (la !== lb) return la < lb ? -1 : 1;
	return a === b ? 0 : a < b ? -1 : 1;
}

/** A document's name in its folder. */
function nameOf(item: IDocumentItem): string {
	return splitPath(item.path).name;
}

/** By name, then path, then objectId. */
function compareFiles(a: IDocumentItem, b: IDocumentItem): number {
	return compareText(nameOf(a), nameOf(b)) || compareText(a.path, b.path) || compareText(a.objectId, b.objectId);
}

/**
 * The prefixes of a folder, outermost first: one per separator that follows another character, so a root
 * (`/`, `\\server\`) stays part of its first folder.
 *
 * @param folder - A folder as splitPath gives it (ending with a separator).
 * @returns e.g. ['C:/', 'C:/demo/', 'C:/demo/handbooks/'].
 */
export function folderPrefixes(folder: string): string[] {
	const out: string[] = [];
	for (let i = 1; i < folder.length; i++) {
		const ch = folder[i];
		const prev = folder[i - 1];
		if ((ch === '/' || ch === '\\') && prev !== '/' && prev !== '\\') out.push(folder.slice(0, i + 1));
	}
	return out.length === 0 ? [folder] : out;
}

/** A folder being built. */
interface IDraft {
	prefix: string;
	children: Map<string, IDraft>;
	files: IDocumentItem[];
}

/** Turn drafts into folders: merge a folder that holds only one folder into it, count, sort. */
function finish(draft: IDraft, parentPrefix: string): ITreeFolder {
	let node = draft;
	while (node.files.length === 0 && node.children.size === 1) node = node.children.values().next().value as IDraft;
	const children = [...node.children.values()].map((child) => finish(child, node.prefix)).sort((a, b) => compareText(a.label, b.label));
	const files = [...node.files].sort(compareFiles);
	return { prefix: node.prefix, label: node.prefix.startsWith(parentPrefix) && parentPrefix !== '' ? node.prefix.slice(parentPrefix.length) : node.prefix, documents: files.length + children.reduce((n, c) => n + c.documents, 0), children, files };
}

/**
 * The folder tree of the loaded documents.
 *
 * @param rows - The loaded documents.
 * @returns The tree.
 */
export function buildTree(rows: readonly IDocumentItem[]): IFolderTree {
	const roots = new Map<string, IDraft>();
	const uploaded: IDocumentItem[] = [];
	for (const item of rows) {
		const parts = splitPath(item.path);
		if (parts.uploaded) {
			uploaded.push(item);
			continue;
		}
		let level = roots;
		let draft: IDraft | undefined;
		for (const prefix of folderPrefixes(parts.folder)) {
			draft = level.get(prefix);
			if (!draft) {
				draft = { prefix, children: new Map(), files: [] };
				level.set(prefix, draft);
			}
			level = draft.children;
		}
		draft?.files.push(item);
	}
	return { folders: [...roots.values()].map((d) => finish(d, '')).sort((a, b) => compareText(a.label, b.label)), uploaded: uploaded.sort(compareFiles), total: rows.length };
}

/**
 * Every folder that holds documents directly, by its whole path (the flat view), each counting the documents under
 * it as a click narrows the list (its subfolders' included).
 *
 * @param tree - The tree.
 * @returns The folders, each without subfolders, sorted by path.
 */
export function flatFolders(tree: IFolderTree): ITreeFolder[] {
	const out: ITreeFolder[] = [];
	const walk = (folder: ITreeFolder): void => {
		// Counted as a click narrows the list: the folder's documents and those of the folders under it.
		if (folder.files.length > 0) out.push({ prefix: folder.prefix, label: folder.prefix, documents: folder.documents, children: [], files: folder.files });
		for (const child of folder.children) walk(child);
	};
	for (const folder of tree.folders) walk(folder);
	return out.sort((a, b) => compareText(a.prefix, b.prefix));
}

/** The id of the "All documents" item. */
export const TREE_ALL = 'all';

/** The id of the Uploaded group. */
export const TREE_UPLOADED = 'uploaded';

/** The id of the Trash item. */
export const TREE_TRASH = 'trash';

/** The id of a folder's item. */
export function folderItemId(prefix: string): string {
	return `f:${prefix}`;
}

/** The id of a document's item. */
export function fileItemId(objectId: string): string {
	return `d:${objectId}`;
}

/** One visible item of the tree, with where it sits (aria-level, -setsize and -posinset). */
export type TreeItem = { id: string; level: number; setsize: number; posinset: number; label: string } & (
	| { kind: 'all'; count: number; expanded: boolean }
	| { kind: 'folder'; folder: ITreeFolder; count: number; expanded: boolean }
	| { kind: 'uploaded'; files: IDocumentItem[]; count: number; expanded: boolean }
	| { kind: 'file'; item: IDocumentItem }
	| { kind: 'trash'; count: number | null }
);

/**
 * The items a tree shows, in order: what is expanded opens its children.
 *
 * @param tree - The tree.
 * @param expanded - The ids of the open items ('all' and folder ids).
 * @param opts - `flat` lists the folders by their whole path; `trash` is the store's count of trashed documents, or null.
 * @returns The visible items.
 */
export function treeItems(tree: IFolderTree, expanded: ReadonlySet<string>, opts: { flat: boolean; trash: number | null }): TreeItem[] {
	const out: TreeItem[] = [];
	const folders = opts.flat ? flatFolders(tree) : tree.folders;
	const allOpen = expanded.has(TREE_ALL);
	out.push({ kind: 'all', id: TREE_ALL, label: 'All documents', count: tree.total, expanded: allOpen, level: 1, setsize: 2, posinset: 1 });
	const files = (list: readonly IDocumentItem[], level: number): void => {
		list.forEach((item, i) => out.push({ kind: 'file', id: fileItemId(item.objectId), label: nameOf(item), item, level, setsize: list.length, posinset: i + 1 }));
	};
	const folder = (node: ITreeFolder, level: number, setsize: number, posinset: number): void => {
		const id = folderItemId(node.prefix);
		const open = expanded.has(id);
		out.push({ kind: 'folder', id, label: node.label, folder: node, count: node.documents, expanded: open, level, setsize, posinset });
		if (!open) return;
		const size = node.children.length + node.files.length;
		node.children.forEach((child, i) => folder(child, level + 1, size, i + 1));
		node.files.forEach((item, i) => out.push({ kind: 'file', id: fileItemId(item.objectId), label: nameOf(item), item, level: level + 1, setsize: size, posinset: node.children.length + i + 1 }));
	};
	if (allOpen) {
		const top = folders.length + (tree.uploaded.length > 0 ? 1 : 0);
		folders.forEach((node, i) => folder(node, 2, top, i + 1));
		if (tree.uploaded.length > 0) {
			const open = expanded.has(TREE_UPLOADED);
			out.push({ kind: 'uploaded', id: TREE_UPLOADED, label: UPLOADED_LABEL, files: tree.uploaded, count: tree.uploaded.length, expanded: open, level: 2, setsize: top, posinset: top });
			if (open) files(tree.uploaded, 3);
		}
	}
	out.push({ kind: 'trash', id: TREE_TRASH, label: 'Trash', count: opts.trash, level: 1, setsize: 2, posinset: 2 });
	return out;
}

/** What a key does in the tree. */
export type TreeKeyAction = { kind: 'move'; index: number } | { kind: 'expand'; id: string } | { kind: 'collapse'; id: string } | { kind: 'activate' };

/** Whether an item opens and closes. */
function expandable(item: TreeItem): item is Extract<TreeItem, { expanded: boolean }> {
	return item.kind === 'all' || item.kind === 'folder' || item.kind === 'uploaded';
}

/**
 * What a key pressed on an item does (the APG tree's keys).
 *
 * @param items - The visible items.
 * @param index - The focused item.
 * @param key - `KeyboardEvent.key`.
 * @returns The action, or null for a key the tree leaves alone.
 */
export function treeKey(items: readonly TreeItem[], index: number, key: string): TreeKeyAction | null {
	if (items.length === 0) return null;
	const at = Math.min(Math.max(index, 0), items.length - 1);
	const item = items[at] as TreeItem;
	switch (key) {
		case 'ArrowDown':
			return { kind: 'move', index: Math.min(at + 1, items.length - 1) };
		case 'ArrowUp':
			return { kind: 'move', index: Math.max(at - 1, 0) };
		case 'Home':
			return { kind: 'move', index: 0 };
		case 'End':
			return { kind: 'move', index: items.length - 1 };
		case 'ArrowRight':
			if (!expandable(item)) return null;
			if (!item.expanded) return { kind: 'expand', id: item.id };
			return at + 1 < items.length && (items[at + 1] as TreeItem).level === item.level + 1 ? { kind: 'move', index: at + 1 } : null;
		case 'ArrowLeft': {
			if (expandable(item) && item.expanded) return { kind: 'collapse', id: item.id };
			for (let i = at - 1; i >= 0; i--) if ((items[i] as TreeItem).level === item.level - 1) return { kind: 'move', index: i };
			return null;
		}
		case 'Enter':
		case ' ':
			return { kind: 'activate' };
		default:
			return null;
	}
}

/**
 * Type-ahead: the next item (after `from`, wrapping) whose label starts with the typed letters; the same letter typed
 * again cycles through the items that start with it.
 *
 * @param items - The visible items.
 * @param from - The focused item.
 * @param typed - The letters typed so far (lower or upper case).
 * @returns The item's index, or -1.
 */
export function typeAhead(items: readonly TreeItem[], from: number, typed: string): number {
	if (typed === '' || items.length === 0) return -1;
	const lower = typed.toLowerCase();
	const repeated = [...lower].every((ch) => ch === lower[0]);
	const needle = repeated ? (lower[0] as string) : lower;
	// A longer prefix stays on the current item while it still matches; one letter (or the same one again) moves on.
	const start = repeated ? from + 1 : from;
	for (let n = 0; n < items.length; n++) {
		const i = (start + n) % items.length;
		if ((items[i] as TreeItem).label.toLowerCase().startsWith(needle)) return i;
	}
	return -1;
}

/**
 * The ids to keep open after Collapse all: every document's folder closes, the top level stays shown.
 *
 * @returns The open ids.
 */
export function collapsedAll(): ReadonlySet<string> {
	return new Set([TREE_ALL]);
}

/**
 * The loaded documents a folder view keeps (nothing is asked of the store again).
 *
 * @param rows - The documents shown before the view.
 * @param view - The folder view, or null for every document.
 * @returns The documents under the folder (its subfolders' included), or the rows themselves without a view.
 */
export function folderRows(rows: readonly IDocumentItem[], view: FolderView | null): readonly IDocumentItem[] {
	if (view === null) return rows;
	if (view.kind === 'uploaded') return rows.filter((row) => splitPath(row.path).uploaded);
	return rows.filter((row) => row.path.startsWith(view.prefix));
}

/**
 * The tree item a folder view selects.
 *
 * @param view - The folder view, or null.
 * @returns The item's id ('all' without a view).
 */
export function viewItemId(view: FolderView | null): string {
	if (view === null) return TREE_ALL;
	return view.kind === 'uploaded' ? TREE_UPLOADED : folderItemId(view.prefix);
}

/**
 * The ids to open so a folder's item is shown (its ancestors, 'all' included).
 *
 * @param tree - The tree.
 * @param prefix - The folder.
 * @returns The ids of the folders above it.
 */
export function ancestorsOf(tree: IFolderTree, prefix: string): string[] {
	const out: string[] = [TREE_ALL];
	let level = tree.folders;
	for (;;) {
		const next = level.find((f) => prefix.startsWith(f.prefix) && f.prefix !== prefix);
		if (!next) return out;
		out.push(folderItemId(next.prefix));
		level = next.children;
	}
}
