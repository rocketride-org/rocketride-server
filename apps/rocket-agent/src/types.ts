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

import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';

export type SessionStatus =
	| 'starting'
	| 'active'
	| 'paused_auth'      // upstream 401 — waiting for a fresh panel token
	| 'workspace_full'   // 512MB cap hit — reaper pauses, panel surfaces it
	| 'archived';

export interface SessionRecord {
	sessionId: string;
	ownerId: string;
	tenantId: string;
	title: string;
	pipePath: string;          // project-store path of the seeded pipe ('' when created without one)
	pipesTouched: string[];    // appended on each save-back (Task 3.3/3.5)
	status: SessionStatus;
	createdAt: number;         // epoch ms
	lastActivity: number;      // epoch ms
	saveFailed?: boolean;      // set by archive() when the final save-back threw (3.5 surfaces this in listings)
}

export interface LiveSession {
	record: SessionRecord;
	proc: ChildProcess;
	port: number;
	password: string;          // per-session opencode basic-auth secret — NEVER serialized
	baseUrl: string;           // http://127.0.0.1:<port>
	mcpSecret: string;         // guards /internal/mcp/:id/:secret
	latestToken: string;       // freshest user credential seen on the proxy
	workspaceDir: string;
	sessionHome: string;       // per-session HOME/XDG root (opencode persistence)
	events: EventEmitter;      // rocket-agent's own panel events (auth.expired, snapshot, saved…)
	openStreams: number;       // in-flight proxied/panel streams — reaper skips idle-archival while > 0
	turn: TurnState;           // per-turn volatile state, injected via the prompt `system` field (never the static prompt)
	model?: string;            // the `<provider>/<model>` string this opencode child was spawned with; lets the panel detect a mid-session model change and offer a resume-to-apply
}

/** Per-turn volatile state for the canvas agent (injected via the prompt `system` field, never the static prompt). */
export interface TurnState {
	activePhase?: string;
	awaitingGate?: { id: string; options: string[] };
}

export interface Identity {
	ownerId: string;
	tenantId: string;
}

export interface IdentityResolver {
	resolve(credential: string): Promise<Identity>;
}

/** opencode provider id -> API key. */
export type ProviderKeyMap = Record<string, string>;

/** What a KeyResolver returns: the provider keys the user configured + their chosen model. */
export interface InferenceSettings {
	keys: ProviderKeyMap;
	model?: string;
}

export interface KeyResolver {
	resolve(credential: string): Promise<InferenceSettings>;
}

/** Subset of RocketRideClient used for project-store IO (fsReadString/fsWriteString at client.ts:2826/2850). */
/** Compact per-provider summary used to seed the agent's discoverable component catalog. */
export interface ServiceSummaryLite {
	title?: string;
	description?: string;
	classType?: string[];
	lanes?: Record<string, string[]>;
}

export interface StoreFs {
	fsReadString(path: string): Promise<string>;
	fsWriteString(path: string, text: string): Promise<void>;
	close(): Promise<void>;
	/**
	 * The server's live component catalog (one compact summary per provider), used to seed
	 * `docs/COMPONENTS.md` so the agent can grep for a real provider instead of inventing one.
	 * Optional: stub stores (blank-workspace seed, tests) omit it and the catalog is skipped.
	 */
	listServices?(): Promise<Record<string, ServiceSummaryLite>>;
	/**
	 * List one directory in the project store (non-recursive). Used by `listStorePipes`
	 * (workspace.ts) to walk `.projects/` and seed EVERY existing pipeline into a new session's
	 * workspace, so the agent sees the user's whole cwd — prior pipes and nested folders — not
	 * just the one that was opened. Optional: stub stores (blank-workspace seed, tests) may omit
	 * it, in which case only the explicitly-opened pipe is seeded.
	 */
	fsListDir?(path: string): Promise<{ entries: Array<{ name: string; type: 'file' | 'dir' }> }>;
}

export interface SessionIndex {
	put(record: SessionRecord): Promise<void>;
	get(id: string): Promise<SessionRecord | null>;
	listByOwner(ownerId: string): Promise<SessionRecord[]>;
	countActive(tenantId: string): Promise<number>;   // non-archived sessions
	listArchivedOlderThan(cutoffMs: number): Promise<SessionRecord[]>;
	/** Across ALL tenants — boot-time orphan reconciliation (final-review Critical 2) needs the whole index, not one owner/tenant slice. */
	listNonArchived(): Promise<SessionRecord[]>;
	remove(id: string): Promise<void>;
	close?(): Promise<void>;   // RedisSessionIndex (3.5): release the connection; MemorySessionIndex has nothing to close
}

export class HttpError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}
