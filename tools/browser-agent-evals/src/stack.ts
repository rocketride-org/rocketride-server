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
// STACK: the engine and the two dev servers a browser trial runs against
// =============================================================================

/**
 * Starts the local dev stack, as the rr-verify-agent skill's launch.sh does
 * (origin/feat/rocket-agent-testing), or attaches to one already running:
 *
 * - the engine from dist/server on 5565, with a store of its own under the
 *   run folder (RR_STORE_URL), because the default store, ~/.rocketlib, is
 *   shared by every local engine and a trial's reset empties it;
 * - the rocket-ui dev remote on 3010, serving this checkout's Rocket Builder
 *   under /apps/rocketride.pipeBuilder/dev;
 * - the shell dev server on 3000, which proxies the engine's paths to 5565
 *   (packages/shell/rsbuild.config.mts) and the dev prefix to 3010.
 *
 * That is slot 0. run --slots starts several stacks side by side, and each
 * slot owns everything it writes (slotPlan): its ports, its generated dev
 * configs, the shell's build output, its store and logs, and past slot 0 an
 * APFS clone of dist/server without the engine's .env. Each slot's shell
 * proxies the engine's paths to that slot's engine.
 *
 * The model keys, read from the env file, go into the engine's environment
 * and nowhere else; no process gets a model key from the shell. A port
 * already in use stops the start: the stack never stops or shares what it
 * did not start. stop() ends the three process groups it started and
 * removes what the slot generated.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { REPO_ROOT } from './catalog';
import { engineEnv, scrubbedLines, withoutKeys, type HeldKey, type Scrubber } from './evidence';
import { APP_ID, Store } from './store';

/** The API key the shell's sign-in uses on a local engine. */
export const LOCAL_APIKEY = 'local-test';

const DEV_PREFIX = `/apps/${APP_ID}/dev`;
const ENGINE_DIR = path.join(REPO_ROOT, 'dist', 'server');
const UI_DIR = path.join(REPO_ROOT, 'apps', 'rocket-ui');
const SHELL_DIR = path.join(REPO_ROOT, 'packages', 'shell');

/** The most stacks run --slots starts side by side. */
export const MAX_SLOTS = 8;

/** Where one slot lives on the machine. Slot 0 is the stack as it always ran. */
export interface SlotPlan {
	slot: number;
	enginePort: number;
	uiPort: number;
	shellPort: number;
	/** The generated dev config, relative to each dev server's package folder. */
	wrapper: string;
	/** The slot's folder in the run folder: its logs, the engine's store, the shell's build output and, past slot 0, the engine's clone. */
	dir: string;
}

/**
 * A slot's ports, config file name and folder. Slot 0 keeps 5565, 3010 and
 * 3000; slot k keeps to 5600 + 10k for the engine and 3100 + 10k for the shell,
 * with rocket-ui one above it.
 */
export function slotPlan(slot: number): SlotPlan {
	if (slot === 0) return { slot, enginePort: 5565, uiPort: 3010, shellPort: 3000, wrapper: '.rocketride/browser-agent-evals.rsbuild.config.mts', dir: 'stack' };
	return { slot, enginePort: 5600 + 10 * slot, uiPort: 3101 + 10 * slot, shellPort: 3100 + 10 * slot, wrapper: `.rocketride/browser-agent-evals-${slot}.rsbuild.config.mts`, dir: `stack-${slot}` };
}

/** What the trial records about the engine. */
export interface EngineInfo {
	mode: 'dist/server' | 'attached';
	url: string;
	/** What GET /version answered. */
	version: unknown;
	/** dist/server only: the engine source hash the builder recorded for the binary (build/state.json server.buildHash). */
	sourceHash?: string | null;
	/** dist/server only: where the engine keeps this run's files. */
	store?: string;
}

/** A running stack. */
export interface Stack {
	/** Its slot (0 for a single stack or an attached one). */
	slot: number;
	/** The shell, which the browser opens. */
	shellUrl: string;
	/** Whether the shell serves Rocket Builder from this checkout's dev remote (rrdev=1): a local stack. */
	devRemote: boolean;
	/** The engine, which the store client talks to. */
	engineUri: string;
	apiKey: string;
	engine: EngineInfo;
	/** Why the stack is no longer whole (a process it started exited before stop), or null while it is. */
	died(): string | null;
	stop(): Promise<void>;
}

export interface StackOptions {
	/** Attach to this shell URL instead of starting a stack. Its origin also serves the engine's paths. */
	url?: string;
	/** Start the engine only: no dev servers, no shell URL (the model smoke test). */
	engineOnly?: boolean;
	/** The API key the page and the store client sign in with. */
	apiKey: string;
	/** The model keys from the env file (readModelKeys): the only keys a started engine gets. */
	modelKeys: HeldKey[];
	/** Where the stack writes its logs and the engine's store (the run folder's slotPlan(slot).dir). */
	dir: string;
	/** Which slot to start (default 0). */
	slot?: number;
	scrubber: Scrubber;
	log: (line: string) => void;
}

/**
 * Starts the stack, or attaches to the one at `url`.
 *
 * @returns The stack, ready: a signed-in client can list the store and the shell serves the dev remote.
 */
export async function openStack(opts: StackOptions): Promise<Stack> {
	if (opts.url) {
		const origin = new URL(opts.url).origin;
		const version = await httpJson(`${origin}/version`);
		opts.log(`attached to ${origin}`);
		const host = new URL(origin).hostname;
		return { slot: 0, shellUrl: origin, devRemote: ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host), engineUri: origin, apiKey: opts.apiKey, engine: { mode: 'attached', url: origin, version }, died: () => null, stop: async () => {} };
	}
	return await startLocal(opts);
}

async function startLocal(opts: StackOptions): Promise<Stack> {
	const plan = slotPlan(opts.slot ?? 0);
	if (!fs.existsSync(path.join(ENGINE_DIR, 'engine')) || !fs.existsSync(path.join(ENGINE_DIR, 'ai', 'eaas.py'))) {
		throw new Error(`no engine in ${ENGINE_DIR}. Build one for this checkout first (README: the engine), or pass --url to use a running stack`);
	}
	for (const port of opts.engineOnly ? [plan.enginePort] : [plan.enginePort, plan.uiPort, plan.shellPort]) {
		if (await portInUse(port)) throw new Error(`port ${port} is in use by something this run did not start, such as a dev stack. Stop it and run again. Running against that stack with --url and --allow-wipe would empty its account's workspace and agent sessions`);
	}
	fs.mkdirSync(opts.dir, { recursive: true });
	const store = path.join(opts.dir, 'store');
	fs.mkdirSync(store, { recursive: true });

	const started: Array<{ name: string; child: ChildProcess; log: string }> = [];
	// what the slot generated outside its logs and store, removed when it stops
	const generated: string[] = [];
	let stopping = false;
	const removeGenerated = () => {
		for (const p of generated.splice(0)) removeGeneratedPath(p);
	};
	const stop = async () => {
		stopping = true;
		for (const s of [...started].reverse()) await stopGroup(s.child);
		removeGenerated();
	};
	const onExit = () => {
		for (const s of started) killGroup(s.child, 'SIGKILL');
		removeGenerated();
	};
	process.once('exit', onExit);
	const died = () => {
		const dead = stopping ? undefined : started.find((s) => s.child.exitCode !== null || s.child.signalCode !== null);
		return dead ? `slot ${plan.slot}'s ${dead.name} process exited (${dead.child.exitCode ?? dead.child.signalCode}); see ${dead.log}` : null;
	};
	const begin = (name: string, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
		const p = startProcess(name, cmd, args, cwd, env, opts.dir, opts.scrubber);
		p.child.once('exit', (code, signal) => {
			if (!stopping) opts.log(`the ${name} process exited (${code ?? signal}) while the stack was up; see ${p.log}`);
		});
		started.push(p);
	};

	try {
		// step: past slot 0 the engine runs from its own APFS clone of dist/server, without the engine's .env
		let engineDir = ENGINE_DIR;
		if (plan.slot > 0) {
			engineDir = path.join(opts.dir, 'engine');
			generated.push(engineDir);
			await cloneEngine(engineDir);
		}
		// step: the engine, the env file's model keys in its environment only, its store in the run folder
		const env: NodeJS.ProcessEnv = { ...engineEnv(opts.modelKeys), RR_STORE_URL: `filesystem://${store}` };
		begin('engine', './engine', ['ai/eaas.py', `--port=${plan.enginePort}`], engineDir, env);
		opts.log(`starting the engine from ${path.relative(REPO_ROOT, engineDir)} on ${plan.enginePort}, store ${store}`);
		const engineUri = `http://127.0.0.1:${plan.enginePort}`;
		const version = await waitFor('the engine to answer /version', 300_000, () => httpJson(`${engineUri}/version`), started);
		await waitFor(
			'a signed-in client to list the store',
			60_000,
			async () => {
				const s = await Store.connect(engineUri, opts.apiKey);
				await s.workspaceFiles();
				await s.close();
				return true;
			},
			started
		);
		const engine: EngineInfo = { mode: 'dist/server', url: engineUri, version, sourceHash: builtHash(), store };
		const up = (shellUrl: string): Stack => ({
			slot: plan.slot,
			shellUrl,
			devRemote: shellUrl !== '',
			engineUri,
			apiKey: opts.apiKey,
			engine,
			died,
			stop: async () => {
				process.removeListener('exit', onExit);
				await stop();
			},
		});

		if (opts.engineOnly) {
			opts.log('engine ready (no dev servers)');
			return up('');
		}

		// step: the dev servers, through generated configs that git ignores (.rocketride/), the shell's build output in the slot's folder
		const shellOut = path.join(opts.dir, 'shell-dist');
		generated.push(shellOut);
		generated.push(writeWrapper(UI_DIR, plan.wrapper, uiWrapper(plan)));
		generated.push(writeWrapper(SHELL_DIR, plan.wrapper, shellWrapper(plan, shellOut)));
		// step: the dev servers get no key
		const devEnv = withoutKeys(process.env);
		begin('rocket-ui', './node_modules/.bin/rsbuild', ['dev', '--config', plan.wrapper], UI_DIR, devEnv);
		begin('shell', './node_modules/.bin/rsbuild', ['dev', '--config', plan.wrapper], SHELL_DIR, devEnv);
		opts.log(`starting the rocket-ui dev remote on ${plan.uiPort} and the shell dev server on ${plan.shellPort}`);
		await waitFor('the rocket-ui dev remote', 300_000, () => httpOk(`http://127.0.0.1:${plan.uiPort}${DEV_PREFIX}/remoteEntry.js`), started);
		await waitFor('the shell dev server and its proxy', 300_000, () => httpOk(`http://127.0.0.1:${plan.shellPort}${DEV_PREFIX}/package.json`), started);

		const shellUrl = `http://127.0.0.1:${plan.shellPort}`;
		opts.log(`stack ready at ${shellUrl}`);
		return up(shellUrl);
	} catch (err) {
		await stop();
		process.removeListener('exit', onExit);
		throw err;
	}
}

/** An APFS clone of dist/server (cp -c: no full copy), without the engine's .env, which is removed unread. */
async function cloneEngine(to: string): Promise<void> {
	fs.rmSync(to, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(to), { recursive: true });
	await promisify(execFile)('cp', ['-c', '-R', ENGINE_DIR, to]);
	fs.rmSync(path.join(to, '.env'), { force: true });
}

// =============================================================================
// the generated dev configs (launch.sh's wrappers)
// =============================================================================

/** rocket-ui under the dev prefix, the shape a local-first dev server has (apps/vscode/src/appdev/proxyConfig.ts). */
export function uiWrapper(plan: SlotPlan): string {
	return `// GENERATED by browser-agent-evals for one run. Do not edit or commit.
import { mergeRsbuildConfig } from '@rsbuild/core';
import appConfigExport from '../rsbuild.config.mts';

const appConfig = typeof appConfigExport === 'function'
	? appConfigExport({ env: 'development', command: 'dev', envMode: 'development' })
	: appConfigExport;

export default mergeRsbuildConfig(appConfig, {
	dev: { assetPrefix: '${DEV_PREFIX}/', hmr: false, liveReload: false },
	output: { copy: [{ from: 'package.json', to: '.' }, { from: 'icon.svg', to: '.' }] },
	server: { host: '127.0.0.1', port: ${plan.uiPort}, strictPort: true },
});
`;
}

/**
 * The shell's own dev config, with the dev prefix sent to the slot's
 * rocket-ui first (so it wins over the '/apps/' rule), every engine path the
 * shell proxies sent to the slot's engine, and the build output in the
 * slot's folder (the shell writes it to disk and empties it on start). A
 * proxy rule that does not go to the engine on 5565 stops the start: a slot
 * must not reach another slot's server.
 *
 * @param plan - The slot.
 * @param outDir - Where the shell writes its build output.
 * @param base - The shell's own dev config.
 */
export function shellWrapper(plan: SlotPlan, outDir: string, base = path.join(SHELL_DIR, 'rsbuild.config.mts')): string {
	const enginePort = slotPlan(0).enginePort;
	return `// GENERATED by browser-agent-evals for one run. Do not edit or commit.
import shellConfigExport from ${JSON.stringify(base)};

const base = typeof shellConfigExport === 'function'
	? shellConfigExport({ env: 'development', command: 'dev', envMode: 'development' })
	: shellConfigExport;

const engine = 'http://127.0.0.1:${plan.enginePort}';
const baseProxy = base.server?.proxy;
if (!baseProxy || typeof baseProxy !== 'object' || Array.isArray(baseProxy)) throw new Error('browser-agent-evals: the shell dev config has no proxy map to point at the slot engine');
const proxy = { '${DEV_PREFIX}': { target: 'http://127.0.0.1:${plan.uiPort}' } };
for (const [route, rule] of Object.entries(baseProxy)) {
	const target = typeof rule === 'string' ? rule : rule?.target;
	if (typeof target !== 'string' || new URL(target).port !== '${enginePort}') {
		throw new Error('browser-agent-evals: the shell proxies ' + route + ' to ' + String(target) + ', not the engine on ${enginePort}; tools/browser-agent-evals/src/stack.ts must learn where it goes');
	}
	proxy[route] = typeof rule === 'string' ? engine : { ...rule, target: engine };
}

export default {
	...base,
	output: { ...base.output, distPath: { ...base.output?.distPath, root: ${JSON.stringify(outDir)} } },
	server: {
		...base.server,
		host: '127.0.0.1',
		port: ${plan.shellPort},
		strictPort: true,
		proxy,
	},
};
`;
}

/** Writes a generated config into a package folder, and returns its path. */
function writeWrapper(dir: string, wrapper: string, text: string): string {
	const file = path.join(dir, wrapper);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

/** Removes something a slot generated; a generated config's .rocketride folder goes too once it is empty. */
function removeGeneratedPath(p: string): void {
	fs.rmSync(p, { recursive: true, force: true });
	const folder = path.dirname(p);
	if (path.basename(folder) === '.rocketride' && fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
}

// =============================================================================
// processes
// =============================================================================

/** Starts a command as the leader of its own process group, its output scrubbed into <dir>/<name>.log line by line. */
function startProcess(name: string, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, dir: string, scrubber: Scrubber): { name: string; child: ChildProcess; log: string } {
	const log = path.join(dir, `${name}.log`);
	const fd = fs.openSync(log, 'a');
	const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	const out = scrubbedLines(fd, scrubber);
	const err = scrubbedLines(fd, scrubber);
	child.stdout?.on('data', (chunk: Buffer) => out.write(chunk));
	child.stderr?.on('data', (chunk: Buffer) => err.write(chunk));
	child.on('close', () => {
		out.end();
		err.end();
		fs.closeSync(fd);
	});
	child.on('error', () => {
		/* reported by waitFor, which sees the process gone */
	});
	return { name, child, log };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		/* already gone */
	}
}

/** SIGTERM to the group, then SIGKILL after 15 seconds. */
async function stopGroup(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
	killGroup(child, 'SIGTERM');
	const timer = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), 15_000));
	if ((await Promise.race([exited, timer])) === 'late') {
		killGroup(child, 'SIGKILL');
		await exited;
	}
}

/** Polls until `probe` returns a value, failing early when a started process has exited. */
async function waitFor<T>(what: string, ms: number, probe: () => Promise<T | false>, started: Array<{ name: string; child: ChildProcess; log: string }>): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const dead = started.find((s) => s.child.exitCode !== null || s.child.signalCode !== null);
		if (dead) throw new Error(`the ${dead.name} process exited while waiting for ${what}; see ${dead.log}`);
		try {
			const v = await probe();
			if (v !== false) return v;
		} catch {
			/* not up yet */
		}
		if (Date.now() - t0 > ms) throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 2000));
	}
}

// =============================================================================
// probes
// =============================================================================

function portInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: '127.0.0.1', port });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
	});
}

async function httpOk(url: string): Promise<boolean> {
	const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	return res.ok;
}

async function httpJson(url: string): Promise<unknown> {
	const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text.slice(0, 200);
	}
}

/** The engine source hash the builder recorded when it put the binary in dist/server. */
function builtHash(): string | null {
	try {
		const state = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'build', 'state.json'), 'utf8')) as { server?: { buildHash?: string } };
		return state.server?.buildHash ?? null;
	} catch {
		return null;
	}
}
