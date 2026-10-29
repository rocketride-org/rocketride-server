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
// FILESYSTEM TOOLKIT — generic file tools over a host-supplied workspace view
// =============================================================================

/**
 * The agent's file tools over a host-supplied workspace view. The host's backend
 * owns the namespace, path translation, change announcements and layout rules;
 * this file knows no layout beyond skipping the read-only .rocketride/ guides in
 * a whole-workspace search. A mutation of a path the user holds dirty asks first;
 * an edit or overwrite needs a read this run. Each change goes into the run's Undo
 * record (./undo.ts); reads show `«secret:<id>»` markers that writes put back
 * (./secretMarkers.ts).
 */

import { sha256Hex } from '../../vfs/hash';
import { ROCKETRIDE_ROOT, isReferencePath } from '../../vfs/referenceTree';
import { StaleVersionError, StaleWriteError } from '../../vfs/stagedFileSystem';
import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { SaveDroppedError, type EditorControl } from '../host';
import { AgentTool, AgentToolkit, RefusedError, type ToolStep } from '../tools';
import { replaceSpans, type ChoiceFn } from './common';
import { FileTracker } from './fileTracker';
import { SecretMarkers } from './secretMarkers';
import { UndoRecord } from './undo';

// =============================================================================
// CONSTANTS — caps and hygiene
// =============================================================================

const READ_DEFAULT_BYTES = 256 * 1024;
const READ_MAX_BYTES = 4 * 1024 * 1024;
/** Hard write cap in bytes — one whole-file write per call. */
const WRITE_MAX_BYTES = 4 * 1024 * 1024;

/** The writer identity every agent mutation carries, so the host can tell agent changes from the user's. */
export const AGENT_ORIGIN = 'agent';

/** search_files: most files visited per search. */
const SEARCH_MAX_FILES = 2000;
/** search_files: per-file content ceiling (longer content is skipped). */
const SEARCH_MAX_FILE_CHARS = 256 * 1024;
const SEARCH_READ_BATCH = 50;
/** search_files: default and hard caps on returned matches. */
const SEARCH_DEFAULT_RESULTS = 50;
const SEARCH_MAX_RESULTS = 200;

/** Directories never entered on search walks (platform-owned build trees). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);

/** Extensions treated as text for search (everything else is skipped). */
const TEXT_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'pipe', 'md', 'txt', 'css', 'html', 'svg', 'py', 'yaml', 'yml', 'toml', 'env', 'sh', 'cmd', 'sql', 'csv']);

/** Printable characters the platform store refuses in paths (client-side mirror). */
const INVALID_PRINTABLE_CHARS = /[*?<>|"]/;

/** C0 controls are checked by char code: a control-range regex trips eslint's no-control-regex. */
function hasInvalidPathChar(p: string): boolean {
	if (INVALID_PRINTABLE_CHARS.test(p)) return true;
	for (let i = 0; i < p.length; i += 1) {
		if (p.charCodeAt(i) < 0x20) return true;
	}
	return false;
}

/** The default group instructions — generic file-tool doctrine only. */
const FILESYSTEM_INSTRUCTIONS = `File tools operate on the workspace virtual filesystem. Paths are workspace-relative and always use forward slashes.
- Read a file before editing or overwriting it. edit_file and write_file refuse a file you have not read. write_file refuses a file that changed since you read it; edit_file then applies your anchor to the current content only when it still matches once. Either way, read the file again before your next change to it.
- Prefer edit_file (exact-anchor find/replace) for changes; write_file replaces a whole file.
- Reads see the user's unsaved editor buffers. Changing a file with unsaved changes asks the user first; if they keep their changes, the call is refused: ask them how to proceed instead of retrying.
- Truncated reads are always labeled; use offset/limit to window large files cheaply.`;

const UNSAVED_TITLE = 'Unsaved changes';

// =============================================================================
// PATH HYGIENE — generic validation, no layout knowledge
// =============================================================================

/**
 * Normalizes and validates an agent-supplied path. Layout rules (which
 * roots exist, what may be deleted) belong to the host's backend; this
 * layer only refuses what no backend could accept, with messages the LLM
 * can act on.
 *
 * @param allowRoot - Whether '' (the tree root) is acceptable.
 * @returns The canonical path ('' only when allowRoot).
 */
export function normalizePath(raw: unknown, allowRoot = false): string {
	// step: normalize separators and trim the edges
	const cleaned = String(raw ?? '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	if (!cleaned) {
		if (allowRoot) return '';
		throw new Error('A file or directory path is required.');
	}
	// step: refuse traversal and store-illegal characters up front
	if (hasInvalidPathChar(cleaned)) {
		throw new Error(`Path contains characters the store refuses: '${String(raw)}'`);
	}
	const segments = cleaned.split('/').filter((s) => s.length > 0);
	if (segments.some((s) => s === '.' || s === '..')) {
		throw new Error(`Path traversal is not allowed: '${String(raw)}'`);
	}
	return segments.join('/');
}

// =============================================================================
// UNSAVED CHANGES — asking the user before a change lands on their typing
// =============================================================================

/** How the toolkit asks about unsaved changes, and the editors that act on the answer. */
export interface UnsavedOptions {
	choose: ChoiceFn;
	editor: (path: string) => EditorControl | null;
}

/** `a`, `a and b`, or `a, b and c`. */
function listPaths(paths: string[]): string {
	return paths.length === 1 ? paths[0] : `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`;
}

function kept(dirty: string[]): string {
	return `The user kept their unsaved changes in ${listPaths(dirty)}. Ask them how to proceed; do not retry.`;
}

/** The question never showed, because another dialog was open: the user kept nothing. */
function unasked(dirty: string[]): string {
	return `The user was not asked about ${listPaths(dirty)} because another dialog was open. Try again after they close it.`;
}

/**
 * A call that changed nothing throws RefusedError, which the finish rule skips. One where a user
 * save landed or sent a write throws a plain Error: the file may have changed, so it needs its check.
 */
function refusal(message: string, changed: boolean): Error {
	return changed ? new Error(message) : new RefusedError(message);
}

// =============================================================================
// FILESYSTEM TOOLKIT
// =============================================================================

/** File tools over a host-supplied workspace view, plus the host's instructions for its tree. */
export class FilesystemTools extends AgentToolkit {
	readonly name = 'filesystem';
	readonly instructions: string;

	/** The host's virtual tree — all I/O goes through it. */
	private readonly vfs: IWorkspaceFileSystem;

	/** Each file this run read or changed: its version and hash then, and what the run did to it. */
	readonly tracker = new FileTracker();

	/** What this run's changes replaced and left, so Undo can put the files back. */
	readonly undo: UndoRecord;

	/** The secret values this run's reads hid, each with its marker; writes put them back. */
	readonly secrets = new SecretMarkers();

	private readonly afterSave?: (path: string) => Promise<string>;

	private readonly unsaved?: UnsavedOptions;

	/**
	 * @param vfs - The host's workspace view: the SAME instance its editors register
	 *   overlays on, so agent reads see unsaved buffers and the dirty guard protects them.
	 * @param instructions - Host guidance on what the tree holds.
	 * @param afterSave - Called with the canonical path after each save that worked;
	 *   its text is appended to the tool result.
	 * @param unsaved - How to ask about unsaved changes; without it a dirty path is refused.
	 */
	constructor(vfs: IWorkspaceFileSystem, instructions = '', afterSave?: (path: string) => Promise<string>, unsaved?: UnsavedOptions) {
		super();
		this.vfs = vfs;
		this.undo = new UndoRecord(vfs);
		this.afterSave = afterSave;
		this.unsaved = unsaved;
		// step: mechanics first, then the host's map of its own tree
		this.instructions = instructions.trim().length > 0 ? `${FILESYSTEM_INSTRUCTIONS}\n\n${instructions.trim()}` : FILESYSTEM_INSTRUCTIONS;
	}

	// ── Internals ────────────────────────────────────────────────────────

	/** The paths the user holds dirty at or under some paths (a folder move or delete takes its files along). */
	private dirtyUnder(paths: string[]): string[] {
		const all = [...this.vfs.dirtyPaths()];
		return [...new Set(paths.flatMap((path) => (this.vfs.isDirty(path) ? [path] : all.filter((p) => p.startsWith(`${path}/`)))))];
	}

	/** Refuses a mutation while the user holds a path dirty. Synchronous, so the caller's write in the same block leaves no gap for typing. */
	private refuseDirty(paths: string[], op: string, changed = false): void {
		const dirty = this.dirtyUnder(paths);
		if (dirty.length > 0) {
			throw refusal(`${op} refused: ${dirty[0]} has unsaved editor changes. Ask the user to save or discard them first.`, changed);
		}
	}

	/** Whether settleUnsaved can ask about every dirty path at or under some paths. */
	private canSettle(paths: string[]): boolean {
		const dirty = this.dirtyUnder(paths);
		return dirty.length === 0 || (this.unsaved !== undefined && dirty.every((p) => this.unsaved?.editor(p) != null));
	}

	/**
	 * Settles the user's unsaved changes before a mutation: their editors save or drop them, or the call is
	 * refused (always, with no way to ask or no editor). Returns null when nothing was dirty.
	 */
	private async settleUnsaved(paths: string[], op: string, action: string): Promise<{ choice: 'save' | 'discard'; dirty: string[] } | null> {
		const dirty = this.dirtyUnder(paths);
		if (dirty.length === 0) return null;
		const editors = dirty.map((p) => this.unsaved?.editor(p) ?? null);
		if (!this.unsaved || editors.includes(null)) this.refuseDirty(paths, op);
		const message = dirty.length === 1 && dirty[0] === paths[0] ? `The agent wants to ${action}, which has unsaved changes.` : `The agent wants to ${action}, which takes along unsaved changes in ${listPaths(dirty)}.`;
		const choice = await (this.unsaved as UnsavedOptions).choose(UNSAVED_TITLE, message);
		if (choice === 'keep') throw new RefusedError(kept(dirty));
		if (choice === 'unasked') throw new RefusedError(unasked(dirty));
		const versions = dirty.map((p) => this.vfs.version(p));
		let stored = false;
		try {
			for (const editor of editors as EditorControl[]) {
				if (choice === 'save') await editor.save(() => (stored = true));
				else await editor.discard();
			}
		} catch (err) {
			// step: the view counts a write when it is called. A failed save that moved a version may still have landed; one that moved none sent
			// nothing. A save that joined a Ctrl+S already on its way moved none either, so a save that landed counts on its own
			const sent = stored || dirty.some((p, i) => this.vfs.version(p) !== versions[i]);
			if (err instanceof SaveDroppedError) throw refusal(`${op} refused: the unsaved changes in ${listPaths(dirty)} were not saved. While the save waited its turn, the user reloaded, discarded or closed them, or saved newer changes over them. Read ${listPaths(dirty)} again, then ask the user how to proceed.`, sent);
			throw refusal(`${op} refused: ${choice === 'save' ? 'saving' : 'discarding'} the unsaved changes in ${listPaths(dirty)} failed (${err instanceof Error ? err.message : String(err)}). Ask the user how to proceed; do not retry.`, sent);
		}
		return { choice, dirty };
	}

	/** Refuses an edit or overwrite of a file the agent has not read this run. */
	private requireRead(path: string, op: string): { readVersion?: number; readHash: string } {
		const seen = this.tracker.get(path);
		if (seen?.readHash === undefined) {
			throw new RefusedError(`${op} refused: read ${path} first — edits must start from its current content.`);
		}
		return { readVersion: seen.readVersion, readHash: seen.readHash };
	}

	/** The refusal for a file that changed since the run last saw it; `saved` when the user's save in this call changed it. */
	private staleRefusal(op: string, path: string, seen: number | undefined, now: number, saved = false): Error {
		const writer = this.vfs.lastWriter(path);
		const versions = seen !== undefined && seen !== now ? ` (version ${seen}, now ${now}${writer ? `; last writer: ${writer}` : ''})` : '';
		const why = saved ? `the user saved their unsaved changes in ${path} first, so it changed since you read it` : `${path} changed since you read it`;
		return refusal(`${op} refused: ${why}${versions}. Read it again, then redo the change from the current content.`, saved);
	}

	/**
	 * Writes a file at the version it was computed from; the dirty and version checks share one synchronous
	 * block. If the server's copy moved on, the cache is dropped so the next read gets it. `before` is the
	 * content at `expect` (null for no file), for Undo.
	 */
	private async writeAt(path: string, content: string, expect: number, before: string | null, op: string, existed: boolean, saved = false): Promise<number> {
		this.refuseDirty([path], op, saved);
		const writing = this.vfs.write(path, content, AGENT_ORIGIN, expect);
		const mine = this.vfs.version(path);
		try {
			await writing;
		} catch (err) {
			if (err instanceof StaleVersionError) throw this.staleRefusal(op, path, err.expected, err.actual, saved);
			if (err instanceof StaleWriteError) {
				this.vfs.invalidate(path);
				throw refusal(`${op} refused: ${path} changed on the server since you read it (another tab or a teammate). Read it again, then redo the change from the current content.`, saved);
			}
			// step: the write may have landed in part, so Undo cannot say what to put back
			this.undo.failed(path, before, expect);
			throw err;
		}
		this.tracker.wrote(path, mine, await sha256Hex(content), existed);
		await this.undo.landed(path, before, expect, { version: mine, content });
		return mine;
	}

	/**
	 * Undo puts back text only. The store decodes every file as UTF-8, so a binary file still reads as a
	 * string (U+FFFD or NUL characters) that would not write back as its bytes; null marks it, and the turn
	 * cannot be undone.
	 */
	private undoText(content: unknown): string | null {
		if (typeof content === 'string' && !content.includes('\0') && !content.includes('\uFFFD')) return content;
		this.undo.unavailable('this turn changed a file that is not text');
		return null;
	}

	/** The entry kind of a path from `vfs.stat`, which forces no tree load. */
	private async entryType(path: string): Promise<'file' | 'dir' | null> {
		// step: stat() asks the backend when the cache can't; scoped/staged views don't promise to fill the cache
		return this.vfs.stat(path);
	}

	/** The host's note for a save that worked; a throwing hook adds nothing, since the save already happened. */
	private async noteAfterSave(path: string): Promise<string> {
		if (!this.afterSave) return '';
		try {
			return await this.afterSave(path);
		} catch {
			return '';
		}
	}

	/**
	 * A file's text as the model sees it: secret values as markers, plus the read's note. Guides under
	 * .rocketride/ are server text no tool can change, so they show as served. Every tool result still
	 * passes through redactText.
	 */
	private shown(path: string, text: string): { text: string; note: string } {
		return isReferencePath(path) ? { text, note: '' } : this.secrets.hide(path, text);
	}

	/**
	 * Collects searchable files under a directory ('' for the root) within the skip list, text-extension
	 * filter and file budget. A whole-workspace search skips the root's .rocketride/ guides.
	 */
	private async collectSearchFiles(dir: string, out: string[]): Promise<void> {
		if (out.length >= SEARCH_MAX_FILES) return;
		const entries = await this.vfs.list(dir);
		for (const entry of entries) {
			if (out.length >= SEARCH_MAX_FILES) return;
			const path = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.type === 'dir') {
				if (SKIP_DIRS.has(entry.name) || (dir === '' && entry.name === ROCKETRIDE_ROOT)) continue;
				await this.collectSearchFiles(path, out);
			} else {
				const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase() : '';
				if (TEXT_EXTENSIONS.has(ext)) out.push(path);
			}
		}
	}

	// ── Executors ────────────────────────────────────────────────────────

	/**
	 * read_file: cached whole-file read, sliced locally. Line windows cost
	 * nothing after the first read; overlays win over the cache so unsaved
	 * buffers are what the agent sees.
	 *
	 * @param maxBytes - Optional byte cap (clamped to READ_MAX_BYTES).
	 * @param offset - Optional 1-based first line of a partial read.
	 * @param limit - Optional line count of a partial read.
	 * @returns The content or window, truncation always labeled.
	 */
	private async readFile(rawPath: unknown, maxBytes?: number, offset?: number, limit?: number): Promise<string> {
		const path = normalizePath(rawPath);
		const cap = Math.min(Math.max(1, maxBytes ?? READ_DEFAULT_BYTES), READ_MAX_BYTES);
		// step: under unsaved typing, also the stored copy a delete is based on. Both reads start together, so no save lands between them
		const dirty = this.vfs.isDirty(path);
		const [read, stored] = await Promise.all([this.vfs.readVersioned(path), dirty ? this.vfs.readVersioned(path, { stored: true }).catch(() => null) : null]);
		let text = String(read.content);
		// step: record the whole file's version and hash, windowed or not — they are what edits are checked against
		const hash = await sha256Hex(text);
		this.tracker.read(path, read.version, hash, stored ? await sha256Hex(String(stored.content)) : hash);
		// step: hide secret values before any window — a window could cut one in half, and half a key no longer matches
		const hidden = this.shown(path, text);
		text = hidden.text;
		const note = hidden.note ? `\n[${hidden.note}]` : '';

		// step: line window first — the usual partial-read path
		let header = '';
		if (offset !== undefined || limit !== undefined) {
			const lines = text.split('\n');
			const start = Math.max(1, Math.floor(offset ?? 1));
			const count = Math.max(1, Math.floor(limit ?? lines.length));
			const slice = lines.slice(start - 1, start - 1 + count);
			if (slice.length === 0) return `[EMPTY WINDOW: ${path} has ${lines.length} lines; requested from line ${start}]`;
			header = `[Lines ${start}-${start - 1 + slice.length} of ${lines.length} in ${path}]\n`;
			text = slice.join('\n');
		}

		// step: cap by UTF-8 byte length — the cap bounds payload, not chars
		const bytes = new TextEncoder().encode(text);
		if (bytes.length <= cap) return header + text + note;
		const truncated = new TextDecoder().decode(bytes.slice(0, cap));
		return `${header}${truncated}\n[TRUNCATED: showing first ${cap} of ${bytes.length} bytes — narrow with offset/limit or raise maxBytes]${note}`;
	}

	/**
	 * write_file: whole-file replacement through the VFS. A new file needs no
	 * read; replacing an existing one follows the read-before-edit rule, and
	 * is refused when the file changed since the run last saw it.
	 */
	private async writeFile(rawPath: unknown, content: string): Promise<string> {
		const path = normalizePath(rawPath);
		// step: the model writes markers; the file gets the values they stand for
		content = this.secrets.reveal(content, 'write_file');
		const size = new TextEncoder().encode(content).length;
		if (size > WRITE_MAX_BYTES) {
			throw new Error(`write_file caps at ${WRITE_MAX_BYTES} bytes per file (got ${size}).`);
		}
		// step: a new file needs no read; replacing an existing one must start from what was read
		let expect = this.vfs.version(path);
		const existed = (await this.entryType(path)) === 'file';
		const seen = existed ? this.requireRead(path, 'write_file') : undefined;
		// step: after Save mine first the file changed in this call, so a refusal still counts as a change (see refusal())
		const saved = (await this.settleUnsaved([path], 'write_file', `change ${path}`))?.choice === 'save';
		let before: string | null = null;
		if (seen) {
			const current = await this.vfs.readVersioned(path);
			if (seen.readVersion !== current.version || seen.readHash !== (await sha256Hex(String(current.content)))) throw this.staleRefusal('write_file', path, seen.readVersion, current.version, saved);
			expect = current.version;
			before = this.undoText(current.content);
		}
		await this.writeAt(path, content, expect, before, 'write_file', existed, saved);
		return `Wrote ${size} bytes to ${path}.${await this.noteAfterSave(path)}`;
	}

	/**
	 * edit_file: anchored find/replace against the cached content — the
	 * partial-update surface. Refused when the file was not read this run,
	 * and when the anchor is missing or ambiguous, with recovery guidance in
	 * the error.
	 *
	 * @param oldString - Exact text to replace.
	 * @param replaceAll - Replace every occurrence instead of requiring uniqueness.
	 * @returns A confirmation naming the occurrence count.
	 */
	private async editFile(rawPath: unknown, oldString: string, newString: string, replaceAll: boolean): Promise<string> {
		const path = normalizePath(rawPath);
		// step: a path the view refuses, such as the read-only .rocketride/, is refused before any anchor is matched
		this.vfs.assertWritable?.(path);
		if (!oldString) throw new Error('edit_file needs a non-empty oldString anchor.');
		if (oldString === newString) throw new Error('oldString and newString are identical — nothing to change.');
		// step: refuse a marker this run did not make; the replacement's markers become the values they stand for
		this.secrets.reveal(oldString, 'edit_file');
		const replacement = this.secrets.reveal(newString, 'edit_file');
		const seen = this.requireRead(path, 'edit_file');
		const choice = (await this.settleUnsaved([path], 'edit_file', `change ${path}`))?.choice ?? null;
		const saved = choice === 'save';
		const { content, version } = await this.vfs.readVersioned(path);
		const text = String(content);
		const stale = seen.readVersion !== version || seen.readHash !== (await sha256Hex(text));

		// step: match the anchor against the file as the model sees it, markers in place, so an anchor cannot test a guess at a hidden value
		const found = this.secrets.anchors(path, text, oldString);

		// step: count anchors — zero is a miss, several without replaceAll is ambiguous. On a
		// file that changed since the read, only an anchor that names one place still applies
		const occurrences = found.length;
		if (stale && occurrences !== 1) throw this.staleRefusal('edit_file', path, seen.readVersion, version, saved);
		if (occurrences === 0) {
			throw new Error(`edit_file: oldString not found in ${path}. Re-read the file — the anchor must match exactly, including whitespace.`);
		}
		if (occurrences > 1 && !replaceAll) {
			throw new Error(`edit_file: oldString matches ${occurrences} places in ${path}. Extend the anchor to make it unique, or pass replaceAll: true.`);
		}

		// step: splice the replacement in as written, so '$&' and '$$' in newString stay literal
		const updated = replaceSpans(text, replaceAll ? found : found.slice(0, 1), () => replacement);
		const size = new TextEncoder().encode(updated).length;
		if (size > WRITE_MAX_BYTES) {
			throw new Error(`edit_file result exceeds the ${WRITE_MAX_BYTES}-byte file cap.`);
		}
		const writer = this.vfs.lastWriter(path);
		await this.writeAt(path, updated, version, this.undoText(content), 'edit_file', true, saved);
		const note = stale ? ` ${this.appliedNote(choice, writer, path)}` : '';
		return `Replaced ${occurrences} occurrence(s) in ${path}.${note}${await this.noteAfterSave(path)}`;
	}

	/** What an edit result adds when the file had changed since the read and the anchor still matched once. */
	private appliedNote(choice: 'save' | 'discard' | null, writer: string | undefined, path: string): string {
		if (choice === 'save') return `The user saved their unsaved changes first; your anchor still matched once in the saved text, so the edit was applied on top of it. Read ${path} again before further edits.`;
		if (choice === 'discard') return `The user discarded their unsaved changes; your anchor still matched once in the stored file, so the edit was applied there. Read ${path} again before further edits.`;
		return `The file had changed since you read it${writer ? ` (last writer: ${writer})` : ''}; your anchor still matched once, so the edit was applied to the current content. Read it again before further edits.`;
	}

	/**
	 * list_directory: one directory's entries from the cached inventory.
	 *
	 * @param rawPath - Agent-supplied directory path ('' for the root).
	 * @returns JSON entries [{name, type}].
	 */
	private async listDirectory(rawPath: unknown): Promise<string> {
		const entries = await this.vfs.list(normalizePath(rawPath, true));
		return JSON.stringify(entries, null, 1);
	}

	/**
	 * stat_file: existence and kind from the cached inventory.
	 *
	 * @returns JSON {exists, type?}.
	 */
	private async statFile(rawPath: unknown): Promise<string> {
		const path = normalizePath(rawPath);
		const type = await this.entryType(path);
		return JSON.stringify(type === null ? { exists: false } : { exists: true, type });
	}

	/**
	 * search_files: literal (default) or regex content search, walking and
	 * reading through the VFS so results include unsaved buffers and warm
	 * the cache as they go.
	 *
	 * @param pattern - The text or regex to find.
	 * @param rawPath - Optional directory to search under, or one file to search ('' = whole tree).
	 * @param isRegex - Treat pattern as a JavaScript regular expression.
	 * @param maxResults - Result cap (clamped to SEARCH_MAX_RESULTS).
	 * @returns Matches as path:line:text rows, or a no-match message.
	 */
	private async searchFiles(pattern: string, rawPath?: unknown, isRegex?: boolean, maxResults?: number): Promise<string> {
		if (!pattern) throw new Error('search_files needs a pattern.');
		const cap = Math.min(Math.max(1, maxResults ?? SEARCH_DEFAULT_RESULTS), SEARCH_MAX_RESULTS);
		// step: compile once — literal searches are case-insensitive substring
		let matcher: (line: string) => boolean;
		if (isRegex) {
			let re: RegExp;
			try {
				re = new RegExp(pattern);
			} catch (err) {
				throw new Error(`Invalid regular expression: ${(err as Error).message}`);
			}
			matcher = (line) => re.test(line);
		} else {
			const needle = pattern.toLowerCase();
			matcher = (line) => line.toLowerCase().includes(needle);
		}

		// step: bounded walk, then read through the cache; a file path searches that one file
		const root = normalizePath(rawPath ?? '', true);
		const files: string[] = [];
		if (root && (await this.entryType(root)) === 'file') files.push(root);
		else await this.collectSearchFiles(root, files);
		const contents: Array<[file: string, content: string]> = [];
		for (let i = 0; i < files.length; i += SEARCH_READ_BATCH) {
			// step: one batched read per chunk — unreadable files come back omitted
			const batch = files.slice(i, i + SEARCH_READ_BATCH);
			const read = await this.vfs.readMany(batch);
			for (const file of batch) {
				const raw = Object.hasOwn(read, file) ? read[file] : undefined;
				if (raw !== undefined && String(raw).length <= SEARCH_MAX_FILE_CHARS) contents.push([file, String(raw)]);
			}
		}

		// step: hide every file once before scanning any — a value that only a later file names as a secret must not show in an earlier one
		for (const [file, content] of contents) this.shown(file, content);
		const matches: string[] = [];
		for (const [file, content] of contents) {
			if (matches.length >= cap) break;
			// step: match and clip the text with its secrets hidden, so no line shows one and no pattern can probe one
			const lines = this.shown(file, content).text.split('\n');
			for (let n = 0; n < lines.length && matches.length < cap; n++) {
				if (matcher(lines[n])) matches.push(`${file}:${n + 1}: ${lines[n].trim().slice(0, 200)}`);
			}
		}

		if (matches.length === 0) return `No matches for '${pattern}' in ${files.length} files searched.`;
		const header = matches.length >= cap ? `Showing first ${cap} matches (cap reached — narrow the pattern or path):` : `${matches.length} match(es):`;
		return `${header}\n${matches.join('\n')}`;
	}

	/**
	 * rename: move within the tree; the backend enforces any structural
	 * rules about what may move where.
	 */
	private async rename(rawOld: unknown, rawNew: unknown): Promise<string> {
		const oldPath = normalizePath(rawOld);
		const newPath = normalizePath(rawNew);
		// step: both ends — the target's dirty buffer would be overwritten too
		const settled = await this.settleUnsaved([oldPath, newPath], 'rename', `move ${oldPath} to ${newPath}`);
		// step: the user's text landed, so the move the agent planned is out of date
		if (settled?.choice === 'save') throw new Error(`rename refused: the user saved their unsaved changes in ${listPaths(settled.dirty)} first, so the files changed since you planned the move. Read ${listPaths(settled.dirty)} again, then ask the user whether to move ${oldPath} to ${newPath}.`);
		const ends = await this.undoEnds(oldPath, newPath);
		this.refuseDirty([oldPath, newPath], 'rename');
		const from = { old: this.vfs.version(oldPath), new: this.vfs.version(newPath) };
		const moving = this.vfs.rename(oldPath, newPath, AGENT_ORIGIN);
		const left = { old: this.vfs.version(oldPath), new: this.vfs.version(newPath) };
		try {
			await moving;
		} catch (err) {
			// step: a rename the view counted may have moved the file in part
			if (ends && left.old !== from.old) {
				this.undo.failed(oldPath, ends.old.content, from.old);
				this.undo.failed(newPath, ends.new.content, from.new);
			}
			throw err;
		}
		this.tracker.renamed(oldPath, newPath, (p) => this.vfs.version(p));
		if (ends) {
			await this.undo.landed(oldPath, ends.old.content, from.old, { version: left.old, content: null }, ends.old.version);
			await this.undo.landed(newPath, ends.new.content, from.new, { version: left.new, content: ends.old.content }, ends.new.version);
		}
		return `Renamed ${oldPath} to ${newPath}.`;
	}

	/**
	 * What both ends of a rename hold before it, for Undo. A folder's move
	 * cannot be undone, and neither can a move onto a folder.
	 *
	 * @returns Each end's content (null for no file) and the version it was read at; null when Undo cannot cover the rename.
	 */
	private async undoEnds(oldPath: string, newPath: string): Promise<{ old: { content: string; version: number }; new: { content: string | null; version: number } } | null> {
		const [fromType, toType] = [await this.entryType(oldPath), await this.entryType(newPath)];
		if (fromType === 'dir' || toType === 'dir') this.undo.unavailable('this turn moved a folder');
		if (fromType !== 'file' || toType === 'dir') return null;
		const source = await this.vfs.readVersioned(oldPath, { stored: true });
		const target = toType === 'file' ? await this.vfs.readVersioned(newPath, { stored: true }) : { content: null, version: this.vfs.version(newPath) };
		const content = this.undoText(source.content);
		const replaced = target.content === null ? null : this.undoText(target.content);
		if (content === null || (target.content !== null && replaced === null)) return null;
		return { old: { content, version: source.version }, new: { content: replaced, version: target.version } };
	}

	private async createDirectory(rawPath: unknown): Promise<string> {
		const path = normalizePath(rawPath);
		await this.vfs.mkdir(path, AGENT_ORIGIN);
		return `Created directory ${path}.`;
	}

	/**
	 * delete_file, made ready. The act names the target for the approval list, since a delete does not go
	 * through the client. The root and paths the view refuses are refused before the user is asked; unsaved
	 * changes are asked about in the run, after the card, because a prepare only reads.
	 * @param recursive - Required true to remove a directory and its contents.
	 */
	private async prepareDelete(rawPath: unknown, recursive: boolean): Promise<ToolStep> {
		const path = normalizePath(rawPath);
		this.vfs.assertWritable?.(path);
		const type = await this.entryType(path);
		if (type === null) throw new Error(`No such path: ${path}`);
		if (type === 'dir' && !recursive) {
			throw new Error(`${path} is a directory — pass recursive: true to delete it and its contents.`);
		}
		if (!this.canSettle([path])) this.refuseDirty([path], 'delete_file');
		return {
			act: { name: 'delete_file', params: [path, type] },
			run: () => this.undo.track(this.deleteNow(path, type)),
		};
	}

	/**
	 * delete_file's run, once its act is let through.
	 *
	 * @param type - What the prepare found there.
	 */
	private async deleteNow(path: string, type: 'file' | 'dir'): Promise<string> {
		// step: the user may have typed while the card waited
		const settled = await this.settleUnsaved([path], 'delete_file', `delete ${path}`);
		// step: the user's text landed, so the delete the agent planned is out of date
		if (settled?.choice === 'save') throw new Error(`delete_file refused: the user saved their unsaved changes in ${listPaths(settled.dirty)} first, so ${path} changed since you decided to delete it. Read it again, then ask the user whether to delete it.`);
		// step: what Undo needs: the file's content before the delete; a folder's delete cannot be undone
		if (type === 'dir') this.undo.unavailable('this turn deleted a folder');
		const read = type === 'file' ? await this.deletedContent(path) : null;
		const before = read ? this.undoText(read.content) : null;
		this.refuseDirty([path], 'delete_file');
		// step: the files a folder holds go with it, read or not, so each is a deletion of its own
		const held = type === 'dir' ? this.vfs.listEntries().flatMap((entry) => (entry.type === 'file' && entry.path.startsWith(`${path}/`) ? [entry.path] : [])) : [];
		const from = this.vfs.version(path);
		const deleting = this.vfs.delete(path, AGENT_ORIGIN, this.tracker.get(path)?.storedHash);
		const mine = this.vfs.version(path);
		try {
			await deleting;
		} catch (err) {
			if (err instanceof StaleWriteError) throw new RefusedError(`delete_file refused: ${path} changed since you read it. Read it again, then ask the user whether to delete it.`);
			// step: a delete the view counted may have landed
			if (read && before !== null && mine !== from) this.undo.failed(path, before, from);
			throw err;
		}
		this.tracker.deleted(path, mine, held);
		if (read && before !== null) await this.undo.landed(path, before, from, { version: mine, content: null }, read.version);
		return `Deleted ${path}.`;
	}

	/**
	 * What a delete of a file replaces, for Undo: the staged content while the change is staged, otherwise
	 * the server's copy read afresh, since the cache may predate a teammate's change.
	 */
	private async deletedContent(path: string): Promise<{ content: unknown; version: number }> {
		const staged = this.vfs.changedPaths?.().has(path) === true;
		// step: drop the cached copy, so the read takes the server's
		if (!staged) this.vfs.invalidate(path);
		return this.vfs.readVersioned(path, { stored: true });
	}

	// ── Toolkit surface ──────────────────────────────────────────────────

	/**
	 * The paths whose content this toolkit saw this run, read or written.
	 *
	 * @returns Canonical paths, in the order first seen.
	 */
	pathsSeen(): string[] {
		return this.tracker.seen();
	}

	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'read_file',
				description: `Read one file as UTF-8 text, or a line window of it via offset/limit (1-based; repeated windows on the same file are cheap — the content is cached). Reads see unsaved editor buffers. Truncation is always labeled. Default cap ${READ_DEFAULT_BYTES} bytes, maximum ${READ_MAX_BYTES}.`,
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative file path' },
						offset: { type: 'number', description: 'Optional 1-based first line of a partial read' },
						limit: { type: 'number', description: 'Optional number of lines to return' },
						maxBytes: { type: 'number', description: `Optional read cap in bytes (1..${READ_MAX_BYTES})` },
					},
					required: ['path'],
					additionalProperties: false,
				},
				execute: (a) => this.readFile(a.path, a.maxBytes === undefined ? undefined : Number(a.maxBytes), a.offset === undefined ? undefined : Number(a.offset), a.limit === undefined ? undefined : Number(a.limit)),
			}),
			new AgentTool({
				name: 'list_directory',
				description: "List one directory's entries ('' lists the workspace root). Entries carry name and type.",
				parameters: {
					type: 'object',
					properties: { path: { type: 'string', description: "Workspace-relative directory path; '' for the root" } },
					additionalProperties: false,
				},
				execute: (a) => this.listDirectory(a.path ?? ''),
			}),
			new AgentTool({
				name: 'stat_file',
				description: 'Whether a path exists and whether it is a file or a directory.',
				parameters: {
					type: 'object',
					properties: { path: { type: 'string', description: 'Workspace-relative path' } },
					required: ['path'],
					additionalProperties: false,
				},
				execute: (a) => this.statFile(a.path),
			}),
			new AgentTool({
				name: 'search_files',
				description: `Search file contents across the workspace (or one subtree or file). Literal case-insensitive by default; set isRegex for a JavaScript regex. Returns path:line:text matches, capped at ${SEARCH_MAX_RESULTS}. Build trees are skipped.`,
				parameters: {
					type: 'object',
					properties: {
						pattern: { type: 'string', description: 'Text or regex to find' },
						path: { type: 'string', description: 'Optional directory to search under, or one file to search; omit for the whole workspace' },
						isRegex: { type: 'boolean', description: 'Treat pattern as a regular expression' },
						maxResults: { type: 'number', description: `Match cap (default ${SEARCH_DEFAULT_RESULTS}, max ${SEARCH_MAX_RESULTS})` },
					},
					required: ['pattern'],
					additionalProperties: false,
				},
				execute: (a) => this.searchFiles(String(a.pattern), a.path, a.isRegex === true, a.maxResults === undefined ? undefined : Number(a.maxResults)),
			}),
			new AgentTool({
				name: 'edit_file',
				description: 'PREFERRED way to change an existing file: replace an exact text anchor. oldString must match the file exactly (including whitespace) and be unique unless replaceAll is true. Refused unless you read the file this run. If the file changed since, the edit applies only when oldString matches exactly one place in the current content. A file with unsaved editor changes asks the user first.',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative path to edit' },
						oldString: { type: 'string', description: 'Exact existing text to replace' },
						newString: { type: 'string', description: 'The replacement text' },
						replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique anchor' },
					},
					required: ['path', 'oldString', 'newString'],
					additionalProperties: false,
				},
				execute: (a) => this.undo.track(this.editFile(a.path, String(a.oldString), String(a.newString), a.replaceAll === true)),
			}),
			new AgentTool({
				name: 'write_file',
				description: `Create a file or replace one COMPLETELY with new UTF-8 content (for targeted changes use edit_file instead). Creates missing parent directories. Cap ${WRITE_MAX_BYTES} bytes. Replacing an existing file is refused unless you read it this run and it has not changed since; a new file needs no read. A file with unsaved editor changes asks the user first.`,
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative path to write' },
						content: { type: 'string', description: 'The complete new file content' },
					},
					required: ['path', 'content'],
					additionalProperties: false,
				},
				execute: (a) => this.undo.track(this.writeFile(a.path, String(a.content))),
			}),
			new AgentTool({
				name: 'rename',
				description: 'Move or rename a file or directory.',
				parameters: {
					type: 'object',
					properties: {
						oldPath: { type: 'string', description: 'Current workspace-relative path' },
						newPath: { type: 'string', description: 'New workspace-relative path' },
					},
					required: ['oldPath', 'newPath'],
					additionalProperties: false,
				},
				execute: (a) => this.undo.track(this.rename(a.oldPath, a.newPath)),
			}),
			new AgentTool({
				name: 'create_directory',
				description: 'Create a directory (parents included).',
				parameters: {
					type: 'object',
					properties: { path: { type: 'string', description: 'Workspace-relative directory path to create' } },
					required: ['path'],
					additionalProperties: false,
				},
				execute: (a) => this.createDirectory(a.path),
			}),
			new AgentTool({
				name: 'delete_file',
				description: 'Delete a file, or a directory with recursive: true.',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative path to delete' },
						recursive: { type: 'boolean', description: 'Required true to delete a directory and its contents' },
					},
					required: ['path'],
					additionalProperties: false,
				},
				prepare: (a) => this.prepareDelete(a.path, a.recursive === true),
			}),
		];
	}
}
