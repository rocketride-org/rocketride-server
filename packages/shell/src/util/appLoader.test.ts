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
import { devPreviewHoldRemainingMs, isDevPreviewPending, isRemoteLoaded, isRemotePending, loadAppModule, registerAndMapApps, registerDevRemote, registerLocalApp, setDescriptorInvalidator } from './appLoader';
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
	const self = {};
	const store = new Map<string, string>();
	Reflect.set(globalThis, 'window', { self, top: framed ? {} : self, location: { search } });
	Reflect.set(globalThis, 'sessionStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	});
}

/** Pins the page clock (ms since navigation start) the hold is measured on. */
function stubClock(ms: number): void {
	mock.method(performance, 'now', () => ms);
}

afterEach(() => {
	mock.restoreAll();
	setDescriptorInvalidator(null);
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
	const [entry] = registerAndMapApps([{ id: 'org.race', moduleId: 'race_mod', name: 'Race', dev: true, entry: 'http://localhost:9/remoteEntry.js' }]);
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
	const [entry] = registerAndMapApps([{ id: 'org.race2', moduleId: 'race_mod2', name: 'Race 2', dev: true, entry: 'http://localhost:9/remoteEntry.js' }]);
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
	const [entry] = registerAndMapApps([{ id: 'org.sync', moduleId: 'sync_mod', name: 'Sync', dev: true, entry: 'http://localhost:9/remoteEntry.js' }]);
	assert.throws(() => entry.load(), /no federation instance/);
	assert.equal(isRemotePending('sync_mod'), false, 'the app load released its mark');
	assert.equal(await loadAppModule('org.sync', 'telemetry'), null);
	assert.equal(isRemotePending('sync_mod'), false, 'the module load released its mark');
});

test('a later registration batch (the apps a sign-in adds) keeps the earlier batch loadable', async () => {
	stubPage('', false);
	stubLoader(async (id: string) => ({ default: id }));
	registerAndMapApps([{ id: 'org.probe', moduleId: 'probe_mod', name: 'Probe', dev: true, entry: 'http://localhost:9/remoteEntry.js' }]);
	registerAndMapApps([{ id: 'org.gated', moduleId: 'gated_mod', name: 'Gated', dev: true, entry: 'http://localhost:9/remoteEntry.js' }]);
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

test('a top-level page never holds', () => {
	stubPage('?appid=org.held&rrdev=1', false);
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
	stubPage('?appid=org.held&rrdev=1', false);
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
