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
 * What the ordering explorations (ordering*.test.ts) cannot reach: going back
 * to a team, another tab, the change announcements, the cache, the scaffold,
 * the preview, the dev session's models, the versions a teammate's change
 * moves, and the editor documents' splits, closed tabs and renames.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Documents } from 'shell/src/components/docs/Documents';

import { registerEditor, saveDocumentEditor } from '../../../../rocket-ui/src/agent/editorControls';
import { canvasDocument } from '../../../../rocket-ui/src/surfaces/pipelines/canvasDocument';
import { appPath, scaffoldApp } from '../../../../rocket-ui/src/surfaces/preview/session/appStore';
import { createWebAppBuilderHost } from '../../../../rocket-ui/src/surfaces/preview/session/webHost';
import { fileDocument } from '../../../../rocket-ui/src/surfaces/workspace/fileDocument';
import { renameWithTabs } from '../../../../rocket-ui/src/surfaces/workspace/vfs/openWorkspaceFile';
import { createDocumentsVfs, createProjectVfs, reloadPipeline, savePipeline } from '../../../../rocket-ui/src/surfaces/workspace/projectVfs';
import { createWorkspace, type Workspace } from '../../../../rocket-ui/src/surfaces/workspace/vfs/workspace';
import { CachedVfs } from 'shell/src/modules/explorer/CachedVfs';
import { SaveDroppedError } from '../agent/host';
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

/** The same in manual mode: changes stay staged until Commit all. */
function manualWorkspace(teamId: string): Promise<Workspace> {
	return workspace(teamId, false);
}

/** The paths a team's staging manifest names, which is what a reload restores. */
function manifestPaths(store: FakeStore, teamId: string): string[] {
	const manifest = JSON.parse(store.files.get(`.staging/workspace.test/team-${teamId}/manifest.json`) as string) as { layers: Array<{ entries: Record<string, unknown> }> };
	return manifest.layers.flatMap((layer) => Object.keys(layer.entries)).sort();
}

/**
 * Holds the store's next read of a path once it has the content, so the read
 * comes back with the file as it was when it was made.
 *
 * @param s - The fake store.
 * @param path - The store path.
 * @returns Settles once the read is held, and lets it come back.
 */
function holdRead(s: ReturnType<typeof storage>, path: string): { held: Promise<void>; release: () => void } {
	const [held, landing] = [deferred(), deferred()];
	const read = s.store.client.fsReadString;
	s.store.client.fsReadString = async (p: string) => {
		const content = await read(p);
		if (p === path) {
			s.store.client.fsReadString = read;
			held.resolve();
			await landing.promise;
		}
		return content;
	};
	return { held: held.promise, release: landing.resolve };
}

/**
 * Holds the store's next write of a path until the test lets it land.
 *
 * @param s - The fake store.
 * @param path - The store path.
 * @returns Settles once the write is held, and lets it land.
 */
function holdWrite(s: ReturnType<typeof storage>, path: string): { held: Promise<void>; release: () => void } {
	const [held, landing] = [deferred(), deferred()];
	const write = s.store.client.fsWriteString;
	s.store.client.fsWriteString = async (p: string, value: string) => {
		if (p === path) {
			s.store.client.fsWriteString = write;
			held.resolve();
			await landing.promise;
		}
		return write(p, value);
	};
	return { held: held.promise, release: landing.resolve };
}

/** Ctrl+S in the editor of a document: a text tab (`apps/...`) or a canvas (`pipelines/...`); undefined when no editor holds it. */
function ctrlS(view: Workspace['view'], path: string): Promise<void> | undefined {
	return saveDocumentEditor(view, path.startsWith('pipelines/') ? path.slice('pipelines/'.length) : `file:${path}`) ?? undefined;
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

test("a tab's save on its way when the cached copy is dropped counts once, so the tab's next save lands", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const tab = await editorTab(ws.view, path);
	// step: the cached copy is dropped (going back to the team, the agent's refused write) while the store holds the tab's write
	s.store.watched.add(s.a);
	tab.text = 'const probe = 2; // mine';
	const saving = tab.save();
	let held = await s.store.next();
	while (!held.label.startsWith('write ')) {
		held.release();
		held = await s.store.next();
	}
	ws.view.invalidate(path);
	s.store.watched.delete(s.a);
	held.release();
	await saving;
	const after = ws.view.version(path);
	assert.equal((await ws.view.readVersioned(path)).version, after, "the tab's own write is no teammate's change");
	await ws.view.write(path, 'const probe = 3; // mine again', 'editor', after);
	assert.equal(s.store.files.get(s.a), 'const probe = 3; // mine again');
});

test("Commit all's write on its way when the cached copy is dropped counts once, so the tab's next save is staged", async () => {
	const s = storage();
	const ws = await workspace(s.alpha, false);
	const path = 'apps/probe.txt';
	const tab = await editorTab(ws.view, path);
	tab.text = 'const probe = 2; // mine';
	await tab.save();
	const staged = ws.view.version(path);
	// step: the cached copy is dropped while the store holds Commit all's write
	s.store.watched.add(s.a);
	const committing = ws.view.commit();
	let held = await s.store.next();
	while (!held.label.startsWith('write ')) {
		held.release();
		held = await s.store.next();
	}
	ws.view.invalidate(path);
	s.store.watched.delete(s.a);
	held.release();
	await committing;
	assert.equal((await ws.view.readVersioned(path)).version, staged, "Commit all's own write is no teammate's change");
	await ws.view.write(path, 'const probe = 3; // mine again', 'editor', staged);
	assert.equal(await ws.view.read(path), 'const probe = 3; // mine again');
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

// =============================================================================
// CANVAS SAVES
// =============================================================================

test('a canvas reload that cannot read the stored pipeline keeps its version, so the next save is refused', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.store.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents(createDocumentsVfs(s.store.client as never));
	await docs.openDocument('chat.pipe');
	const projectVfs = createProjectVfs(s.store.client as never);
	const content = () => docs.getState().documents['chat.pipe'].content as { name: string };
	const loaded = ws.view.version('pipelines/chat.pipe');

	// step: the agent writes a pipeline that is not valid JSON; the clean canvas cannot reload it
	await ws.view.write('pipelines/chat.pipe', '{ not json', 'agent');
	assert.equal(await reloadPipeline(docs, 'chat.pipe'), null);
	assert.equal(content().name, 'Chat', 'the canvas keeps what it showed');

	// step: so a save from the version the canvas really holds is refused, and the agent's write stays
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	await assert.rejects(savePipeline(projectVfs, docs, 'chat.pipe', 'chat.pipe', content(), loaded), StaleWriteError);
	assert.equal(s.store.files.get(pipePath), '{ not json');

	// step: a deleted pipeline does not reload either
	await ws.view.delete('pipelines/chat.pipe', 'agent');
	assert.equal(await reloadPipeline(docs, 'chat.pipe'), null);

	// step: a readable pipeline reloads, at the version it belongs to
	await ws.view.write('pipelines/chat.pipe', JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	assert.equal(await reloadPipeline(docs, 'chat.pipe'), ws.view.version('pipelines/chat.pipe'));
	assert.equal(content().name, 'Agent');
	assert.equal(docs.getState().documents['chat.pipe'].dirty, false);
});

test('two editors of one path both guard it, and closing one keeps the other', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'pipelines/chat.pipe';
	const editor = (name: string, dirty: { on: boolean }) => ({
		uri: `${name}.pipe`,
		getContent: () => `${name} canvas`,
		isDirty: () => dirty.on,
		save: async () => {
			dirty.on = false;
		},
	});
	const left = { on: true };
	const right = { on: false };
	const closeLeft = registerEditor(ws.view, path, editor('left', left));
	const closeRight = registerEditor(ws.view, path, editor('right', right));
	assert.equal(ws.view.isDirty(path), true, 'dirty while any editor is');
	assert.equal(await ws.view.read(path), 'left canvas', 'readers get the dirty buffer');

	// step: the newer split closes; the older one, still dirty, still guards the file
	closeRight();
	assert.equal(ws.view.isDirty(path), true);
	assert.equal(await ws.view.read(path), 'left canvas');

	// step: the last one closes; nothing guards the file
	closeLeft();
	assert.equal(ws.view.isDirty(path), false);
});

// =============================================================================
// EDITOR DOCUMENTS — Ctrl+S, splits, and unsaved text that outlives its tab
// =============================================================================

/** Lets every promise that can move, move. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

test('Ctrl+S in a canvas saves the canvas only, not a text tab of the same pipeline, and a failed save is not swallowed', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'pipelines/chat.pipe';
	const ctrlS = (uri: string) => saveDocumentEditor(ws.view, uri);
	const did: string[] = [];
	const editor = (name: string, uri: string, failing: boolean) => {
		const state = { dirty: true };
		return {
			uri,
			getContent: () => name,
			isDirty: () => state.dirty,
			save: async () => {
				did.push(name);
				if (failing) throw new Error(`the ${name} could not be saved`);
				state.dirty = false;
			},
			discard: async () => undefined,
		};
	};
	registerEditor(ws.view, path, editor('text tab', 'file:pipelines/chat.pipe', true));
	registerEditor(ws.view, path, editor('canvas', 'chat.pipe', false));

	// step: both have typing; Ctrl+S in the canvas
	await ctrlS('chat.pipe');
	assert.deepEqual(did, ['canvas'], 'only the canvas saved');
	assert.equal(ws.view.isDirty(path), true, "the text tab's typing stays unsaved");

	// step: Ctrl+S in the text tab, whose save fails: the failure reaches the caller
	await assert.rejects(Promise.resolve(ctrlS('file:pipelines/chat.pipe')), /the text tab could not be saved/);
	assert.equal(saveDocumentEditor(ws.view, 'other.pipe'), null, 'a document no editor holds is left to its caller');
});

test('a text tab closed with unsaved typing keeps its loaded version: the file stays dirty, and its save after reopening is refused when the file moved on', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';

	// step: the tab loads the file, the user types, then closes the tab (Monaco keeps the text)
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	const loaded = doc.version;
	doc.type('const probe = 1; // mine');
	close();
	assert.equal(ws.view.isDirty(path), true, 'the unsaved text survives the close, so the file is still dirty');
	assert.equal(await ws.view.read(path), 'const probe = 1; // mine', 'readers get the unsaved text');
	assert.equal(ws.view.isDirty(path), true, 'the unsaved text still guards the file');

	// step: the file changes meanwhile, by a write that asks nobody
	await ws.view.write(path, 'const probe = 2;', 'agent');

	// step: the tab opens again on the same document: the typing, the old version, the banner
	const again = fileDocument(ws.view, path);
	assert.equal(again, doc);
	const closeAgain = again.open();
	await again.load();
	assert.deepEqual([again.text, again.version, again.dirty, again.stale], ['const probe = 1; // mine', loaded, true, true]);
	await assert.rejects(again.save(), StaleWriteError);
	assert.equal(s.store.files.get(s.a), 'const probe = 2;', 'the other change stays');

	// step: Reload shows the stored file; once clean and closed, the document goes
	await again.discard();
	assert.deepEqual([again.text, again.dirty, again.stale], ['const probe = 2;', false, false]);
	closeAgain();
	assert.equal(ws.view.isDirty(path), false);
	assert.equal(ctrlS(ws.view, path), undefined);
	assert.notEqual(fileDocument(ws.view, path), doc, 'the next tab loads the stored file afresh');
});

test('two tabs of one text file share its text, version and save: a save from one leaves the other clean at the new version', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const left = fileDocument(ws.view, path);
	const closeLeft = left.open();
	const right = fileDocument(ws.view, path);
	const closeRight = right.open();
	assert.equal(right, left, 'the splits share one document');
	// step: both editors are bound to one model; setting it echoes back as a change from the other split
	let model = '';
	left.sync = (text) => {
		model = text;
		left.type(text);
	};
	await left.load();
	assert.deepEqual([model, left.dirty], ['const probe = 1;', false], "the document's own change is not typing");

	left.type('const probe = 1; // mine');
	assert.equal(right.dirty, true);
	await left.save();
	assert.deepEqual([right.dirty, right.stale, right.version], [false, false, ws.view.version(path)]);

	// step: nothing is dirty, so another writer goes ahead; the clean tabs follow it
	assert.equal(ws.view.isDirty(path), false);
	await ws.view.write(path, 'const probe = 3;', 'agent');
	await right.load();
	assert.deepEqual([right.text, right.stale, model], ['const probe = 3;', false, 'const probe = 3;']);
	closeLeft();
	assert.ok(ctrlS(ws.view, path), 'the other split still holds the file');
	closeRight();
	assert.equal(ctrlS(ws.view, path), undefined);
});

test("a load of the old team's text tab that lands after a team switch leaves the Monaco model alone, so typing in the new team's tab of the same path stays", { timeout: 10_000 }, async () => {
	type Doc = ReturnType<typeof fileDocument>;
	const s = storage();
	const path = 'apps/probe.txt';
	// step: Monaco keeps one model per URI for the page, and the URI names the path, not the team. Each mounted
	// editor reports a change of the model as typing
	const model = { value: '', editors: new Set<Doc>() };
	const setModel = (text: string): void => {
		if (model.value === text) return;
		model.value = text;
		for (const doc of [...model.editors]) doc.type(text);
	};
	// step: a tab as FileProvider mounts it: it joins the document and loads it, then the editor's beforeMount binds the document to the model
	const mount = async (doc: Doc): Promise<() => void> => {
		const close = doc.open();
		await doc.load();
		doc.sync = setModel;
		doc.syncModel();
		model.editors.add(doc);
		return () => {
			model.editors.delete(doc);
			close();
		};
	};

	const old = await workspace(s.alpha);
	const oldDoc = fileDocument(old.view, path);
	const closeOld = await mount(oldDoc);
	assert.equal(model.value, 'const probe = 1;');
	// step: a teammate's change drops the cached copy, and the clean tab's load of it is held
	s.store.files.set(s.a, 'const probe = 2;');
	old.view.invalidate(path);
	const reading = holdRead(s, s.a);
	const lateLoad = oldDoc.load();
	await reading.held;

	// step: the user switches team, which unmounts the old tab, opens the same path there and types
	closeOld();
	const fresh = await workspace(s.beta);
	const freshDoc = fileDocument(fresh.view, path);
	assert.notEqual(freshDoc, oldDoc);
	const closeFresh = await mount(freshDoc);
	assert.equal(model.value, 'const probe = 900;');
	setModel('const probe = 900; // mine');

	reading.release();
	await lateLoad;
	await flush();
	assert.equal(oldDoc.text, 'const probe = 2;', 'the old document took its load');
	assert.deepEqual([freshDoc.text, freshDoc.dirty, model.value], ['const probe = 900; // mine', true, 'const probe = 900; // mine'], "the new team's typing is kept");
	assert.equal(await fresh.view.read(path), 'const probe = 900; // mine');
	closeFresh();
});

test('an older load that fails after a newer one worked leaves the editor showing the newer text', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	// step: the first read of the file is held, then fails
	const reading = deferred();
	const read = s.store.client.fsReadString;
	let held = false;
	s.store.client.fsReadString = async (p: string) => {
		if (p === s.a && !held) {
			held = true;
			await reading.promise;
			throw new Error('the store did not answer');
		}
		return read(p);
	};
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	const oldLoad = doc.load();
	await flush();

	// step: the agent reads the file and changes it; the tab follows the change with a newer load
	await ws.view.read(path);
	await ws.view.write(path, 'const probe = 2;', 'agent');
	await flush();
	assert.equal(doc.text, 'const probe = 2;');

	// step: the old load fails late
	reading.resolve();
	await oldLoad;
	assert.deepEqual([doc.text, doc.error, doc.version], ['const probe = 2;', null, ws.view.version(path)], 'the newer load stands');
	close();
});

test("closing the last tab of a dirty canvas drops the pipeline, and its document and the agent's guard go with it", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.store.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents(createDocumentsVfs(s.store.client as never));
	const path = 'pipelines/chat.pipe';

	// step: the canvas opens and the user changes a node; the agent now asks before it changes the file
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.store.client as never);
	const leave = doc.open(async () => undefined);
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	assert.equal(ws.view.isDirty(path), true);
	assert.equal(ws.view.isDirty(path), true);

	// step: the user closes the tab (the shell's dirty-close dialog asked first, and the user chose Don't Save)
	docs.closeEditor(Object.keys(docs.getState().editors)[0]);
	leave();
	assert.equal(docs.getState().documents['chat.pipe'], undefined, 'Documents drops the pipeline with its last view');
	assert.equal(ws.view.isDirty(path), false, 'nothing guards a pipeline nobody holds');
	assert.equal(ctrlS(ws.view, path), undefined);
	assert.notEqual(canvasDocument(ws.view, docs, path, 'chat.pipe'), doc, 'the next canvas loads the stored pipeline afresh');
});

test('a rename from the sidebar closes the tabs of the file while it runs and opens them on the new path, so no typing stays on the old path', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, leave } = await openCanvas(s, ws, { name: 'Original', components: [] });
	docs.openStaticDocument('file:apps/probe.txt', 'probe.txt');
	const text = fileDocument(ws.view, 'apps/probe.txt');
	const close = text.open();
	await text.load();
	const tabs = () =>
		Object.values(docs.getState().editors)
			.map((ed) => ed.documentUri)
			.sort();
	// step: a file with unsaved changes keeps its tabs and the typing, and the rename is refused
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	await assert.rejects(renameWithTabs(ws.view, docs, 'pipelines/chat.pipe', 'pipelines/renamed.pipe'), /unsaved changes/);
	assert.deepEqual([tabs(), docs.getState().documents['chat.pipe']?.dirty], [['chat.pipe', 'file:apps/probe.txt'], true]);
	await ctrlS(ws.view, 'pipelines/chat.pipe');
	const renames = [
		{ from: 'pipelines/chat.pipe', to: 'pipelines/renamed.pipe', uri: 'chat.pipe', type: () => docs.updateContent('chat.pipe', { name: 'Typed', components: [] }) },
		{ from: 'apps/probe.txt', to: 'apps/renamed.txt', uri: 'file:apps/probe.txt', type: () => text.type('const probe = 1; // mine') },
	];
	for (const { from, to, uri, type } of renames) {
		// step: the store holds the rename, and the user types in the file's tab while one is open
		const [held, landing] = [deferred(), deferred()];
		const rename = s.store.client.fsRename;
		s.store.client.fsRename = async (a: string, b: string) => {
			s.store.client.fsRename = rename;
			held.resolve();
			await landing.promise;
			return rename(a, b);
		};
		const renaming = renameWithTabs(ws.view, docs, from, to);
		await held.promise;
		const typed = tabs().includes(uri);
		if (typed) type();
		landing.resolve();
		await renaming;
		assert.equal(typed, false, `no tab of ${from} is open to type in while the rename runs`);
		assert.equal(ws.view.isDirty(from), false);
	}
	assert.deepEqual(tabs(), ['file:apps/renamed.txt', 'renamed.pipe'], 'the tabs are on the new paths');
	assert.equal((docs.getState().documents['renamed.pipe']?.content as { name: string }).name, 'Mine');
	leave();
	close();
});

test('a folder rename moves the tabs of the files under it, and unsaved changes in one of them refuse it with every tab left open', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const folder = `@/Team/=${s.alpha}/.projects/.appdev/src`;
	s.store.files.set(`${folder}/probe.txt`, 'const probe = 1;');
	s.store.files.set(`${folder}/draft.txt`, 'const draft = 1;');
	s.store.client.fsRename = async (from: string, to: string) => {
		for (const [p, content] of [...s.store.files]) {
			if (!p.startsWith(`${from}/`)) continue;
			s.store.files.set(to + p.slice(from.length), content);
			s.store.files.delete(p);
		}
	};
	const docs = new Documents(createDocumentsVfs(s.store.client as never));
	docs.openStaticDocument('file:apps/src/probe.txt', 'probe.txt');
	docs.openStaticDocument('file:apps/src/draft.txt', 'draft.txt');
	const draft = fileDocument(ws.view, 'apps/src/draft.txt');
	const close = draft.open();
	await draft.load();
	// step: the user types in one file under the folder; the rename is refused and no tab closes
	draft.type('const draft = 2; // mine');
	const editors = Object.keys(docs.getState().editors);
	await assert.rejects(renameWithTabs(ws.view, docs, 'apps/src', 'apps/lib'), /unsaved changes/);
	assert.deepEqual(Object.keys(docs.getState().editors), editors);
	// step: once that file is saved, the rename moves both tabs to the new folder
	await ctrlS(ws.view, 'apps/src/draft.txt');
	await renameWithTabs(ws.view, docs, 'apps/src', 'apps/lib');
	const tabs = Object.values(docs.getState().editors).map((ed) => ed.documentUri);
	assert.deepEqual(tabs.sort(), ['file:apps/lib/draft.txt', 'file:apps/lib/probe.txt']);
	close();
});

/** A pipeline open on a canvas, in Documents whose dirty-close dialog answers Save, as the shell's close dialog drives it. */
async function canvasForClose(alpha: string, s: ReturnType<typeof storage>, ws: Workspace) {
	const pipePath = `@/Team/=${alpha}/.projects/chat.pipe`;
	s.store.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents({ vfs: createDocumentsVfs(s.store.client as never), ui: { confirmDirtyClose: async () => 'save' } });
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, 'pipelines/chat.pipe', 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.store.client as never);
	// step: the canvas's save, as PipelineProvider's performSave makes it: it shows its own failure (a dropped save is none) and rethrows
	const failures: unknown[] = [];
	const leave = doc.open(async () => {
		try {
			await doc.save(docs.getState().documents['chat.pipe']?.content);
		} catch (err) {
			if (!(err instanceof SaveDroppedError)) failures.push(err);
			throw err;
		}
	});
	const close = () => docs.requestCloseEditor(Object.keys(docs.getState().editors)[0]);
	return { docs, doc, pipePath, failures, leave, close };
}

test('in manual mode, a kept save counts at its own version, not one a discard and a write queued behind it gave the path', { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const { docs, leave, close } = await canvasForClose(s.alpha, s, ws);
	const mine = { name: 'Mine', components: [] };
	const manifest = `.staging/workspace.test/team-${s.alpha}/manifest.json`;
	// step: hold the next manifest write that keeps the pipeline; fail it if asked
	type Hold = { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred>; fail: boolean };
	let hold: Hold | null = null;
	const write = s.store.client.fsWriteJson;
	s.store.client.fsWriteJson = async (p: string, value: unknown) => {
		if (p === manifest && hold && JSON.stringify(value).includes('pipelines/chat.pipe')) {
			const held = hold;
			hold = null;
			held.entered.resolve();
			await held.gate.promise;
			if (held.fail) throw new Error('the store did not answer');
		}
		return write(p, value);
	};
	// step: the canvas saves Mine, and the staging store holds its manifest write
	const first: Hold = { entered: deferred(), gate: deferred(), fail: false };
	hold = first;
	docs.updateContent('chat.pipe', mine);
	const saving = outcome(saveDocumentEditor(ws.view, 'chat.pipe') ?? undefined);
	await first.entered.promise;
	// step: the user types, and a discard and a write of the same text queue behind the save
	docs.updateContent('chat.pipe', { name: 'Typed', components: [] });
	const discarding = ws.view.discard('pipelines/chat.pipe');
	const rewriting = ws.view.write('pipelines/chat.pipe', JSON.stringify(mine, null, 2), 'editor').catch(() => undefined);
	const second: Hold = { entered: deferred(), gate: deferred(), fail: true };
	hold = second;
	first.gate.resolve();
	await saving;
	await discarding;
	await second.entered.promise;
	// step: while the staging store holds the rewrite, the user puts Mine back on the canvas and closes it with Save
	docs.updateContent('chat.pipe', { ...mine });
	const closing = close();
	await flush();
	second.gate.resolve();
	await rewriting;
	const closed = await closing;
	assert.ok(!closed || manifestPaths(s.store, s.alpha).includes('pipelines/chat.pipe'), 'a closed tab means a reload brings the pipeline back');
	assert.equal(closed, false, 'nothing kept the pipeline, so the close is abandoned');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true);
	leave();
});

test('in manual mode, a canvas save that a discard and a write queued behind it overtake still finishes, and the tab stays dirty', { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const { docs, leave } = await canvasForClose(s.alpha, s, ws);
	const mine = { name: 'Mine', components: [] };
	const manifest = `.staging/workspace.test/team-${s.alpha}/manifest.json`;
	// step: hold the manifest write that keeps the canvas's save
	const [entered, gate] = [deferred(), deferred()];
	let held = false;
	const write = s.store.client.fsWriteJson;
	s.store.client.fsWriteJson = async (p: string, value: unknown) => {
		if (p === manifest && !held && JSON.stringify(value).includes('pipelines/chat.pipe')) {
			held = true;
			entered.resolve();
			await gate.promise;
		}
		return write(p, value);
	};
	docs.updateContent('chat.pipe', mine);
	const saving = outcome(saveDocumentEditor(ws.view, 'chat.pipe') ?? undefined);
	await entered.promise;
	// step: a discard and a write of the same text queue behind the save, with no typing
	const discarding = ws.view.discard('pipelines/chat.pipe');
	const rewriting = ws.view.write('pipelines/chat.pipe', JSON.stringify(mine, null, 2), 'editor');
	gate.resolve();
	await discarding;
	await rewriting;
	const within = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('stuck'), 2_000))]);
	assert.equal(await within(saving), 'settled', 'the save does not wait on itself');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true, 'the path moved on after the save, so the tab is not marked clean');
	assert.equal(await within(outcome(saveDocumentEditor(ws.view, 'chat.pipe') ?? undefined)), 'settled', 'the next save is not blocked');
	leave();
});

test("the close dialog's Save checks the version as Ctrl+S does, also for the pipeline the canvas saved last", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, pipePath, failures, leave, close } = await canvasForClose(s.alpha, s, ws);
	// step: the user saves A, then edits it and undoes back to A
	docs.updateContent('chat.pipe', { name: 'A', components: [] });
	await ctrlS(ws.view, 'pipelines/chat.pipe');
	docs.updateContent('chat.pipe', { name: 'X', components: [] });
	docs.updateContent('chat.pipe', { name: 'A', components: [] });
	// step: a teammate stores B, which the page has not heard of
	s.store.files.set(pipePath, JSON.stringify({ name: 'B', components: [] }, null, 2));
	// step: the close dialog's Save is refused, so the canvas shows its stale dialog and the tab stays open
	assert.equal(await close(), false);
	assert.ok(failures[0] instanceof StaleWriteError, 'the canvas got the refusal Ctrl+S gets');
	assert.equal(JSON.parse(s.store.files.get(pipePath) as string).name, 'B');
	leave();
});

test('a canvas that opens on a pipeline Documents restored with unsaved changes asks before its first save', async () => {
	const s = storage();
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	// step: the page reloads with a dirty pipeline in its saved state; the stored file changed while it was closed
	s.store.files.set(pipePath, JSON.stringify({ name: 'Changed while closed', components: [] }, null, 2));
	const ws = await workspace(s.alpha);
	const restored = {
		documents: { 'chat.pipe': { uri: 'chat.pipe', content: { name: 'Mine', components: [] }, dirty: true, version: 4, editorCount: 1, isNew: false } },
		editors: { 'editor-1': { id: 'editor-1', documentUri: 'chat.pipe', scrollTop: 0, scrollLeft: 0, cursorLine: 1, cursorColumn: 1, label: 'chat.pipe' } },
		groups: { 'group-1': { id: 'group-1', editorIds: ['editor-1'], activeEditorIndex: 0 } },
		rootNode: { type: 'leaf', id: 'group-1', groupId: 'group-1' },
		activeGroupId: 'group-1',
	};
	const docs = new Documents({ vfs: createDocumentsVfs(s.store.client as never), workspace: { appState: { documents: restored }, updateAppState: () => {} } });
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, true);

	// step: its canvas mounts at boot; something in the page has read the stored pipeline (the agent's read_file, say), so the server's freshness check passes
	await ws.view.read('pipelines/chat.pipe');
	const doc = canvasDocument(ws.view, docs, 'pipelines/chat.pipe', 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.store.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	await assert.rejects(ctrlS(ws.view, 'pipelines/chat.pipe')!, StaleWriteError, 'the first save asks Reload or Overwrite');
	assert.equal(JSON.parse(s.store.files.get(pipePath) as string).name, 'Changed while closed');

	// step: Overwrite saves the restored pipeline on purpose
	await doc.save(docs.getState().documents['chat.pipe']?.content, { overwrite: true });
	assert.equal(JSON.parse(s.store.files.get(pipePath) as string).name, 'Mine');
	assert.equal(docs.getState().documents['chat.pipe']?.dirty, false);
	leave();
	docs.destroy();
});

test("a canvas reloading a pipeline leaves a text tab's unsaved typing on it guarding the file, and reads the stored pipeline, not the typing", async () => {
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.store.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';
	await ws.view.write(path, JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	const docs = new Documents(createDocumentsVfs(s.store.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.store.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	// step: the same pipeline is open in a text tab too, with unsaved typing
	const text = fileDocument(ws.view, path);
	const closeText = text.open();
	await text.load();
	const typed = JSON.stringify({ name: 'Typed in the text tab', components: [] });
	text.type(typed);

	// step: the user discards the agent's change; the clean canvas reloads, and its read is slow
	const read = holdRead(s, pipePath);
	await ws.view.discardPath(path);
	await read.held;
	const reloading = doc.reload;
	assert.equal(ws.view.isDirty(path), true, "the text tab's typing still guards the pipeline");
	assert.equal(await ws.view.read(path), typed, 'other readers still get the typing');
	await assert.rejects(ws.view.rename(path, 'pipelines/renamed.pipe', 'workspace'), /Save or discard the unsaved changes in pipelines\/chat\.pipe first/);
	read.release();

	assert.equal(await reloading, true);
	assert.equal((docs.getState().documents['chat.pipe']?.content as { name: string }).name, 'Chat', 'the canvas shows the stored pipeline');
	assert.equal(text.text, typed, 'the text tab keeps its typing');
	closeText();
	leave();
});

// =============================================================================
// SLOW READS AND SECOND EDITORS — what an editor loads, and under which version
// =============================================================================

test("a text tab opened over a canvas's unsaved pipeline shows the stored file, so after the canvas discards it the pipeline does not come back through the tab", async () => {
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.store.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';

	// step: the canvas has unsaved changes, then the user opens the pipeline as text
	const docs = new Documents(createDocumentsVfs(s.store.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.store.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	docs.updateContent('chat.pipe', { name: 'Unsaved on the canvas', components: [] });
	const text = fileDocument(ws.view, path);
	const closeText = text.open();
	await text.load();
	assert.deepEqual([JSON.parse(text.text as string).name, text.dirty], ['Chat', false], 'the text tab shows the stored pipeline, not the canvas changes');

	// step: the canvas drops its changes (Discard mine), then the user edits the text tab and saves
	assert.equal(await doc.reloadStored(), true);
	await flush();
	text.type(JSON.stringify({ name: 'Chat', components: [], note: 'mine' }, null, 2));
	await text.save();
	await ws.policy.commitAll();
	assert.deepEqual(JSON.parse(s.store.files.get(pipePath) as string), { name: 'Chat', components: [], note: 'mine' }, 'the discarded canvas changes are not stored');
	closeText();
	leave();
});

test("a canvas's Overwrite asks again about a change that lands while it reads the stored pipeline", async () => {
	const s = storage();
	const ws = await manualWorkspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.store.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';
	const docs = new Documents(createDocumentsVfs(s.store.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.store.client as never);
	const leave = doc.open(() => doc.save(docs.getState().documents['chat.pipe']?.content));
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });

	// step: the agent changes the pipeline and Commit all stores it, so the canvas's save asks Reload or Overwrite
	await ws.view.write(path, JSON.stringify({ name: 'Agent', components: [] }, null, 2), 'agent');
	await ws.policy.commitAll();
	const mine = () => docs.getState().documents['chat.pipe']?.content;
	await assert.rejects(doc.save(mine()), StaleWriteError);

	// step: the user picks Overwrite; its read of the stored pipeline is slow, and the agent changes it again meanwhile
	const read = holdRead(s, pipePath);
	const overwriting = doc.save(mine(), { overwrite: true });
	await read.held;
	await ws.view.write(path, JSON.stringify({ name: 'Agent again', components: [] }, null, 2), 'agent');
	read.release();
	await assert.rejects(overwriting, StaleWriteError, 'the save asks again');
	assert.equal(JSON.parse(String((await ws.view.readVersioned(path, { stored: true })).content)).name, 'Agent again', "the agent's later change stays");
	assert.equal((mine() as { name: string }).name, 'Mine', 'so does the canvas change');
	leave();
});

// =============================================================================
// THE SERVER'S COPY — the dev preview's reads, Reload, and a teammate's change
// =============================================================================

test("a text tab's Reload after a save refused for a teammate's change shows the server's copy, and the next save keeps the change", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();

	// step: a teammate changes the file; the user types and saves, and the save is refused
	s.store.files.set(s.a, 'const probe = 2; // teammate');
	doc.type('const probe = 1; // mine');
	await assert.rejects(doc.save(), StaleWriteError);
	assert.equal(doc.stale, true);

	// step: Reload shows the server's copy, clean; a save on top of it lands and keeps the teammate's change
	await doc.discard();
	assert.deepEqual([doc.text, doc.dirty, doc.stale], ['const probe = 2; // teammate', false, false]);
	doc.type('const probe = 2; // teammate, then mine');
	await doc.save();
	assert.equal(s.store.files.get(s.a), 'const probe = 2; // teammate, then mine');
	close();
});

test("the first Overwrite after a save refused for a teammate's change writes, in a text tab and on a canvas", async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	// step: Overwrite's own read takes the teammate's copy in, which moves the version once more
	const doc = fileDocument(ws.view, 'apps/probe.txt');
	const close = doc.open();
	await doc.load();
	s.store.files.set(s.a, 'const probe = 2; // teammate');
	doc.type('const probe = 1; // mine');
	await assert.rejects(doc.save(), StaleWriteError);
	await doc.save(true);
	assert.equal(s.store.files.get(s.a), 'const probe = 1; // mine');
	close();

	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.store.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const docs = new Documents(createDocumentsVfs(s.store.client as never));
	await docs.openDocument('chat.pipe');
	const canvas = canvasDocument(ws.view, docs, 'pipelines/chat.pipe', 'chat.pipe');
	canvas.projectVfs = createProjectVfs(s.store.client as never);
	const content = () => docs.getState().documents['chat.pipe']?.content;
	const leave = canvas.open(() => canvas.save(content()));
	s.store.files.set(pipePath, JSON.stringify({ name: 'Teammate', components: [] }, null, 2));
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	await assert.rejects(canvas.save(content()), StaleWriteError);
	await canvas.save(content(), { overwrite: true });
	assert.equal(JSON.parse(s.store.files.get(pipePath) as string).name, 'Mine');
	leave();
});

test("editing a canvas during its Reload keeps the edit, and a save of it is refused, so the teammate's change stays", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.store.files.set(pipePath, JSON.stringify({ name: 'Chat', components: [] }, null, 2));
	const path = 'pipelines/chat.pipe';
	const docs = new Documents(createDocumentsVfs(s.store.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, path, 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.store.client as never);
	const content = () => docs.getState().documents['chat.pipe']?.content as { name: string };
	const leave = doc.open(() => doc.save(content()));
	s.store.files.set(pipePath, JSON.stringify({ name: 'Teammate', components: [] }, null, 2));
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	await assert.rejects(doc.save(content()), StaleWriteError);

	// step: the user clicks Reload; its read of the server's pipeline is slow, and the user edits the canvas meanwhile
	const read = holdRead(s, pipePath);
	const reloading = doc.reloadStored();
	await read.held;
	docs.updateContent('chat.pipe', { name: 'Edited during the reload', components: [] });
	read.release();
	assert.equal(await reloading, false, 'the edit stays');
	assert.equal(content().name, 'Edited during the reload');
	await assert.rejects(doc.save(content()), StaleWriteError);
	assert.equal(JSON.parse(s.store.files.get(pipePath) as string).name, 'Teammate');

	// step: Reload again, with nothing edited meanwhile, shows the change
	assert.equal(await doc.reloadStored(), true);
	assert.deepEqual([content().name, docs.getState().documents['chat.pipe']?.dirty], ['Teammate', false]);
	leave();
});

// =============================================================================
// A SAVE CALLED WHILE A SAVE RUNS — Ctrl+S again, and the agent's Save mine first
// =============================================================================

test('Ctrl+S on a canvas again while its save is on its way waits for that save, and is not refused as a change from outside this editor', { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, failures, leave } = await canvasForClose(s.alpha, s, ws);
	const path = 'pipelines/chat.pipe';
	docs.updateContent('chat.pipe', { name: 'Mine', components: [] });
	const write = holdWrite(s, pipePath);
	const first = ctrlS(ws.view, path);
	await write.held;

	// step: the second Ctrl+S saves the same pipeline: it is the first save, and the document stays saving
	const second = ctrlS(ws.view, path);
	await flush();
	assert.equal(doc.saving, true, 'still saving: the first write has not landed');
	write.release();
	await first;
	await second;
	assert.deepEqual(failures, []);
	assert.equal(JSON.parse(s.store.files.get(pipePath) as string).name, 'Mine');
	assert.equal(s.store.landed.filter((w) => w.path === pipePath).length, 1, 'one store write');
	assert.deepEqual([docs.getState().documents['chat.pipe']?.dirty, doc.saving, doc.version], [false, false, ws.view.version(path)]);
	leave();
});

// =============================================================================
// A SAVE THE USER DROPPED — Discard mine, Reload, Overwrite and close while a save waits its turn
// =============================================================================

/**
 * Records every content the store is given for a path. Set it up before any
 * holdWrite of the path, so a held write is recorded when it lands.
 *
 * @param s - The fake store.
 * @param path - The store path.
 * @returns The contents, in the order they landed.
 */
function storeWrites(s: ReturnType<typeof storage>, path: string): string[] {
	const landed: string[] = [];
	const write = s.store.client.fsWriteString;
	s.store.client.fsWriteString = async (p: string, value: string) => {
		await write(p, value);
		if (p === path) landed.push(value);
	};
	return landed;
}

/**
 * A pipeline open on a canvas whose save is PipelineProvider's: it saves
 * what Documents holds, records its failure and rethrows. A save the user
 * dropped is no failure (performSave shows nothing for it), but it rethrows
 * too.
 *
 * @param s - The fake store.
 * @param ws - The workspace.
 * @param pipeline - What the stored pipeline holds.
 */
async function openCanvas(s: ReturnType<typeof storage>, ws: Workspace, pipeline: unknown) {
	const pipePath = `@/Team/=${s.alpha}/.projects/chat.pipe`;
	s.store.files.set(pipePath, JSON.stringify(pipeline, null, 2));
	const docs = new Documents(createDocumentsVfs(s.store.client as never));
	await docs.openDocument('chat.pipe');
	const doc = canvasDocument(ws.view, docs, 'pipelines/chat.pipe', 'chat.pipe');
	doc.projectVfs = createProjectVfs(s.store.client as never);
	const content = () => docs.getState().documents['chat.pipe']?.content;
	const dirty = () => docs.getState().documents['chat.pipe']?.dirty;
	const failures: unknown[] = [];
	const leave = doc.open(async () => {
		try {
			await doc.save(content());
		} catch (err) {
			if (!(err instanceof SaveDroppedError)) failures.push(err);
			throw err;
		}
	});
	return { docs, doc, pipePath, content, dirty, failures, leave, landed: storeWrites(s, pipePath) };
}

/** The names of the pipelines the store was given, in order. */
function names(landed: string[]): string[] {
	return landed.map((content) => (JSON.parse(content) as { name: string }).name);
}

test('a canvas Reload while a second save waits its turn drops that save, and a save of the same pipeline after the Reload is a new save that writes it', { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, content, dirty, failures, leave, landed } = await openCanvas(s, ws, { name: 'Chat', components: [] });
	const path = 'pipelines/chat.pipe';
	docs.updateContent('chat.pipe', { name: 'Saved', components: [] });
	const write = holdWrite(s, pipePath);
	const first = ctrlS(ws.view, path);
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Dropped', components: [] });
	const queued = ctrlS(ws.view, path);

	// step: the user clicks Reload before the first write lands; the reload reads the pipeline once the write is done
	const reloading = doc.reloadStored();
	write.release();
	await first;
	await assert.rejects(queued!, SaveDroppedError);
	assert.equal(await reloading, true);
	assert.deepEqual(names(landed), ['Saved'], 'the dropped pipeline is never written');
	assert.deepEqual([(content() as { name: string }).name, dirty(), doc.saving], ['Saved', false, false]);

	// step: the user saves, and while the write is on its way changes the pipeline, presses Ctrl+S and clicks Reload. During the
	// reload's read they make the same change again, which Documents keeps over the read, and save it: a new save, at the version the write left
	docs.updateContent('chat.pipe', { name: 'Saved, then more', components: [] });
	const again = holdWrite(s, pipePath);
	const third = ctrlS(ws.view, path);
	await again.held;
	docs.updateContent('chat.pipe', { name: 'Dropped', components: [] });
	const fourth = ctrlS(ws.view, path);
	const dropping = doc.reloadStored();
	docs.updateContent('chat.pipe', { name: 'Dropped', components: [] });
	const fifth = ctrlS(ws.view, path);
	again.release();
	await third;
	await assert.rejects(fourth!, SaveDroppedError);
	assert.equal(await dropping, false, 'the typing during the reload stays');
	await fifth;
	assert.deepEqual(names(landed), ['Saved', 'Saved, then more', 'Dropped'], 'the save after the Reload wrote the pipeline, at the version the save before it left');
	assert.deepEqual([dirty(), doc.saving, doc.version], [false, false, ws.view.version(path)]);
	assert.deepEqual(failures, []);
	leave();
});

test("a canvas's Overwrite drops the saves waiting their turn, so an older pipeline is not written and shows no failure", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, content, dirty, failures, leave, landed } = await openCanvas(s, ws, { name: 'Chat', components: [] });
	const path = 'pipelines/chat.pipe';
	docs.updateContent('chat.pipe', { name: 'Saved', components: [] });
	const write = holdWrite(s, pipePath);
	const first = ctrlS(ws.view, path);
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Older', components: [] });
	const queued = ctrlS(ws.view, path);

	// step: the user changes the canvas again and picks Overwrite before the first write lands
	docs.updateContent('chat.pipe', { name: 'Overwritten', components: [] });
	const overwriting = doc.save(content(), { overwrite: true });
	write.release();
	await first;
	await assert.rejects(queued!, SaveDroppedError);
	await overwriting;
	assert.deepEqual(names(landed), ['Saved', 'Overwritten'], 'the older pipeline is never written');
	assert.deepEqual([dirty(), doc.saving, doc.version], [false, false, ws.view.version(path)]);
	assert.deepEqual(failures, []);
	leave();
});

test("a Reload while a text tab's second save waits its turn drops that save, so typing after it is not saved over the first save, and the tab asks", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const landed = storeWrites(s, s.a);
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();

	// step: the user types and saves; while the write is on its way they type more and press Ctrl+S again, and that save waits its turn
	doc.type('const probe = 1; // saved');
	const write = holdWrite(s, s.a);
	const first = doc.save();
	await write.held;
	doc.type('const probe = 1; // saved, then dropped');
	const queued = doc.save();

	// step: the user clicks Reload, then types on the stored text the tab shows
	await doc.discard();
	assert.equal(doc.text, 'const probe = 1;');
	doc.type('const probe = 1; // typed after the discard');
	write.release();
	await first;
	await assert.rejects(queued, SaveDroppedError);
	await flush();
	assert.deepEqual(landed, ['const probe = 1; // saved'], 'neither the dropped text nor the typing after the discard is written');
	assert.deepEqual([doc.text, doc.dirty, doc.stale, doc.saving], ['const probe = 1; // typed after the discard', true, true, false], 'the typing stays, and the tab asks Reload or Overwrite: it does not hold the first save');
	await assert.rejects(doc.save(), StaleWriteError);
	assert.equal(s.store.files.get(s.a), 'const probe = 1; // saved');
	close();
});

test("a text tab's second Overwrite drops the first one and the save waiting its turn, so only the text at the second click is written", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const path = 'apps/probe.txt';
	const doc = fileDocument(ws.view, path);
	const close = doc.open();
	await doc.load();
	s.store.files.set(s.a, 'const probe = 2; // teammate');
	doc.type('const probe = 1; // mine');
	await assert.rejects(doc.save(), StaleWriteError);
	const landed = storeWrites(s, s.a);

	// step: the user picks Overwrite and its read of the server's copy is slow; they type, press Ctrl+S, and pick Overwrite again
	const read = holdRead(s, s.a);
	const first = doc.save(true);
	await read.held;
	doc.type('const probe = 1; // mine, then more');
	const queued = doc.save();
	const second = doc.save(true);
	read.release();
	await assert.rejects(first, SaveDroppedError);
	await assert.rejects(queued, SaveDroppedError);
	await second;
	assert.deepEqual(landed, ['const probe = 1; // mine, then more'], 'the text at the first click is never written');
	assert.deepEqual([doc.dirty, doc.stale, doc.saving, doc.saveError], [false, false, false, null]);
	close();
});

// =============================================================================
// A SAVE THAT OUTLIVES ITS CANVAS: a move, a split, a layout change and a team switch keep it
// =============================================================================

/** How a promise settled: 'saved' when it resolved, else what it rejected with. */
function outcome(work: Promise<unknown> | undefined): Promise<unknown> {
	return (work ?? Promise.resolve()).then(
		() => 'saved',
		(err: unknown) => err
	);
}

/**
 * Saves a pipeline, then, while that write is held, changes it and saves
 * again, so the second save waits its turn (Ctrl+S twice).
 *
 * @param s - The fake store.
 * @param ws - The workspace.
 * @param docs - The Documents that holds the pipeline.
 * @param pipePath - The pipeline's store path.
 * @returns The two saves, and lets the first write land.
 */
async function twoSaves(s: ReturnType<typeof storage>, ws: Workspace, docs: Documents, pipePath: string) {
	docs.updateContent('chat.pipe', { name: 'First', components: [] });
	const write = holdWrite(s, pipePath);
	const first = outcome(ctrlS(ws.view, 'pipelines/chat.pipe'));
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Second', components: [] });
	const second = outcome(ctrlS(ws.view, 'pipelines/chat.pipe'));
	return { first, second, release: write.release };
}

test("two canvases of one pipeline share its document: a save from each split waits its turn, and closing one split keeps the other's save", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc: left, pipePath, content, dirty, failures, leave, landed } = await openCanvas(s, ws, { name: 'Original', components: [] });
	// step: the user splits the group, and a second canvas of the pipeline mounts beside the first
	docs.splitGroupWithDocument(docs.getState().activeGroupId, 'horizontal');
	const right = canvasDocument(ws.view, docs, 'pipelines/chat.pipe', 'chat.pipe');
	right.projectVfs = left.projectVfs;
	const leaveRight = right.open(() => right.save(content()));
	// step: Ctrl+S in the left canvas, whose write the store holds, then typing and Ctrl+S in the right one
	docs.updateContent('chat.pipe', { name: 'First', components: [] });
	const write = holdWrite(s, pipePath);
	const first = outcome(left.save(content()));
	await write.held;
	docs.updateContent('chat.pipe', { name: 'Second', components: [] });
	const second = outcome(right.save(content()));
	// step: the user closes the left split while the right one's save waits its turn
	docs.closeEditor(Object.keys(docs.getState().editors)[0]);
	leave();
	write.release();
	assert.deepEqual([await first, await second], ['saved', 'saved']);
	await flush();
	assert.deepEqual(names(landed), ['First', 'Second'], "the right split's save is written after the left one's");
	assert.deepEqual([dirty(), right.version, failures], [false, ws.view.version('pipelines/chat.pipe'), []]);
	leaveRight();
});

test("a team switch while a canvas's second save waits its turn keeps that save in the team it was called in", { timeout: 10_000 }, async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const { docs, doc, pipePath, failures, leave, landed } = await openCanvas(s, ws, { name: 'Original', components: [] });
	const path = 'pipelines/chat.pipe';
	const { first, second, release } = await twoSaves(s, ws, docs, pipePath);

	// step: the user switches team. RocketApp tears Documents down, which unmounts every canvas, and builds the new
	// team's workspace, which parks the old one: a write that starts after it stays staged there
	docs.destroy();
	leave();
	await workspace(s.beta);
	release();
	assert.deepEqual([await first, await second], ['saved', 'saved']);
	await flush();
	assert.deepEqual(names(landed), ['First'], 'the first save had reached the store');
	assert.equal(JSON.parse(String(await ws.view.read(path))).name, 'Second', "the second is staged in the old team's workspace, which a return to the team brings back");
	assert.equal(s.store.files.get(`@/Team/=${s.beta}/.projects/chat.pipe`), undefined, 'the new team is untouched');
	assert.deepEqual([doc.saving, failures], [false, []]);
	assert.equal(ws.view.isDirty(path), false, "no canvas shows the old team's pipeline, so it guards nothing");
});

// =============================================================================
// WHAT WAITS ON A SAVE: Save & Run, publish, Save mine first and the close dialog's Save stop when it is dropped
// =============================================================================
