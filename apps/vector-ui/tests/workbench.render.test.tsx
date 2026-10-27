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
// THE WORKBENCH RENDERS: the header, the tab row, and on each tab the panel
// that holds today's parts (rendered over a LOCAL env on a fake engine)
// =============================================================================

import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { manualClock } from 'shared/explorer/connect/testing';
import type { IExplorerEndpoint } from 'shared/explorer';
import type { IVectorEnv } from '../src/env';
import type { WorkbenchTab } from '../src/vector/workbench';
import { vectorWorld } from './support/vectorWorld';

// The shell's building blocks exist only inside a running shell: a stand-in for each that renders its text.
const shellStandIn = new Proxy({} as Record<string, unknown>, {
	get: (_target, name: string) => {
		if (name === '__esModule') return false;
		if (name === 'commonStyles') return new Proxy({}, { get: () => ({}) });
		if (name.startsWith('use')) return () => undefined;
		const StandIn = (p: { title?: string; description?: string; children?: React.ReactNode; actions?: React.ReactNode; options?: Array<{ id: string; label: string }> }) => (
			<div data-shell={name}>
				{p.title ? <strong>{p.title}</strong> : null}
				{p.description ? <p>{p.description}</p> : null}
				{p.options?.map((o) => <button key={o.id} type="button">{o.label}</button>)}
				{p.actions}
				{p.children}
			</div>
		);
		return StandIn;
	},
});
const moduleWithLoad = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean): unknown {
	if (request === 'shell') return shellStandIn;
	return originalLoad.call(this, request, parent, isMain);
};

const { makeVectorEndpointStore } = require('../src/adapters/explorer') as typeof import('../src/adapters/explorer');
const { createConnectionRegistry } = require('../src/adapters/connections') as typeof import('../src/adapters/connections');
const { sessionQueryHistory } = require('../src/adapters/queryHistory') as typeof import('../src/adapters/queryHistory');
const { DEVTOOL_HISTORY_NOTE } = require('../src/env') as typeof import('../src/env');
const { VectorEnvProvider } = require('../src/envContext') as typeof import('../src/envContext');
const { createLocalVectorEnv } = require('../src/localEnv') as typeof import('../src/localEnv');
const { DEFAULT_LIMITS, readDialect } = require('../src/vector/results') as typeof import('../src/vector/results');
const { ConsoleView } = require('../src/views/ConsoleView') as typeof import('../src/views/ConsoleView');

/** A LOCAL env over a fake pgvector engine, discovered and probed once. */
async function discovered(): Promise<{ env: IVectorEnv; endpoint: IExplorerEndpoint }> {
	const world = vectorWorld();
	const clock = manualClock();
	const store = makeVectorEndpointStore({ clock, debounceMs: 0 });
	const env = createLocalVectorEnv({ ready: true, client: world.client, store, registry: createConnectionRegistry(), queryHistory: sessionQueryHistory(DEVTOOL_HISTORY_NOTE), activeConnection: { get: () => null, subscribe: () => () => undefined }, openConsole: () => undefined, openDocument: () => undefined });
	const refreshing = env.refresh();
	await clock.advance(0);
	await refreshing;
	await clock.settle();
	return { env, endpoint: env.endpoints.get().endpoints[0] };
}

/**
 * The console's markup with one tab in front.
 *
 * @param env - The env.
 * @param endpoint - The connection.
 * @param tab - The tab.
 * @returns The markup.
 */
function render(env: IVectorEnv, endpoint: IExplorerEndpoint, tab: WorkbenchTab): string {
	const probe = env.endpoints.get().probes[endpoint.key];
	env.connection(endpoint, (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS).tab.set(tab);
	return renderToStaticMarkup(
		<VectorEnvProvider value={env}>
			<ConsoleView opened={endpoint} active />
		</VectorEnvProvider>
	);
}

test('the workbench renders its header and tab row, and on each tab only that tab\'s panel, holding today\'s parts', async () => {
	const { env, endpoint } = await discovered();
	assert.ok(endpoint, 'the premise: a connection');
	const parts: Record<WorkbenchTab, RegExp> = {
		overview: /<section aria-label="Database summary"/,
		documents: /role="tree" aria-label="Folders of the loaded documents"[^]*?role="grid" aria-label="Stored documents"/,
		query: /aria-label="Chat" role="region"[^]*?data-component="SearchPanel"/,
		map: /class="vector-map"/,
		collection: /hnsw \(m 16, ef_construction 64\)/,
		trash: /role="grid" aria-label="Documents in the trash"/,
	};
	for (const tab of Object.keys(parts) as WorkbenchTab[]) {
		const html = render(env, endpoint, tab);
		for (const label of ['Refresh', 'Details', 'Add documents']) assert.ok(html.includes(`>${label}</`), `${tab}: the header's ${label}`);
		assert.match(html, /data-workbench-tabs=""><div data-shell="ToggleGroup"><button type="button">Overview<\/button><button type="button">Documents<\/button><button type="button">Query<\/button><button type="button">Map<\/button><button type="button">Collection<\/button><button type="button">Trash<\/button>/, `${tab}: the tab row, on its own row`);
		assert.ok(html.indexOf('data-workbench-tabs') < html.indexOf('flex-direction:column;padding:'), `${tab}: the tab row is above the panels`);
		assert.equal((html.match(/display:flex;flex-direction:column;padding:/g) ?? []).length, 1, `${tab}: only the tab shown first is mounted`);
		assert.match(html, parts[tab], `${tab}: its panel holds today's part`);
	}
});
