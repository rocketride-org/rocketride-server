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
// WORKSPACE TESTS — rocket-ui's real workspace end to end: team switch and timed-out calls
// =============================================================================

/**
 * These tests run rocket-ui's workspace (workspace.ts: its store backend,
 * CachedVfs and the staged view) over a fake store client, the only place
 * the whole stack runs in a test. The client is the one the shell stub's
 * getClient() hands out (scripts/stub-shell.cjs).
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { appPath, readAppImageDataUri, readAppPackage, readAppText, scaffoldApp } from '../../../../rocket-ui/src/surfaces/preview/session/appStore';
import { prepareDependencies } from '../../../../rocket-ui/src/surfaces/preview/session/deps';
import { createWebAppBuilderHost } from '../../../../rocket-ui/src/surfaces/preview/session/webHost';
import { createWorkspace, type Workspace } from '../../../../rocket-ui/src/surfaces/workspace/vfs/workspace';
import { CachedVfs } from 'shell/src/modules/explorer/CachedVfs';
import type { ChatAskAnswer, ChatAskCard, ChatAsking } from 'shell/src/components/chat/types';
import type { AgentHost } from '../agent/host';
import { BUILDER_PROMPTS } from '../agent/prompts';
import { CheckRecord, runAgent } from '../agent/run';
import { FilesystemTools } from '../agent/toolkits/filesystem';
import { runLoop } from '../agent/wave/loop';
import { StagedFileSystem } from './stagedFileSystem';
import { StagingStore } from './staging';

// =============================================================================
// HARNESS
// =============================================================================

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

/** A reply asking for one tool call. */
function plan(tool: string, args: unknown): string {
	return JSON.stringify({ tool_calls: [{ tool, args }] });
}

/** Ends a scripted model run. */
function boundedStop(): never {
	throw new Error('bounded test stop');
}

/** Counts workspaces, so each test roots its own in teams no other test used. */
let teams = 0;

/**
 * A fake store with one app file in each of two teams, as the store client
 * the workspace talks to.
 *
 * @returns The client, its files, the store paths written in order, and the team ids and file paths.
 */
function storage() {
	teams += 1;
	const [alpha, beta] = [`alpha${teams}`, `beta${teams}`];
	const files = new Map<string, string>();
	const writes: string[] = [];
	const a = `@/Team/=${alpha}/.projects/.appdev/probe.txt`;
	const b = `@/Team/=${beta}/.projects/.appdev/probe.txt`;
	files.set(a, 'const probe = 1;');
	files.set(b, 'const probe = 900;');
	const client = {
		fsReadJson: async (path: string) => {
			if (!files.has(path)) throw new Error(`File not found: ${path}`);
			return JSON.parse(files.get(path) as string);
		},
		fsWriteJson: async (path: string, value: unknown) => {
			files.set(path, JSON.stringify(value));
		},
		fsReadString: async (path: string) => {
			if (!files.has(path)) throw new Error(`File not found: ${path}`);
			return files.get(path) as string;
		},
		fsWriteString: async (path: string, value: string) => {
			files.set(path, value);
			writes.push(path);
		},
		fsReadMany: async (paths: string[]) => paths.map((path) => (files.has(path) ? { ok: true, data: new TextEncoder().encode(files.get(path)) } : { ok: false })),
		fsListDir: async () => ({ entries: [] }),
		fsStat: async () => ({ type: 'file' }),
		fsDelete: async (path: string) => {
			files.delete(path);
		},
		fsRmdir: async () => undefined,
		fsMkdir: async () => undefined,
	};
	(globalThis as { __shellTestClient?: unknown }).__shellTestClient = client;
	return { client, files, writes, alpha, beta, a, b };
}

/** The paths a team's staging manifest names, which is what a reload restores. */
function manifestPaths(s: ReturnType<typeof storage>, teamId: string): string[] {
	const manifest = JSON.parse(s.files.get(`.staging/workspace.test/team-${teamId}/manifest.json`) as string) as { layers: Array<{ entries: Record<string, unknown> }> };
	return manifest.layers.flatMap((layer) => Object.keys(layer.entries)).sort();
}

/**
 * A second tab's view of a team: its own staged view and staging store over
 * the same staging namespace. Its base sees no files, which staging does not need.
 */
async function otherTab(teamId: string): Promise<StagedFileSystem> {
	const blank = { list: async () => [], read: async () => Promise.reject(new Error('File not found')), write: async () => undefined, rename: async () => undefined, delete: async () => undefined, mkdir: async () => undefined };
	const view = new StagedFileSystem(new CachedVfs(blank), new StagingStore('workspace.test', `team-${teamId}`));
	await view.whenReady();
	return view;
}

/** The workspace of a team, built the way RocketApp's bootstrap builds it (auto mode unless told). */
function workspace(teamId: string, autoCommit = true): Promise<Workspace> {
	return createWorkspace({ hostAppId: 'workspace.test', autoCommit, scope: { kind: 'team', teamId } });
}

/** An agent host over a view, as createRocketAgentHost binds one. */
function host(vfs: Workspace['view']): AgentHost {
	return { vfs, scaffoldApp: async () => ({ appId: 'unused', folder: 'unused' }), packApp: async () => new Uint8Array(), devSession: () => null };
}

/** What runAgent is asked with: a turn nobody stops and no messages sent during it. */
function options() {
	return { history: [], prompts: BUILDER_PROMPTS, token: async () => '', signal: new AbortController().signal, takeQueued: () => [] };
}

// =============================================================================
// TEAM SWITCH
// =============================================================================

test('a write in flight when the team changes lands in the team it started in', async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	const entered = deferred();
	const release = deferred();
	let reads = 0;
	const read = s.client.fsReadString;
	s.client.fsReadString = async (path: string) => {
		const value = await read(path);
		// step: hold the write's freshness check, after the agent decided to write
		if (path === s.a && ++reads === 2) {
			entered.resolve();
			await release.promise;
		}
		return value;
	};
	let calls = 0;
	const pending = runAgent('edit', () => undefined, options(), {
		host: host(old.view),
		client: () => null,
		markers: async () => null,
		model: async () => {
			switch (++calls) {
				case 1:
					return plan('read_file', { path: 'apps/probe.txt' });
				case 2:
					return plan('edit_file', { path: 'apps/probe.txt', oldString: '1', newString: '2' });
				default:
					return boundedStop();
			}
		},
	});
	await entered.promise;
	const fresh = await workspace(s.beta);
	assert.notEqual(old.view, fresh.view);
	release.resolve();
	await pending;
	assert.equal(s.files.get(s.a), 'const probe = 2;', 'the write landed in the team the run started in');
	assert.equal(s.files.get(s.b), 'const probe = 900;', 'the other team is untouched');
	assert.ok(!s.writes.includes(s.b));
});

test("a write started after the team changes stays staged in the old team's workspace", async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	let calls = 0;
	await runAgent('edit', () => undefined, options(), {
		host: host(old.view),
		client: () => null,
		markers: async () => null,
		model: async () => {
			switch (++calls) {
				case 1:
					return plan('read_file', { path: 'apps/probe.txt' });
				case 2:
					await workspace(s.beta);
					return plan('edit_file', { path: 'apps/probe.txt', oldString: '1', newString: '2' });
				default:
					return boundedStop();
			}
		},
	});
	assert.equal(s.files.get(s.a), 'const probe = 1;');
	assert.equal(s.files.get(s.b), 'const probe = 900;');
	assert.equal(await old.view.read('apps/probe.txt'), 'const probe = 2;');
});

test('a delete the user approves after the team changed lands in the team the run started in', async () => {
	const s = storage();
	// step: list each folder's files, so the delete finds the file it removes
	const listing = async (dir: string) => ({ entries: [...s.files.keys()].filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/')).map((path) => ({ name: path.slice(dir.length + 1), type: 'file' as const })) });
	(s.client as { fsListDir: typeof listing }).fsListDir = listing;
	const old = await workspace(s.alpha);
	const asked = deferred();
	let answer: (value: ChatAskAnswer) => void = () => undefined;
	const cards: ChatAskCard[] = [];
	const ask = (card: ChatAskCard): ChatAsking => {
		cards.push(card);
		asked.resolve();
		return { answer: new Promise<ChatAskAnswer>((settle) => (answer = settle)), approve: () => answer('approve') };
	};
	let calls = 0;
	const pending = runAgent(
		'delete it',
		() => undefined,
		{ ...options(), ask },
		{
			host: host(old.view),
			client: () => null,
			markers: async () => null,
			model: async () => (++calls === 1 ? plan('delete_file', { path: 'apps/probe.txt' }) : boundedStop()),
		}
	);
	// step: the card waits; the user switches team, then approves
	await asked.promise;
	const fresh = await workspace(s.beta);
	answer('approve');
	await pending;
	assert.equal(cards.length, 1);
	// step: the switch parked the old workspace in manual mode, so the delete is staged there
	assert.equal(await old.view.stat('apps/probe.txt'), null, "the delete landed in the old team's workspace");
	assert.ok(old.view.changedPaths().has('apps/probe.txt'));
	assert.equal(await fresh.view.read('apps/probe.txt'), 'const probe = 900;', "the new team's file is still there");
	assert.equal(fresh.view.changedPaths().size, 0);
	// step: back in the first team, the staged delete is pending there and its commit removes that team's file
	const back = await workspace(s.alpha);
	assert.equal(back.view, old.view);
	await back.view.commit();
	assert.equal(s.files.has(s.a), false, 'the commit deleted the file in the team the run started in');
	assert.equal(s.files.get(s.b), 'const probe = 900;', 'the other team is untouched');
});

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
	assert.deepEqual(
		s.writes.filter((path) => path.startsWith(`@/Team/=${s.beta}/`)),
		[],
		'nothing was written to the new team'
	);
});

test('a change an old call stages after the user switches away and back is kept', async () => {
	const s = storage();
	const old = await workspace(s.alpha, false);
	await workspace(s.beta, false);
	const back = await workspace(s.alpha, false);
	// step: the old run's late write lands after the return, then the user edits in the same team
	await old.view.write('apps/late.txt', 'late agent content', 'agent');
	assert.ok(back.view.changedPaths().has('apps/late.txt'), 'the late change shows as pending');
	await back.view.write('apps/new.txt', 'new editor content', 'editor');
	assert.deepEqual(manifestPaths(s, s.alpha), ['apps/late.txt', 'apps/new.txt']);
});

test('going back to a team keeps a change another tab staged there meanwhile', async () => {
	const s = storage();
	await workspace(s.alpha, false);
	await workspace(s.beta, false);
	await (await otherTab(s.alpha)).write('apps/other.txt', 'saved in the other tab', 'editor');
	const back = await workspace(s.alpha, false);
	assert.ok(back.view.changedPaths().has('apps/other.txt'), "the other tab's change shows as pending");
	await back.view.write('apps/current.txt', 'saved here', 'editor');
	assert.deepEqual(manifestPaths(s, s.alpha), ['apps/current.txt', 'apps/other.txt']);
});

test('going back to a team does not bring back a change another tab discarded meanwhile', async () => {
	const s = storage();
	const old = await workspace(s.alpha, false);
	await old.view.write('apps/draft.txt', 'staged before the switch', 'editor');
	await workspace(s.beta, false);
	await (await otherTab(s.alpha)).discard();
	const back = await workspace(s.alpha, false);
	assert.equal(back.view.changedPaths().has('apps/draft.txt'), false);
	await back.view.write('apps/current.txt', 'saved here', 'editor');
	assert.deepEqual(manifestPaths(s, s.alpha), ['apps/current.txt']);
});

test('a read still on its way when the user leaves a team cannot bring back an older file after a save there', async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	const entered = deferred();
	const release = deferred();
	const read = s.client.fsReadString;
	s.client.fsReadString = async (path: string) => {
		const value = await read(path);
		if (path === s.a) {
			entered.resolve();
			await release.promise;
		}
		return value;
	};
	const pending = old.view.read('apps/probe.txt');
	await entered.promise;
	await workspace(s.beta);
	const back = await workspace(s.alpha);
	s.client.fsReadString = read;
	assert.equal(await back.view.read('apps/probe.txt'), 'const probe = 1;');
	await back.view.write('apps/probe.txt', 'const probe = 2;', 'editor');
	release.resolve();
	assert.equal(await pending, 'const probe = 1;', 'the old read returns what it read');
	assert.equal(s.files.get(s.a), 'const probe = 2;');
	assert.equal(await back.view.read('apps/probe.txt'), 'const probe = 2;', 'the saved file, not the old read, is what the cache serves');
});

test('a read still on its way when its folder is deleted or renamed cannot put the old file back in the cache', async () => {
	for (const change of ['delete', 'rename'] as const) {
		const files = new Map([['src/a.ts', 'value = 1']]);
		const entered = deferred();
		const release = deferred();
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
				entered.resolve();
				await release.promise;
				if (text === undefined) throw new Error(`No file ${path}`);
				return text;
			},
			write: async (path, content) => void files.set(path, String(content)),
			rename: (from, to) => move(from, to),
			delete: (path) => move(path),
			mkdir: async () => undefined,
		});
		const pending = cache.read('src/a.ts');
		await entered.promise;
		if (change === 'delete') await cache.delete('src');
		else await cache.rename('src', 'lib');
		release.resolve();
		assert.equal(await pending, 'value = 1', `${change}: the old read returns what it read`);
		assert.equal(cache.cachedContent('src/a.ts'), undefined, `${change}: the cache does not keep a file its folder took away`);
		await assert.rejects(cache.read('src/a.ts'), /No file src\/a\.ts/, `${change}: a later read asks the store, which no longer has the file`);
	}
});

// =============================================================================
// READ-ONLY GUIDES — .rocketride/ in kept and reopened workspaces
// =============================================================================

test("the read-only guides read, and refuse changes, in each team's workspace, a run's old one and a reopened one", async () => {
	const s = storage();
	// step: the server's docs bundle, zipped with the fflate rocket-ui unzips it with
	const { zipSync, strToU8 } = createRequire(resolve(__dirname, '../../../../rocket-ui/package.json'))('fflate') as { zipSync: (files: Record<string, Uint8Array>) => Uint8Array; strToU8: (text: string) => Uint8Array };
	const bundle = zipSync({ 'ROCKETRIDE_APPS.md': strToU8('# Apps guide'), 'ROCKETRIDE_README.md': strToU8('# hidden') });
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		if (String(url) !== '/client/docs') throw new Error(`unexpected fetch ${url}`);
		return new Response(new Blob([new Uint8Array(bundle)]), { status: 200, headers: { 'content-type': 'application/zip' } });
	}) as unknown as typeof fetch;
	const guide = '.rocketride/docs/ROCKETRIDE_APPS.md';
	try {
		const old = await workspace(s.alpha, false);
		assert.equal(await old.view.read(guide), '# Apps guide');
		const fresh = await workspace(s.beta, false);
		const back = await workspace(s.alpha, false);
		assert.equal(back.view, old.view, 'going back reopened the kept workspace');
		// step: the reopened view dropped its cache and walked the tree again, guides included
		assert.ok((await back.view.list('.rocketride/docs')).some((entry) => entry.name === 'ROCKETRIDE_APPS.md'));
		assert.equal(await back.view.read(guide), '# Apps guide');
		assert.equal(await fresh.view.read(guide), '# Apps guide');
		// step: every change to a guide is refused before it stages, in each view, and none reaches the store
		for (const view of [old.view, fresh.view]) {
			await assert.rejects(view.write(guide, 'changed'), /^Error: \.rocketride\/ is read-only reference\. Write under apps\/, nodes\/ or pipelines\/\.$/);
			await assert.rejects(view.delete(guide), /read-only reference/);
			await assert.rejects(view.rename(guide, 'apps/guide.md'), /read-only reference/);
		}
		// step: the agent's own write, after it read the guide, as a run bound to the old team makes it
		const files = new FilesystemTools(old.view);
		const tool = (name: string) => files.tools().find((t) => t.name === name)!;
		assert.match(await (await tool('read_file').prepare({ path: guide })).run(), /# Apps guide/);
		await assert.rejects(async () => (await tool('write_file').prepare({ path: guide, content: 'changed' })).run(), /read-only reference/);
		assert.equal(old.view.hasPendingChanges(), false, 'nothing was staged');
		assert.deepEqual(
			s.writes.filter((path) => path.includes('.rocketride')),
			[],
			'nothing was written to the store'
		);
		assert.equal(await back.view.read(guide), '# Apps guide');
	} finally {
		globalThis.fetch = realFetch;
	}
});

// =============================================================================
// PREVIEW
// =============================================================================

test('a dependency version the preview settles after the team changes is locked in the team it started in', async () => {
	const s = storage();
	const old = await workspace(s.alpha);
	const entered = deferred();
	const release = deferred();
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		// step: hold the version lookup; the module graph is not needed here
		if (String(url).endsWith('/package.json')) {
			entered.resolve();
			await release.promise;
			return { ok: true, json: async () => ({ version: '1.2.3' }) };
		}
		throw new Error('no module graph in this test');
	}) as unknown as typeof fetch;
	try {
		const pending = prepareDependencies('same-ui', 'local.same', { dependencies: { example: '^1' } }, {}, old.view);
		await entered.promise;
		const fresh = await workspace(s.beta);
		release.resolve();
		await pending;
		const lock = 'apps/same-ui/rr-lock.json';
		assert.equal(JSON.parse(String(await old.view.read(lock))).example, '1.2.3');
		assert.equal(fresh.view.changedPaths().has(lock), false);
		assert.deepEqual(
			s.writes.filter((path) => path.startsWith(`@/Team/=${s.beta}/`)),
			[],
			'nothing was written to the new team'
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("the preview's package, text and image reads stay in the team its session opened in", async () => {
	const s = storage();
	for (const [team, name] of [
		[s.alpha, 'Alpha'],
		[s.beta, 'Beta'],
	]) {
		const root = `@/Team/=${team}/.projects/.appdev/same-ui`;
		s.files.set(`${root}/package.json`, JSON.stringify({ name }));
		s.files.set(`${root}/README.md`, `# ${name}`);
		// step: the raw binary read's own path (the test stub has no PROJECT_DIR)
		s.files.set(appPath('same-ui', 'icon.png', { kind: 'team', teamId: team }), name);
	}
	const old = await workspace(s.alpha);
	await workspace(s.beta);
	assert.equal((await readAppPackage('same-ui', old.view)).name, 'Alpha');
	assert.equal(await readAppText('same-ui', 'README.md', old.view), '# Alpha');
	const client = s.client as unknown as Parameters<typeof readAppImageDataUri>[0];
	assert.equal(await readAppImageDataUri(client, 'same-ui', 'icon.png', old.scope), `data:image/png;base64,${btoa('Alpha')}`);
});

test('a listing save whose read ends after the team changes writes the package in the team it started in', async () => {
	for (const autoCommit of [false, true]) {
		const s = storage();
		const pkgPath = (team: string) => `@/Team/=${team}/.projects/.appdev/same-ui/package.json`;
		s.files.set(pkgPath(s.alpha), JSON.stringify({ name: 'alpha-app', appManifest: { id: 'local.same', name: 'Alpha' } }));
		s.files.set(pkgPath(s.beta), JSON.stringify({ name: 'beta-app', appManifest: { id: 'local.same', name: 'Beta' } }));
		const old = await workspace(s.alpha, autoCommit);
		const entered = deferred();
		const release = deferred();
		const read = s.client.fsReadString;
		s.client.fsReadString = async (path: string) => {
			const value = await read(path);
			// step: hold the save's read of the package until the user has switched teams
			if (path === pkgPath(s.alpha)) {
				entered.resolve();
				await release.promise;
			}
			return value;
		};
		const appHost = createWebAppBuilderHost({
			client: s.client as never,
			prefs: undefined as never,
			appId: 'local.same',
			folder: 'same-ui',
			hasReviewLadder: false,
			previewUrl: '',
			session: null,
			onReloadPreview: () => undefined,
			onOpenDebugTab: () => undefined,
		});
		const saving = appHost.saveListing?.({ appId: 'local.same', mode: 'free', name: 'Alpha Listed', description: 'Listed in alpha.', plans: [] });
		await entered.promise;
		const fresh = await workspace(s.beta, autoCommit);
		release.resolve();
		await saving;
		const file = 'apps/same-ui/package.json';
		const mode = autoCommit ? 'auto' : 'manual';
		const saved = JSON.parse(String(await old.view.read(file))) as { name: string; appManifest: { name: string } };
		assert.deepEqual([saved.name, saved.appManifest.name], ['alpha-app', 'Alpha Listed'], `${mode}: the listing landed in the team the save started in`);
		assert.equal(fresh.view.changedPaths().has(file), false, `${mode}: nothing was staged in the new team`);
		assert.equal((JSON.parse(String(await fresh.view.read(file))) as { name: string }).name, 'beta-app', `${mode}: the new team's package is its own`);
		assert.deepEqual(
			s.writes.filter((path) => path.startsWith(`@/Team/=${s.beta}/`)),
			[],
			`${mode}: nothing was written to the new team`
		);
	}
});

/** The parts of a dev session the model test drives: rocket-ui has no Monaco in node, so the test hands it a fake. */
interface DevSessionInternals {
	monaco: unknown;
	models: Map<string, unknown>;
	wireModel(path: string, text: string): unknown;
	adoptExternalChange(path: string): Promise<void>;
	releaseModel(path: string): void;
	emitOne(path: string): Promise<{ js: string } | null>;
}

/**
 * A stand-in for the Monaco API a dev session uses to wire and emit models.
 * Each new model starts at version 1, as Monaco's do, and its emit is its
 * text.
 *
 * @param disposed - Collects the uri of each model disposed.
 * @returns The fake Monaco.
 */
function fakeMonaco(disposed: string[], hold?: { reply: Promise<void>; asked: () => void }): unknown {
	const live = new Map<string, () => string>();
	return {
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
						// the text at the call, as the worker's own copy is; a hold keeps the reply on its way
						const text = live.get(uri)?.() ?? '';
						hold?.asked();
						await hold?.reply;
						return { outputFiles: [{ name: 'out.js', text }] };
					},
				}),
			},
		},
	};
}

test("a deleted file's model leaves the dev session, and a file the store failed to read keeps its model", async () => {
	// step: Monaco's worker wiring subclasses Worker when its module loads
	(globalThis as { Worker?: unknown }).Worker ??= class {};
	const { WebDevSession } = await import('../../../../rocket-ui/src/surfaces/preview/session/devSession');
	for (const autoCommit of [false, true]) {
		const s = storage();
		const mode = autoCommit ? 'auto' : 'manual';
		const root = `@/Team/=${s.alpha}/.projects/.appdev/gone-ui`;
		s.files.set(`${root}/src/unused.ts`, 'export const unused = 1;');
		s.files.set(`${root}/src/kept.ts`, 'export const kept = 1;');
		// step: the store lists what it holds, so the view's tree has both files
		(s.client as { fsListDir: unknown }).fsListDir = async (dir: string) => {
			const found = new Map<string, 'file' | 'dir'>();
			for (const path of s.files.keys()) {
				if (!path.startsWith(`${dir}/`)) continue;
				const [name, ...below] = path.slice(dir.length + 1).split('/');
				found.set(name, below.length ? 'dir' : 'file');
			}
			return { entries: [...found].map(([name, type]) => ({ name, type })) };
		};
		const ws = await workspace(s.alpha, autoCommit);
		const appId = `local.gone${mode}`;
		const session = new WebDevSession(s.client as never, appId, 'gone-ui', 'Gone');
		const internals = session as unknown as DevSessionInternals;
		const disposed: string[] = [];
		internals.monaco = fakeMonaco(disposed);
		try {
			for (const path of ['src/unused.ts', 'src/kept.ts']) internals.wireModel(path, String(await session.vfs.read(path)));
			// step: the store fails a read of a file it still has
			const read = s.client.fsReadString;
			s.client.fsReadString = async (path: string) => {
				if (path === `${root}/src/kept.ts`) throw new Error('socket closed');
				return read(path);
			};
			session.vfs.invalidate('src/kept.ts');
			await internals.adoptExternalChange('src/kept.ts');
			assert.ok(internals.models.has('src/kept.ts'), `${mode}: a failed read keeps the model`);
			assert.deepEqual(disposed, [], `${mode}: no model was disposed`);
			s.client.fsReadString = read;
			// step: the agent deletes the other file; the session hears of it
			await ws.view.delete('apps/gone-ui/src/unused.ts');
			await internals.adoptExternalChange('src/unused.ts');
			assert.equal(internals.models.has('src/unused.ts'), false, `${mode}: the deleted file's model left the session`);
			assert.deepEqual(disposed, [`file:///${appId}/src/unused.ts`], `${mode}: the deleted file's model was disposed`);
			assert.ok(internals.models.has('src/kept.ts'));
		} finally {
			session.dispose();
		}
	}
});

test("a deleted file's compiled output goes with its model, so a new file at its path is compiled again", async () => {
	(globalThis as { Worker?: unknown }).Worker ??= class {};
	const { WebDevSession } = await import('../../../../rocket-ui/src/surfaces/preview/session/devSession');
	const s = storage();
	await workspace(s.alpha);
	const session = new WebDevSession(s.client as never, 'local.reborn', 'reborn-ui', 'Reborn');
	const internals = session as unknown as DevSessionInternals;
	internals.monaco = fakeMonaco([]);
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
	(globalThis as { Worker?: unknown }).Worker ??= class {};
	const { WebDevSession } = await import('../../../../rocket-ui/src/surfaces/preview/session/devSession');
	const s = storage();
	await workspace(s.alpha);
	const session = new WebDevSession(s.client as never, 'local.reborn', 'reborn-ui', 'Reborn');
	const internals = session as unknown as DevSessionInternals;
	const reply = deferred();
	const asked = deferred();
	internals.monaco = fakeMonaco([], { reply: reply.promise, asked: asked.resolve });
	try {
		internals.wireModel('src/a.ts', 'export const value = 1;');
		const inFlight = internals.emitOne('src/a.ts');
		await asked.promise;
		// step: while the worker still holds the reply, the file is deleted and made again at the same path and version
		internals.releaseModel('src/a.ts');
		internals.wireModel('src/a.ts', 'export const value = 2;');
		reply.resolve();
		await inFlight;
		assert.equal((await internals.emitOne('src/a.ts'))?.js, 'export const value = 2;', "the new file's own output, not the deleted file's");
	} finally {
		session.dispose();
	}
});

// =============================================================================
// TIMED-OUT CALLS
// =============================================================================

test('a timed-out edit is never overtaken by a later edit of the same file in the real workspace', async () => {
	const s = storage();
	const ws = await workspace(s.alpha);
	const release = deferred();
	let reads = 0;
	const read = s.client.fsReadString;
	s.client.fsReadString = async (path: string) => {
		const value = await read(path);
		if (path === s.a && ++reads === 2) await release.promise;
		return value;
	};
	const landed: string[] = [];
	const write = s.client.fsWriteString;
	s.client.fsWriteString = async (path: string, value: string) => {
		await write(path, value);
		if (path === s.a) landed.push(value);
	};
	const files = new FilesystemTools(ws.view);
	await (
		await files
			.tools()
			.find((t) => t.name === 'read_file')!
			.prepare({ path: 'apps/probe.txt' })
	).run();
	let calls = 0;
	await runLoop({
		request: 'edit',
		history: [],
		prefix: { role: 'review', instructions: [] },
		tools: files.tools(),
		finish: new CheckRecord(async () => null),
		emit: () => undefined,
		timeoutMs: () => 10,
		signal: new AbortController().signal,
		takeQueued: () => [],
		approve: async (_act, run) => run,
		model: async () => {
			if (++calls === 1) {
				return JSON.stringify({
					tool_calls: [
						{ tool: 'edit_file', args: { path: 'apps/probe.txt', oldString: '1', newString: '2' } },
						{ tool: 'edit_file', args: { path: 'apps/probe.txt', oldString: '1', newString: '3' } },
					],
				});
			}
			return boundedStop();
		},
	});
	// step: the first edit is still held; the second was never run
	assert.deepEqual(landed, []);
	release.resolve();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(landed, ['const probe = 2;']);
	assert.equal(s.files.get(s.a), 'const probe = 2;');
});
