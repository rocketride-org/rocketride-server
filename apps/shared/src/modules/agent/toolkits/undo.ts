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
// UNDO — the latest turn's file changes, and putting them back
// =============================================================================

/**
 * The file toolkit keeps one UndoRecord per run. At each path's first touch
 * in the turn it records the content before (null for a file that did not
 * exist). After each of the agent's changes it records the version that
 * change left and the hash of the content or the absence it left. A rename
 * records both ends. The record lives in memory only: no content goes into
 * the session file, a prompt or the chat, so after a reload or a team switch
 * there is nothing to undo. Above UNDO_MAX_BYTES of content a turn cannot be
 * undone, and neither can one that deleted or moved a folder or created an
 * app, since the record does not hold what those changed.
 *
 * Undo reverses only the file changes of one turn: never a run, a deploy, a
 * publish, a schedule or a Variable. It first checks every path, and
 * refuses the whole Undo, naming the paths, when any of them fails:
 *
 * - no editor holds unsaved changes there;
 * - the path is at the version the agent's last change left;
 * - nothing else changed it between two of the agent's changes: each later
 *   change started from the version, and replaced the content, that the
 *   agent's last change left;
 * - what stores it still matches the hash of what the agent left. For a path
 *   whose change is still staged (manual mode), that is the staged content.
 *   Otherwise (auto mode, or a path committed since) it is a fresh read of
 *   the server's copy, so a teammate's change on the server is seen. Only a
 *   missing file reads as an absence; any other failed read refuses.
 *
 * Then every inverse starts in one synchronous block, after the versions and
 * editors are checked once more: the content before is written back at the
 * version the agent left (`expect`), and a file the agent created is
 * removed. A rename is reversed at both ends: its old path gets its content
 * back and its new path goes. In manual mode the write-back of a staged
 * file drops its staged entry, and a file the agent created that was never
 * committed has its staged entry dropped rather than a delete staged, so
 * nothing is left pending. In auto mode the store has no conditional write,
 * so a change that lands between the check and the write is lost (known
 * bug 3). A failure part way is reported as it is: what was reversed, and
 * what was not.
 */

import { sha256Hex } from '../../vfs/hash';
import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The most file content one turn's record keeps: 4 MB. */
export const UNDO_MAX_BYTES = 4 * 1024 * 1024;

/** The writer identity Undo's changes carry. */
export const UNDO_ORIGIN = 'undo';

/** The start of the row that says an Undo changed files; the model reads it in the history. */
export const UNDO_ROW = 'Undo: ';

// =============================================================================
// TYPES
// =============================================================================

/** One path the turn changed. */
interface UndoPath {
	/** The workspace path. */
	path: string;
	/** The content before the turn's first change to it; null when it did not exist. */
	before: string | null;
	/** The version the agent's last change of it left. */
	version: number;
	/** The SHA-256 of what the agent's last change left; null for an absence. */
	hash: string | null;
	/** Why it cannot be reversed: someone else changed it between two of the agent's changes, or a change failed part way. */
	spoiled?: string;
}

/** What an Undo did. */
export interface UndoOutcome {
	/** 'undone': every path is back; 'refused': nothing was changed; 'partial': a change failed part way. */
	kind: 'undone' | 'refused' | 'partial';
	/** The row the chat shows. An 'undone' or 'partial' row starts with UNDO_ROW, and the model reads it. */
	text: string;
}

/** Whether Undo can run, and why not. */
export type UndoState = 'none' | 'ready' | 'waiting' | { unavailable: string };

// =============================================================================
// TEXT
// =============================================================================

/** Paths for a sentence. */
function listed(paths: string[]): string {
	return paths.length === 1 ? paths[0] : `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`;
}

/** An error's message. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a read failed because nothing is stored at the path: the store's
 * 'File not found: …', or the view's 'No such file: …' for a path whose
 * delete is staged. Any other failure, such as a dropped connection, proves
 * nothing.
 *
 * @param error - What the read threw.
 * @returns True only for a missing file.
 */
function provenAbsent(error: unknown): boolean {
	return error instanceof Error && /file not found|no such file/i.test(error.message);
}

// =============================================================================
// THE RECORD
// =============================================================================

/** One turn's file changes, as Undo needs them. */
export class UndoRecord {
	/** The paths the turn changed, in the order first changed. */
	private readonly paths = new Map<string, UndoPath>();
	/** The bytes of content kept. */
	private bytes = 0;
	/** Why the turn cannot be undone, once something made it so. */
	private reason: string | undefined;
	/** The agent's file changes still on their way (a call that timed out may still run after the turn ends). */
	private inflight = 0;
	/** Called once no change is on its way any more. */
	private readonly listeners = new Set<() => void>();

	/** @param vfs - The workspace view the turn changed. */
	constructor(readonly vfs: IWorkspaceFileSystem) {}

	/** Whether the turn changed any file, or a change of it is still on its way. */
	get changed(): boolean {
		return this.paths.size > 0 || this.reason !== undefined || this.inflight > 0;
	}

	/** Whether none of the turn's file changes is still on its way. */
	get settled(): boolean {
		return this.inflight === 0;
	}

	/**
	 * Whether Undo can run now.
	 *
	 * @returns Why it is unavailable; 'waiting' while a change is on its way; 'none' when the turn changed no file; else 'ready'.
	 */
	state(): UndoState {
		if (this.reason !== undefined) return { unavailable: this.reason };
		if (!this.settled) return 'waiting';
		return this.paths.size > 0 ? 'ready' : 'none';
	}

	/**
	 * Hears when the last change on its way ends.
	 *
	 * @param listener - Called with no arguments.
	 * @returns The unsubscribe.
	 */
	onSettled(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Counts one of the agent's file changes as on its way until it ends.
	 *
	 * @param work - The change.
	 * @returns The same promise.
	 */
	track<T>(work: Promise<T>): Promise<T> {
		this.inflight++;
		const end = (): void => {
			this.inflight--;
			if (this.inflight === 0) for (const listener of [...this.listeners]) listener();
		};
		work.then(end, end);
		return work;
	}

	/**
	 * Makes the turn one that cannot be undone, and drops the content kept.
	 *
	 * @param reason - Why, as the card ends "Undo is unavailable: …" with it.
	 */
	unavailable(reason: string): void {
		this.reason ??= reason;
		this.paths.clear();
		this.bytes = 0;
	}

	/**
	 * One of the agent's changes of a path landed.
	 *
	 * @param path - The canonical path.
	 * @param before - The content the change replaced, or null for none; kept only at the path's first touch, and after it compared with what the agent's last change left.
	 * @param from - The version the change started from.
	 * @param left - The version the change left, and the content it left (null for an absence).
	 * @param readAt - The version `before` was read at, when the change itself did not name it (a delete, a rename).
	 */
	async landed(path: string, before: string | null, from: number, left: { version: number; content: string | null }, readAt = from): Promise<void> {
		const hash = left.content === null ? null : await sha256Hex(left.content);
		const replaced = before === null ? null : await sha256Hex(before);
		if (this.reason !== undefined) return;
		const entry = this.paths.get(path);
		if (!entry) {
			const kept = this.keep(before);
			// step: the path moved on between the read and the change, so what was read may not be what the change replaced
			if (this.reason === undefined) this.paths.set(path, { path, before: kept, version: left.version, hash, ...(readAt !== from ? { spoiled: 'was changed by someone else during the turn' } : {}) });
			return;
		}
		// step: the path moved on between two of the agent's changes, or the change replaced something other than what the agent left: someone else changed it during the turn
		if (entry.version !== from || entry.hash !== replaced) entry.spoiled ??= 'was changed by someone else during the turn';
		entry.version = left.version;
		entry.hash = hash;
	}

	/**
	 * One of the agent's changes of a path failed, and may have landed in part.
	 *
	 * @param path - The canonical path.
	 * @param before - The content the change would have replaced.
	 * @param from - The version the change started from.
	 */
	failed(path: string, before: string | null, from: number): void {
		if (this.reason !== undefined) return;
		const entry = this.paths.get(path) ?? { path, before: this.keep(before), version: from, hash: null };
		if (this.reason !== undefined) return;
		entry.spoiled ??= 'had a change by the agent that failed part way';
		this.paths.set(path, entry);
	}

	/** Content to keep at a first touch, counted against the cap. */
	private keep(before: string | null): string | null {
		if (before === null) return null;
		this.bytes += new TextEncoder().encode(before).length;
		if (this.bytes > UNDO_MAX_BYTES) this.unavailable(`this turn changed more than ${UNDO_MAX_BYTES / (1024 * 1024)} MB of files`);
		return before;
	}

	// ── Undo ─────────────────────────────────────────────────────────────

	/**
	 * Reverses the turn's file changes, or refuses and changes nothing.
	 *
	 * @returns What happened, with the row the chat shows.
	 */
	async undo(): Promise<UndoOutcome> {
		const state = this.state();
		if (state !== 'ready') return { kind: 'refused', text: `Undo refused, nothing was changed: ${typeof state === 'object' ? state.unavailable : state === 'waiting' ? 'a change of the turn is still running' : 'the turn changed no file'}.` };
		// step: a path the turn left as it found it (created and deleted, or changed and changed back) needs nothing
		const entries: UndoPath[] = [];
		for (const entry of this.paths.values()) {
			const net = entry.spoiled !== undefined || (entry.before === null ? entry.hash !== null : (await sha256Hex(entry.before)) !== entry.hash);
			if (net) entries.push(entry);
		}
		const problems: string[] = [];
		// step: what reads what is stored: the staged content for a path still staged, else the server's copy afresh
		const staged = this.vfs.changedPaths?.() ?? new Map<string, string>();
		for (const entry of entries) {
			const problem = entry.spoiled ?? this.moved(entry) ?? (await this.storedProblem(entry, staged.has(entry.path)));
			if (problem) problems.push(`${entry.path} ${problem}`);
		}
		if (problems.length > 0) return { kind: 'refused', text: `Undo refused, nothing was changed: ${problems.join('; ')}.` };

		// step: one block: the editors and versions are checked again, then every inverse starts, with nothing awaited in between
		for (const entry of entries) {
			const problem = this.moved(entry);
			if (problem) problems.push(`${entry.path} ${problem}`);
		}
		if (problems.length > 0) return { kind: 'refused', text: `Undo refused, nothing was changed: ${problems.join('; ')}.` };
		const stagedNow = this.vfs.changedPaths?.() ?? new Map<string, string>();
		const inverses = entries.map((entry) => ({ path: entry.path, work: this.inverse(entry, stagedNow.get(entry.path)) }));
		const ends = await Promise.allSettled(inverses.map((inverse) => inverse.work));

		// step: one level: the record is spent, whatever happened
		this.paths.clear();
		this.reason = 'this turn was undone';
		const reversed = inverses.filter((_, i) => ends[i].status === 'fulfilled').map((inverse) => inverse.path);
		const failed = inverses.flatMap((inverse, i) => {
			const end = ends[i];
			return end.status === 'rejected' ? [`${inverse.path} (${messageOf(end.reason)})`] : [];
		});
		if (reversed.length === 0 && failed.length === 0) return { kind: 'undone', text: `${UNDO_ROW}the user undid the turn before, which left every file as it found it.` };
		if (failed.length === 0) return { kind: 'undone', text: `${UNDO_ROW}the user reversed the file changes of the turn before, so these files are back as they were before it: ${listed(reversed)}.` };
		return { kind: 'partial', text: `${UNDO_ROW}reversing the file changes of the turn before stopped part way. Reversed: ${reversed.length ? listed(reversed) : 'nothing'}. Not reversed: ${listed(failed)}.` };
	}

	/** Why a path cannot be reversed now, as far as the page knows: an editor holds unsaved changes there, or it moved on since the agent's change. */
	private moved(entry: UndoPath): string | undefined {
		if (this.vfs.isDirty(entry.path)) return 'has unsaved changes in an editor';
		if (this.vfs.version(entry.path) !== entry.version) return 'changed since the turn';
		return undefined;
	}

	/**
	 * Why what stores a path no longer matches what the agent left, or
	 * undefined when it does. A read that fails for any reason but a missing
	 * file leaves the path unchecked, which is a problem too.
	 *
	 * @param entry - The path.
	 * @param staged - Whether its change is still staged: then the staged content counts, not the server's copy.
	 * @returns The problem, or undefined.
	 */
	private async storedProblem(entry: UndoPath, staged: boolean): Promise<string | undefined> {
		let hash: string | null;
		try {
			hash = await this.storedHash(entry.path, staged);
		} catch (error) {
			return `could not be checked (${messageOf(error)})`;
		}
		if (hash === entry.hash) return undefined;
		return staged ? 'changed since the turn' : 'changed on the server since the turn';
	}

	/**
	 * The hash of what stores a path now.
	 *
	 * @param path - The canonical path.
	 * @param staged - Whether its change is still staged: then the staged content counts, not the server's copy.
	 * @returns The hash, or null when nothing stores it.
	 * @throws The read's error when it failed for any reason but a missing file.
	 */
	private async storedHash(path: string, staged: boolean): Promise<string | null> {
		let content: unknown;
		try {
			content = staged ? (await this.vfs.readVersioned(path, { stored: true })).content : await this.vfs.peekBase(path);
		} catch (error) {
			if (provenAbsent(error)) return null;
			throw error;
		}
		return sha256Hex(String(content));
	}

	/**
	 * Starts the change that puts one path back. It is called in the
	 * synchronous block after the checks, so its version check runs there.
	 *
	 * @param entry - The path.
	 * @param staged - How its change is staged, when it is.
	 * @returns The change.
	 */
	private inverse(entry: UndoPath, staged: string | undefined): Promise<void> {
		if (entry.before !== null) return this.vfs.write(entry.path, entry.before, UNDO_ORIGIN, entry.version);
		// step: a file the agent created and that was never committed: its staged entry goes, and no delete is staged
		if (staged === 'added' && this.vfs.discardPath) return this.vfs.discardPath(entry.path);
		return this.vfs.delete(entry.path, UNDO_ORIGIN);
	}
}
