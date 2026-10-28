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
// WORKSPACE TESTS
// =============================================================================

/**
 * What the ordering explorations (ordering.test.ts) cannot reach: going back
 * to a team, another tab, the change announcements, the cache, the scaffold,
 * the preview, the dev session's models, and the versions a teammate's change
 * moves.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appPath, scaffoldApp } from '../../../../rocket-ui/src/surfaces/preview/session/appStore';
import { createWebAppBuilderHost } from '../../../../rocket-ui/src/surfaces/preview/session/webHost';
import { createWorkspace, type Workspace } from '../../../../rocket-ui/src/surfaces/workspace/vfs/workspace';
import { CachedVfs } from 'shell/src/modules/explorer/CachedVfs';
import { FilesystemTools } from '../agent/toolkits/filesystem';
import type { AgentTool } from '../agent/tools';
import { FakeStore } from './fakeStore.harness';
import { StagedFileSystem, StaleVersionError, StaleWriteError } from './stagedFileSystem';
import { StagingStore } from './staging';

// =============================================================================
// HARNESS
// =============================================================================

/**
 * Calls a tool the way the loop does when it lets every act through: it gets
 * the call ready, then runs its step.
 *
 * @param tool - The tool.
 * @param args - The call's arguments.
 * @returns The tool result.
 */
async function callTool(tool: AgentTool, args: Record<string, unknown>): Promise<string> {
	return (await tool.prepare(args)).run();
}

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

/** Counts workspaces, so each test roots its own in teams no other test used. */
let teams = 0;

/** A store path in a team. */
function inTeam(team: string, rel: string): string {
	return `@/Team/=${team}/.projects/.appdev/${rel}`;
}

/**
 * The fake store with one file in each of two teams, installed.
 *
 * @returns The store, the team ids, and the file's store path in each.
 */
function storage() {
	teams += 1;
	const [alpha, beta] = [`alpha${teams}`, `beta${teams}`];
	const [a, b] = [inTeam(alpha, 'probe.txt'), inTeam(beta, 'probe.txt')];
	const store = new FakeStore({ [a]: 'const probe = 1;', [b]: 'const probe = 900;' }).install();
	return { store, alpha, beta, a, b };
}

/** The store paths written in a team. */
function writtenIn(store: FakeStore, team: string): string[] {
	return store.landed.map((w) => w.path).filter((path) => path.startsWith(`@/Team/=${team}/`));
}

/** The workspace of a team, built the way RocketApp's bootstrap builds it (auto mode unless told). */
function workspace(teamId: string, autoCommit = true): Promise<Workspace> {
	return createWorkspace({ hostAppId: 'workspace.test', autoCommit, scope: { kind: 'team', teamId } });
}

/** The paths a team's staging manifest names, which is what a reload restores. */
function manifestPaths(store: FakeStore, teamId: string): string[] {
	const manifest = JSON.parse(store.files.get(`.staging/workspace.test/team-${teamId}/manifest.json`) as string) as { layers: Array<{ entries: Record<string, unknown> }> };
	return manifest.layers.flatMap((layer) => Object.keys(layer.entries)).sort();
}

// =============================================================================
// TEAM SWITCH
// =============================================================================

test("a change staged in the old team's workspace after the switch is announced under the old team's path", async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	await workspace(s.beta);
	const announced: string[] = [];
	(globalThis as { __shellTestEmit?: unknown }).__shellTestEmit = (_topic: string, event: { uri: string }) => announced.push(event.uri);
	try {
		await old.view.write('apps/probe.txt', 'const probe = 3;', 'agent');
	} finally {
		delete (globalThis as { __shellTestEmit?: unknown }).__shellTestEmit;
	}
	// step: the new team's dev previews and rescans never hear of a file they do not have
	assert.deepEqual(announced, [s.a]);
});

test('an app the agent scaffolds after the team changes is created in the team the run started in', async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	await workspace(s.beta);
	// step: the scaffold names the preview URL from the page's origin
	(globalThis as { window?: unknown }).window = { location: { origin: 'http://localhost' } };
	try {
		await scaffoldApp({ appName: 'late', displayName: 'Late', publisher: 'local', frame: { sidebar: false, statusFooter: false, docTabs: false } }, old);
	} finally {
		delete (globalThis as { window?: unknown }).window;
	}
	assert.ok(old.view.changedPaths().has('apps/late-ui/package.json'), "the scaffold is staged in the old team's workspace");
	assert.deepEqual(writtenIn(s.store, s.beta), [], 'nothing was written to the new team');
});

// =============================================================================
// GOING BACK
// =============================================================================

test('a change an old call stages after the user switches away and back is kept', async () => {
	const s = storage();
	const old = await workspace(s.alpha, false);
	await workspace(s.beta, false);
	const back = await workspace(s.alpha, false);
	// step: the old run's late write lands after the return, then the user edits in the same team
	await old.view.write('apps/late.txt', 'late agent content', 'agent');
	assert.ok(back.view.changedPaths().has('apps/late.txt'), 'the late change shows as pending');
	await back.view.write('apps/new.txt', 'new editor content', 'editor');
	assert.deepEqual(manifestPaths(s.store, s.alpha), ['apps/late.txt', 'apps/new.txt']);
});

test('going back to a team does not bring back a change another tab discarded meanwhile', async () => {
	const s = storage();
	const old = await workspace(s.alpha, false);
	await old.view.write('apps/draft.txt', 'staged before the switch', 'editor');
	await workspace(s.beta, false);
	// step: another tab: its own staged view and staging store over the same namespace
	const blank = { list: async () => [], read: async () => Promise.reject(new Error('File not found')), write: async () => undefined, rename: async () => undefined, delete: async () => undefined, mkdir: async () => undefined };
	const otherTab = new StagedFileSystem(new CachedVfs(blank), new StagingStore('workspace.test', `team-${s.alpha}`));
	await otherTab.whenReady();
	await otherTab.discard();
	const back = await workspace(s.alpha, false);
	assert.equal(back.view.changedPaths().has('apps/draft.txt'), false);
	await back.view.write('apps/current.txt', 'saved here', 'editor');
	assert.deepEqual(manifestPaths(s.store, s.alpha), ['apps/current.txt']);
});

test('going back to a team reads its files and its file list again, so a change made there meanwhile shows', async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	await old.view.read('apps/probe.txt');
	await old.view.list('apps');
	await workspace(s.beta);
	// step: another tab saves the file and adds one while the user is in the other team
	s.store.files.set(s.a, 'const probe = 2;');
	s.store.files.set(inTeam(s.alpha, 'added.txt'), '');
	const back = await workspace(s.alpha);
	assert.equal(await back.view.read('apps/probe.txt'), 'const probe = 2;');
	assert.deepEqual((await back.view.list('apps')).map((e) => e.name).sort(), ['added.txt', 'probe.txt']);
});

test('a read still on its way when the user leaves a team cannot bring back an older file after a save there', async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	s.store.heldAnswers.add(s.a);
	const pending = old.view.read('apps/probe.txt');
	const answer = await s.store.next();
	s.store.heldAnswers.delete(s.a);
	await workspace(s.beta);
	const back = await workspace(s.alpha);
	assert.equal(await back.view.read('apps/probe.txt'), 'const probe = 1;');
	await back.view.write('apps/probe.txt', 'const probe = 2;', 'editor');
	answer.release();
	// step: the return dropped the cache while the old read was on its way, so the view takes the file again
	assert.equal(await pending, 'const probe = 2;', 'the old read returns the saved file');
	assert.equal(s.store.files.get(s.a), 'const probe = 2;');
	assert.equal(await back.view.read('apps/probe.txt'), 'const probe = 2;', 'the saved file, not the old read, is what the cache serves');
});

// =============================================================================
// CACHE
// =============================================================================

test('a read still on its way does not cache its old copy once its file, a folder above it or the whole cache changed', async () => {
	const changes: Record<string, (cache: CachedVfs) => unknown> = {
		write: (cache) => cache.write('src/a.ts', 'value = 2'),
		prime: (cache) => cache.prime('src/a.ts', 'value = 2'),
		'invalidate the file': (cache) => cache.invalidate('src/a.ts'),
		'drop the cache': (cache) => cache.invalidate(),
		'delete the folder': (cache) => cache.delete('src'),
		'rename the folder': (cache) => cache.rename('src', 'lib'),
	};
	for (const [change, make] of Object.entries(changes)) {
		const files = new Map([['src/a.ts', 'value = 1']]);
		let deliver = (): void => undefined;
		const answered = new Promise<void>((resolve) => (deliver = resolve));
		const move = async (from: string, to?: string): Promise<void> => {
			for (const [path, text] of [...files]) {
				if (path !== from && !path.startsWith(`${from}/`)) continue;
				files.delete(path);
				if (to !== undefined) files.set(`${to}${path.slice(from.length)}`, text);
			}
		};
		const cache = new CachedVfs({
			list: async () => [],
			read: async (path) => {
				const text = files.get(path);
				await answered;
				return text;
			},
			write: async (path, content) => void files.set(path, String(content)),
			rename: (from, to) => move(from, to),
			delete: (path) => move(path),
			mkdir: async () => undefined,
		});
		const pending = cache.read('src/a.ts');
		await make(cache);
		deliver();
		assert.equal(await pending, 'value = 1', `${change}: the old read returns what it read`);
		assert.notEqual(cache.cachedContent('src/a.ts'), 'value = 1', `${change}: the cache does not keep it`);
	}
});

// =============================================================================
// PREVIEW
// =============================================================================

test('a listing save whose read ends after the team changes writes the package in the team it started in', async () => {
	const s = storage();
	const pkgPath = (team: string) => inTeam(team, 'same-ui/package.json');
	s.store.files.set(pkgPath(s.alpha), JSON.stringify({ name: 'alpha-app', appManifest: { id: 'local.same', name: 'Alpha' } }));
	s.store.files.set(pkgPath(s.beta), JSON.stringify({ name: 'beta-app', appManifest: { id: 'local.same', name: 'Beta' } }));
	const old = await workspace(s.alpha, false);
	const appHost = createWebAppBuilderHost({
		client: s.store.client as never,
		prefs: undefined as never,
		appId: 'local.same',
		folder: 'same-ui',
		hasReviewLadder: false,
		previewUrl: '',
		session: null,
		onReloadPreview: () => undefined,
		onOpenDebugTab: () => undefined,
	});
	// step: hold the save's read of the package until the user has switched teams
	s.store.watched.add(pkgPath(s.alpha));
	const saving = appHost.saveListing?.({ appId: 'local.same', mode: 'free', name: 'Alpha Listed', description: 'Listed in alpha.', plans: [] });
	const read = await s.store.next();
	s.store.watched.clear();
	const fresh = await workspace(s.beta, false);
	read.release();
	await saving;
	const file = 'apps/same-ui/package.json';
	const saved = JSON.parse(String(await old.view.read(file))) as { name: string; appManifest: { name: string } };
	assert.deepEqual([saved.name, saved.appManifest.name], ['alpha-app', 'Alpha Listed'], 'the listing landed in the team the save started in');
	assert.equal(fresh.view.changedPaths().has(file), false, 'nothing was staged in the new team');
});

// =============================================================================
// DEV SESSION MODELS
// =============================================================================

/** The parts of a dev session the model tests drive: rocket-ui has no Monaco in node, so the tests hand it a fake. */
interface DevSessionInternals {
	monaco: unknown;
	models: Map<string, unknown>;
	wireModel(path: string, text: string): unknown;
	adoptExternalChange(path: string): Promise<void>;
	releaseModel(path: string): void;
	emitOne(path: string): Promise<{ js: string } | null>;
	previewWindow: unknown;
	buildOnce(): Promise<void>;
	registrationMeta: { icon?: string };
	refreshRegistrationMeta(pkg: Record<string, unknown>): Promise<void>;
}

/**
 * A dev session for an app in a fresh workspace, with a fake Monaco: each new
 * model starts at version 1, as Monaco's do, and its emit is its text, read
 * when the worker is asked.
 *
 * @param appId - The app id; each test uses its own, since the emit cache is shared.
 * @param folder - The app's folder.
 * @param hold - Keeps each emit's reply on its way, and says when the worker was asked.
 * @returns The session, its internals, the uri of each model disposed, and its workspace.
 */
async function devSession(appId: string, folder: string, hold?: { reply: Promise<void>; asked: () => void }) {
	// step: Monaco's worker wiring subclasses Worker when its module loads
	(globalThis as { Worker?: unknown }).Worker ??= class {};
	const { WebDevSession } = await import('../../../../rocket-ui/src/surfaces/preview/session/devSession');
	const s = storage();
	const ws = await workspace(s.alpha);
	const session = new WebDevSession(s.store.client as never, appId, folder, appId);
	const internals = session as unknown as DevSessionInternals;
	const disposed: string[] = [];
	const live = new Map<string, () => string>();
	internals.monaco = {
		Uri: { parse: (uri: string) => ({ toString: () => uri }) },
		editor: {
			getModel: () => null,
			createModel: (text: string, _language: string, uri: { toString(): string }) => {
				let value = text;
				live.set(uri.toString(), () => value);
				return {
					uri,
					getValue: () => value,
					setValue: (next: string) => (value = next),
					getVersionId: () => 1,
					onDidChangeContent: () => ({ dispose: () => undefined }),
					dispose: () => {
						live.delete(uri.toString());
						disposed.push(uri.toString());
					},
				};
			},
		},
		languages: {
			typescript: {
				getTypeScriptWorker: async () => async () => ({
					getEmitOutput: async (uri: string) => {
						const text = live.get(uri)?.() ?? '';
						hold?.asked();
						await hold?.reply;
						return { outputFiles: [{ name: 'out.js', text }] };
					},
				}),
			},
		},
	};
	return { s, ws, session, internals, disposed };
}

test('a dev session reads its package, lock and icons, and locks a dependency version, in the team it opened in after the team changes', async () => {
	const { s, ws, session, internals } = await devSession('local.deps', 'deps-ui');
	for (const [team, name] of [
		[s.alpha, 'Alpha'],
		[s.beta, 'Beta'],
	]) {
		s.store.files.set(inTeam(team, 'deps-ui/icon.svg'), name);
		// step: the raw binary read's own path (the test stub has no PROJECT_DIR)
		s.store.files.set(appPath('deps-ui', 'icon.png', { kind: 'team', teamId: team }), name);
	}
	s.store.files.set(inTeam(s.alpha, 'deps-ui/package.json'), JSON.stringify({ dependencies: { example: '^1' }, appManifest: { icon: 'icon.svg' } }));
	s.store.files.set(inTeam(s.beta, 'deps-ui/rr-lock.json'), JSON.stringify({ example: '9.9.9', 'example#range': '^1' }));
	await workspace(s.beta);
	const realFetch = globalThis.fetch;
	// step: the version lookup answers; the module graph is not needed here
	globalThis.fetch = (async (url: string) => {
		if (String(url).endsWith('/package.json')) return { ok: true, json: async () => ({ version: '1.2.3' }) };
		throw new Error('no module graph in this test');
	}) as unknown as typeof fetch;
	try {
		internals.previewWindow = { __rrShellDev: { getShareScope: () => ({}) } };
		await internals.buildOnce();
		assert.equal(JSON.parse(String(await ws.view.read('apps/deps-ui/rr-lock.json'))).example, '1.2.3', "the new team's lock was not read");
		assert.deepEqual(writtenIn(s.store, s.beta), [], 'nothing was written to the new team');
		assert.equal(internals.registrationMeta.icon, 'data:image/svg+xml;utf8,Alpha');
		await internals.refreshRegistrationMeta({ appManifest: { icon: 'icon.png' } });
		assert.equal(internals.registrationMeta.icon, `data:image/png;base64,${btoa('Alpha')}`);
	} finally {
		globalThis.fetch = realFetch;
		session.dispose();
	}
});

test("a deleted file's model leaves the dev session, and a file the store failed to read keeps its model", async () => {
	const { s, ws, session, internals, disposed } = await devSession('local.gone', 'gone-ui');
	try {
		for (const path of ['src/unused.ts', 'src/kept.ts']) {
			s.store.files.set(inTeam(s.alpha, `gone-ui/${path}`), `export const value = '${path}';`);
			internals.wireModel(path, '');
		}
		await ws.view.refresh();
		// step: the store fails a read of a file it still has
		const read = s.store.client.fsReadString;
		s.store.client.fsReadString = async (path: string) => {
			if (path === inTeam(s.alpha, 'gone-ui/src/kept.ts')) throw new Error('socket closed');
			return read(path);
		};
		await internals.adoptExternalChange('src/kept.ts');
		assert.ok(internals.models.has('src/kept.ts'), 'a failed read keeps the model');
		assert.deepEqual(disposed, []);
		s.store.client.fsReadString = read;
		// step: the agent deletes the other file; the session hears of it
		await ws.view.delete('apps/gone-ui/src/unused.ts');
		await internals.adoptExternalChange('src/unused.ts');
		assert.equal(internals.models.has('src/unused.ts'), false, "the deleted file's model left the session");
		assert.deepEqual(disposed, ['file:///local.gone/src/unused.ts'], "the deleted file's model was disposed");
	} finally {
		session.dispose();
	}
});

test("a deleted file's compiled output goes with its model, so a new file at its path is compiled again", async () => {
	const { session, internals } = await devSession('local.reborn', 'reborn-ui');
	try {
		internals.wireModel('src/a.ts', 'export const value = 1;');
		assert.equal((await internals.emitOne('src/a.ts'))?.js, 'export const value = 1;');
		// step: the file is deleted, so its model goes; then a file is created at the same path
		internals.releaseModel('src/a.ts');
		internals.wireModel('src/a.ts', 'export const value = 2;');
		assert.equal((await internals.emitOne('src/a.ts'))?.js, 'export const value = 2;', "the new file's own output, not the deleted file's");
	} finally {
		session.dispose();
	}
});

test("an emit still on its way when its file is deleted and made again does not cache the deleted file's output", async () => {
	let asked = (): void => undefined;
	const worker = new Promise<void>((resolve) => (asked = resolve));
	let deliver = (): void => undefined;
	const reply = new Promise<void>((resolve) => (deliver = resolve));
	const { session, internals } = await devSession('local.inflight', 'inflight-ui', { reply, asked });
	try {
		internals.wireModel('src/a.ts', 'export const value = 1;');
		const inFlight = internals.emitOne('src/a.ts');
		await worker;
		// step: while the worker still holds the reply, the file is deleted and made again at the same path and version
		internals.releaseModel('src/a.ts');
		internals.wireModel('src/a.ts', 'export const value = 2;');
		deliver();
		await inFlight;
		assert.equal((await internals.emitOne('src/a.ts'))?.js, 'export const value = 2;', "the new file's own output, not the deleted file's");
	} finally {
		session.dispose();
	}
});

// =============================================================================
// THE SAVE RACE — reads a change overtook, and a teammate's change
// =============================================================================

test("the agent's write refused for a teammate's change drops the cached copy, so its next read gets the server's copy and its edit keeps the change", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const files = new FilesystemTools(ws.view);
	const tool = (name: string, args: Record<string, unknown>) => callTool(files.tools().find((t) => t.name === name)!, args);

	// step: the agent reads the file; a teammate changes it; the agent's edit is refused
	await tool('read_file', { path });
	s.store.files.set(s.a, 'const probe = 1; // teammate');
	await assert.rejects(tool('edit_file', { path, oldString: 'const probe = 1;', newString: 'const probe = 2;' }), /^Error: edit_file refused: apps\/probe\.txt changed on the server since you read it \(another tab or a teammate\)\. Read it again, then redo the change from the current content\.$/);
	assert.equal(s.store.files.get(s.a), 'const probe = 1; // teammate');

	// step: the agent reads it again and gets the server's copy; its edit then lands on it
	assert.equal(await tool('read_file', { path }), 'const probe = 1; // teammate');
	await tool('edit_file', { path, oldString: 'const probe = 1;', newString: 'const probe = 2;' });
	assert.equal(s.store.files.get(s.a), 'const probe = 2; // teammate');
});

/** An editor tab as the text tabs keep one: it loads the file at a version, and saves its text at that version. */
async function editorTab(view: Workspace['view'], path: string): Promise<{ text: string; version: number; save: () => Promise<void> }> {
	const loaded = await view.readVersioned(path);
	const tab = { text: String(loaded.content), version: loaded.version, save: () => view.write(path, tab.text, 'editor', loaded.version) };
	return tab;
}

test("a teammate's change that a read takes in after the cached copy was dropped moves the version, so a tab that loaded before it cannot save over it", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const tab = await editorTab(ws.view, path);
	tab.text = 'const probe = 1; // mine';
	// step: a teammate changes the file; the cached copy is dropped (a Reload), and two tabs read the server's copy at once
	s.store.files.set(s.a, 'const probe = 2; // teammate');
	ws.view.invalidate(path);
	const [second, third] = await Promise.all([editorTab(ws.view, path), editorTab(ws.view, path)]);
	assert.deepEqual([second.version, third.version], [ws.view.version(path), ws.view.version(path)], 'both reads count the copy one of them took in');
	await assert.rejects(tab.save(), StaleVersionError);
	assert.equal(s.store.files.get(s.a), 'const probe = 2; // teammate');
	// step: a Reload that takes the same copy in moves nothing; the tab whose read took the teammate's change in saves at the version it got
	ws.view.invalidate(path);
	await ws.view.readVersioned(path);
	second.text = 'const probe = 3; // after the teammate';
	await second.save();
	assert.equal(s.store.files.get(s.a), 'const probe = 3; // after the teammate');
});

test("after a switch away and back, a file nobody changed saves at once, and a teammate's change that the preview's batch read takes in moves the version", async () => {
	const s = storage();
	const other = `@/Team/=${s.alpha}/.projects/.appdev/other.txt`;
	s.store.files.set(other, 'const other = 1;');
	const ws = await workspace(s.alpha);
	const [path, otherPath] = ['apps/probe.txt', 'apps/other.txt'];
	const [tab, untouched] = [await editorTab(ws.view, path), await editorTab(ws.view, otherPath)];
	tab.text = 'const probe = 1; // mine';
	untouched.text = 'const other = 1; // mine';
	await workspace(s.beta);
	s.store.files.set(s.a, 'const probe = 2; // teammate');
	const back = await workspace(s.alpha);
	await untouched.save();
	assert.equal(s.store.files.get(other), 'const other = 1; // mine');
	assert.deepEqual(await back.view.readMany([path]), { [path]: 'const probe = 2; // teammate' });
	await assert.rejects(tab.save(), StaleVersionError);
	assert.equal(s.store.files.get(s.a), 'const probe = 2; // teammate');
});

test("a read that finds the teammate's copy a batch read cached and has not counted yet reports the version the batch counts", async () => {
	const files = new Map(Object.entries({ 'a.ts': 'A0', 'b.ts': 'B0' }));
	const slow = deferred();
	const view = new StagedFileSystem(
		new CachedVfs({
			list: async () => [],
			read: async (path) => {
				if (path === 'b.ts') await slow.promise;
				return files.get(path);
			},
			write: async (path, content) => void files.set(path, String(content)),
			rename: async () => undefined,
			delete: async () => undefined,
			mkdir: async () => undefined,
		}),
		null,
		{ writeThrough: true }
	);
	await view.read('a.ts');
	// step: a teammate changes a.ts and a Reload drops the cached copy; a batch read caches the new a.ts while b.ts is slow, and a tab opens a.ts
	files.set('a.ts', 'A1');
	view.invalidate('a.ts');
	const batch = view.readMany(['a.ts', 'b.ts']);
	await new Promise((resolve) => setImmediate(resolve));
	const tab = await view.readVersioned('a.ts');
	slow.resolve();
	await batch;
	assert.deepEqual(tab, { content: 'A1', version: view.version('a.ts') });
	await view.write('a.ts', 'A1 + mine', 'editor', tab.version);
	assert.equal(files.get('a.ts'), 'A1 + mine');
});

test("after a switch away and back, a teammate's delete refuses a tab's save once; a save after the refusal makes the file again", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const tab = await editorTab(ws.view, path);
	tab.text = 'const probe = 1; // mine';
	await workspace(s.beta);
	s.store.files.delete(s.a);
	const back = await workspace(s.alpha);
	await assert.rejects(tab.save(), StaleWriteError);
	assert.equal(s.store.files.has(s.a), false);
	// step: the tab reloads, finds the file gone, and saves its text as a new file
	await assert.rejects(back.view.readVersioned(path), /File not found/);
	await back.view.write(path, tab.text, 'editor', back.view.version(path));
	assert.equal(s.store.files.get(s.a), 'const probe = 1; // mine');
});

test('a batch read on its way when the cached copy is dropped does not put the older copy back', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';

	// step: a batch read of the file (the preview opening) is slow, and holds the copy it read
	const [held, landing] = [deferred(), deferred()];
	const readMany = s.store.client.fsReadMany;
	s.store.client.fsReadMany = async (paths: string[]) => {
		s.store.client.fsReadMany = readMany;
		const found = await readMany(paths);
		held.resolve();
		await landing.promise;
		return found;
	};
	const batch = ws.view.readMany([path]);
	await held.promise;

	// step: a teammate changes the file; a Reload drops the cached copy and reads the server's; then the batch lands
	s.store.files.set(s.a, 'const probe = 2; // teammate');
	ws.view.invalidate(path);
	assert.equal(String((await ws.view.readVersioned(path)).content), 'const probe = 2; // teammate');
	landing.resolve();
	assert.deepEqual(await batch, { [path]: 'const probe = 2; // teammate' }, 'the batch reads the file again');
	assert.equal(ws.view.cachedContent(path), 'const probe = 2; // teammate', 'the cache keeps the newer copy');
	await ws.view.write(path, 'const probe = 3;', 'editor');
	assert.equal(s.store.files.get(s.a), 'const probe = 3;', 'so a save checked against it lands');
});
