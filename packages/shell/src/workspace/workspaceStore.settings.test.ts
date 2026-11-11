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
// PARTITION-RESIDENT SETTINGS — the storage cutover's load-bearing behaviors
// =============================================================================
//
// Settings deltas live in their OWNING partition's file (shell → global.json,
// apps → <id>.workspace.json); the legacy flat settings.json is NEVER read
// nor written. These tests pin exactly that, over a stub fs client.
// =============================================================================

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { RocketRideClient } from 'rocketride';
import { WorkspaceStore, SHELL_PARTITION, appPartition } from './workspaceStore';

/** One microtask-queue drain (the store's load path awaits plain promises). */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** An in-memory fs stub recording every read and write by path. */
function makeClient(files: Record<string, unknown>) {
	const reads: string[] = [];
	const writes = new Map<string, unknown>();
	const client = {
		fsReadJson: async (path: string) => {
			reads.push(path);
			if (path in files) return files[path];
			throw new Error(`ENOENT ${path}`);
		},
		fsWriteJson: async (path: string, body: unknown) => {
			writes.set(path, body);
		},
	};
	return { client: client as unknown as RocketRideClient, reads, writes };
}

/** A connected store over the stub, fully loaded. */
async function makeStore(files: Record<string, unknown>) {
	const fs = makeClient(files);
	const store = new WorkspaceStore({ defaultAppId: 'test.app' });
	store.setConnection(fs.client, true);
	await settle();
	return { store, ...fs };
}

test('load reads shell settings from global.json and NEVER touches settings.json', async () => {
	const { store, reads } = await makeStore({
		'.workspace/global.json': { version: 3, activeAppId: 'test.app', shellPrefs: { theme: 'light' }, settings: { 'rocketride.general.sidebar': 'rocketride' } },
	});

	assert.equal(store.getSnapshot().loaded, true);
	assert.equal(store.getSnapshot().settings['rocketride.general.sidebar'], 'rocketride');
	assert.equal(reads.some((p) => p.endsWith('/settings.json')), false, 'the legacy flat file must never be read');
});

test('shell-partition updates land in global.json (deltas only; undefined deletes)', async () => {
	const { store, writes } = await makeStore({});

	store.updateSetting(SHELL_PARTITION, 'rocketride.general.sidebar', 'vscode');
	store.flushNow();
	await settle();
	let global = writes.get('.workspace/global.json') as { settings?: Record<string, unknown> };
	assert.equal(global.settings?.['rocketride.general.sidebar'], 'vscode');

	store.updateSetting(SHELL_PARTITION, 'rocketride.general.sidebar', undefined);
	store.flushNow();
	await settle();
	global = writes.get('.workspace/global.json') as { settings?: Record<string, unknown> };
	assert.equal('rocketride.general.sidebar' in (global.settings ?? {}), false, 'reset deletes the delta');
});

test('app-partition updates ride the partition file and join the merged snapshot', async () => {
	const { store, writes } = await makeStore({});
	const partition = appPartition('builtin.pipelines');

	store.updateSetting(partition, 'rocketride.pipeBuilder.pipelineTTL', 1800);
	assert.equal(store.getSnapshot().settings['rocketride.pipeBuilder.pipelineTTL'], 1800, 'merged view sees the delta immediately');
	assert.deepEqual(store.settingsFor(partition), { 'rocketride.pipeBuilder.pipelineTTL': 1800 });

	store.flushNow();
	await settle();
	const slice = writes.get('.workspace/builtin.pipelines.workspace.json') as { settings?: Record<string, unknown> };
	assert.equal(slice.settings?.['rocketride.pipeBuilder.pipelineTTL'], 1800);
	assert.equal(writes.has('.workspace/settings.json'), false, 'the legacy flat file must never be written');
});

test('ensurePartition pulls a partition file whose settings join the merged view', async () => {
	const partition = appPartition('builtin.pipelines');
	const { store } = await makeStore({
		'.workspace/builtin.pipelines.workspace.json': { prefs: { activeView: 'x' }, appState: {}, settings: { 'rocketride.pipeBuilder.pipelineTraceLevel': 'none' } },
	});

	assert.equal(store.getSnapshot().settings['rocketride.pipeBuilder.pipelineTraceLevel'], undefined, 'not loaded yet');
	await store.ensurePartition(partition);
	assert.equal(store.getSnapshot().settings['rocketride.pipeBuilder.pipelineTraceLevel'], 'none');
});

test('shell and partition deltas merge; settingsFor stays per-partition', async () => {
	const { store } = await makeStore({
		'.workspace/global.json': { version: 3, activeAppId: 'test.app', settings: { 'rocketride.general.sidebar': 'cursor' } },
	});
	const partition = appPartition('acme.tool');
	store.updateSetting(partition, 'acme.tool.flag', true);

	const merged = store.getSnapshot().settings;
	assert.equal(merged['rocketride.general.sidebar'], 'cursor');
	assert.equal(merged['acme.tool.flag'], true);
	assert.deepEqual(store.settingsFor(SHELL_PARTITION), { 'rocketride.general.sidebar': 'cursor' });
	assert.deepEqual(store.settingsFor(partition), { 'acme.tool.flag': true });
});
