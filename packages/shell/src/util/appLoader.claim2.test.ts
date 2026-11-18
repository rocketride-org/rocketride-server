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
// PR2b G4 ROUND 2 — claimed container names (DA 1, DA LOW 1, security LOW-5)
// =============================================================================
//
//   * repointRemote(appId, moduleId, entry) repoints only the container the
//     shell mapped for that app id; an isolated app claiming a first-party
//     container (unloaded) under a changed resolution or a ?version= override
//     leaves its registered URL unchanged; Shell's two repoint loops skip
//     isolated ids;
//   * a claimed name never joins the isolated set: once the first-party owner
//     maps it later, its repoint, reset and dev registration work;
//   * runRescope backs off while a logout is in progress (security LOW-4).
// Own process, `optin`.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { afterEach, mock } from 'node:test';
import { init } from '@module-federation/runtime';
import { getRegisteredEntry, isDevRemote, registerAndMapApps, registerDevRemote, repointRemote, resetRemote } from './appLoader';
import type { ServerAppEntry } from './appLoader';
import { resetDevGateForTests } from './devGate';
import { applyAppVersionOverride, versionedEntryUrl } from './versionOverride';
import { installIsolation } from '../isolation/config';

const federation = init({ name: 'shell_claim2_test', remotes: [] });
const entry = (id: string, extra: Partial<ServerAppEntry> = {}): ServerAppEntry => ({ id, moduleId: id.replace(/\./g, '_'), name: id, registryVersion: 1, ...extra });
const repoint = repointRemote as unknown as (appId: string, moduleId: string, url: string) => boolean;

function spyFederation(): { registered: string[] } {
	const spies = { registered: [] as string[] };
	mock.method(federation, 'registerRemotes', (remotes: Array<{ name: string }>) => void remotes.forEach((r) => spies.registered.push(r.name)));
	mock.method(federation, 'loadRemote', async (id: string) => ({ default: { id, name: id } }));
	return spies;
}

function stubPage(): void {
	const self = {};
	const store = new Map<string, string>();
	Reflect.set(globalThis, 'window', { self, top: self, location: { search: '' }, addEventListener() {}, removeEventListener() {} });
	Reflect.set(globalThis, 'sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
	resetDevGateForTests();
}

afterEach(() => mock.restoreAll());

test('G4r2 an isolated app claiming an UNLOADED first-party container: a changed resolution and a ?version= override leave its URL unchanged', () => {
	stubPage();
	installIsolation({ mode: 'optin', originTemplate: 'https://{label}.apps.example', protoMin: 1, protoMax: 1 });
	spyFederation();
	registerAndMapApps([entry('rocketride.home', { firstParty: true })]);
	const url = getRegisteredEntry('rocketride_home');
	assert.ok(url);
	registerAndMapApps([entry('acme.x', { isolated: true, moduleId: 'rocketride_home', registryVersion: 3 })]);
	assert.equal(repoint('acme.x', 'rocketride_home', versionedEntryUrl('acme.x', 3)), false, 'the reconcile repoint is refused: acme.x does not own that container');
	assert.equal(applyAppVersionOverride('acme.x', 'rocketride_home', { version: 4 }), 'ready');
	assert.equal(getRegisteredEntry('rocketride_home'), url, 'the first-party container still points at its own URL');
	assert.equal(repoint('rocketride.home', 'rocketride_home', versionedEntryUrl('rocketride.home', 2)), true, 'control: its owner can repoint it');
});

test('G4r2 a name claimed before its first-party owner is mapped does not block that owner later', async () => {
	stubPage();
	const spies = spyFederation();
	registerAndMapApps([entry('acme.early', { isolated: true, moduleId: 'rocketride_gated' })]);
	registerAndMapApps([entry('rocketride.gated', { firstParty: true })]);
	assert.equal(repoint('rocketride.gated', 'rocketride_gated', versionedEntryUrl('rocketride.gated', 5)), true, 'repoint');
	const before = spies.registered.length;
	resetRemote('rocketride_gated');
	assert.equal(spies.registered.length, before + 1, 'reset');
	registerDevRemote('rocketride.gated', 'rocketride_gated', 'Dev', 'http://localhost:3000/remoteEntry.js');
	assert.equal(isDevRemote('rocketride_gated'), true, 'dev registration');
});

const SHELL = readFileSync(path.join(__dirname, '..', 'components', 'layout', 'Shell.tsx'), 'utf8');

test('G4r2 Shell: both repoint loops skip isolated ids and pass the app id to repointRemote', () => {
	const calls = [...SHELL.matchAll(/repointRemote\(([^)]*)\)/g)].map((m) => m[1]);
	assert.equal(calls.length, 2, 'the reconcile and the override loops');
	for (const args of calls) assert.match(args, /^\s*(a\.id|appId)\s*,/, `repointRemote(${args}) names the app id first`);
	const reconcile = SHELL.slice(SHELL.indexOf('const identityApps = (identity?.apps'), SHELL.indexOf('}, [identity?.apps]);'));
	assert.match(reconcile, /isIsolatedId\(a\.id\)/, 'the reconcile loop skips isolated ids');
	const override = SHELL.slice(SHELL.indexOf('const overrides = getAppVersionOverrides();'), SHELL.indexOf('}, [identity, apps]);'));
	assert.match(override, /isIsolatedId\(appId\)/, 'the override loop skips isolated ids');
});

test('G4r2 Shell: an org-change rescope backs off while a logout is in progress', () => {
	const at = SHELL.indexOf("cm.on('shell:orgChanged'");
	assert.ok(at > 0);
	assert.match(SHELL.slice(at, at + 600), /loggingOutRef\.current/, 'the orgChanged handler checks the logout flag');
	const logout = SHELL.slice(SHELL.indexOf('const handleLogout = '), SHELL.indexOf('const handleLogout = ') + 900);
	assert.match(logout, /loggingOutRef\.current\s*=\s*true/, 'handleLogout sets it before the final teardown');
	const home = SHELL.slice(SHELL.indexOf('const handleBackToHome = '), SHELL.indexOf('const handleBackToHome = ') + 900);
	assert.match(home, /loggingOutRef\.current\s*=\s*true/, 'handleBackToHome too');
});
