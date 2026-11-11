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
 * The SDK's app workspace logic — the ONE scaffold, discovery, manifest,
 * and preflight shared by the VS Code extension and the CLI. Everything
 * runs against a temp workspace with no server and no install.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createAppWorkspace,
	DEFAULT_DEVELOPER_ID,
	ensureProjectId,
	ensureWorkspaceFile,
	ensureWorkspaceGitignore,
	preflightApp,
	readAppListing,
	readProjectIdAt,
	resolveDeveloperId,
	saveAppListing,
	scanAppMarkers,
} from '../src/app-pack/index';

let ws: string;

beforeEach(() => {
	ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-app-ws-'));
});

afterEach(() => {
	fs.rmSync(ws, { recursive: true, force: true });
});

/** Reads a workspace-relative file as text. */
const read = (rel: string): string => fs.readFileSync(path.join(ws, rel), 'utf8');

/** Writes a minimal app (package.json + optional marker) at a workspace-relative folder. */
function writeApp(rel: string, manifest: Record<string, unknown>, options: { marker?: boolean; extra?: Record<string, unknown> } = {}): string {
	const folder = path.join(ws, rel);
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, 'package.json'), `${JSON.stringify({ name: 'x', ...options.extra, appManifest: manifest }, null, '\t')}\n`);
	if (options.marker !== false) {
		fs.writeFileSync(path.join(folder, `${String(manifest.id ?? 'x').split('.').pop()}.rrapp`), '{}\n');
	}
	return folder;
}

describe('createAppWorkspace', () => {
	it('scaffolds apps/<slug>-ui under the default developer id', async () => {
		const created = await createAppWorkspace(ws, 'clock', { install: false });

		expect(created.appId).toBe(`${DEFAULT_DEVELOPER_ID}.clock`);
		expect(created.folder).toBe('apps/clock-ui');
		expect(fs.existsSync(path.join(ws, 'apps', 'clock'))).toBe(false);
		expect(fs.existsSync(path.join(ws, 'apps', 'clock-ui', 'clock.rrapp'))).toBe(true);
		expect(created.installed).toBe(false);
	});

	it('uses the given developer id as the namespace and publisher', async () => {
		const created = await createAppWorkspace(ws, 'clock', { developerId: 'acme', install: false });
		const pkg = JSON.parse(read('apps/clock-ui/package.json'));

		expect(created.appId).toBe('acme.clock');
		expect(pkg.appManifest.id).toBe('acme.clock');
	});

	it('stamps a working-copy projectId at creation', async () => {
		await createAppWorkspace(ws, 'clock', { install: false });
		const pkg = JSON.parse(read('apps/clock-ui/package.json'));

		expect(pkg.appManifest.projectId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('bakes a deterministic per-slug dev port into the rsbuild config', async () => {
		await createAppWorkspace(ws, 'clock', { install: false });
		const port = Number(/port:\s*(\d+)/.exec(read('apps/clock-ui/rsbuild.config.mts'))?.[1]);

		let hash = 0;
		for (const ch of 'clock') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
		expect(port).toBe(3700 + (hash % 300));
	});

	it('writes the workspace file and every ignore entry', async () => {
		await createAppWorkspace(ws, 'clock', { install: false });

		expect(read('pnpm-workspace.yaml')).toMatch(/^\s*- 'apps\/\*'/m);
		const ignore = read('.gitignore').split(/\r?\n/);
		for (const entry of ['.env', '.rocketride/', '**/node_modules/', '**/dist/']) {
			expect(ignore).toContain(entry);
		}
	});

	it('does not vendor when the host opts out', async () => {
		const lines: string[] = [];
		const created = await createAppWorkspace(ws, 'clock', { install: false, vendor: false, onProgress: (l) => lines.push(l) });

		expect(created.vendored).toEqual({ shell: false, client: false });
		expect(lines.some((l) => /vendor/i.test(l))).toBe(false);
	});

	it('warns instead of failing when the workspace file cannot be amended', async () => {
		fs.writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), "packages: ['libs/*']\n");
		const lines: string[] = [];

		const created = await createAppWorkspace(ws, 'clock', { install: false, onProgress: (l) => lines.push(l) });

		expect(created.appId).toBe('local.clock');
		expect(lines.some((l) => /warning: pnpm-workspace\.yaml not updated/.test(l))).toBe(true);
	});

	it('refuses an existing folder', async () => {
		fs.mkdirSync(path.join(ws, 'apps', 'clock-ui'), { recursive: true });

		await expect(createAppWorkspace(ws, 'clock', { install: false })).rejects.toThrow(/"apps\/clock-ui" already exists/);
	});

	it('refuses an invalid developer id before touching disk', async () => {
		await expect(createAppWorkspace(ws, 'clock', { developerId: 'Acme', install: false })).rejects.toThrow(/Developer id/);
		expect(fs.existsSync(path.join(ws, 'apps'))).toBe(false);
	});
});

describe('ensureWorkspaceFile', () => {
	it('amends an existing block list that lacks the apps/* claim', () => {
		fs.writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), "packages:\n    - 'libs/*'\n");

		ensureWorkspaceFile(ws);

		expect(read('pnpm-workspace.yaml')).toBe("packages:\n    - 'apps/*'\n    - 'libs/*'\n");
	});

	it('refuses an inline packages value', () => {
		fs.writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), "packages: ['libs/*']\n");

		expect(() => ensureWorkspaceFile(ws)).toThrow(/inline value/);
	});

	it('retires island-era per-app workspace files', () => {
		fs.mkdirSync(path.join(ws, 'apps', 'old'), { recursive: true });
		fs.writeFileSync(path.join(ws, 'apps', 'old', 'pnpm-workspace.yaml'), 'packages: []\n');

		ensureWorkspaceFile(ws);

		expect(fs.existsSync(path.join(ws, 'apps', 'old', 'pnpm-workspace.yaml'))).toBe(false);
	});
});

describe('ensureWorkspaceGitignore', () => {
	it('treats any common spelling as covered', () => {
		fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules\ndist/\n/.env\n.rocketride\n');

		expect(ensureWorkspaceGitignore(ws)).toEqual([]);
	});

	it('appends only the missing entries', () => {
		fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules/');

		expect(ensureWorkspaceGitignore(ws)).toEqual(['.env', '.rocketride/', '**/dist/']);
		expect(read('.gitignore').startsWith('node_modules/\n')).toBe(true);
	});
});

describe('scanAppMarkers', () => {
	it('keeps the shallowest binding per app id and skips non-apps', async () => {
		const shallow = writeApp('apps/clock', { id: 'acme.clock', name: 'Clock' });
		writeApp('vendor/copy/apps/clock', { id: 'acme.clock', name: 'Copy' });
		const notApp = path.join(ws, 'misc');
		fs.mkdirSync(notApp);
		fs.writeFileSync(path.join(notApp, 'stray.rrapp'), '{}');
		fs.writeFileSync(path.join(notApp, 'package.json'), '{"name":"plain"}');

		const markers = [
			path.join(ws, 'vendor/copy/apps/clock/clock.rrapp'),
			path.join(notApp, 'stray.rrapp'),
			path.join(shallow, 'clock.rrapp'),
		];
		const apps = await scanAppMarkers(markers);

		expect(apps).toHaveLength(1);
		expect(apps[0]).toMatchObject({ id: 'acme.clock', name: 'Clock', moduleId: 'acme_clock', folder: shallow });
	});
});

describe('manifest', () => {
	it('ensureProjectId adopts a legacy marker guid, then keeps it', () => {
		const folder = writeApp('apps/clock', { id: 'acme.clock' }, { marker: false });
		fs.writeFileSync(path.join(folder, 'clock.rrapp'), JSON.stringify({ id: 'acme.clock', projectId: 'legacy-guid' }));

		expect(ensureProjectId(folder)).toBe('legacy-guid');
		expect(ensureProjectId(folder)).toBe('legacy-guid');
		expect(read('apps/clock/package.json')).toContain('\t"appManifest"');
	});

	it('readProjectIdAt forwards the manifest id, else a legacy marker guid, and never writes', () => {
		writeApp('apps/clock', { id: 'acme.clock', projectId: 'manifest-guid' });
		expect(readProjectIdAt(ws, 'apps/clock')).toBe('manifest-guid');

		const legacy = writeApp('apps/timer', { id: 'acme.timer' }, { marker: false });
		fs.writeFileSync(path.join(legacy, 'timer.rrapp'), JSON.stringify({ id: 'acme.timer', projectId: 'legacy-guid' }));
		const before = read('apps/timer/package.json');
		expect(readProjectIdAt(ws, legacy)).toBe('legacy-guid');
		expect(read('apps/timer/package.json')).toBe(before);

		writeApp('apps/bare', { id: 'acme.bare' });
		const bare = read('apps/bare/package.json');
		expect(readProjectIdAt(ws, 'apps/bare')).toBeNull();
		expect(read('apps/bare/package.json')).toBe(bare);
	});

	it('ensureProjectId refuses a folder that is not an app', () => {
		const folder = path.join(ws, 'plain');
		fs.mkdirSync(folder);
		fs.writeFileSync(path.join(folder, 'package.json'), '{}');

		expect(() => ensureProjectId(folder)).toThrow(/Not an app project/);
	});

	it('saveAppListing drops emptied keys and round-trips through readAppListing', () => {
		const folder = writeApp('apps/clock', { id: 'acme.clock', icon: 'icon.svg', billing: { plans: [{ id: 'p' }] } });

		saveAppListing(folder, { appId: 'acme.clock', mode: 'free', name: 'Clock', description: 'Tells time', plans: [], icon: '', typecheck: false });

		const pkg = JSON.parse(read('apps/clock/package.json'));
		expect(pkg.appManifest.icon).toBeUndefined();
		expect(pkg.appManifest.billing).toBeUndefined();
		expect(pkg.appManifest.typecheck).toBe(false);
		expect(readAppListing(folder)).toMatchObject({ name: 'Clock', description: 'Tells time', typecheck: false });
	});
});

describe('preflightApp', () => {
	it('fails a declared-but-missing icon and passes a resolving include', async () => {
		fs.mkdirSync(path.join(ws, 'shared'));
		const folder = writeApp('apps/clock', { id: 'acme.clock', name: 'Clock', icon: 'missing.svg', include: ['shared'], description: 'Tells time' });

		const checks = await preflightApp(folder, ws);
		const byId = Object.fromEntries(checks.map((c) => [c.id, c]));

		expect(byId.icon.state).toBe('fail');
		expect(byId.include.state).toBe('pass');
		expect(byId.readme.state).toBe('warn');
		expect(byId.desc).toMatchObject({ state: 'pass', tier: 'store' });
	});

	it('reports a missing include when no workspace is known', async () => {
		const folder = writeApp('apps/clock', { id: 'acme.clock', include: ['shared'] });

		const include = (await preflightApp(folder)).find((c) => c.id === 'include');

		expect(include?.state).toBe('fail');
	});

	it('requires plans for a paid listing at the store tier', async () => {
		const folder = writeApp('apps/clock', { id: 'acme.clock', mode: 'subscription' });

		const pricing = (await preflightApp(folder, ws)).find((c) => c.id === 'pricing');

		expect(pricing).toMatchObject({ state: 'fail', tier: 'store' });
	});

	it('returns one manifest failure for a non-app folder', async () => {
		const folder = path.join(ws, 'plain');
		fs.mkdirSync(folder);

		expect(await preflightApp(folder, ws)).toEqual([expect.objectContaining({ id: 'manifest', state: 'fail' })]);
	});
});

describe('resolveDeveloperId', () => {
	it('reads organization.developerId off the account info', () => {
		expect(resolveDeveloperId({ getAccountInfo: () => ({ organization: { developerId: 'acme' } }) })).toBe('acme');
	});

	it('is null for an unregistered org, a missing org, or no client', () => {
		expect(resolveDeveloperId({ getAccountInfo: () => ({ organization: { developerId: null } }) })).toBeNull();
		expect(resolveDeveloperId({ getAccountInfo: () => undefined })).toBeNull();
		expect(resolveDeveloperId(undefined)).toBeNull();
	});
});
