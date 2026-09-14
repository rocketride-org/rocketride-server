/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentConfig } from './config';
import { log } from './log';
import type { SessionManager } from './session';
import type { SessionIndex } from './types';
import { workspaceSize } from './workspace';

export async function sweep(manager: SessionManager, index: SessionIndex, cfg: AgentConfig, now = Date.now()): Promise<void> {
	// 1. Idle sessions → archive (save-back + snapshot + free the process). 2h TTL approved.
	for (const live of manager.listLive()) {
		// A held-open proxied stream (panel SSE, opencode SSE passthrough, in-flight MCP
		// call) counts as activity — never archive out from under a connected client.
		if (live.openStreams > 0) continue;
		if (now - live.record.lastActivity > cfg.idleTtlMs) {
			await manager.archive(live.record.sessionId, 'reap');
			continue;
		}
		// 2. Workspace cap (512MB approved): pause, don't kill — the user may clean up via the agent.
		if ((await workspaceSize(live.workspaceDir)) > cfg.workspaceCapBytes) manager.pauseForCap(live);
	}
	// 3. Retention (default 30 days): purge archived sessions' disk + index entries.
	const cutoff = now - cfg.retentionDays * 86_400_000;
	const sessionsRoot = path.resolve(cfg.dataDir, 'sessions');
	for (const record of await index.listArchivedOlderThan(cutoff)) {
		const dir = sessionDirFor(sessionsRoot, record.sessionId);
		if (!dir) {
			// A sessionId that resolves outside sessionsRoot (e.g. '..' segments) never gets
			// anywhere near fs.rm — an index entry cannot be trusted to imply a safe disk path.
			log.error(`[reaper] refusing to purge session with suspicious id ${JSON.stringify(record.sessionId)}`);
			continue;
		}
		await fsp.rm(dir, { recursive: true, force: true });
		await index.remove(record.sessionId);
	}
}

/** Resolves <sessionsRoot>/<sessionId>, returning null unless the result stays strictly inside sessionsRoot. */
function sessionDirFor(sessionsRoot: string, sessionId: string): string | null {
	const dir = path.resolve(sessionsRoot, sessionId);
	return dir === sessionsRoot || !dir.startsWith(sessionsRoot + path.sep) ? null : dir;
}

/**
 * Boot-time reconciliation (final-review Critical 2, the other half of archiveAllLive() in
 * session.ts): rocket-agent runs single-replica (`strategy: Recreate`) — a fresh process
 * starts with an EMPTY live map, so at true boot any non-archived index record is, by
 * definition, orphaned (its opencode child died with the previous pod). Left alone it stays
 * 'active'/'paused_auth' forever: countActive() keeps counting it against the tenant cap,
 * the reaper's idle sweep only ever looks at manager.listLive() (never this record), and
 * retention only purges records that are ALREADY archived — the tenant would be stuck at
 * the cap with no way to create OR resume. Marking it archived here frees the cap and
 * leaves it resumable (workspace + opencode session data are untouched on disk).
 *
 * Safe only under the single-replica assumption above: on a hypothetical multi-replica
 * deployment this would need to distinguish "no live process anywhere" from "no live
 * process on THIS replica" (e.g. via a per-record replica-owner marker) before archiving.
 */
export async function reconcileOnBoot(manager: SessionManager, index: SessionIndex): Promise<void> {
	for (const record of await index.listNonArchived()) {
		if (manager.getLive(record.sessionId)) continue; // defensive: true at every real boot, but keeps this call idempotent/safe if ever reused
		record.status = 'archived';
		await index.put(record);
	}
}

export function startReaper(manager: SessionManager, index: SessionIndex, cfg: AgentConfig, intervalMs = 60_000): NodeJS.Timeout {
	const t = setInterval(() => void sweep(manager, index, cfg).catch((err) => log.error('[reaper]', err)), intervalMs);
	t.unref();
	return t;
}
