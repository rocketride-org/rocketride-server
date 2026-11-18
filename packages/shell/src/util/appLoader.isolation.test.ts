// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// LOADER ISOLATION — T60 (E1), T61, T62 (sticky set), T63 (E2), T64 (E3), T65 (E4),
// T66 and T67 (E5, E13), T68 (no isolation: the base call pattern)
// =============================================================================
//
// A separate file from appLoader.test.ts on purpose: the sticky isolated set
// is module state that "only ever grows in a document", and node:test runs
// every file in its own process, so these tests start from an empty set. The
// tests inside run in order and ids are unique per test.
//
// Seams pinned here (plan section 3.3 `appLoader.ts`, `config.ts`):
//   * `ServerAppEntry` gains `isolated?` and `firstParty?`;
//   * an isolated entry's `load()` returns `{ id, name, icon, branding: {}, app: IsolatedAppFrame }`
//     and never calls `loadRemote` or `registerRemotes`, and never consults `localOverrides`;
//   * `markIsolated(entry): boolean` adds the id and its module to the sticky sets and returns
//     whether the container had ALREADY loaded in this realm (the "Reload required" case);
//   * `isIsolatedId(appId): boolean` (the WorkspaceContext call-time check);
//   * `repointRemote`, `resetRemote`, `fallbackSkippedRemote`, `loadAppModule` refuse isolated ids;
//   * `registerDevRemote` / `registerLocalApp` do nothing for an id without a `firstParty` stamp
//     while isolation is installed (they may log; they must register nothing);
//   * `applyAppVersionOverride` for an isolated id stores the override, does not touch Module
//     Federation, and fires the descriptor invalidator (the frame is reminted).
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { init } from '@module-federation/runtime';
import * as React from 'react';
import { getLocalAppEntries, getRegisteredEntry, isDevRemote, isRemotePending, loadAppModule, registerAndMapApps, registerDevRemote, registerLocalApp, repointRemote, resetRemote, fallbackSkippedRemote, setDescriptorInvalidator } from './appLoader';
import type { ServerAppEntry } from './appLoader';
import { resetDevGateForTests } from './devGate';
import { applyAppVersionOverride, getAppVersionOverride } from './versionOverride';
import { installDom, render } from '../test/domHarness';
import type { AppDescriptor } from '../components/workspace/types';

const federation = init({ name: 'shell_isolation_test', remotes: [] });
const TEMPLATE = 'https://{label}.apps.example';

const entry = (id: string, extra: Partial<ServerAppEntry> = {}): ServerAppEntry => ({ id, moduleId: id.replace(/\./g, '_'), name: id, registryVersion: 1, ...extra });

interface ISpies {
	registered: string[];
	loaded: string[];
}

/** Spies Module Federation: which containers were registered, which modules were loaded. */
function spyFederation(): ISpies {
	const spies: ISpies = { registered: [], loaded: [] };
	mock.method(federation, 'registerRemotes', (remotes: Array<{ name: string }>) => void remotes.forEach((r) => spies.registered.push(r.name)));
	mock.method(federation, 'loadRemote', async (id: string) => {
		spies.loaded.push(id);
		return { default: { id, name: id } };
	});
	return spies;
}

function stubPage(): void {
	const self = {};
	const store = new Map<string, string>();
	Reflect.set(globalThis, 'window', { self, top: self, location: { search: '' }, addEventListener() {}, removeEventListener() {} });
	Reflect.set(globalThis, 'sessionStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	});
	resetDevGateForTests();
}

afterEach(() => {
	mock.restoreAll();
	setDescriptorInvalidator(null);
});

async function isolation(): Promise<typeof import('../isolation/config')> {
	return await import('../isolation/config');
}

async function loader(): Promise<typeof import('./appLoader') & { markIsolated(e: ServerAppEntry): boolean; isIsolatedId(id: string): boolean }> {
	return (await import('./appLoader')) as never;
}

// ─────────────────────────────────────────────────────────────────────────────
// T68 first: nothing installed, no stamps: the base call pattern, byte for byte
// ─────────────────────────────────────────────────────────────────────────────

test('T68 no isolation and no stamps: the entry is registered as a remote and its load() calls loadRemote (base behaviour)', async () => {
	stubPage();
	const spies = spyFederation();
	const [mapped] = registerAndMapApps([entry('org.plain')]);
	assert.deepEqual(spies.registered, ['org_plain'], 'one registration, for the one container');
	assert.equal(getRegisteredEntry('org_plain') !== undefined, true);
	const descriptor = (await mapped.load()) as AppDescriptor;
	assert.deepEqual(spies.loaded, ['org_plain/AppDescriptor']);
	assert.equal(typeof descriptor, 'object', 'the remote\'s default export is the descriptor');
	assert.equal(isRemotePending('org_plain'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// T60 E1: an isolated entry is never MF-registered, in any mode, with or without the probe
// ─────────────────────────────────────────────────────────────────────────────

test('T60 an isolated:true entry is isolated even with NO probe: never registered, load() is the frame descriptor', async () => {
	stubPage();
	const l = await loader();
	const spies = spyFederation();
	const mapped = registerAndMapApps([entry('acme.noprobe', { isolated: true, icon: '/icons/x.svg' })]);
	assert.equal(mapped.length, 1, 'an isolated entry has no MF load URL but must still be mapped');
	assert.deepEqual(spies.registered, [], 'never passed to registerRemotes');
	assert.equal(getRegisteredEntry('acme_noprobe'), undefined);
	const descriptor = (await mapped[0].load()) as AppDescriptor & { branding?: unknown };
	assert.deepEqual(spies.loaded, [], 'never loadRemote');
	assert.equal(descriptor.id, 'acme.noprobe');
	assert.equal(descriptor.name, 'acme.noprobe');
	assert.deepEqual(descriptor.branding, {});
	assert.equal(typeof descriptor.app, 'function', 'the frame component');
	assert.equal(l.isIsolatedId('acme.noprobe'), true);
});

test('T60 a local override never wins over an isolated entry (load() does not consult localOverrides)', async () => {
	stubPage();
	const spies = spyFederation();
	const [mapped] = registerAndMapApps([entry('acme.override', { isolated: true })]);
	let called = false;
	registerLocalApp('acme.override', async () => {
		called = true;
		return { id: 'acme.override', name: 'evil' } as never;
	});
	const descriptor = (await mapped.load()) as AppDescriptor;
	assert.equal(called, false);
	assert.notEqual(descriptor.name, 'evil');
	assert.deepEqual(spies.loaded, []);
});

test('T60 enforce: an entry without firstParty is isolated, a firstParty entry loads in the realm, with or without the probe stamp', async () => {
	stubPage();
	(await isolation()).installIsolation({ mode: 'enforce', originTemplate: TEMPLATE, protoMin: 1, protoMax: 1 });
	const spies = spyFederation();
	const mapped = registerAndMapApps([entry('acme.unstamped'), entry('rocketride.home', { firstParty: true }), entry('acme.thirdparty', { firstParty: false })]);
	assert.deepEqual(spies.registered, ['rocketride_home'], 'only the first-party container is a remote');
	await mapped[1].load();
	assert.deepEqual(spies.loaded, ['rocketride_home/AppDescriptor']);
	for (const i of [0, 2]) {
		const d = (await mapped[i].load()) as AppDescriptor;
		assert.equal(typeof d.app, 'function');
	}
	assert.deepEqual(spies.loaded, ['rocketride_home/AppDescriptor'], 'the isolated ones never reached loadRemote');
});

// ─────────────────────────────────────────────────────────────────────────────
// T62 the sticky rule, mixed-fleet case (M2)
// ─────────────────────────────────────────────────────────────────────────────

test('T62 M2 mixed fleet: mapped without stamps, stamped isolated by a connect, then opened: no loadRemote, loadAppModule null, the earlier load() is the frame', async () => {
	stubPage();
	const l = await loader();
	const iso = await isolation();
	// the probe came from an `off` pod: no mode installed yet in this scenario's view; first first-party stamp arrives
	iso.noteFirstParty('rocketride.home');
	const spies = spyFederation();
	// optin cannot be reinstalled over enforce; the scenario uses the entry-level stamps of a mixed fleet.
	const probe = entry('acme.late', { firstParty: true });
	const [early] = registerAndMapApps([probe]);
	assert.deepEqual(spies.registered, ['acme_late'], 'the probe entry was mapped in-realm');
	// the connect from an enforce pod stamps it isolated
	const reloadRequired = l.markIsolated(entry('acme.late', { isolated: true }));
	assert.equal(reloadRequired, false, 'nothing of it had loaded in this realm yet');
	const before = spies.registered.length;
	const descriptor = (await early.load()) as AppDescriptor;
	assert.equal(typeof descriptor.app, 'function', 'the load() mapped BEFORE the stamp returns the isolated descriptor');
	assert.deepEqual(spies.loaded, [], 'no loadRemote call');
	assert.equal(await loadAppModule('acme.late', 'telemetry'), null, 'loadAppModule checks the set at call time');
	assert.deepEqual(spies.loaded, []);
	assert.equal(spies.registered.length, before);
});

test('T62 the sticky set only grows: a later push of the same id WITHOUT the stamp stays isolated', async () => {
	stubPage();
	const spies = spyFederation();
	const [again] = registerAndMapApps([entry('acme.late')]);
	assert.ok(!spies.registered.includes('acme_late'), 'not re-registered as a remote');
	const d = (await again.load()) as AppDescriptor;
	assert.equal(typeof d.app, 'function');
	assert.deepEqual(spies.loaded, []);
});

test('T62 an id whose container had already loaded in this realm is flagged for the blocking "Reload required" overlay', async () => {
	stubPage();
	const l = await loader();
	spyFederation();
	const [mapped] = registerAndMapApps([entry('rocketride.loaded', { firstParty: true })]);
	await mapped.load();
	assert.equal(l.markIsolated(entry('rocketride.loaded', { isolated: true })), true, 'in-realm-loaded, now isolated: the shell must unmount and ask for a reload');
});

// ─────────────────────────────────────────────────────────────────────────────
// T63 E2, T64 E3, T65 E4
// ─────────────────────────────────────────────────────────────────────────────

test('T63 E2 loadAppModule is null for an isolated app, for every module path, without a load', async () => {
	stubPage();
	const spies = spyFederation();
	registerAndMapApps([entry('acme.e2', { isolated: true })]);
	for (const p of ['telemetry', 'AppDescriptor', 'widgets/x']) assert.equal(await loadAppModule('acme.e2', p), null, p);
	assert.deepEqual(spies.loaded, []);
	assert.equal(isRemotePending('acme_e2'), false, 'no pending mark was left');
});

test('T64 E3 repointRemote is refused for an isolated module, and a version override reminting the frame leaves Module Federation alone', async () => {
	stubPage();
	const spies = spyFederation();
	registerAndMapApps([entry('acme.e3', { isolated: true })]);
	assert.equal(repointRemote('acme_e3', 'https://x.example/remoteEntry.js'), false);
	assert.deepEqual(spies.registered, []);
	const invalidated: string[] = [];
	setDescriptorInvalidator((appId) => void invalidated.push(appId));
	const result = applyAppVersionOverride('acme.e3', 'acme_e3', { version: 2 });
	assert.equal(result, 'ready');
	assert.equal(getAppVersionOverride('acme.e3')?.version, 2, 'the override is stored (the frame is reminted with it)');
	assert.deepEqual(spies.registered, [], 'no versioned MF URL was ever registered');
	assert.deepEqual(invalidated, ['acme.e3'], 'the descriptor is invalidated so the frame is reminted');
});

test('T65 E4 resetRemote and fallbackSkippedRemote are refused for an isolated app', async () => {
	stubPage();
	const spies = spyFederation();
	registerAndMapApps([entry('acme.e4', { isolated: true })]);
	resetRemote('acme_e4');
	assert.equal(fallbackSkippedRemote('acme.e4'), false);
	assert.deepEqual(spies.registered, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// T66 E5 / T67 E13: dev registration needs a first-party stamp while isolation is installed
// ─────────────────────────────────────────────────────────────────────────────

test('T66 E5 registerDevRemote for an id without a firstParty stamp registers nothing (isolated, unstamped, or brand new)', async () => {
	stubPage();
	const spies = spyFederation();
	for (const [appId, moduleId] of [['acme.devnew', 'acme_devnew'], ['acme.e3', 'acme_e3'], ['acme.unstamped', 'acme_unstamped']]) {
		try {
			registerDevRemote(appId, moduleId, 'Dev', 'http://localhost:3000/remoteEntry.js');
		} catch {
			/* a refusal may throw or may be silent */
		}
		assert.equal(isDevRemote(moduleId), false, `${appId}: not a dev remote`);
		assert.equal(getRegisteredEntry(moduleId), undefined, `${appId}: no entry registered`);
	}
	assert.ok(!spies.registered.some((n) => ['acme_devnew', 'acme_e3', 'acme_unstamped'].includes(n)));
	assert.deepEqual(getLocalAppEntries().filter((e) => e.id.startsWith('acme.')), [], 'no synthetic local entry either');
});

test('T66 E5 a first-party id (stamped) can still be dev-registered: the stamp, not the mode, is the gate', async () => {
	stubPage();
	const spies = spyFederation();
	(await isolation()).noteFirstParty('rocketride.devok');
	registerDevRemote('rocketride.devok', 'rocketride_devok', 'Dev', 'http://localhost:3000/remoteEntry.js');
	assert.equal(isDevRemote('rocketride_devok'), true);
	assert.ok(spies.registered.includes('rocketride_devok'));
});

test('T66 E5 through the message path of devMode (rrdev:registerRemote from the embedder), and T67 through window.__rrShellDev: nothing is registered for an unstamped id', async () => {
	const dom = installDom('http://localhost:5565/?rrdev=1');
	try {
		resetDevGateForTests();
		const spies = spyFederation();
		const { installDevHooks } = await import('./devMode');
		await installDevHooks();
		dom.window.dispatchEvent(
			new (dom.window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', {
				data: { type: 'rrdev:registerRemote', appId: 'acme.viamessage', moduleId: 'acme_viamessage', entry: 'http://localhost:3000/remoteEntry.js' },
				source: dom.window.parent as unknown as MessageEventSource,
			}) as never
		);
		assert.equal(isDevRemote('acme_viamessage'), false, 'the message path');
		assert.ok(!spies.registered.includes('acme_viamessage'));
		const hook = (dom.window as unknown as { __rrShellDev?: { registerLocalApp(id: string, load: () => Promise<unknown>, meta?: object): void } }).__rrShellDev;
		assert.ok(hook, 'the dev hooks are installed in this page');
		hook.registerLocalApp('rocketride.evil2', async () => ({ id: 'rocketride.evil2', name: 'evil' }), { name: 'Evil2' });
		assert.deepEqual(getLocalAppEntries().filter((e) => e.id === 'rocketride.evil2'), [], 'the __rrShellDev route reaches the same refusal');
	} finally {
		dom.cleanup();
	}
});

test('T67 E13 registerLocalApp is refused for an unstamped id (the id the issue names: rocketride.evil)', async () => {
	stubPage();
	let ran = false;
	registerLocalApp('rocketride.evil', async () => {
		ran = true;
		return { id: 'rocketride.evil', name: 'evil' } as never;
	}, { name: 'Evil' });
	assert.deepEqual(getLocalAppEntries().filter((e) => e.id === 'rocketride.evil'), [], 'no local entry for an id with no stamp');
	const [mapped] = registerAndMapApps([entry('rocketride.evil', { isolated: true })]);
	await mapped.load();
	assert.equal(ran, false, 'the refused loader never runs');
});

// ─────────────────────────────────────────────────────────────────────────────
// T61 mixed fleet and probe failure: the tile
// ─────────────────────────────────────────────────────────────────────────────

test('T61 after a failed probe (unknown state) an isolated entry renders the "Isolation unavailable" tile and never a frame', async () => {
	const dom = installDom('http://localhost:5565/');
	try {
		const spies = spyFederation();
		(await isolation()).installIsolation(undefined, { probeFailed: true });
		const [mapped] = registerAndMapApps([entry('acme.tile', { isolated: true })]);
		const descriptor = (await mapped.load()) as AppDescriptor;
		const App = descriptor.app as unknown as React.ComponentType<Record<string, unknown>>;
		const tree = await render(React.createElement(App, { isConnected: true, appId: 'acme.tile' }));
		assert.match(tree.container.textContent ?? '', /Isolation unavailable/);
		assert.equal(tree.container.querySelector('iframe'), null, 'no frame');
		assert.deepEqual(spies.loaded, []);
		await tree.unmount();
	} finally {
		dom.cleanup();
	}
});
