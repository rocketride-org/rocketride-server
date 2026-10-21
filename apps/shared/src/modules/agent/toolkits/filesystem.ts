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
 * The agent's filesystem toolkit, host-agnostic by construction. The HOST
 * creates it with:
 *
 *   - the workspace view (IWorkspaceFileSystem) the agent works on (the host's
 *     backend defines the namespace, performs any path translation to real
 *     storage, announces changes, and enforces structural rules such as
 *     protected roots), and
 *   - the instructions that teach the LLM what that tree contains and how
 *     to work in it (layout, entity kinds, conventions).
 *
 * This file knows NOTHING about any particular workspace layout. What it
 * provides: whole-and-partial reads served from the cache, anchored
 * edit_file updates, dirty-overlay protection (reads see unsaved editor
 * buffers; mutations refuse paths the user holds dirty), read-before-edit
 * (an edit or overwrite is refused unless the file was read this run and has
 * not changed since), content search, and generic path hygiene (traversal
 * and store-illegal characters are refused here with LLM-readable errors —
 * backends still validate again).
 *
 * Tool results are strings fed straight back to the LLM; structured
 * results are JSON.
 */

import { sha256Hex } from '../../vfs/hash';
import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { AgentTool, AgentToolkit } from '../tools';

// =============================================================================
// CONSTANTS — caps and hygiene
// =============================================================================

/** Default read cap in bytes. */
const READ_DEFAULT_BYTES = 256 * 1024;
/** Hard read cap in bytes. */
const READ_MAX_BYTES = 4 * 1024 * 1024;
/** Hard write cap in bytes — one whole-file write per call. */
const WRITE_MAX_BYTES = 4 * 1024 * 1024;

/** The writer identity every agent mutation carries, so the host can tell agent changes from the user's. */
export const AGENT_ORIGIN = 'agent';

/** search_files: most files visited per search. */
const SEARCH_MAX_FILES = 2000;
/** search_files: per-file content ceiling (longer content is skipped). */
const SEARCH_MAX_FILE_CHARS = 256 * 1024;
/** search_files: files fetched per batched read. */
const SEARCH_READ_BATCH = 50;
/** search_files: default and hard caps on returned matches. */
const SEARCH_DEFAULT_RESULTS = 50;
const SEARCH_MAX_RESULTS = 200;

/** Directories never entered on search walks (platform-owned build trees). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);

/** Extensions treated as text for search (everything else is skipped). */
const TEXT_EXTENSIONS = new Set([
	'ts', 'tsx', 'js', 'jsx', 'json', 'pipe', 'md', 'txt', 'css', 'html', 'svg',
	'py', 'yaml', 'yml', 'toml', 'env', 'sh', 'cmd', 'sql', 'csv',
]);

/** Printable characters the platform store refuses in paths (client-side mirror). */
const INVALID_PRINTABLE_CHARS = /[*?<>|"]/;

/**
 * Whether a path holds a store-illegal character. C0 controls are checked by
 * char code — a control range inside a regex trips eslint's no-control-regex.
 *
 * @param p - The cleaned path.
 * @returns True when the store would refuse it.
 */
function hasInvalidPathChar(p: string): boolean {
	if (INVALID_PRINTABLE_CHARS.test(p)) return true;
	for (let i = 0; i < p.length; i += 1) {
		if (p.charCodeAt(i) < 0x20) return true;
	}
	return false;
}

/** The default group instructions — generic file-tool doctrine only. */
const FILESYSTEM_INSTRUCTIONS = `File tools operate on the workspace virtual filesystem. Paths are workspace-relative and always use forward slashes.
- Read a file before editing or overwriting it. edit_file and write_file refuse a file you have not read, or one that changed since you read it; read it again, then redo the edit.
- Prefer edit_file (exact-anchor find/replace) for changes; write_file replaces a whole file.
- Reads see the user's unsaved editor buffers; mutations are refused while the user has unsaved changes to the file - relay that to the user instead of retrying.
- Truncated reads are always labeled; use offset/limit to window large files cheaply.`;

// =============================================================================
// PATH HYGIENE — generic validation, no layout knowledge
// =============================================================================

/**
 * Normalizes and validates an agent-supplied path. Layout rules (which
 * roots exist, what may be deleted) belong to the host's backend; this
 * layer only refuses what no backend could accept, with messages the LLM
 * can act on.
 *
 * @param raw - The path exactly as the LLM supplied it.
 * @param allowRoot - Whether '' (the tree root) is acceptable.
 * @returns The canonical path ('' only when allowRoot).
 */
export function normalizePath(raw: unknown, allowRoot = false): string {
	// step: normalize separators and trim the edges
	const cleaned = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
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
// FILESYSTEM TOOLKIT
// =============================================================================

/**
 * Generic file tools over a host-supplied workspace view. The host passes the
 * instructions that describe ITS tree; they are appended to the built-in
 * file-tool doctrine so the LLM gets both the mechanics and the map.
 */
export class FilesystemTools extends AgentToolkit {
	readonly name = 'filesystem';
	readonly instructions: string;

	/** The host's virtual tree — all I/O goes through it. */
	private readonly vfs: IWorkspaceFileSystem;

	/** SHA-256 of each file's full content as this run last read or wrote it, by path. */
	private readonly readHashes = new Map<string, string>();

	/** The host's after-save hook, if any. */
	private readonly afterSave?: (path: string) => Promise<string>;

	/**
	 * Builds the toolkit for one agent.
	 *
	 * @param vfs - The host's workspace view. Pass the SAME instance the host's
	 *   editors register overlays on, so agent reads see unsaved buffers
	 *   and the dirty guard protects them.
	 * @param instructions - Host guidance for the LLM: what the tree
	 *   contains, layout conventions, entity anatomy. Appended to the
	 *   generic file-tool doctrine.
	 * @param afterSave - Optional host hook, called with the canonical path
	 *   after each write_file or edit_file save that worked; the text it
	 *   returns is appended to the tool result. What it does with the path is
	 *   the host's business: this toolkit stays layout-agnostic.
	 */
	constructor(vfs: IWorkspaceFileSystem, instructions = '', afterSave?: (path: string) => Promise<string>) {
		super();
		this.vfs = vfs;
		this.afterSave = afterSave;
		// step: mechanics first, then the host's map of its own tree
		this.instructions = instructions.trim().length > 0
			? `${FILESYSTEM_INSTRUCTIONS}\n\n${instructions.trim()}`
			: FILESYSTEM_INSTRUCTIONS;
	}

	// ── Internals ────────────────────────────────────────────────────────

	/**
	 * Refuses mutations against a path the user holds dirty in an editor —
	 * the agent must never silently clobber unsaved work. A tree guard: the
	 * path itself or any dirty file under it (a directory move or delete
	 * takes its files along) refuses the call.
	 *
	 * @param path - Canonical path.
	 * @param op - Tool name for the refusal message.
	 */
	private guardDirty(path: string, op: string): void {
		const dirtyPath = this.vfs.isDirty(path) ? path : [...this.vfs.dirtyPaths()].find((p) => p.startsWith(`${path}/`));
		if (dirtyPath !== undefined) {
			throw new Error(`${op} refused: ${dirtyPath} has unsaved editor changes. Ask the user to save or discard them first.`);
		}
	}

	/**
	 * Refuses an edit or overwrite of a file the agent has not read this run,
	 * or one whose content differs from what it read — the edit would start
	 * from text the agent never saw.
	 *
	 * @param path - Canonical path.
	 * @param op - Tool name for the refusal message.
	 * @param current - The file's current full content.
	 */
	private async guardRead(path: string, op: string, current: string): Promise<void> {
		const seen = this.readHashes.get(path);
		if (seen === undefined) {
			throw new Error(`${op} refused: read ${path} first — edits must start from its current content.`);
		}
		if (seen !== (await sha256Hex(current))) {
			throw new Error(`${op} refused: ${path} changed since you read it. Read it again, then redo the edit.`);
		}
	}

	/**
	 * The entry kind of a path, forcing the lazy tree load first so a null
	 * answer reliably means "does not exist".
	 *
	 * @param path - Canonical path.
	 * @returns 'file' | 'dir' | null.
	 */
	private async entryType(path: string): Promise<'file' | 'dir' | null> {
		// step: stat() is the view contract's definitive answer — it consults
		// the backend when the cached inventory can't; entryType() alone only
		// reads the cache, which scoped/staged views don't promise to fill
		return this.vfs.stat(path);
	}

	/**
	 * The host's note for a save that worked. A hook that throws adds
	 * nothing: the save already happened, so it must never fail the save.
	 *
	 * @param path - Canonical path of the saved file.
	 * @returns The text to append to the save's result ('' without a hook).
	 */
	private async noteAfterSave(path: string): Promise<string> {
		if (!this.afterSave) return '';
		try {
			return await this.afterSave(path);
		} catch {
			return '';
		}
	}

	/**
	 * Recursively collects searchable files under a directory, honoring the
	 * skip list, the text-extension filter, and the file budget.
	 *
	 * @param dir - Canonical directory ('' for the root).
	 * @param out - Accumulator of file paths.
	 */
	private async collectSearchFiles(dir: string, out: string[]): Promise<void> {
		if (out.length >= SEARCH_MAX_FILES) return;
		const entries = await this.vfs.list(dir);
		for (const entry of entries) {
			if (out.length >= SEARCH_MAX_FILES) return;
			const path = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.type === 'dir') {
				if (SKIP_DIRS.has(entry.name)) continue;
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
	 * @param rawPath - Agent-supplied path.
	 * @param maxBytes - Optional byte cap (clamped to READ_MAX_BYTES).
	 * @param offset - Optional 1-based first line of a partial read.
	 * @param limit - Optional line count of a partial read.
	 * @returns The content or window, truncation always labeled.
	 */
	private async readFile(rawPath: unknown, maxBytes?: number, offset?: number, limit?: number): Promise<string> {
		const path = normalizePath(rawPath);
		const cap = Math.min(Math.max(1, maxBytes ?? READ_DEFAULT_BYTES), READ_MAX_BYTES);
		let text = String(await this.vfs.read(path));
		// step: record the whole file's hash, windowed or not — it is what edits are checked against
		this.readHashes.set(path, await sha256Hex(text));

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
		if (bytes.length <= cap) return header + text;
		const truncated = new TextDecoder().decode(bytes.slice(0, cap));
		return `${header}${truncated}\n[TRUNCATED: showing first ${cap} of ${bytes.length} bytes — narrow with offset/limit or raise maxBytes]`;
	}

	/**
	 * write_file: whole-file replacement through the VFS. A new file needs no
	 * read; replacing an existing one follows the read-before-edit rule.
	 *
	 * @param rawPath - Agent-supplied path.
	 * @param content - The complete new file content.
	 * @returns A confirmation the LLM can act on.
	 */
	private async writeFile(rawPath: unknown, content: string): Promise<string> {
		const path = normalizePath(rawPath);
		const size = new TextEncoder().encode(content).length;
		if (size > WRITE_MAX_BYTES) {
			throw new Error(`write_file caps at ${WRITE_MAX_BYTES} bytes per file (got ${size}).`);
		}
		this.guardDirty(path, 'write_file');
		// step: a new file needs no read; replacing an existing one must start from what was read
		if ((await this.entryType(path)) === 'file') await this.guardRead(path, 'write_file', String(await this.vfs.read(path)));
		await this.vfs.write(path, content, AGENT_ORIGIN);
		this.readHashes.set(path, await sha256Hex(content));
		return `Wrote ${size} bytes to ${path}.${await this.noteAfterSave(path)}`;
	}

	/**
	 * edit_file: anchored find/replace against the cached content — the
	 * partial-update surface. Refused when the file was not read this run or
	 * changed since, and when the anchor is missing or ambiguous, with
	 * recovery guidance in the error.
	 *
	 * @param rawPath - Agent-supplied path.
	 * @param oldString - Exact text to replace.
	 * @param newString - The replacement text.
	 * @param replaceAll - Replace every occurrence instead of requiring uniqueness.
	 * @returns A confirmation naming the occurrence count.
	 */
	private async editFile(rawPath: unknown, oldString: string, newString: string, replaceAll: boolean): Promise<string> {
		const path = normalizePath(rawPath);
		if (!oldString) throw new Error('edit_file needs a non-empty oldString anchor.');
		if (oldString === newString) throw new Error('oldString and newString are identical — nothing to change.');
		this.guardDirty(path, 'edit_file');
		const text = String(await this.vfs.read(path));
		await this.guardRead(path, 'edit_file', text);

		// step: count anchors — zero is a miss, several without replaceAll is ambiguous
		const occurrences = text.split(oldString).length - 1;
		if (occurrences === 0) {
			throw new Error(`edit_file: oldString not found in ${path}. Re-read the file — the anchor must match exactly, including whitespace.`);
		}
		if (occurrences > 1 && !replaceAll) {
			throw new Error(`edit_file: oldString matches ${occurrences} places in ${path}. Extend the anchor to make it unique, or pass replaceAll: true.`);
		}

		// step: a replacer function keeps '$&' and '$$' in newString literal
		const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
		const size = new TextEncoder().encode(updated).length;
		if (size > WRITE_MAX_BYTES) {
			throw new Error(`edit_file result exceeds the ${WRITE_MAX_BYTES}-byte file cap.`);
		}
		await this.vfs.write(path, updated, AGENT_ORIGIN);
		this.readHashes.set(path, await sha256Hex(updated));
		return `Replaced ${occurrences} occurrence(s) in ${path}.${await this.noteAfterSave(path)}`;
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
	 * @param rawPath - Agent-supplied path.
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
	 * @param rawPath - Optional directory to search under ('' = whole tree).
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

		// step: bounded walk, then read-and-scan through the cache
		const files: string[] = [];
		await this.collectSearchFiles(normalizePath(rawPath ?? '', true), files);
		const matches: string[] = [];
		for (let i = 0; i < files.length && matches.length < cap; i += SEARCH_READ_BATCH) {
			// step: one batched read per chunk — unreadable files come back omitted
			const batch = files.slice(i, i + SEARCH_READ_BATCH);
			const contents = await this.vfs.readMany(batch);
			for (const file of batch) {
				if (matches.length >= cap) break;
				const raw = contents.get(file);
				if (raw === undefined) continue;
				const content = String(raw);
				if (content.length > SEARCH_MAX_FILE_CHARS) continue;
				const lines = content.split('\n');
				for (let n = 0; n < lines.length && matches.length < cap; n++) {
					if (matcher(lines[n])) matches.push(`${file}:${n + 1}: ${lines[n].trim().slice(0, 200)}`);
				}
			}
		}

		if (matches.length === 0) return `No matches for '${pattern}' in ${files.length} files searched.`;
		const header = matches.length >= cap
			? `Showing first ${cap} matches (cap reached — narrow the pattern or path):`
			: `${matches.length} match(es):`;
		return `${header}\n${matches.join('\n')}`;
	}

	/**
	 * rename: move within the tree; the backend enforces any structural
	 * rules about what may move where.
	 *
	 * @param rawOld - Current agent-supplied path.
	 * @param rawNew - Target agent-supplied path.
	 * @returns A confirmation line.
	 */
	private async rename(rawOld: unknown, rawNew: unknown): Promise<string> {
		const oldPath = normalizePath(rawOld);
		const newPath = normalizePath(rawNew);
		// step: both ends — the target's dirty buffer would be overwritten too
		this.guardDirty(oldPath, 'rename');
		this.guardDirty(newPath, 'rename');
		await this.vfs.rename(oldPath, newPath, AGENT_ORIGIN);
		return `Renamed ${oldPath} to ${newPath}.`;
	}

	/**
	 * create_directory: mkdir through the VFS.
	 *
	 * @param rawPath - Agent-supplied directory path.
	 * @returns A confirmation line.
	 */
	private async createDirectory(rawPath: unknown): Promise<string> {
		const path = normalizePath(rawPath);
		await this.vfs.mkdir(path, AGENT_ORIGIN);
		return `Created directory ${path}.`;
	}

	/**
	 * delete_file: remove a file, or a directory when recursive is true.
	 * The tree root is refused here; protected roots inside the tree are
	 * the backend's rule to enforce.
	 *
	 * @param rawPath - Agent-supplied path.
	 * @param recursive - Required true to remove a directory and its contents.
	 * @returns A confirmation line.
	 */
	private async deleteFile(rawPath: unknown, recursive: boolean): Promise<string> {
		const path = normalizePath(rawPath);
		const type = await this.entryType(path);
		if (type === null) throw new Error(`No such path: ${path}`);
		if (type === 'dir' && !recursive) {
			throw new Error(`${path} is a directory — pass recursive: true to delete it and its contents.`);
		}
		this.guardDirty(path, 'delete_file');
		await this.vfs.delete(path, AGENT_ORIGIN);
		return `Deleted ${path}.`;
	}

	// ── Toolkit surface ──────────────────────────────────────────────────

	/**
	 * The filesystem tool set — all tools, full access to the tree the
	 * host's VFS presents.
	 *
	 * @returns The group's tools.
	 */
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
				execute: (a) => this.readFile(
					a.path,
					a.maxBytes === undefined ? undefined : Number(a.maxBytes),
					a.offset === undefined ? undefined : Number(a.offset),
					a.limit === undefined ? undefined : Number(a.limit),
				),
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
				description: `Search file contents across the workspace (or one subtree). Literal case-insensitive by default; set isRegex for a JavaScript regex. Returns path:line:text matches, capped at ${SEARCH_MAX_RESULTS}. Build trees are skipped.`,
				parameters: {
					type: 'object',
					properties: {
						pattern: { type: 'string', description: 'Text or regex to find' },
						path: { type: 'string', description: 'Optional directory to search under; omit for the whole workspace' },
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
				description: 'PREFERRED way to change an existing file: replace an exact text anchor. oldString must match the file exactly (including whitespace) and be unique unless replaceAll is true. Refused unless you read the file this run and it has not changed since (the error says to read it again), and when the user has unsaved editor changes to it.',
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
				execute: (a) => this.editFile(a.path, String(a.oldString), String(a.newString), a.replaceAll === true),
			}),
			new AgentTool({
				name: 'write_file',
				description: `Create a file or replace one COMPLETELY with new UTF-8 content (for targeted changes use edit_file instead). Creates missing parent directories. Cap ${WRITE_MAX_BYTES} bytes. Replacing an existing file is refused unless you read it this run and it has not changed since; a new file needs no read. Also refused when the user has unsaved editor changes to the file.`,
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace-relative path to write' },
						content: { type: 'string', description: 'The complete new file content' },
					},
					required: ['path', 'content'],
					additionalProperties: false,
				},
				execute: (a) => this.writeFile(a.path, String(a.content)),
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
				execute: (a) => this.rename(a.oldPath, a.newPath),
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
				execute: (a) => this.deleteFile(a.path, a.recursive === true),
			}),
		];
	}
}
