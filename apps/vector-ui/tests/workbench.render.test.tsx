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
import { NO_STAGED, stage } from '../src/vector/staged';
import { documentOrigin } from '../src/vector/confirm';
import { pgvectorNode, vectorWorld } from './support/vectorWorld';

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
async function discovered(over: Parameters<typeof vectorWorld>[0] = {}): Promise<{ env: IVectorEnv; endpoint: IExplorerEndpoint; clock: ReturnType<typeof manualClock> }> {
	const world = vectorWorld(over);
	const clock = manualClock();
	const store = makeVectorEndpointStore({ clock, debounceMs: 0 });
	const env = createLocalVectorEnv({ ready: true, client: world.client, store, registry: createConnectionRegistry(), queryHistory: sessionQueryHistory(DEVTOOL_HISTORY_NOTE), activeConnection: { get: () => null, subscribe: () => () => undefined }, openConsole: () => undefined, openDocument: () => undefined });
	const refreshing = env.refresh();
	await clock.advance(0);
	await refreshing;
	await clock.settle();
	return { env, endpoint: env.endpoints.get().endpoints[0], clock };
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
		query: /data-component="QueryTab"[^]*?role="tablist" aria-label="Query"[^]*?data-component="SearchPanel"[^]*?data-component="ChatPanel"/,
		map: /class="vector-map"/,
		collection: /hnsw \(m 16, ef_construction 64\)/,
		trash: /role="grid" aria-label="Documents in the trash"/,
	};
	for (const tab of Object.keys(parts) as WorkbenchTab[]) {
		const html = render(env, endpoint, tab);
		for (const label of ['Refresh', 'Details', 'Add documents']) assert.ok(html.includes(`>${label}</`), `${tab}: the header's ${label}`);
		const row = html.slice(html.indexOf('role="tablist" aria-label="Collection views"'), html.indexOf('</div>', html.indexOf('role="tablist" aria-label="Collection views"')));
		assert.deepEqual([...row.matchAll(/role="tab" id="[^"]*-tab-(\w+)"/g)].map((m) => m[1]), ['overview', 'documents', 'query', 'map', 'collection', 'trash'], `${tab}: the tab row, on its own row`);
		assert.match(row, />Trash<\/span><span aria-hidden="true"[^>]*>Trash \(888\)</, `${tab}: the Trash label reserves its count's width`);
		assert.match(row, new RegExp(`aria-selected="true" aria-controls="[^"]*-panel-${tab}" tabindex="0"`), `${tab}: the shown tab is selected and the one in the tab order`);
		assert.equal((row.match(/tabindex="0"/g) ?? []).length, 1, `${tab}: one tab in the tab order (roving)`);
		assert.ok(html.indexOf('data-workbench-tabs') < html.indexOf('flex-direction:column;padding:'), `${tab}: the tab row is above the panels`);
		assert.equal((html.match(/display:flex;flex-direction:column;padding:/g) ?? []).length, 1, `${tab}: only the tab shown first is mounted`);
		assert.match(html, parts[tab], `${tab}: its panel holds today's part`);
	}
});

test('the bottom slot is one line of the same height whatever it holds: nothing, a write\'s line, or the pending bar', async () => {
	const { env, endpoint } = await discovered();
	const probe = env.endpoints.get().probes[endpoint.key];
	const entry = env.connection(endpoint, (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS);
	const slotOf = (html: string): string => {
		const at = html.indexOf('data-bottom-slot=""');
		assert.ok(at > 0, 'the slot is always there');
		const open = html.lastIndexOf('<div', at);
		return html.slice(open, at);
	};
	const empty = render(env, endpoint, 'documents');
	assert.match(empty, /data-bottom-slot=""><\/div>/, 'empty: no words, the same line');
	// A cancelled confirmation leaves "Cancelled. Nothing was sent." in the slot.
	entry.controller.setWritesEnabled(true);
	entry.controller.requestRemove([{ objectId: 'doc-x', path: 'x.md', chunks: 1 }]);
	entry.controller.cancelRemove();
	const cancelled = render(env, endpoint, 'documents');
	assert.match(cancelled, /data-write-line=""[^>]*><div role="status"[^>]*>Cancelled\. Nothing was sent\.</, 'the write line, in the slot');
	// Staged documents: the pending bar takes the slot (the cancelled line shows first only when it lands while staged).
	entry.staged.set(stage(NO_STAGED, [{ objectId: 'doc-y', path: 'y.md', chunks: 2 }]));
	const staged = render(env, endpoint, 'documents');
	assert.equal(slotOf(cancelled), slotOf(empty), 'the slot looks the same with a write line as empty');
	assert.equal(slotOf(staged), slotOf(empty), 'and with the pending bar');
	assert.match(slotOf(empty), /height:32px/, "the pending bar's height");
	entry.controller.dispose();
});

test('R2-I1: every finished write line offers Write details with its whole sentence, even with no audit', async () => {
	const inTrash = (call: { input?: unknown }): boolean => JSON.stringify(call.input ?? {}).includes('deleted');
	const lineOf = (html: string): string => html.slice(html.indexOf('data-bottom-slot=""'));
	// The markup escapes an apostrophe.
	const sentenceIn = (line: string, message: string | null): boolean => message !== null && /<summary[^>]*>Write details<\/summary>/.test(line) && line.includes(`<p style="margin:0">${message.replace(/'/g, '&#x27;')}</p>`);
	// A done write that sent no audit: Empty trash over an empty trash.
	{
		const { env, endpoint } = await discovered({ list_documents: (call) => (inTrash(call) ? { success: true, items: [], next_cursor: null, total: 0, counts_exact: true, distinct: true, sorted: true, caveats: [] } : pgvectorNode(call)) });
		const probe = env.endpoints.get().probes[endpoint.key];
		const entry = env.connection(endpoint, (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS);
		entry.controller.setWritesEnabled(true);
		await entry.controller.requestEmptyTrash();
		const state = entry.controller.getState().removal;
		assert.equal(state.status, 'done', 'the premise: done');
		assert.equal(state.audit, undefined, 'the premise: no audit');
		const line = lineOf(render(env, endpoint, 'trash'));
		assert.ok(sentenceIn(line, state.message), 'Write details, with the whole sentence first');
		entry.controller.dispose();
	}
	// A failure before any batch: the trash could not be listed.
	{
		const { env, endpoint } = await discovered({ list_documents: (call) => (inTrash(call) ? { success: false, code: 'INTERNAL', error: 'boom' } : pgvectorNode(call)) });
		const probe = env.endpoints.get().probes[endpoint.key];
		const entry = env.connection(endpoint, (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS);
		entry.controller.setWritesEnabled(true);
		await entry.controller.requestEmptyTrash();
		const state = entry.controller.getState().removal;
		assert.equal(state.status, 'error', 'the premise: failed before any batch');
		assert.ok(!state.audit || state.audit.length === 0);
		const line = lineOf(render(env, endpoint, 'trash'));
		assert.match(line, /<div role="alert"/);
		assert.ok(sentenceIn(line, state.message), 'Write details, with the whole sentence first');
		entry.controller.dispose();
	}
});

test("R2-B3: Write details lists what the store recorded after Move to trash and after Restore, as after a permanent delete", async () => {
	const { env, endpoint, clock } = await discovered();
	const probe = env.endpoints.get().probes[endpoint.key];
	const entry = env.connection(endpoint, (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS);
	const lineOf = (html: string): string => html.slice(html.indexOf('data-bottom-slot=""'));
	const target = { objectId: '91ae15d4-3f6e-589f-bb81-72301f2ca1b6', path: 'C:/demo/a.md', chunks: 12 };
	entry.controller.setWritesEnabled(true);
	entry.controller.requestRemove([target]);
	await entry.controller.confirmRemove();
	assert.deepEqual(entry.controller.getState().removal.audit, [{ action: 'vector.soft_delete', rows: 12, caller: 'account' }], "the soft_delete answer's audit is kept");
	assert.match(lineOf(render(env, endpoint, 'documents')), /<summary[^>]*>Write details<\/summary>[\s\S]*<li>vector\.soft_delete, 12 rows, called by account<\/li>/);
	// The write checks the store again; Restore waits for that answer, as it would on the page.
	await clock.settle();
	await entry.controller.restore([target]);
	assert.deepEqual(entry.controller.getState().removal.audit, [{ action: 'vector.restore', rows: 12, caller: 'account' }], "the restore answer's audit is kept");
	assert.match(lineOf(render(env, endpoint, 'trash')), /<summary[^>]*>Write details<\/summary>[\s\S]*<li>vector\.restore, 12 rows, called by account<\/li>/);
	entry.controller.dispose();
});

test("B10: a document tab's cancel or write (sharing this controller in the full app) is not the console's line", async () => {
	const { env, endpoint } = await discovered();
	const probe = env.endpoints.get().probes[endpoint.key];
	const entry = env.connection(endpoint, (probe?.ok ? readDialect(probe.info)?.limits : null) ?? DEFAULT_LIMITS);
	entry.controller.setWritesEnabled(true);
	entry.controller.requestRemove([{ objectId: 'doc-x', path: 'x.md', chunks: 1 }], documentOrigin('doc-x'));
	entry.controller.cancelRemove();
	assert.equal(entry.controller.getState().removal.message, 'Cancelled. Nothing was sent.', 'the premise: a cancel in the document tab');
	assert.match(render(env, endpoint, 'documents'), /data-bottom-slot=""><\/div>/, 'the console shows nothing of it');
	entry.controller.requestRemove([{ objectId: 'doc-x', path: 'x.md', chunks: 1 }]);
	entry.controller.cancelRemove();
	assert.match(render(env, endpoint, 'documents'), /data-write-line=""[^>]*><div role="status"[^>]*>Cancelled\. Nothing was sent\.</, "the console's own cancel shows");
	entry.controller.dispose();
});

test("B10: a document surface says what its own write did, in a fixed slot of the hub's height; nothing of another surface's", async () => {
	const { DocumentWriteLine } = require('../src/components/DocumentWriteLine') as typeof import('../src/components/DocumentWriteLine');
	const { CONSOLE_ORIGIN } = require('../src/vector/confirm') as typeof import('../src/vector/confirm');
	const over = (removal: Record<string, unknown>) => ({ controller: { subscribe: () => () => undefined, getState: () => ({ removal }) } }) as unknown as Parameters<typeof DocumentWriteLine>[0]['entry'];
	const draw = (removal: Record<string, unknown>, origin: string): string => renderToStaticMarkup(<DocumentWriteLine entry={over(removal)} origin={origin} returnFocus={() => null} />);
	const slotTag = (html: string): string => html.slice(0, html.indexOf('data-document-write-slot=""'));
	const doc = documentOrigin('doc-x');
	const failed = draw({ status: 'error', message: 'Stopped after 0 of 1 batches: the store is busy.', audit: [], origin: doc }, doc);
	assert.match(failed, /<div role="alert"[^>]*>Stopped after 0 of 1 batches: the store is busy\.<\/div>/, 'a failure of its Move to trash, as an alert');
	assert.match(failed, /<summary[^>]*>Write details<\/summary>[\s\S]*<p[^>]*>Stopped after 0 of 1 batches/, 'with Write details');
	const partial = draw({ status: 'done', message: 'x.md was already gone; nothing was moved to the trash', audit: [], partial: true, origin: doc }, doc);
	assert.match(partial, /<div role="status"[^>]*>x\.md was already gone/, 'a write that did not do all it was asked stays');
	assert.match(draw({ status: 'running', message: null, origin: doc }, doc), /<div role="status"[^>]*>Removing/);
	const empty = draw({ status: 'idle', message: null }, CONSOLE_ORIGIN);
	assert.match(empty, /data-document-write-slot=""><\/div>$/, 'nothing to say: the slot, empty');
	// The console's write, or another document's: not this tab's line (the full app shares one controller).
	assert.match(draw({ status: 'error', message: 'Moved 0 documents.', origin: undefined }, doc), /data-document-write-slot=""><\/div>$/);
	assert.match(draw({ status: 'error', message: 'No.', origin: documentOrigin('doc-y') }, doc), /data-document-write-slot=""><\/div>$/);
	// A dev-tool document frame has its own controller: its writes carry no origin, and show.
	assert.match(draw({ status: 'error', message: 'Stopped after 0 of 1 batches.', audit: [] }, CONSOLE_ORIGIN), /role="alert"[^>]*>Stopped after 0 of 1 batches\./);
	// One height and style in every state, and exactly the hub's slot.
	for (const html of [failed, partial, empty]) assert.equal(slotTag(html), slotTag(empty));
	assert.match(slotTag(empty), /height:32px/);
	const { env, endpoint } = await discovered();
	const hub = render(env, endpoint, 'documents');
	const hubSlot = hub.slice(hub.lastIndexOf('<div', hub.indexOf('data-bottom-slot=""')), hub.indexOf('data-bottom-slot=""'));
	assert.equal(slotTag(empty), hubSlot, "the hub's bottom slot, exactly");
});

