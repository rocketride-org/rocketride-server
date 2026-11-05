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
// FAKE ENGINE: a client the toolkits, the workspace and the sessions can use, with no engine
// =============================================================================

/**
 * L1 and L2 run the real agent against this object in place of a connected
 * RocketRideClient. It serves what the agent and its host call:
 *
 * - The file store (`fs*`), in memory, so the real rocket-ui workspace and the
 *   real session storage run on it unchanged.
 * - The catalog (`getServices`, `getService`) from the branch's services files.
 * - `validate`, by the static pipeline rules (score.ts), which stand in for the
 *   engine's own.
 * - `use`, `getTaskStatus`, `send`, `terminate`. A start checks the pipeline's
 *   `${ROCKETRIDE_*}` names against the run's Variables, as the engine does, and
 *   refuses a second start of a running pipeline. Pipelines never run, and
 *   `send` says so.
 * - `chat` on the stand-in model pipeline's token, which asks the trial's
 *   model: a replay (L1) or a live provider (L2).
 *
 * Any other client method throws a message naming it, so a gap shows up in the
 * tool result instead of as a silent pass.
 */

import { RocketRideClient } from 'rocketride';

import { catalog } from './catalog';
import { staticErrors } from './score';

// =============================================================================
// TYPES
// =============================================================================

/** What the stand-in's chat hands the model: the client's Question, as an object. */
export type ModelQuestion = Record<string, unknown>;

/** What a model answers: the text, and token counts when it has them. */
export interface ModelAnswer {
	text: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Options for a fake engine. */
export interface FakeEngineOptions {
	/** The run's Variables, name to value. Values never leave the engine. */
	variables: Record<string, string>;
	/** The model behind the stand-in pipeline. */
	model: (question: ModelQuestion) => Promise<ModelAnswer>;
}

interface Task {
	token: string;
	projectId: string;
	source: string;
	startTime: number;
	standin: boolean;
	state: 'running' | 'stopped';
}

// =============================================================================
// HELPERS
// =============================================================================

/** Every `${ROCKETRIDE_*}` name in a value. */
function placeholders(value: unknown, out = new Set<string>()): Set<string> {
	if (typeof value === 'string') for (const m of value.matchAll(/\$\{(ROCKETRIDE_[A-Z0-9_]+)\}/g)) out.add(m[1]);
	else if (Array.isArray(value)) for (const v of value) placeholders(v, out);
	else if (value && typeof value === 'object') for (const v of Object.values(value)) placeholders(v, out);
	return out;
}

/** A store path without leading or trailing slashes. */
function norm(path: string): string {
	return String(path ?? '').replace(/^\/+|\/+$/g, '');
}

function notFound(path: string): Error {
	return new Error(`File not found: ${path}`);
}

/** The real client's method names: a fake method under one of these throws, any other name is not a method. */
const CLIENT_METHODS = new Set(Object.getOwnPropertyNames(RocketRideClient.prototype));

/** The sub-clients a rocketride_client call may name. */
const SUB_CLIENTS = ['account', 'billing', 'database', 'deploy', 'log'];

// =============================================================================
// THE ENGINE
// =============================================================================

/** The fake engine. Build it with createFakeEngine, which adds the refusals for everything else. */
class FakeEngine {
	/** Files by store path. */
	readonly files = new Map<string, Uint8Array>();
	/** Folders made with fsMkdir; folders that hold files are implied. */
	readonly dirs = new Set<string>();
	/** Every pipeline started, by token. */
	readonly tasks = new Map<string, Task>();
	private next = 1;

	constructor(private readonly o: FakeEngineOptions) {}

	// ---- the connection ----

	isConnected(): boolean {
		return true;
	}

	/** OSS mode: one team, `local`, as the OSS engine reports. */
	getAccountInfo(): Record<string, unknown> {
		return { userId: 'eval-user', devTeam: 'local', organization: { id: 'local', teams: [{ id: 'local', name: 'Local' }] } };
	}

	async ping(): Promise<void> {}

	// ---- the catalog ----

	async getServices(): Promise<Record<string, unknown>> {
		const services: Record<string, unknown> = {};
		for (const [name, entry] of catalog()) services[name] = entry.raw;
		return { services, version: 'eval-fake-engine' };
	}

	async getService(name: string): Promise<Record<string, unknown>> {
		const entry = catalog().get(String(name));
		if (!entry) throw new Error(`Service ${String(name)} not found`);
		return entry.raw;
	}

	// ---- pipelines ----

	async validate(options: { pipeline: Record<string, unknown>; source?: string }): Promise<{ errors: Array<{ message: string; id?: string }>; warnings: Array<{ message: string; id?: string }> }> {
		const pipeline = options?.pipeline ?? {};
		const ids = new Set((Array.isArray(pipeline.components) ? pipeline.components : []).map((c: { id?: unknown }) => String(c?.id)));
		const entry = (text: string) => {
			const m = /^([^:\s]+): (.*)$/.exec(text);
			return m && ids.has(m[1]) ? { id: m[1], message: m[2] } : { message: text };
		};
		const { errors, warnings } = staticErrors(pipeline);
		return { errors: errors.map(entry), warnings: warnings.map(entry) };
	}

	async use(options: { pipeline?: Record<string, unknown>; source?: string; useExisting?: boolean } = {}): Promise<Record<string, unknown> & { token: string }> {
		const pipeline = options.pipeline;
		if (!pipeline || typeof pipeline !== 'object') throw new Error('Pipeline execution failed: no pipeline given');
		const projectId = String(pipeline.project_id ?? '');
		const source = String(options.source ?? pipeline.source ?? '');
		const standin = this.isStandin(pipeline);
		if (!standin) {
			const { errors } = staticErrors(pipeline);
			if (errors.length) throw new Error(`Pipeline execution failed: ${errors[0]}`);
		}
		const missing = [...placeholders(pipeline)].filter((name) => !(name in this.o.variables));
		if (missing.length) throw new Error(`Pipeline execution failed: no variable named ${missing[0]} was found`);
		const running = [...this.tasks.values()].find((t) => t.state === 'running' && t.projectId === projectId && t.source === source);
		if (running) {
			if (options.useExisting) return { token: running.token, projectId, reused: true };
			throw new Error('Pipeline execution failed: Pipeline is already running');
		}
		const token = `${standin ? 'standin' : 'task'}-${this.next++}`;
		this.tasks.set(token, { token, projectId, source, startTime: Date.now(), standin, state: 'running' });
		return { token, projectId, reused: false };
	}

	async getTaskStatus(token: string): Promise<Record<string, unknown>> {
		const t = this.tasks.get(String(token));
		if (!t) throw new Error(`Task ${String(token)} not found`);
		return { name: t.source, project_id: t.projectId, source: t.source, startTime: t.startTime, completed: t.state !== 'running', state: t.state === 'running' ? 3 : 5, completedCount: 0, totalCount: 0, errors: [], warnings: [], notes: ['The eval engine validates pipelines but does not run them.'] };
	}

	async getTasks(): Promise<Array<Record<string, unknown>>> {
		return [...this.tasks.values()].filter((t) => t.state === 'running' && !t.standin).map((t) => ({ token: t.token, project_id: t.projectId, source: t.source }));
	}

	async send(token: string): Promise<Record<string, unknown>> {
		const t = this.tasks.get(String(token));
		if (!t || t.state !== 'running') throw new Error(`Task ${String(token)} is not running`);
		return { name: t.source, result_types: {}, note: 'The eval engine validates pipelines but does not run them, so nothing was produced.' };
	}

	async terminate(token: string): Promise<void> {
		const t = this.tasks.get(String(token));
		if (!t) throw new Error(`Task ${String(token)} not found`);
		t.state = 'stopped';
	}

	/** The stand-in's chat asks the trial's model; no other pipeline answers questions here. */
	async chat(options: { token: string; question: unknown }): Promise<Record<string, unknown>> {
		const t = this.tasks.get(String(options?.token));
		if (!t?.standin || t.state !== 'running') throw new Error(`Task ${String(options?.token)} is not a running model pipeline`);
		const answer = await this.o.model(JSON.parse(JSON.stringify(options.question)) as ModelQuestion);
		return { answers: [answer.text], name: t.source, path: '', result_types: { answers: 'answers' }, objectId: `eval-${this.next++}`, ...(answer.usage ? { usage: answer.usage } : {}) };
	}

	/** The stand-in model pipeline (standin.ts): webhook, one LLM, answers, and the conversation id as project. */
	private isStandin(pipeline: Record<string, unknown>): boolean {
		const comps = Array.isArray(pipeline.components) ? (pipeline.components as Array<{ provider?: string }>) : [];
		return comps.length === 3 && comps[0]?.provider === 'webhook' && String(comps[1]?.provider).startsWith('llm_') && comps[2]?.provider === 'response_answers' && /^[0-9a-f-]{36}$/i.test(String(pipeline.project_id));
	}

	// ---- the store ----

	private isDir(path: string): boolean {
		if (path === '') return true;
		if (this.dirs.has(path)) return true;
		const prefix = `${path}/`;
		for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
		for (const d of this.dirs) if (d.startsWith(prefix)) return true;
		return false;
	}

	async fsListDir(path = ''): Promise<{ entries: Array<{ name: string; type: 'file' | 'dir'; size?: number }>; count: number }> {
		const base = norm(path);
		const prefix = base ? `${base}/` : '';
		const names = new Map<string, { type: 'file' | 'dir'; size?: number }>();
		for (const [f, data] of this.files) {
			if (!f.startsWith(prefix)) continue;
			const rest = f.slice(prefix.length);
			const cut = rest.indexOf('/');
			if (cut < 0) names.set(rest, { type: 'file', size: data.length });
			else names.set(rest.slice(0, cut), { type: 'dir' });
		}
		for (const d of this.dirs) {
			if (!d.startsWith(prefix) || d === base) continue;
			names.set(d.slice(prefix.length).split('/')[0], { type: 'dir' });
		}
		const entries = [...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, e]) => ({ name, ...e }));
		return { entries, count: entries.length };
	}

	async fsStat(path: string): Promise<{ exists: boolean; type?: 'file' | 'dir'; size?: number }> {
		const p = norm(path);
		if (this.files.has(p)) return { exists: true, type: 'file', size: this.files.get(p)?.length };
		if (this.isDir(p)) return { exists: true, type: 'dir' };
		return { exists: false };
	}

	async fsReadString(path: string): Promise<string> {
		const data = this.files.get(norm(path));
		if (!data) throw notFound(path);
		return new TextDecoder().decode(data);
	}

	async fsWriteString(path: string, text: string): Promise<void> {
		this.files.set(norm(path), new TextEncoder().encode(String(text)));
	}

	async fsReadJson(path: string): Promise<unknown> {
		return JSON.parse(await this.fsReadString(path));
	}

	async fsWriteJson(path: string, obj: unknown): Promise<void> {
		await this.fsWriteString(path, JSON.stringify(obj));
	}

	async fsReadMany(paths: string[]): Promise<Array<{ path: string; ok: boolean; data?: Uint8Array; error?: string }>> {
		return paths.map((path) => {
			const data = this.files.get(norm(path));
			return data ? { path, ok: true, data } : { path, ok: false, error: 'File not found' };
		});
	}

	async fsDelete(path: string): Promise<void> {
		if (!this.files.delete(norm(path))) throw notFound(path);
	}

	async fsMkdir(path: string): Promise<void> {
		this.dirs.add(norm(path));
	}

	async fsRmdir(path: string, recursive = false): Promise<void> {
		const p = norm(path);
		const prefix = `${p}/`;
		const inside = [...this.files.keys()].filter((f) => f.startsWith(prefix));
		if (inside.length && !recursive) throw new Error(`Directory not empty: ${path}`);
		for (const f of inside) this.files.delete(f);
		for (const d of [...this.dirs]) if (d === p || d.startsWith(prefix)) this.dirs.delete(d);
	}

	async fsRename(oldPath: string, newPath: string): Promise<void> {
		const from = norm(oldPath);
		const to = norm(newPath);
		if (this.files.has(from)) {
			this.files.set(to, this.files.get(from) as Uint8Array);
			this.files.delete(from);
			return;
		}
		if (!this.isDir(from)) throw notFound(oldPath);
		const prefix = `${from}/`;
		for (const [f, data] of [...this.files]) {
			if (!f.startsWith(prefix)) continue;
			this.files.set(`${to}/${f.slice(prefix.length)}`, data);
			this.files.delete(f);
		}
		for (const d of [...this.dirs]) {
			if (d !== from && !d.startsWith(prefix)) continue;
			this.dirs.delete(d);
			this.dirs.add(to + d.slice(from.length));
		}
	}
}

/** A method of the real client the fake does not serve: it says so when called. */
function refusal(name: string): () => Promise<never> {
	return async () => {
		throw new Error(`${name} is not served by the eval's fake engine`);
	};
}

/** A sub-client whose every method refuses. */
function refusingSubClient(prefix: string): object {
	return new Proxy(
		{},
		{
			get: (_t, prop) => (typeof prop === 'string' && prop !== 'then' ? refusal(`${prefix}.${prop}`) : undefined),
		}
	);
}

/**
 * Builds a fake engine that stands where a connected RocketRideClient would.
 *
 * @param o - The run's Variables and the model behind the stand-in.
 * @returns The engine, typed as the client the agent expects, and the engine itself for the runner.
 */
export function createFakeEngine(o: FakeEngineOptions): { client: RocketRideClient; engine: FakeEngine } {
	const engine = new FakeEngine(o);
	const subs = new Map(SUB_CLIENTS.map((name) => [name, refusingSubClient(name)]));
	const client = new Proxy(engine, {
		get: (target, prop, receiver) => {
			if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
			if (typeof prop !== 'string') return undefined;
			if (subs.has(prop)) return subs.get(prop);
			if (CLIENT_METHODS.has(prop) && prop !== 'constructor') return refusal(prop);
			return undefined;
		},
	});
	return { client: client as unknown as RocketRideClient, engine };
}

export type { FakeEngine };
