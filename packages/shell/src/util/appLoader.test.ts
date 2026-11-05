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

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { init } from '@module-federation/runtime';
import { devPreviewHoldRemainingMs, isDevPreviewPending, isDevRemote, isRemoteLoaded, isRemotePending, loadAppModule, registerAndMapApps, registerDevRemote, registerLocalApp, setDescriptorInvalidator } from './appLoader';
import { resetDevGateForTests } from './devGate';
import type { AppDescriptor } from '../components/workspace/types';

// In the browser the rsbuild MF plugin creates the host instance; stand one
// up so registerDevRemote's registerRemotes has a runtime to register into,
// and so a test can stand in for its module loads (stubLoader).
const federation = init({ name: 'shell_test', remotes: [] });

/**
 * Routes the shell's module loads (Module Federation's loadRemote, which calls
 * the host instance's) to `load` for the current test; afterEach restores it.
 *
 * @param load - Receives the module id (`container/module`) and returns the load.
 */
function stubLoader(load: (id: string) => unknown): void {
	mock.method(federation, 'loadRemote', load);
}

/**
 * Points the loader at a shell page: its query string and whether it is
 * framed (an embedded App Builder preview) or the top-level window.
 */
function stubPage(search: string, framed: boolean): void {
	// The preview behaviour under test is a DEV-build capability: stage it
	// explicitly instead of inheriting whatever NODE_ENV the runner has.
	process.env.NODE_ENV = 'development';
	const self = {};
	const store = new Map<string, string>();
	Reflect.set(globalThis, 'window', { self, top: framed ? {} : self, location: { search } });
	Reflect.set(globalThis, 'sessionStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	});
	// The tab session freezes on first read (a real page's identity never
	// changes mid-session); each stubbed page is a NEW page.
	resetDevGateForTests();
}

/** Pins the page clock (ms since navigation start) the hold is measured on. */
function stubClock(ms: number): void {
	mock.method(performance, 'now', () => ms);
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
	mock.restoreAll();
	setDescriptorInvalidator(null);
	process.env.NODE_ENV = ORIGINAL_NODE_ENV;
	resetDevGateForTests();
});

/** A module loader whose loads stay open until the test settles them, one handle per module id. */
function heldLoader(): Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }> {
	const held = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
	stubLoader((id) => new Promise((resolve, reject) => { held.set(id, { resolve, reject }); }));
	return held;
}

test('a module load that ends first (the waitlist screen\'s telemetry entry) never clears the pending mark of the app load still in flight', async () => {
	stubPage('', false);
	const held = heldLoader();
	const [entry] = registerAndMapApps([{ id: 'org.race', moduleId: 'race_mod', name: 'Race', registryVersion: 1 }]);
	const appLoad = entry.load();
	assert.equal(isRemotePending('race_mod'), true, 'the app load marks the container');
	const telemetry = loadAppModule('org.race', 'telemetry');
	assert.equal(isRemotePending('race_mod'), true);
	// the telemetry entry is missing in this build of the app: its load ends first
	held.get('race_mod/telemetry')!.reject(new Error('no telemetry entry'));
	assert.equal(await telemetry, null);
	assert.equal(isRemotePending('race_mod'), true, 'the app load is still in flight: the container stays committed');
	assert.equal(isRemoteLoaded('race_mod'), false);
	held.get('race_mod/AppDescriptor')!.resolve({ default: { id: 'org.race' } });
	await appLoad;
	assert.equal(isRemotePending('race_mod'), false, 'no load in flight once both ended');
	assert.equal(isRemoteLoaded('race_mod'), true);
});

test('the other order: the app load ends first and the module load keeps the mark until it ends', async () => {
	stubPage('', false);
	const held = heldLoader();
	const [entry] = registerAndMapApps([{ id: 'org.race2', moduleId: 'race_mod2', name: 'Race 2', registryVersion: 1 }]);
	const telemetry = loadAppModule('org.race2', 'telemetry');
	const appLoad = entry.load();
	held.get('race_mod2/AppDescriptor')!.resolve({ default: { id: 'org.race2' } });
	await appLoad;
	assert.equal(isRemotePending('race_mod2'), true, 'the module load is still in flight');
	held.get('race_mod2/telemetry')!.resolve({ default: () => undefined });
	assert.notEqual(await telemetry, null);
	assert.equal(isRemotePending('race_mod2'), false);
});

test('a loader that throws before returning a promise leaves no pending mark (app load and module load)', async () => {
	stubPage('', false);
	stubLoader(() => { throw new Error('no federation instance'); });
	const [entry] = registerAndMapApps([{ id: 'org.sync', moduleId: 'sync_mod', name: 'Sync', registryVersion: 1 }]);
	assert.throws(() => entry.load(), /no federation instance/);
	assert.equal(isRemotePending('sync_mod'), false, 'the app load released its mark');
	assert.equal(await loadAppModule('org.sync', 'telemetry'), null);
	assert.equal(isRemotePending('sync_mod'), false, 'the module load released its mark');
});

test('a later registration batch (the apps a sign-in adds) keeps the earlier batch loadable', async () => {
	stubPage('', false);
	stubLoader(async (id: string) => ({ default: id }));
	registerAndMapApps([{ id: 'org.probe', moduleId: 'probe_mod', name: 'Probe', registryVersion: 1 }]);
	registerAndMapApps([{ id: 'org.gated', moduleId: 'gated_mod', name: 'Gated', registryVersion: 1 }]);
	assert.deepEqual(await loadAppModule('org.probe', 'telemetry'), { default: 'probe_mod/telemetry' }, 'the probe catalog app still resolves');
	assert.deepEqual(await loadAppModule('org.gated', 'telemetry'), { default: 'gated_mod/telemetry' });
});

test('a module load of an unknown app resolves null and marks nothing', async () => {
	stubPage('', false);
	heldLoader();
	assert.equal(await loadAppModule('org.unknown', 'telemetry'), null);
	assert.equal(isRemotePending('org.unknown'), false);
});

test('an embedded dev preview holds its locked app while the registration is pending', () => {
	stubPage('?appid=org.held&rrdev=1', true);
	stubClock(1_000);
	assert.equal(isDevPreviewPending('org.held'), true);
});

test('the hold ends once the dev-remote deadline has passed', () => {
	stubPage('?appid=org.held&rrdev=1', true);
	stubClock(31_000);
	assert.equal(isDevPreviewPending('org.held'), false);
});

test('the hold applies only to the app the preview is locked to', () => {
	stubPage('?appid=org.held&rrdev=1', true);
	stubClock(1_000);
	assert.equal(isDevPreviewPending('org.other'), false);
});

test('a top-level rrdev tab holds too (URL-convention self-registration)', () => {
	// Local-first dev: a top-level F5 tab (?appid&rrdev=1) self-registers
	// its dev build from its own proxy origin, so its first load holds for
	// that registration exactly like a framed preview.
	stubPage('?appid=org.held&rrdev=1', false);
	stubClock(1_000);
	assert.equal(isDevPreviewPending('org.held'), true);
});

test('a page without the rrdev marker never holds', () => {
	stubPage('?appid=org.held', false);
	stubClock(1_000);
	assert.equal(isDevPreviewPending('org.held'), false);
});

test('the hold ends once the locked app registers', () => {
	stubPage('?appid=org.registered&rrdev=1', true);
	stubClock(1_000);
	registerLocalApp('org.registered', () => Promise.resolve({} as AppDescriptor));
	assert.equal(isDevPreviewPending('org.registered'), false);
});

test('the remaining hold time counts down to zero and is zero outside a dev preview', () => {
	stubPage('?appid=org.held&rrdev=1', true);
	stubClock(1_000);
	assert.equal(devPreviewHoldRemainingMs(), 29_000);
	mock.restoreAll();
	stubClock(31_000);
	assert.equal(devPreviewHoldRemainingMs(), 0);
	// Outside a dev preview = no rrdev marker (a top-level rrdev tab is a
	// dev preview now — it self-registers and holds like a framed one).
	stubPage('?appid=org.held', false);
	mock.restoreAll();
	stubClock(1_000);
	assert.equal(devPreviewHoldRemainingMs(), 0);
});

test('a dev registration for a different app than the locked one is reported', () => {
	stubPage('?appid=org.locked&rrdev=1', true);
	setDescriptorInvalidator(() => {});
	const warn = mock.method(console, 'warn', () => {});
	registerDevRemote('org.typo', 'org_typo', 'Typo', 'http://localhost:1/remoteEntry.js');
	const mentionsBoth = warn.mock.calls.some((call) => {
		const text = call.arguments.map(String).join(' ');
		return text.includes('"org.typo"') && text.includes('"org.locked"');
	});
	assert.equal(mentionsBoth, true);
});

test('a dev registration for the locked app is not reported as a mismatch', () => {
	stubPage('?appid=org.match&rrdev=1', true);
	setDescriptorInvalidator(() => {});
	const warn = mock.method(console, 'warn', () => {});
	registerDevRemote('org.match', 'org_match', 'Match', 'http://localhost:1/remoteEntry.js');
	assert.equal(warn.mock.callCount(), 0);
});

test('a dev registration whose entry is not a loopback dev server is refused (no remote, no local app)', () => {
	stubPage('?appid=org.evil&rrdev=1', true);
	setDescriptorInvalidator(() => {});
	mock.method(console, 'error', () => {});
	const registerRemotes = mock.method(federation, 'registerRemotes', () => {});
	for (const [i, entry] of ['https://attacker.example/remoteEntry.js', '//attacker.example/remoteEntry.js', 'javascript:alert(1)', 'http://localhost.attacker.example/remoteEntry.js', 'http://user:pw@localhost:1/remoteEntry.js', '/remoteEntry.js'].entries()) {
		registerDevRemote('org.evil', `org_evil${i}`, 'Evil', entry);
		assert.equal(isDevRemote(`org_evil${i}`), false, entry);
	}
	assert.equal(registerRemotes.mock.callCount(), 0, 'nothing was handed to Module Federation');
	assert.equal(isDevPreviewPending('org.evil'), true, 'the locked app is still waiting for a real registration');
});

test('a dev registration with a loopback dev-server entry is registered', () => {
	stubPage('?appid=org.good&rrdev=1', true);
	setDescriptorInvalidator(() => {});
	registerDevRemote('org.good', 'org_good', 'Good', 'http://127.0.0.1:3001/remoteEntry.js?t=1');
	assert.equal(isDevRemote('org_good'), true);
});

test('the registered entry is the canonical URL that was vetted, not the raw input', () => {
	stubPage('?appid=org.canon&rrdev=1', true);
	setDescriptorInvalidator(() => {});
	const registerRemotes = mock.method(federation, 'registerRemotes', () => {});
	// Tabs and newlines are stripped by the URL parser; the loader must fetch
	// exactly what was vetted.
	registerDevRemote('org.canon', 'org_canon', 'Canon', 'http://loc\talhost:3001/remote\nEntry.js?t=1');
	assert.equal(isDevRemote('org_canon'), true);
	assert.equal(registerRemotes.mock.callCount(), 1, 'the module federation runtime was handed the remote');
	assert.deepEqual(registerRemotes.mock.calls[0].arguments[0], [{ name: 'org_canon', entry: 'http://localhost:3001/remoteEntry.js?t=1' }]);
});

test('a production build never holds for a dev preview, whatever the URL and tab session say', () => {
	stubPage('?appid=org.held&rrdev=1', true);
	process.env.NODE_ENV = 'production';
	resetDevGateForTests();
	stubClock(1_000);
	assert.equal(isDevPreviewPending('org.held'), false);
	assert.equal(devPreviewHoldRemainingMs(), 0);
});
