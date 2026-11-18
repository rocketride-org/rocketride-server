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
// THE ENGINE SERVER OF ONE RUN
// =============================================================================
// Starts `server/serve.py` (the engine's Python web stack with the fixture app)
// on a free port, with generated keys. Nothing here is a real secret: every key
// is random bytes made for this process.
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Playwright loads this file as CommonJS, where __dirname is defined.
const HERE = __dirname;
export const E2E_ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(E2E_ROOT, '..', '..', '..');
export const FIXTURE_ID = 'e2e.fixture';

export type IsolationMode = 'enforce' | 'optin' | 'off';

export interface IServerOptions {
	mode: IsolationMode;
	/** `team` (default): the fixture is bound to the local team, so it is absent from the public probe. */
	audience?: 'public' | 'team';
	/** API key to user id, for the specs that need two users. */
	users?: Record<string, { userId: string; displayName?: string }>;
}

export interface IServer {
	mode: IsolationMode;
	port: number;
	/** The shell origin, `http://localhost:<port>`. */
	origin: string;
	/** The fixture app's origin under the template (also what the app uses under `off`: not used). */
	appOrigin: string;
	label: string;
	apiKey: string;
	url(pathname: string): string;
	json<T = unknown>(pathname: string, init?: { method?: string; body?: unknown }): Promise<T>;
	commands(): Promise<Array<{ command: string; subcommand: string | null; user: string | null; authenticated: boolean; credential: boolean; t: number }>>;
	hits(): Promise<Array<{ path: string; host: string }>>;
	clear(): Promise<void>;
	seed(stamp: number): Promise<{ version: number }>;
	orgChange(): Promise<{ sent: number; t: number }>;
	log(): string;
	stop(): Promise<void>;
}

const b64url = (bytes: number): string => randomBytes(bytes).toString('base64url');

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address() as net.AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}

/** Starts one engine server; resolves when `/__e2e/info` answers. */
export async function startServer(options: IServerOptions): Promise<IServer> {
	const port = await freePort();
	const apiKey = `e2e-key-${b64url(12)}`;
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-e2e-'));
	const store = path.join(runDir, 'store');
	fs.mkdirSync(store, { recursive: true });

	// E2E_SRC_ROOT points the engine's Python at another checkout (the red base runs the PR1 head's server and shell).
	const src = process.env.E2E_SRC_ROOT ?? REPO_ROOT;
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PYTHONPATH: [path.join(src, 'packages/ai/src'), path.join(src, 'packages/client-python/src'), path.join(src, 'packages/server/engine-lib/rocketlib-python/lib')].join(path.delimiter),
		PYTHONUNBUFFERED: '1',
		E2E_PORT: String(port),
		E2E_FIXTURE_DIST: path.join(E2E_ROOT, '.build', 'fixture-app'),
		E2E_HOME_DIST: path.join(E2E_ROOT, '.build', 'home-app'),
		E2E_STORE: store,
		E2E_RUN_DIR: runDir,
		E2E_AUDIENCE: options.audience ?? 'team',
		E2E_USERS: JSON.stringify(options.users ?? {}),
		ROCKETRIDE_APIKEY: apiKey,
		RR_APP_ISOLATION: options.mode,
	};
	if (options.mode !== 'off') {
		Object.assign(env, {
			RR_APP_ORIGIN_TEMPLATE: `http://{label}.apps.localhost:${port}`,
			RR_SHELL_ORIGINS: `http://localhost:${port}`,
			RR_FRONTEND_ORIGIN: `http://localhost:${port}`,
			RR_APP_FRAME_TOKEN_KEYS: `k1:${b64url(32)}`,
			RR_APP_ALIAS_KEY: b64url(32),
		});
		if (options.mode === 'optin') env.RR_APP_ISOLATION_APPS = FIXTURE_ID;
	}

	let output = '';
	const child: ChildProcess = spawn(process.env.E2E_PYTHON ?? 'python3', [path.join(E2E_ROOT, 'server', 'serve.py')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout?.on('data', (chunk) => (output = (output + chunk).slice(-60_000)));
	child.stderr?.on('data', (chunk) => (output = (output + chunk).slice(-60_000)));
	let exited = false;
	child.on('exit', () => (exited = true));

	const origin = `http://localhost:${port}`;
	const stop = async (): Promise<void> => {
		if (!exited) {
			child.kill('SIGTERM');
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => (child.kill('SIGKILL'), resolve()), 5000);
				child.once('exit', () => (clearTimeout(timer), resolve()));
			});
		}
		fs.rmSync(runDir, { recursive: true, force: true });
	};

	const json = async <T>(pathname: string, init?: { method?: string; body?: unknown }): Promise<T> => {
		const response = await fetch(origin + pathname, { method: init?.method ?? 'GET', headers: { 'content-type': 'application/json' }, body: init?.body === undefined ? undefined : JSON.stringify(init.body) });
		if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status}`);
		return (await response.json()) as T;
	};

	const deadline = Date.now() + 60_000;
	let info: { label: string } | null = null;
	while (Date.now() < deadline && !info) {
		if (exited) throw new Error(`the e2e server exited during start-up:\n${output.slice(-4000)}`);
		try {
			info = await json<{ label: string }>('/__e2e/info');
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	if (!info) {
		await stop();
		throw new Error(`the e2e server did not answer in 60 s:\n${output.slice(-4000)}`);
	}

	return {
		mode: options.mode,
		port,
		origin,
		appOrigin: `http://${info.label}.apps.localhost:${port}`,
		label: info.label,
		apiKey,
		url: (pathname) => origin + pathname,
		json,
		commands: () => json('/__e2e/commands'),
		hits: () => json('/__e2e/hits'),
		clear: async () => void (await json('/__e2e/clear', { method: 'POST' })),
		seed: (stamp) => json('/__e2e/seed', { method: 'POST', body: { stamp } }),
		orgChange: () => json('/__e2e/org-change', { method: 'POST' }),
		log: () => output,
		stop,
	};
}
