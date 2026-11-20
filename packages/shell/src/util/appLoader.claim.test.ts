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
// PR2b G4 ROUND 1 — a third-party isolated entry cannot claim an in-realm
// app's Module Federation container (DA must-fix 2)
// =============================================================================
//
// `markIsolated` takes only the container the shell itself mapped for that app
// id, and never a module name another in-realm app id owns. Own process: the
// sticky set and the install state are module-level. Isolation is `optin`.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { init } from '@module-federation/runtime';
import { isDevRemote, isIsolatedId, markIsolated, registerAndMapApps, registerDevRemote, repointRemote, resetRemote } from './appLoader';
import type { ServerAppEntry } from './appLoader';
import { resetDevGateForTests } from './devGate';
import { installIsolation } from '../isolation/config';

const federation = init({ name: 'shell_claim_test', remotes: [] });
const entry = (id: string, extra: Partial<ServerAppEntry> = {}): ServerAppEntry => ({ id, moduleId: id.replace(/\./g, '_'), name: id, registryVersion: 1, ...extra });

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

test("G4 an isolated entry claiming a LOADED in-realm app's module name does not ask for a reload", async () => {
	stubPage();
	installIsolation({ mode: 'optin', originTemplate: 'https://{label}.apps.example', protoMin: 1, protoMax: 1 });
	spyFederation();
	const [home] = registerAndMapApps([entry('rocketride.home', { firstParty: true })]);
	await home.load();
	assert.equal(markIsolated(entry('acme.claim', { isolated: true, moduleId: 'rocketride_home' })), false, 'no requireReload for a container acme.claim never owned');
	assert.equal(isIsolatedId('acme.claim'), true, 'the claiming app itself is isolated');
});

test('G4 the claimed container can still be repointed and reset', async () => {
	stubPage();
	const spies = spyFederation();
	registerAndMapApps([entry('rocketride.docs', { firstParty: true })]);
	markIsolated(entry('acme.claim2', { isolated: true, moduleId: 'rocketride_docs' }));
	assert.equal((repointRemote as unknown as (a: string, m: string, u: string) => boolean)('rocketride.docs', 'rocketride_docs', 'https://x.example/remoteEntry.js'), true, 'repoint is not blocked');
	const before = spies.registered.length;
	(resetRemote as unknown as (a: string, m: string) => void)('rocketride.docs', 'rocketride_docs');
	assert.equal(spies.registered.length, before + 1, 'reset is not blocked');
});

test('G4 the claimed container can still be dev-registered by its first-party owner', async () => {
	stubPage();
	spyFederation();
	registerAndMapApps([entry('rocketride.dev3', { firstParty: true })]);
	markIsolated(entry('acme.claim3', { isolated: true, moduleId: 'rocketride_dev3' }));
	registerDevRemote('rocketride.dev3', 'rocketride_dev3', 'Dev', 'http://localhost:3000/remoteEntry.js');
	assert.equal(isDevRemote('rocketride_dev3'), true);
});

test('G4 an isolated entry whose module name nobody else owns is still refused everywhere (control)', async () => {
	stubPage();
	spyFederation();
	registerAndMapApps([entry('acme.own', { isolated: true })]);
	assert.equal((repointRemote as unknown as (a: string, m: string, u: string) => boolean)('acme.own', 'acme_own', 'https://x.example/remoteEntry.js'), false);
	registerDevRemote('acme.own', 'acme_own', 'Dev', 'http://localhost:3000/remoteEntry.js');
	assert.equal(isDevRemote('acme_own'), false);
});
