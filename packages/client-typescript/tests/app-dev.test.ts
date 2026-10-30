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

/**
 * The app dev loop (`rocketride/app-dev`) and `rocketride app dev`.
 *
 * The session tests run the REAL loop — embedded guard, guarded spawn,
 * output classification, the proxy wrapper, tree stop — against
 * a stand-in `node_modules/@rsbuild/core/bin/rsbuild.js` that prints
 * rsbuild's banner and a build line, then idles.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { classifyDevOutput, DEV_SERVER_GUARD_SOURCE, DevSession, devPreviewUrl, materializeDevServerGuard, resolveRsbuildInvocation, splitCompleteLines, stopDevServer, writeProxyConfig } from '../src/app-dev/index';
import * as vendor from '../src/app-pack/vendor';
import * as common from '../src/cli/common';
import { executeAppDev } from '../src/cli/commands/app';
import { Output } from '../src/cli/output';

let ws: string;

beforeEach(() => {
	ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-app-dev-'));
});

afterEach(() => {
	jest.restoreAllMocks();
	fs.rmSync(ws, { recursive: true, force: true });
});

/** A connectClient stand-in for executeAppDev (validated once, then dropped). */
function fakeClient() {
	const calls: Array<Record<string, unknown>> = [];
	return { calls, call: async (_command: string, args: Record<string, unknown>) => { calls.push(args); return {}; }, disconnect: async () => undefined };
}

/** Writes an app at apps/clock-ui whose "rsbuild" prints a dev banner and a build. */
function writeServedApp(port = 3999): { folder: string; app: { id: string; name: string; moduleId: string; folder: string } } {
	const folder = path.join(ws, 'apps', 'clock-ui');
	const bin = path.join(folder, 'node_modules', '@rsbuild', 'core', 'bin');
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'clock-ui', version: '0.1.0', appManifest: { id: 'acme.clock', name: 'Clock' } }));
	fs.writeFileSync(path.join(folder, 'clock.rrapp'), '{}');
	fs.writeFileSync(path.join(bin, 'rsbuild.js'), `console.log('  \\u279c Local:    http://localhost:${port}/');\nconsole.log('ready   built in 0.10 s');\nsetInterval(() => {}, 1000);\n`);
	return { folder, app: { id: 'acme.clock', name: 'Clock', moduleId: 'acme_clock', folder } };
}

/** Polls until the condition holds (fails the test after ~5 s). */
async function waitFor(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	expect(condition()).toBe(true);
}

describe('primitives', () => {
	it('devPreviewUrl locks the app and turns dev hooks on, on the dev origin', () => {
		// Local-first: the DEV SERVER's own origin is the session identity —
		// no nonce rides the URL; the page self-registers by convention.
		expect(devPreviewUrl('http://localhost:3013/', 'acme.clock')).toBe('http://localhost:3013/?appid=acme.clock&rrdev=1');
		expect(devPreviewUrl('http://localhost:3013', 'acme.clock')).not.toContain('rrsession');
	});

	it('splitCompleteLines carries a torn line to the next chunk', () => {
		const first = splitCompleteLines('', 'one\ntw');
		expect(first).toEqual({ lines: ['one'], rest: 'tw' });
		expect(splitCompleteLines(first.rest, 'o\r\n')).toEqual({ lines: ['two'], rest: '' });
	});

	it('classifyDevOutput reads the banner and build edges, ignoring [browser] relays', () => {
		expect(classifyDevOutput(['  ➜ Local:    http://localhost:3013/'])).toEqual({ origin: 'http://localhost:3013' });
		expect(classifyDevOutput(['ready   built in 1.24 s']).event).toBe('built');
		expect(classifyDevOutput(['error   build failed']).event).toBe('failed');
		expect(classifyDevOutput(['start   building src/App.tsx']).event).toBe('building');
		expect(classifyDevOutput(['error   [browser] Uncaught TypeError: x is undefined']).event).toBeUndefined();
	});

	it('resolveRsbuildInvocation prefers a hoisted local bin, else pnpm exec', () => {
		const bin = path.join(ws, 'node_modules', '@rsbuild', 'core', 'bin');
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, 'rsbuild.js'), '');
		const app = path.join(ws, 'apps', 'x');
		fs.mkdirSync(app, { recursive: true });

		expect(resolveRsbuildInvocation(app)).toEqual({ cmd: process.execPath, args: [path.join(bin, 'rsbuild.js')], shell: false });
		fs.rmSync(path.join(ws, 'node_modules'), { recursive: true });
		expect(resolveRsbuildInvocation(app).cmd).toBe('pnpm');
	});

	it('writeProxyConfig renders the front-door wrapper: dev prefix carved out, engine proxied, manifest copied', async () => {
		const folder = path.join(ws, 'apps', 'clock-ui');
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'clock-ui', appManifest: { id: 'acme.clock', icon: 'assets/icon.png' } }));
		fs.writeFileSync(path.join(folder, 'rsbuild.config.mts'), 'export default {};');

		const wrapperPath = await writeProxyConfig(folder, 'acme.clock', 'http://localhost:5565');
		const wrapper = fs.readFileSync(wrapperPath, 'utf8');

		expect(wrapperPath).toBe(path.join(folder, '.rocketride', 'dev-proxy.rsbuild.config.mts'));
		expect(wrapper).toContain('"/apps/acme.clock/dev"');
		expect(wrapper).toContain('"http://localhost:5565"');
		// the catch-all proxy must carve out the locally served prefixes
		expect(wrapper).toContain('pathFilter');
		expect(wrapper).toContain('!/rsbuild-hmr');
		// manifest + declared icon ride the compiled output for self-registration
		expect(wrapper).toContain('"package.json"');
		expect(wrapper).toContain('"assets/icon.png"');
	});

	it('materializeDevServerGuard writes the guard once, owner-only', () => {
		const file = materializeDevServerGuard();

		expect(fs.readFileSync(file, 'utf8')).toBe(DEV_SERVER_GUARD_SOURCE);
		expect(materializeDevServerGuard()).toBe(file);
	});

	it('the guard passes output through and dies when its stdin closes', async () => {
		const proc = spawn(process.execPath, [materializeDevServerGuard(), String(process.pid), '0', process.execPath, '-e', "console.log('hello from child'); setInterval(() => {}, 1000)"], { stdio: ['pipe', 'pipe', 'pipe'] });
		let output = '';
		await new Promise<void>((resolve) => {
			proc.stdout.on('data', (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes('hello from child')) resolve();
			});
		});

		await stopDevServer(proc, 10_000);

		expect(output).toContain('hello from child');
		expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
	});
});

describe('DevSession', () => {
	it('serves through the generated proxy wrapper and stops clean (nothing to unregister)', async () => {
		const { app } = writeServedApp(3999);
		const states: string[] = [];
		const session = new DevSession({ app, workspaceRoot: ws, engineOrigin: 'http://localhost:5565', install: false, watchPackageJson: false, onState: (s) => states.push(s) });

		const origin = await session.start();
		await new Promise((resolve) => setTimeout(resolve, 200));
		await session.stop();

		expect(origin).toBe('http://localhost:3999');
		// the per-session wrapper is the preview's front door
		const wrapper = fs.readFileSync(path.join(app.folder, '.rocketride', 'dev-proxy.rsbuild.config.mts'), 'utf8');
		expect(wrapper).toContain('"http://localhost:5565"');
		expect(wrapper).toContain('"/apps/acme.clock/dev"');
		expect(states).toContain('ok');
		expect(states[states.length - 1]).toBe('stopped');
	});

	it('serializes package.json restarts so an overlapping one never spawns a second server', async () => {
		const { app } = writeServedApp(3997);
		const installs: Array<() => void> = [];
		jest.spyOn(vendor, 'runRootInstall').mockImplementation(() => new Promise<void>((resolve) => installs.push(resolve)));
		const states: string[] = [];
		const session = new DevSession({ app, workspaceRoot: ws, engineOrigin: 'http://localhost:5565', watchPackageJson: false, onState: (s) => states.push(s) });
		const restart = () => (session as unknown as { requestRestart(): void }).requestRestart();

		const started = session.start();
		await waitFor(() => installs.length === 1);
		installs[0]();
		await started;

		// step: a second change lands while the first restart is installing
		restart();
		await waitFor(() => installs.length === 2);
		restart();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(installs.length).toBe(2);

		// step: the queued restart runs only after the first one spawned
		installs[1]();
		await waitFor(() => installs.length === 3);
		expect(states.filter((s) => s === 'starting').length).toBe(2);
		installs[2]();
		await waitFor(() => states.filter((s) => s === 'starting').length === 3);

		// the last spawned server is the one stop() must end; a signal-killed
		// process (Linux/macOS tree kill) has exitCode null and signalCode set
		const proc = (session as unknown as { proc: { exitCode: number | null; signalCode: string | null } }).proc;
		await session.stop();
		await waitFor(() => proc.exitCode !== null || proc.signalCode !== null);
	});

	it('keeps restarting after successive atomic saves of package.json', async () => {
		const { folder, app } = writeServedApp(3996);
		const lines: string[] = [];
		const session = new DevSession({ app, workspaceRoot: ws, engineOrigin: 'http://localhost:5565', install: false, onLine: (line) => lines.push(line) });
		const restarts = () => lines.filter((l) => l.startsWith('package.json changed')).length;
		const atomicSave = (version: string) => {
			const pkg = path.join(folder, 'package.json');
			fs.writeFileSync(`${pkg}.new`, JSON.stringify({ name: 'clock-ui', version, appManifest: { id: 'acme.clock', name: 'Clock' } }));
			fs.renameSync(`${pkg}.new`, pkg);
		};

		await session.start();
		atomicSave('0.1.1');
		await waitFor(() => restarts() === 1);
		atomicSave('0.1.2');
		await waitFor(() => restarts() === 2);
		await session.stop();
	}, 15000);
});

describe('executeAppDev', () => {
	it('prints the dev-origin preview URL, runs until interrupted, then stops', async () => {
		writeServedApp(3998);
		const client = fakeClient();
		jest.spyOn(common, 'connectClient').mockImplementation(async () => client as unknown as Awaited<ReturnType<typeof common.connectClient>>);
		const logs: string[] = [];
		jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(' '));
		});
		jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const running = executeAppDev('clock', { uri: 'https://api.rocketride.ai', apikey: 'k', workspace: ws, install: false }, new Output(undefined));
		for (let i = 0; i < 100 && !logs.some((l) => l.startsWith('Preview:')); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(common.takeInterrupt()).toBe(true);

		expect(await running).toBe(0);
		expect(logs.join('\n')).toContain('Dev server: http://localhost:3998');
		// local-first: the preview rides the DEV SERVER's origin, not the engine's
		expect(logs.join('\n')).toContain('Preview:    http://localhost:3998/?appid=acme.clock&rrdev=1');
		expect(client.calls.length).toBe(0);
	});
});
