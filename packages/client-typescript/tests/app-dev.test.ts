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
 * output classification, overlay register/unregister, tree stop — against
 * a stand-in `node_modules/@rsbuild/core/bin/rsbuild.js` that prints
 * rsbuild's banner and a build line, then idles.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { classifyDevOutput, DEV_SERVER_GUARD_SOURCE, DEV_SESSION_NONCE, DevSession, devPreviewUrl, materializeDevServerGuard, registerDevOverlay, resolveRsbuildInvocation, splitCompleteLines, stopDevServer, unregisterDevOverlay } from '../src/app-dev/index';
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

/** A client stand-in recording every overlay call. */
function fakeClient() {
	const calls: Array<Record<string, unknown>> = [];
	return { calls, call: async (_command: string, args: Record<string, unknown>) => { calls.push(args); return {}; } };
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
	it('devPreviewUrl locks the app, turns dev hooks on, and routes to this host', () => {
		expect(devPreviewUrl('https://api.rocketride.ai/', 'acme.clock', 'nonce-1')).toBe('https://api.rocketride.ai/?appid=acme.clock&rrdev=1&rrsession=nonce-1');
		expect(devPreviewUrl('http://localhost:5565', 'acme.clock')).toContain(`rrsession=${DEV_SESSION_NONCE}`);
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

	it('registerDevOverlay sends a cache-busted entry under this host session; unregister drops it', async () => {
		const client = fakeClient();

		await registerDevOverlay(client, { moduleId: 'acme_clock', appId: 'acme.clock', origin: 'http://localhost:3013', name: 'Clock' });
		await unregisterDevOverlay(client, 'acme_clock');

		expect(client.calls[0]).toMatchObject({ subcommand: 'register_dev', moduleId: 'acme_clock', appId: 'acme.clock', session: DEV_SESSION_NONCE, name: 'Clock' });
		expect(String(client.calls[0].url)).toMatch(/^http:\/\/localhost:3013\/remoteEntry\.js\?t=\d+$/);
		expect(client.calls[1]).toEqual({ subcommand: 'register_dev', moduleId: 'acme_clock', unregister: true });
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
	it('serves, registers the overlay on build, and unregisters on stop', async () => {
		const { app } = writeServedApp(3999);
		const client = fakeClient();
		const states: string[] = [];
		const session = new DevSession({ app, workspaceRoot: ws, client, install: false, watchPackageJson: false, onState: (s) => states.push(s) });

		const origin = await session.start();
		await new Promise((resolve) => setTimeout(resolve, 200));
		await session.stop();

		expect(origin).toBe('http://localhost:3999');
		expect(client.calls.filter((c) => c.subcommand === 'register_dev' && !c.unregister).length).toBeGreaterThanOrEqual(1);
		expect(client.calls[client.calls.length - 1]).toEqual({ subcommand: 'register_dev', moduleId: 'acme_clock', unregister: true });
		expect(states).toContain('ok');
		expect(states[states.length - 1]).toBe('stopped');
	});

	it('serializes package.json restarts so an overlapping one never spawns a second server', async () => {
		const { app } = writeServedApp(3997);
		const installs: Array<() => void> = [];
		jest.spyOn(vendor, 'runRootInstall').mockImplementation(() => new Promise<void>((resolve) => installs.push(resolve)));
		const states: string[] = [];
		const session = new DevSession({ app, workspaceRoot: ws, client: fakeClient(), watchPackageJson: false, onState: (s) => states.push(s) });
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
		const session = new DevSession({ app, workspaceRoot: ws, client: fakeClient(), install: false, onLine: (line) => lines.push(line) });
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
	it('prints the preview URL, runs until interrupted, then stops and unregisters', async () => {
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
		expect(logs.join('\n')).toContain(`Preview:    https://api.rocketride.ai/?appid=acme.clock&rrdev=1&rrsession=${DEV_SESSION_NONCE}`);
		expect(client.calls[client.calls.length - 1]).toEqual({ subcommand: 'register_dev', moduleId: 'acme_clock', unregister: true });
	});
});
