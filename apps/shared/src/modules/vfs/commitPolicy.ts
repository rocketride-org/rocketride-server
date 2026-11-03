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
// COMMIT POLICY — when commit() fires: the autoCommit setting's enforcement
// =============================================================================

/**
 * The one behavioral difference between the two workspace modes:
 *
 *   - AUTO ('auto', the host setting's default true): every turn checkpoint
 *     is committed to the server immediately, RETAINING the checkpoint as
 *     inert history so "Undo this turn" can inverse-replay it. Save means
 *     saved; no commit chrome exists.
 *   - MANUAL ('manual', setting false): checkpoints accumulate; commit runs
 *     only when the user says so (Commit / Commit all). Uncommitted badges,
 *     diffs, and rollback are live.
 *
 * Mode switching: manual -> auto with pending changes is refused with a
 * typed error — the (P3) UI prompts commit / discard / stay instead of ever
 * flushing silently. Auto -> manual is always free.
 */

import type { CommitResult, StagedFileSystem } from './stagedFileSystem';

/** The two workspace modes, mapped from the host's autoCommit setting. */
export type CommitMode = 'auto' | 'manual';

/** Thrown when a mode switch needs a user decision first (P3 prompt). */
export class ModeSwitchBlockedError extends Error {
	constructor() {
		super('Switching to auto-commit with uncommitted changes — commit or discard them first.');
		this.name = 'ModeSwitchBlockedError';
	}
}

export class CommitPolicy {
	/** The governed view. */
	private readonly fs: StagedFileSystem;
	/** The current mode. */
	private mode: CommitMode;

	/**
	 * Binds a policy to a staged view.
	 *
	 * @param fs - The staged workspace view.
	 * @param autoCommit - The host's setting value (true = auto mode).
	 */
	constructor(fs: StagedFileSystem, autoCommit: boolean) {
		this.fs = fs;
		this.mode = autoCommit ? 'auto' : 'manual';
	}

	/** The active mode. */
	getMode(): CommitMode {
		return this.mode;
	}

	/**
	 * Applies a setting change. Refuses manual -> auto while changes are
	 * pending (never a silent flush). The policy is the SINGLE mode owner:
	 * it drives the view's write-through flag itself, so no caller ever
	 * touches setWriteThrough directly.
	 *
	 * @param autoCommit - The new setting value.
	 */
	setMode(autoCommit: boolean): void {
		const next: CommitMode = autoCommit ? 'auto' : 'manual';
		if (next === this.mode) return;
		// step: entering auto with pending state needs an explicit decision
		if (next === 'auto' && this.fs.hasPendingChanges()) {
			throw new ModeSwitchBlockedError();
		}
		// Fire-and-forget: the pending guard above already ruled, and the
		// flag flip itself cannot fail past it.
		void this.fs.setWriteThrough(autoCommit);
		this.mode = next;
	}

	/**
	 * Commits everything pending (manual mode's "Commit all"), sweeping the
	 * layers on success.
	 *
	 * @returns The commit result (conflicts block with nothing written).
	 */
	async commitAll(): Promise<CommitResult> {
		return this.fs.commit();
	}

	/**
	 * Discards everything pending (manual mode's "Discard all") — staged
	 * layers are dropped, the base is never touched.
	 */
	async discardAll(): Promise<void> {
		return this.fs.discard();
	}

	/**
	 * Seals one agent turn: freezes the working layer as a checkpoint and,
	 * in auto mode, commits it immediately (retained for Undo).
	 *
	 * @param label - Checkpoint label (the turn title).
	 * @param sessionId - The producing agent session.
	 * @returns The commit result (auto mode), or null (manual: staged only).
	 */
	async onTurnEnd(label: string, sessionId?: string): Promise<CommitResult | null> {
		const checkpointId = await this.fs.checkpoint(label, sessionId);
		if (checkpointId === null) return null;
		if (this.mode === 'manual') return null;
		// step: auto mode — the server follows every turn; history retained
		return this.fs.commit({ retain: true });
	}
}
