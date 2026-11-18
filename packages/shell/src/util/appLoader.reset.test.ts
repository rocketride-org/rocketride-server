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
// PR2b final batch — resetRemote(appId, moduleId) has repointRemote's checks (DA LOW 1)
// =============================================================================
// Own process, `optin`.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { init } from '@module-federation/runtime';
import { registerAndMapApps, resetRemote } from './appLoader';
import type { ServerAppEntry } from './appLoader';
import { resetDevGateForTests } from './devGate';
import { installIsolation } from '../isolation/config';

const federation = init({ name: 'shell_reset_test', remotes: [] });
const entry = (id: string, extra: Partial<ServerAppEntry> = {}): ServerAppEntry => ({ id, moduleId: id.replace(/\./g, '_'), name: id, registryVersion: 1, ...extra });
const reset = resetRemote as unknown as (appId: string, moduleId: string) => void;

afterEach(() => mock.restoreAll());

test("final: resetting a first-party container while passing an isolated app's id is refused; its owner can reset it", () => {
	const self = {};
	Reflect.set(globalThis, 'window', { self, top: self, location: { search: '' }, addEventListener() {}, removeEventListener() {} });
	Reflect.set(globalThis, 'sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} });
	resetDevGateForTests();
	installIsolation({ mode: 'optin', originTemplate: 'https://{label}.apps.example', protoMin: 1, protoMax: 1 });
	const registered: string[] = [];
	mock.method(federation, 'registerRemotes', (remotes: Array<{ name: string }>) => void remotes.forEach((r) => registered.push(r.name)));
	registerAndMapApps([entry('rocketride.home', { firstParty: true }), entry('acme.y', { isolated: true, moduleId: 'rocketride_home' })]);
	const before = registered.length;
	reset('acme.y', 'rocketride_home');
	assert.equal(registered.length, before, 'refused: acme.y does not own that container');
	reset('rocketride.other', 'rocketride_home');
	assert.equal(registered.length, before, 'refused: nor does any other app id');
	reset('rocketride.home', 'rocketride_home');
	assert.equal(registered.length, before + 1, 'the owner resets it');
});
