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
// STORE: the agent's workspace and sessions, through the TypeScript client
// =============================================================================

/**
 * The Agent tab reads and writes the user's file store on the engine. This
 * module resets it before a trial, writes the task's files, and reads back
 * the final files and the saved session afterwards. It sees the same store
 * the page does, through the engine, never through the page.
 *
 * Workspace paths map to store paths as apps/rocket-ui's workspace.ts maps
 * them: pipelines/ is the .projects root, apps/ is .projects/.appdev and
 * nodes/ is .projects/.nodes, under '@/Team/=<id>/' when the account's dev
 * team is set.
 */

import { RocketRideClient } from 'rocketride';

/** Rocket Builder's app id: its sessions live under .agents/<APP_ID>/. */
export const APP_ID = 'rocketride.pipeBuilder';

const PROJECTS = '.projects';
const MOUNTS: Record<string, string> = { pipelines: '', apps: '.appdev', nodes: '.nodes' };
const AGENTS = '.agents';
const DIR_MARKER = '.dirmarker';
const SAFE_TEAM_ID = /^[A-Za-z0-9_-]+$/;

/** The workspace scope the page uses, from the account info (workspace.ts resolveWorkspaceScope). */
export function scopePrefix(info: { devTeam?: string; organization?: { teams?: Array<{ id: string }> } | null } | null | undefined): string {
	const devTeam = info?.devTeam;
	if (!devTeam || !SAFE_TEAM_ID.test(devTeam)) return '';
	if (!(info?.organization?.teams ?? []).some((t) => t.id === devTeam)) return '';
	return `@/Team/=${devTeam}/`;
}

/**
 * @param prefix - The scope prefix ('' for the user's own files).
 * @param vpath - A workspace path: pipelines/..., apps/... or nodes/...
 * @returns Its store path.
 */
export function storePath(prefix: string, vpath: string): string {
	const [mount, ...rest] = vpath.replace(/^\/+/, '').split('/').filter(Boolean);
	if (mount === undefined || !(mount in MOUNTS)) throw new Error(`not a workspace path: ${vpath} (it starts with pipelines/, apps/ or nodes/)`);
	return [`${prefix}${PROJECTS}`, MOUNTS[mount], ...rest].filter(Boolean).join('/');
}

/** One turn as the session file keeps it (agent turn.ts TurnRecord), read as data. */
export interface SavedTurn {
	turnId: string;
	messageId: number;
	outcome: string;
	reason: string;
	finalText: string;
	error?: string;
	model?: string;
	files: Array<{ path: string; change: string; from?: string }>;
	checks: Array<{ target: string; step: string; status: string; summary: string }>;
	usage: { waves: number; modelRequests: number; toolCalls: number; tokens?: { input: number; output: number; estimated: boolean }; cost?: { usd: number; estimated: boolean } };
	request?: Record<string, unknown>;
	runsStarted?: unknown[];
	undoAvailable?: boolean;
	scopeKey?: string;
}

/** A saved conversation (agent sessions.ts AgentSessionFile), read as data. */
export interface SavedSession {
	version: number;
	sessionId: string;
	title: string;
	messages: Array<{ id: number; sender: string; text: string; sseType?: string }>;
	turns?: SavedTurn[];
	model?: { provider: string; model: string };
}

/** The store, through one signed-in client. */
export class Store {
	private constructor(
		private readonly rr: RocketRideClient,
		/** The scope prefix the page writes under. */
		readonly prefix: string
	) {}

	/**
	 * Connects to the engine with the API key the page signs in with.
	 *
	 * @param uri - The engine (http://127.0.0.1:5565 for the local stack).
	 * @param apiKey - The API key.
	 */
	static async connect(uri: string, apiKey: string): Promise<Store> {
		// env: {} so the client takes nothing from this process's environment
		const client = new RocketRideClient({ uri, env: {} });
		await client.connect(apiKey);
		return new Store(client, scopePrefix(client.getAccountInfo() as Parameters<typeof scopePrefix>[0]));
	}

	/** The signed-in client, for the engine checks that run after the turn. */
	get client(): RocketRideClient {
		return this.rr;
	}

	async close(): Promise<void> {
		await this.rr.disconnect();
	}

	/** The ROCKETRIDE_ variable names the engine offers, which the model picker reads. */
	async variableNames(): Promise<string[]> {
		return await this.rr.account.getEnvironmentKeys();
	}

	/**
	 * Empties the workspace (every mount), the agent sessions and the saved
	 * workbench layouts, so no file, conversation or open tab carries over.
	 */
	async reset(): Promise<void> {
		for (const root of [`${this.prefix}${PROJECTS}`, AGENTS, '.workspace', `${this.prefix}.workspace`]) await this.empty(root);
		const left = await this.workspaceFiles();
		const sessions = await this.files(AGENTS, false);
		if (left.length || sessions.length) throw new Error(`the store reset left ${left.length} workspace files and ${sessions.length} session files`);
	}

	/**
	 * Writes the task's starting files and confirms the workspace holds exactly those.
	 *
	 * @param files - Workspace path and text of each file.
	 */
	async seed(files: Array<{ path: string; text: string }>): Promise<void> {
		for (const f of files) await this.rr.fsWriteString(storePath(this.prefix, f.path), f.text);
		const have = (await this.workspaceFiles()).sort();
		const want = files.map((f) => f.path).sort();
		if (have.join('\n') !== want.join('\n')) throw new Error(`after seeding, the workspace has ${have.length} files, not the task's ${want.length}: ${have.join(', ')}`);
	}

	/** Every file in the workspace, by workspace path. */
	async workspaceFiles(): Promise<string[]> {
		const out: string[] = [];
		for (const mount of Object.keys(MOUNTS)) {
			const dir = storePath(this.prefix, mount);
			for (const f of await this.files(dir, mount === 'pipelines')) out.push(`${mount}/${f.slice(dir.length + 1)}`);
		}
		return out;
	}

	/** The app folders in the workspace (apps/<name>), whether or not their files are written yet. */
	async appFolders(): Promise<string[]> {
		return (await this.list(storePath(this.prefix, 'apps')))
			.filter((e) => e.type === 'dir')
			.map((e) => `apps/${e.name}`)
			.sort();
	}

	/**
	 * The name My Apps lists an app under: its package.json's appManifest.name.
	 *
	 * @param folder - The app folder, apps/<name>.
	 * @returns The name, or null while package.json is missing, half written or has none.
	 */
	async appName(folder: string): Promise<string | null> {
		try {
			const manifest = (JSON.parse(await this.rr.fsReadString(storePath(this.prefix, `${folder}/package.json`))) as { appManifest?: { name?: unknown } }).appManifest;
			return typeof manifest?.name === 'string' && manifest.name ? manifest.name : null;
		} catch {
			return null;
		}
	}

	/** The workspace's files and their text. */
	async readWorkspace(): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		for (const p of await this.workspaceFiles()) out[p] = await this.rr.fsReadString(storePath(this.prefix, p));
		return out;
	}

	/**
	 * The newest saved conversation of the app, waiting until it has at least
	 * `turns` turns: the chat saves a little after the turn ends.
	 *
	 * @param turns - The turns to wait for.
	 * @param waitMs - How long to wait.
	 * @returns The session and its raw text, or null when none was saved.
	 */
	async newestSession(turns: number, waitMs = 15_000): Promise<{ session: SavedSession; text: string } | null> {
		const dir = `${AGENTS}/${APP_ID}`;
		const t0 = Date.now();
		let found: { session: SavedSession; text: string } | null = null;
		for (;;) {
			const files = (await this.list(dir)).filter((e) => e.type === 'file' && /^[0-9a-f-]{36}\.json$/i.test(e.name));
			files.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
			if (files[0]) {
				const text = await this.rr.fsReadString(`${dir}/${files[0].name}`);
				try {
					found = { session: JSON.parse(text) as SavedSession, text };
				} catch {
					/* a save in progress: read it again */
				}
			}
			if ((found?.session.turns?.length ?? 0) >= turns || Date.now() - t0 > waitMs) return found;
			await new Promise((r) => setTimeout(r, 1000));
		}
	}

	/** The session catalog's raw text, or null. */
	async catalogText(): Promise<string | null> {
		try {
			return await this.rr.fsReadString(`${AGENTS}/${APP_ID}/catalog.json`);
		} catch {
			return null;
		}
	}

	// =========================================================================
	// helpers
	// =========================================================================

	private async list(dir: string): Promise<Array<{ name: string; type: 'file' | 'dir'; modified?: number }>> {
		try {
			return (await this.rr.fsListDir(dir)).entries ?? [];
		} catch {
			return [];
		}
	}

	/** Every file under dir, recursively; at the top level, dot-folders are skipped when hideDotDirs is set (the pipelines mount). */
	private async files(dir: string, hideDotDirs: boolean): Promise<string[]> {
		const out: string[] = [];
		for (const e of await this.list(dir)) {
			if (e.name === DIR_MARKER) continue;
			const full = `${dir}/${e.name}`;
			if (e.type === 'dir') {
				if (hideDotDirs && e.name.startsWith('.')) continue;
				out.push(...(await this.files(full, false)));
			} else out.push(full);
		}
		return out;
	}

	/** Deletes everything in a store folder (as #2885's wipeStore did for .projects). */
	private async empty(root: string): Promise<void> {
		for (const e of await this.list(root)) {
			const p = `${root}/${e.name}`;
			if (e.type === 'dir') await this.rr.fsRmdir(p, true);
			else await this.rr.fsDelete(p);
		}
	}
}
