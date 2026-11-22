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
// APP SWITCH — the latest app asked for is the one the store ends on
// =============================================================================
//
// A switch awaits the server (the outgoing app's monitors, the incoming
// partition) before it commits. A request made meanwhile, Back or a second
// click, must win: an earlier target never commits over a later one. These
// tests hold the monitor clear open by hand to make those windows.
// =============================================================================

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { RocketRideClient } from 'rocketride';
import { WorkspaceStore } from './workspaceStore';

/** Drain the microtask queue (a switch chains several plain awaits). */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 25; i++) await Promise.resolve();
};

/**
 * A connected store on `app.a` over a stub client whose monitor clear stays
 * pending until the test releases it, one release per clear in call order.
 */
async function makeStore() {
	const pendingClears: Array<() => void> = [];
	const client = {
		fsReadJson: async (path: string) => {
			if (path === '.workspace/global.json') return { version: 3, activeAppId: 'app.a', shellPrefs: {}, settings: {} };
			throw new Error(`ENOENT ${path}`);
		},
		fsWriteJson: async () => {},
		clearAllMonitors: () => new Promise<void>((resolve) => { pendingClears.push(resolve); }),
		identify: async () => {},
	};
	const store = new WorkspaceStore({ defaultAppId: 'app.a' });
	store.setConnection(client as unknown as RocketRideClient, true);
	await settle();
	assert.equal(store.getSnapshot().activeAppId, 'app.a');

	// Every app the store commits, in order
	const committed: string[] = [];
	let last = store.getSnapshot().activeAppId;
	store.subscribe(() => {
		const active = store.getSnapshot().activeAppId;
		if (active !== last) { committed.push(active); last = active; }
	});

	/** Let the oldest pending monitor clear finish, and what follows it run. */
	const release = async (): Promise<void> => {
		const next = pendingClears.shift();
		assert.ok(next, 'a monitor clear is pending');
		next();
		await settle();
	};
	return { store, committed, release, pendingClears };
}

test('a switch commits its target', async () => {
	const { store, committed, release } = await makeStore();
	void store.switchApp('app.b');
	await release();
	assert.equal(store.getSnapshot().activeAppId, 'app.b');
	assert.deepEqual(committed, ['app.b']);
});

test('Back during a pending switch ends on the app navigated back to, mounted afresh', async () => {
	const { store, committed, release, pendingClears } = await makeStore();
	void store.switchApp('app.b');
	// Back to the app still active: its monitors are being cleared, so it is left and entered again
	void store.switchApp('app.a');
	await release();
	await release();
	assert.equal(store.getSnapshot().activeAppId, 'app.a');
	assert.deepEqual(committed, ['app.b', 'app.a']);
	assert.equal(pendingClears.length, 0);
});

test('a third app asked for during a pending switch commits alone; the first target never shows', async () => {
	const { store, committed, release, pendingClears } = await makeStore();
	void store.switchApp('app.b');
	void store.switchApp('app.c');
	await release();
	// The first target was skipped: the store is still on the outgoing app, switching to the third
	assert.equal(store.getSnapshot().activeAppId, 'app.a');
	await release();
	assert.equal(store.getSnapshot().activeAppId, 'app.c');
	assert.deepEqual(committed, ['app.c']);
	assert.equal(pendingClears.length, 0);
});

test('asking again for the pending target changes nothing', async () => {
	const { store, committed, release, pendingClears } = await makeStore();
	void store.switchApp('app.b');
	void store.switchApp('app.b');
	await release();
	assert.equal(store.getSnapshot().activeAppId, 'app.b');
	assert.deepEqual(committed, ['app.b']);
	assert.equal(pendingClears.length, 0);
});
