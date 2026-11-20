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
// VECTOR-UI — DROP TRAVERSAL (dropped folders become files with paths)
// =============================================================================
//
// A drop hands the page FileSystem entries (`DataTransferItem.
// webkitGetAsEntry()`, in every browser the app supports). Files keep the path
// they had under what was dropped ('handbooks/falcon.md'); that path becomes
// the document's path in the store.
//
// Two rules the browser imposes:
//   - The DataTransfer is emptied when the drop handler returns, so the
//     entries are taken synchronously (`entriesFromDataTransfer`) and walked
//     afterwards (`traverseDrop`).
//   - A directory reader hands out its children in batches; `readEntries` is
//     called until it answers with an empty list.
//
// The walk is bounded (TRAVERSAL_SCAN_CAP files, MAX_TRAVERSAL_DEPTH levels),
// sorted by name at every level so the order is predictable, and skips hidden
// and system files (.DS_Store, Thumbs.db, .git/…), reporting what it skipped.
// An item the browser gives no entry for (webkitGetAsEntry() answers null,
// as it does for a drop a page script builds) is read with getAsFile() and
// stored under its name; an item that yields neither is counted, and the
// drop says so, as it does when nothing at all could be read.
// The upload caps themselves are applied later (src/vector/uploads.ts).
// =============================================================================

/** Files read from one drop before the walk stops (the upload cap is far lower; this only bounds the work). */
export const TRAVERSAL_SCAN_CAP = 1_000;

/** Folder levels walked below what was dropped. */
export const MAX_TRAVERSAL_DEPTH = 32;

/** The parts of a FileSystemEntry the walk uses (structural, so tests can fake it). */
export interface FsEntryLike {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	/** '/folder/name.ext' relative to the drop. */
	fullPath: string;
	file?(success: (file: File) => void, error?: (reason: unknown) => void): void;
	createReader?(): { readEntries(success: (entries: FsEntryLike[]) => void, error?: (reason: unknown) => void): void };
}

/** The parts of a DataTransfer the walk uses. */
export interface DataTransferLike {
	items?: ArrayLike<{ kind?: string; webkitGetAsEntry?: () => FsEntryLike | null; getAsFile?: () => File | null }> | null;
	files?: ArrayLike<File> | null;
}

/** What a drop handed over, taken while the drop event runs. */
export interface DropSnapshot {
	/** Entries to walk (files and folders). */
	entries: FsEntryLike[];
	/** Files without an entry: each is stored under its name. */
	loose: File[];
	/** File items that gave neither an entry nor a file. */
	unreadable: number;
}

/** A drop that yielded no file, no skipped file and no other message. */
export const DROP_NOTHING_READ = 'Nothing in this drop could be read as a file. Use Add files or Add folder instead.';

/**
 * The sentence for dropped items that could not be read.
 *
 * @param count - How many.
 * @returns The sentence.
 */
export function unreadableSentence(count: number): string {
	return count === 1 ? '1 dropped item could not be read as a file. Use Add files or Add folder for it.' : `${count.toLocaleString('en-US')} dropped items could not be read as files. Use Add files or Add folder for them.`;
}

/** A file and the path it is stored under (before any "Store under folder" prefix). */
export interface DroppedFile {
	file: File;
	relPath: string;
}

/** What a drop yielded. */
export interface TraversalResult {
	files: DroppedFile[];
	/** Paths of hidden or system files and folders that were left out. */
	skipped: string[];
	/** True when the walk stopped at {@link TRAVERSAL_SCAN_CAP}. */
	truncated: boolean;
	/** Sentences for what could not be read. */
	errors: string[];
}

/** System files no one means to add to a collection. */
const SYSTEM_NAMES = new Set(['thumbs.db', 'desktop.ini', '__macosx']);

/**
 * Whether a file or folder name is hidden or a system artefact.
 *
 * @param name - A base name.
 * @returns True for dot files and the usual system files.
 */
export function isHiddenName(name: string): boolean {
	return name.startsWith('.') || SYSTEM_NAMES.has(name.toLowerCase());
}

/**
 * Take the entries of a drop. Call this inside the drop handler: the browser
 * empties the DataTransfer when the handler returns.
 *
 * @param transfer - The drop's DataTransfer.
 * @returns The entries to walk, the files that came without an entry (or the
 *   plain file list when the browser gives no entries), and how many items gave neither.
 */
export function entriesFromDataTransfer(transfer: DataTransferLike | null | undefined): DropSnapshot {
	const entries: FsEntryLike[] = [];
	const loose: File[] = [];
	let unreadable = 0;
	const items = transfer?.items ?? null;
	let entrySupport = false;
	if (items) {
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (!item || item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue;
			entrySupport = true;
			const entry = item.webkitGetAsEntry();
			if (entry) {
				entries.push(entry);
				continue;
			}
			// No entry for this item: its file, when the browser hands one over.
			const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
			if (file) loose.push(file);
			else unreadable += 1;
		}
	}
	if (!entrySupport && transfer?.files) {
		for (let i = 0; i < transfer.files.length; i++) loose.push(transfer.files[i]);
	}
	return { entries, loose, unreadable };
}

/**
 * A path relative to the drop ('/a/b.md' → 'a/b.md').
 *
 * @param entry - The entry.
 * @returns Its path without the leading slash.
 */
function relativePath(entry: FsEntryLike): string {
	const full = typeof entry.fullPath === 'string' && entry.fullPath !== '' ? entry.fullPath : entry.name;
	return full.replace(/^\/+/, '');
}

/**
 * Compare names by code point (stable across locales).
 *
 * @param a - An entry.
 * @param b - Another.
 * @returns Sort order.
 */
function byName(a: { name: string }, b: { name: string }): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Read one file entry.
 *
 * @param entry - The entry.
 * @returns The file.
 */
function readFile(entry: FsEntryLike): Promise<File> {
	return new Promise((resolve, reject) => {
		if (typeof entry.file !== 'function') {
			reject(new Error('not a file'));
			return;
		}
		entry.file(resolve, reject);
	});
}

/**
 * Read every child of a directory entry (all batches).
 *
 * @param entry - The directory.
 * @returns Its children.
 */
async function readChildren(entry: FsEntryLike): Promise<FsEntryLike[]> {
	if (typeof entry.createReader !== 'function') return [];
	const reader = entry.createReader();
	const all: FsEntryLike[] = [];
	for (;;) {
		const batch = await new Promise<FsEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
		if (!Array.isArray(batch) || batch.length === 0) break;
		all.push(...batch);
		if (all.length > TRAVERSAL_SCAN_CAP * 4) break;
	}
	return all;
}

/**
 * Walk dropped entries into files with paths.
 *
 * @param entries - From {@link entriesFromDataTransfer}.
 * @param loose - Plain files (no entry support): each is stored under its name.
 * @param cap - Most files read (default {@link TRAVERSAL_SCAN_CAP}).
 * @returns The files, what was skipped, and what failed.
 */
export async function traverseEntries(entries: readonly FsEntryLike[], loose: readonly File[], cap = TRAVERSAL_SCAN_CAP): Promise<TraversalResult> {
	const result: TraversalResult = { files: [], skipped: [], truncated: false, errors: [] };
	let tooDeepReported = false;

	const visit = async (entry: FsEntryLike, depth: number): Promise<void> => {
		if (result.truncated) return;
		const path = relativePath(entry);
		if (isHiddenName(entry.name)) {
			result.skipped.push(path);
			return;
		}
		if (entry.isFile) {
			if (result.files.length >= cap) {
				result.truncated = true;
				return;
			}
			try {
				result.files.push({ file: await readFile(entry), relPath: path });
			} catch {
				result.errors.push(`Could not read ${path}.`);
			}
			return;
		}
		if (!entry.isDirectory) return;
		if (depth > MAX_TRAVERSAL_DEPTH) {
			if (!tooDeepReported) {
				result.errors.push(`Folder ${path} is nested more than ${MAX_TRAVERSAL_DEPTH} levels deep; its contents were not added.`);
				tooDeepReported = true;
			}
			return;
		}
		let children: FsEntryLike[];
		try {
			children = await readChildren(entry);
		} catch {
			result.errors.push(`Could not read the folder ${path}.`);
			return;
		}
		for (const child of [...children].sort(byName)) {
			await visit(child, depth + 1);
			if (result.truncated) return;
		}
	};

	for (const entry of [...entries].sort(byName)) {
		await visit(entry, 0);
		if (result.truncated) break;
	}
	for (const file of loose) {
		if (result.files.length >= cap) {
			result.truncated = true;
			break;
		}
		result.files.push({ file, relPath: file.name });
	}
	return result;
}

/**
 * Walk a drop taken with {@link entriesFromDataTransfer}, and say what could
 * not be read: items that gave neither an entry nor a file, or a drop that
 * yielded nothing at all.
 *
 * @param snapshot - The drop.
 * @param cap - Most files read (default {@link TRAVERSAL_SCAN_CAP}).
 * @returns The files, what was skipped, and the sentences for what failed.
 */
export async function traverseDrop(snapshot: DropSnapshot, cap = TRAVERSAL_SCAN_CAP): Promise<TraversalResult> {
	const result = await traverseEntries(snapshot.entries, snapshot.loose, cap);
	if (snapshot.unreadable > 0) result.errors.push(unreadableSentence(snapshot.unreadable));
	if (result.files.length === 0 && result.skipped.length === 0 && result.errors.length === 0) result.errors.push(DROP_NOTHING_READ);
	return result;
}

/**
 * Files from an `<input type="file">` (plain or `webkitdirectory`).
 *
 * @param list - The input's files.
 * @returns The files with their paths (the folder picker's webkitRelativePath when set), and skipped hidden paths.
 */
export function filesFromInput(list: ArrayLike<File> | null | undefined): { files: DroppedFile[]; skipped: string[] } {
	const files: DroppedFile[] = [];
	const skipped: string[] = [];
	if (!list) return { files, skipped };
	for (let i = 0; i < list.length; i++) {
		const file = list[i];
		const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
		const relPath = typeof relative === 'string' && relative !== '' ? relative : file.name;
		if (relPath.includes('/') && relPath.split('/').some((segment) => isHiddenName(segment))) {
			skipped.push(relPath);
			continue;
		}
		files.push({ file, relPath });
	}
	return { files, skipped };
}
