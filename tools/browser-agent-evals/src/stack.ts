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
 * The model keys, read from the env file, go into the engine's environment
 * and nowhere else; no process gets a model key from the shell. A port
 * already in use stops the start: the stack never stops or shares what it
 * did not start. stop() ends the three process groups it started.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { REPO_ROOT } from './catalog';
import { engineEnv, scrubbedLines, withoutKeys, type HeldKey, type Scrubber } from './evidence';
import { APP_ID, Store } from './store';

export const ENGINE_PORT = 5565;
export const SHELL_PORT = 3000;
export const UI_PORT = 3010;
/** The API key the shell's sign-in uses on a local engine. */
export const LOCAL_APIKEY = 'local-test';

const DEV_PREFIX = `/apps/${APP_ID}/dev`;
const ENGINE_DIR = path.join(REPO_ROOT, 'dist', 'server');
const WRAPPER = '.rocketride/browser-agent-evals.rsbuild.config.mts';
const UI_DIR = path.join(REPO_ROOT, 'apps', 'rocket-ui');
const SHELL_DIR = path.join(REPO_ROOT, 'packages', 'shell');

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
	/** The shell, which the browser opens. */
	shellUrl: string;
	/** Whether the shell serves Rocket Builder from this checkout's dev remote (rrdev=1): a local stack. */
	devRemote: boolean;
	/** The engine, which the store client talks to. */
	engineUri: string;
	apiKey: string;
	engine: EngineInfo;
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
	/** Where the stack writes its logs and the engine's store. */
	dir: string;
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
		return { shellUrl: origin, devRemote: ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host), engineUri: origin, apiKey: opts.apiKey, engine: { mode: 'attached', url: origin, version }, stop: async () => {} };
	}
	return await startLocal(opts);
}

async function startLocal(opts: StackOptions): Promise<Stack> {
	if (!fs.existsSync(path.join(ENGINE_DIR, 'engine')) || !fs.existsSync(path.join(ENGINE_DIR, 'ai', 'eaas.py'))) {
		throw new Error(`no engine in ${ENGINE_DIR}. Build one for this checkout first (README: the engine), or pass --url to use a running stack`);
	}
	for (const port of opts.engineOnly ? [ENGINE_PORT] : [ENGINE_PORT, UI_PORT, SHELL_PORT]) {
		if (await portInUse(port)) throw new Error(`port ${port} is in use by something this run did not start, such as a dev stack. Stop it and run again. Running against that stack with --url and --allow-wipe would empty its account's workspace and agent sessions`);
	}
	fs.mkdirSync(opts.dir, { recursive: true });
	const store = path.join(opts.dir, 'store');
	fs.mkdirSync(store, { recursive: true });

	const started: Array<{ name: string; child: ChildProcess; log: string }> = [];
	const removeWrappers: Array<() => void> = [];
	const stop = async () => {
		for (const s of started.reverse()) await stopGroup(s.child);
		started.length = 0;
		for (const remove of removeWrappers.splice(0)) remove();
	};
	const onExit = () => {
		for (const s of started) killGroup(s.child, 'SIGKILL');
	};
	process.once('exit', onExit);

	try {
		// step: the engine, the env file's model keys in its environment only, its store in the run folder
		const env: NodeJS.ProcessEnv = { ...engineEnv(opts.modelKeys), RR_STORE_URL: `filesystem://${store}` };
		started.push(startProcess('engine', './engine', ['ai/eaas.py', `--port=${ENGINE_PORT}`], ENGINE_DIR, env, opts.dir, opts.scrubber));
		opts.log(`starting the engine from dist/server on ${ENGINE_PORT}, store ${store}`);
		const engineUri = `http://127.0.0.1:${ENGINE_PORT}`;
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

		if (opts.engineOnly) {
			opts.log('engine ready (no dev servers)');
			return {
				shellUrl: '',
				devRemote: false,
				engineUri,
				apiKey: opts.apiKey,
				engine: { mode: 'dist/server', url: engineUri, version, sourceHash: builtHash(), store },
				stop: async () => {
					process.removeListener('exit', onExit);
					await stop();
				},
			};
		}

		// step: the dev servers, through generated configs that git ignores (.rocketride/)
		removeWrappers.push(writeWrapper(UI_DIR, uiWrapper()), writeWrapper(SHELL_DIR, shellWrapper()));
		// step: the dev servers get no key
		const devEnv = withoutKeys(process.env);
		started.push(startProcess('rocket-ui', './node_modules/.bin/rsbuild', ['dev', '--config', WRAPPER], UI_DIR, devEnv, opts.dir, opts.scrubber));
		started.push(startProcess('shell', './node_modules/.bin/rsbuild', ['dev', '--config', WRAPPER], SHELL_DIR, devEnv, opts.dir, opts.scrubber));
		opts.log(`starting the rocket-ui dev remote on ${UI_PORT} and the shell dev server on ${SHELL_PORT}`);
		await waitFor('the rocket-ui dev remote', 300_000, () => httpOk(`http://127.0.0.1:${UI_PORT}${DEV_PREFIX}/remoteEntry.js`), started);
		await waitFor('the shell dev server and its proxy', 300_000, () => httpOk(`http://127.0.0.1:${SHELL_PORT}${DEV_PREFIX}/package.json`), started);

		const shellUrl = `http://127.0.0.1:${SHELL_PORT}`;
		opts.log(`stack ready at ${shellUrl}`);
		return {
			shellUrl,
			devRemote: true,
			engineUri,
			apiKey: opts.apiKey,
			engine: { mode: 'dist/server', url: engineUri, version, sourceHash: builtHash(), store },
			stop: async () => {
				process.removeListener('exit', onExit);
				await stop();
			},
		};
	} catch (err) {
		await stop();
		process.removeListener('exit', onExit);
		throw err;
	}
}

// =============================================================================
// the generated dev configs (launch.sh's wrappers)
// =============================================================================

/** rocket-ui under the dev prefix, the shape a local-first dev server has (apps/vscode/src/appdev/proxyConfig.ts). */
function uiWrapper(): string {
	return `// GENERATED by browser-agent-evals for one run. Do not edit or commit.
import { mergeRsbuildConfig } from '@rsbuild/core';
import appConfigExport from '../rsbuild.config.mts';

const appConfig = typeof appConfigExport === 'function'
	? appConfigExport({ env: 'development', command: 'dev', envMode: 'development' })
	: appConfigExport;

export default mergeRsbuildConfig(appConfig, {
	dev: { assetPrefix: '${DEV_PREFIX}/', hmr: false, liveReload: false },
	output: { copy: [{ from: 'package.json', to: '.' }, { from: 'icon.svg', to: '.' }] },
	server: { host: '127.0.0.1', port: ${UI_PORT}, strictPort: true },
});
`;
}

/** The shell's own dev config plus one proxy rule first, so the dev remote wins over the '/apps/' rule to the engine. */
function shellWrapper(): string {
	return `// GENERATED by browser-agent-evals for one run. Do not edit or commit.
import shellConfigExport from '../rsbuild.config.mts';

const base = typeof shellConfigExport === 'function'
	? shellConfigExport({ env: 'development', command: 'dev', envMode: 'development' })
	: shellConfigExport;

export default {
	...base,
	server: {
		...base.server,
		host: '127.0.0.1',
		port: ${SHELL_PORT},
		strictPort: true,
		proxy: { '${DEV_PREFIX}': { target: 'http://127.0.0.1:${UI_PORT}' }, ...(base.server?.proxy ?? {}) },
	},
};
`;
}

/** Writes a generated config and returns a function that removes it, and its folder when this made the folder. */
function writeWrapper(dir: string, text: string): () => void {
	const file = path.join(dir, WRAPPER);
	const folder = path.dirname(file);
	const made = !fs.existsSync(folder);
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(file, text);
	return () => {
		fs.rmSync(file, { force: true });
		if (made && fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
	};
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
