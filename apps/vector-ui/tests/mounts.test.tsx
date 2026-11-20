// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MOUNTS: the cross-lane components of the additive features, in their hosts
// =============================================================================
//
// A component one part of the app renders inside another's host is mounted
// there from the start with its frozen props (src/contract/types.ts), so the
// host and the component can be built apart. Statically rendered (no effects
// run), each host must contain the component's root (data-component), and a
// component that is still a placeholder says "Not built yet":
//
//   ExportMenu        the map toolbar, the directory, "Why these?"
//   SavedViewsMenu    the map toolbar
//   RecommendPanel    the map's Recommend tab (MapView initialTab 'recommend')
//   SimilarityMatrix  the map's Selection tab with a selection
//
// The components built inside their own lane's host are checked by that
// lane's suites.
// =============================================================================

import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IRoleChannel } from 'shared/explorer';
import type { ConsoleActions, ConsoleModel, IDialectResult, VectorChannels } from '../src/contract/types';
import { fixture } from './support/fixtures';
import { loadSample, modelOf } from './support/map.samples';

// The shell's building blocks exist only inside a running shell: plain stand-ins that render their text.
const shellStandIn = {
	commonStyles: new Proxy({}, { get: () => ({}) }),
	EmptyState: (p: { title: string; description?: string; action?: React.ReactNode }) => (
		<div data-empty-state="">
			<strong>{p.title}</strong>
			{p.description ? <p>{p.description}</p> : null}
			{p.action}
		</div>
	),
	Banner: (p: { children?: React.ReactNode }) => <div role="alert">{p.children}</div>,
	Button: (p: { children?: React.ReactNode }) => <button type="button">{p.children}</button>,
};
const moduleWithLoad = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean): unknown {
	if (request === 'shell') return shellStandIn;
	return originalLoad.call(this, request, parent, isMain);
};

const { createSelectionStore } = require('../src/contract/bridge') as typeof import('../src/contract/bridge');
const { MapView } = require('../src/views/MapView') as typeof import('../src/views/MapView');
const { DocumentDirectory } = require('../src/components/DocumentDirectory') as typeof import('../src/components/DocumentDirectory');
const { RetrievalDebugger } = require('../src/components/RetrievalDebugger') as typeof import('../src/components/RetrievalDebugger');
const { pagerInit } = require('../src/vector/documents') as typeof import('../src/vector/documents');

const dialect = fixture<IDialectResult>('dialect_pgvector');
const noop = (): void => undefined;
const KEY = 'mounts-1';
const on = { enabled: true, reason: null };

/** A connection's console model over the pgvector dialect fixture. */
function model(): ConsoleModel {
	return {
		connectionKey: KEY,
		connection: { endpoint: { key: KEY, nodeId: 'store_1', pipelineName: 'Vector demo' } as ConsoleModel['connection']['endpoint'], dialect },
		nodes: { store: 'store_1', embed: 'embed_1', llm: null, llmName: null },
		collection: dialect.collection,
		stats: null,
		limits: dialect.limits,
		capabilities: dialect.capabilities,
		writes: on,
		ingest: on,
		chat: on,
		embed: on,
		readOnly: false,
	};
}

/** A Tools channel that answers nothing (no effect runs in a static render). */
const tools = { invoke: () => new Promise<never>(() => undefined) } as unknown as IRoleChannel;
const channels: VectorChannels = { tools, chat: null, ingest: null };
const actions: ConsoleActions = { openDocument: noop, showOnMap: noop, requestRemove: noop, askAbout: noop, documentsChanged: noop, announce: noop };

/**
 * Assert a component's root is in a host's markup, and that it says "Not built yet" while it is a placeholder.
 *
 * @param html - The host's static markup.
 * @param name - The component.
 */
function mounted(html: string, name: string): void {
	const at = html.search(new RegExp(`<[a-z]+[^>]*data-component="${name}"`));
	assert.ok(at >= 0, `${name} is mounted in its host`);
	const tag = html.slice(at, html.indexOf('>', at) + 1);
	if (tag.includes('data-placeholder')) assert.match(html.slice(at, at + 600), /Not built yet/, `${name} says it is not built yet`);
}

/** The map with sample_demo_1000.json drawn, statically rendered. */
function map(opts: { initialTab?: 'recommend' | 'selection'; keys?: Array<readonly [string, number]> } = {}): string {
	const selection = createSelectionStore(KEY);
	selection.setSampleModel(modelOf(loadSample('sample_demo_1000.json')));
	if (opts.keys) selection.setKeys(opts.keys);
	return renderToStaticMarkup(<MapView model={model()} channels={channels} selection={selection} actions={actions} visible initialTab={opts.initialTab} />);
}

test('the map toolbar carries the Export and Views menus', () => {
	const html = map();
	const toolbar = html.slice(html.indexOf('role="toolbar"'), html.indexOf('aria-label="Map legend"'));
	mounted(toolbar, 'ExportMenu');
	mounted(toolbar, 'SavedViewsMenu');
});

test("the map's Recommend tab holds the RecommendPanel", () => {
	const html = map({ initialTab: 'recommend' });
	assert.match(html, /role="tab" aria-selected="true"[^>]*>Recommend</);
	mounted(html, 'RecommendPanel');
});

test("the map's Selection tab holds the SimilarityMatrix of the selection", () => {
	const sample = loadSample('sample_demo_1000.json');
	const keys = [0, 1, 2].map((i) => [sample.docs[sample.points.doc[i] as number]?.objectId as string, sample.points.chunk[i] as number] as const);
	const html = map({ initialTab: 'selection', keys });
	assert.match(html, /3 points selected/);
	mounted(html, 'SimilarityMatrix');
});

test('the directory carries the ExportMenu', () => {
	const html = renderToStaticMarkup(<DocumentDirectory pager={pagerInit()} selectedId={null} writes={on} onSelect={noop} onRemove={noop} onLoadMore={noop} onRetry={noop} collection="vx_demo_docs" />);
	mounted(html, 'ExportMenu');
});

test('"Why these?" carries the ExportMenu', () => {
	const html = renderToStaticMarkup(<RetrievalDebugger model={model()} channels={channels} question="Where does Falcon Station get its water?" topK={3} onClose={noop} />);
	mounted(html, 'ExportMenu');
});
