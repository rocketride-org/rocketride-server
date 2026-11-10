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

/** The agent's per-turn limits, as the runner sets them; 0 turns a limit off, and an absent one keeps the product's default. */
export interface AgentLimits {
	steps?: number;
	costUsd?: number;
}

/** The workspace settings behind the limits (apps/shared/src/tools/toolSettings.ts, apps/rocket-ui agentHost.ts LIMIT_KEYS). */
export const LIMIT_KEYS: Readonly<Record<keyof AgentLimits, string>> = {
	steps: 'rocketride.pipeBuilder.agentStepLimit',
	costUsd: 'rocketride.pipeBuilder.agentCostLimit',
};

/**
 * Rocket Builder's workspace file. The shell keeps a setting in its owner's
 * partition file, and Rocket Builder's settings belong to APP_ID's
 * (packages/shell workspaceStore.ts partitionPath).
 */
export const AGENT_SETTINGS_FILE = `.workspace/${APP_ID}.workspace.json`;

/** The prefs a new app partition starts with (packages/shell workspaceStore.ts defaultPrefs); the shell ignores a file without prefs. */
const DEFAULT_PREFS = { activeView: 'welcome', activeActivity: 'explorer', sidePanelOpen: true, theme: 'rocketride-light' };

/**
 * Rocket Builder's workspace file for a fresh store with these limits set:
 * the shell's new-partition defaults, plus the limits as settings.
 */
export function agentSettingsFile(limits: AgentLimits): { prefs: typeof DEFAULT_PREFS; appState: Record<string, never>; settings: Record<string, number> } {
	const settings = Object.fromEntries((Object.keys(LIMIT_KEYS) as Array<keyof AgentLimits>).filter((k) => limits[k] !== undefined).map((k) => [LIMIT_KEYS[k], limits[k] as number]));
	return { prefs: DEFAULT_PREFS, appState: {}, settings };
}

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

/**
 * The engine's system trees (packages/ai file_store.py SYSTEM_TREES): written
 * by the engine, left out of the user's listings and denied to the user, so
 * not the user's files.
 */
const SYSTEM_TREES = new Set(['.logs', '.deployments']);

/** fsReadMany's limit on paths per call. */
const READ_MANY = 256;

/** The part of the client's file API that a snapshot and its restore use. */
export type FileApi = Pick<RocketRideClient, 'fsListDir' | 'fsReadMany' | 'fsOpen' | 'fsWrite' | 'fsClose' | 'fsDelete'>;

/** The user's files at one moment: each file's store path and bytes, and the scope roots they were read under. */
export interface Snapshot {
	roots: string[];
	files: ReadonlyMap<string, Uint8Array>;
}

/**
 * Every file under each root, by store path, less the system trees at a
 * root. A listing that fails throws, so nothing is built on a partial list.
 */
async function userFiles(api: FileApi, roots: string[]): Promise<string[]> {
	const walk = async (dir: string, root: boolean): Promise<string[]> => {
		const out: string[] = [];
		for (const e of (await api.fsListDir(dir)).entries ?? []) {
			if (root && SYSTEM_TREES.has(e.name)) continue;
			const p = dir ? `${dir}/${e.name}` : e.name;
			if (e.type === 'dir') out.push(...(await walk(p, false)));
			else out.push(p);
		}
		return out;
	};
	const out: string[] = [];
	for (const root of roots) out.push(...(await walk(root, true)));
	return out;
}

/**
 * Reads every file under the roots, as bytes, leaving out the system trees.
 *
 * @param roots - Scope roots: '' is the user's own files.
 */
export async function snapshotFiles(api: FileApi, roots: string[]): Promise<Snapshot> {
	const paths = await userFiles(api, roots);
	const files = new Map<string, Uint8Array>();
	for (let i = 0; i < paths.length; i += READ_MANY) {
		for (const r of await api.fsReadMany(paths.slice(i, i + READ_MANY))) {
			if (!r.ok || !r.data) throw new Error(`could not read ${r.path}: ${r.error}`);
			files.set(r.path, r.data);
		}
	}
	return { roots, files };
}

/**
 * Puts the files under the snapshot's roots back as the snapshot has them:
 * deletes each file it does not have, and writes back each file whose bytes
 * differ or that is gone. The system trees are left alone.
 *
 * @returns The store paths deleted and written back.
 */
export async function restoreFiles(api: FileApi, snapshot: Snapshot): Promise<{ deleted: string[]; rewritten: string[] }> {
	const now = (await snapshotFiles(api, snapshot.roots)).files;
	const deleted = [...now.keys()].filter((p) => !snapshot.files.has(p));
	const rewritten = [...snapshot.files].filter(([p, data]) => !now.has(p) || Buffer.compare(now.get(p) as Uint8Array, data) !== 0).map(([p]) => p);
	for (const p of deleted) await api.fsDelete(p);
	for (const p of rewritten) {
		const data = snapshot.files.get(p) as Uint8Array;
		const { handle } = await api.fsOpen(p, 'w');
		try {
			if (data.length) await api.fsWrite(handle, data);
		} finally {
			await api.fsClose(handle, 'w');
		}
	}
	return { deleted, rewritten };
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
	 * Writes Rocket Builder's workspace file with the agent's limits as its
	 * settings, the way the shell saves a changed setting, so the page loads
	 * them when it opens. Run it after reset() and before the page opens.
	 *
	 * @returns The settings written.
	 */
	async setAgentLimits(limits: AgentLimits): Promise<Record<string, number>> {
		const file = agentSettingsFile(limits);
		await this.rr.fsWriteJson(AGENT_SETTINGS_FILE, file);
		return file.settings;
	}

	/**
	 * Rocket Builder's workspace file as it stands: its settings, and whether
	 * the page saved it after the runner wrote it (its prefs changed, as they
	 * do when the page opens the Agent view), which shows the page loaded the
	 * settings and kept them. Null when there is no file.
	 */
	async agentSettings(): Promise<{ settings: Record<string, unknown>; savedByPage: boolean } | null> {
		try {
			const file = await this.rr.fsReadJson<{ prefs?: unknown; settings?: Record<string, unknown> }>(AGENT_SETTINGS_FILE);
			return { settings: file?.settings ?? {}, savedByPage: JSON.stringify(file?.prefs) !== JSON.stringify(DEFAULT_PREFS) };
		} catch {
			return null;
		}
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
	 * The user's files as they stand: every file in the user's own store, and
	 * in the team scope's when the page writes under one, less the system
	 * trees (.logs, .deployments).
	 */
	async snapshot(): Promise<Snapshot> {
		return await snapshotFiles(this.rr, ['', ...(this.prefix ? [this.prefix.replace(/\/$/, '')] : [])]);
	}

	/** Puts the user's files back as the snapshot has them (restoreFiles). */
	async restore(snapshot: Snapshot): Promise<{ deleted: string[]; rewritten: string[] }> {
		return await restoreFiles(this.rr, snapshot);
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
