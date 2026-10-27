// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CONSOLE MOUNTS: the console's own additive panels, in their hosts
// =============================================================================
//
// Statically rendered (no effects run): the directory's filter row is the
// ScopeBar, whose first field is the path box and which keeps the header one
// row with no scope; the stats strip ends with a collapsed Charts disclosure
// holding the StatsCharts; a document tab holds its HealthPanel. A component
// still a placeholder says "Not built yet".
// =============================================================================

import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IRoleChannel } from 'shared/explorer';
import type { ConsoleActions, ConsoleModel, IDialectResult, IDocumentItem, IExportItem, IScopeState, VectorChannels } from '../src/contract/types';
import { fixture } from './support/fixtures';

// The shell's building blocks exist only inside a running shell: plain stand-ins that render their text.
const shellStandIn = {
	commonStyles: new Proxy({}, { get: () => ({}) }),
	Banner: (p: { children?: React.ReactNode }) => <div role="alert">{p.children}</div>,
	Button: (p: { children?: React.ReactNode; disabled?: boolean }) => (
		<button type="button" disabled={p.disabled}>
			{p.children}
		</button>
	),
	BxTrash: () => <svg aria-hidden="true" />,
	ToggleGroup: (p: { options: Array<{ id: string; label: string }> }) => <div>{p.options.map((o) => <button key={o.id} type="button">{o.label}</button>)}</div>,
	ContentHeader: (p: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
		<header>
			<h1>{p.title}</h1>
			{p.subtitle ? <p>{p.subtitle}</p> : null}
			{p.actions}
		</header>
	),
	StatusBadge: (p: { children?: React.ReactNode; label?: string }) => <span>{p.children ?? p.label}</span>,
};
const moduleWithLoad = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean): unknown {
	if (request === 'shell') return shellStandIn;
	return originalLoad.call(this, request, parent, isMain);
};

// The directory's export items as the ExportMenu receives them: a stand-in that records its props.
let exportItems: readonly IExportItem[] = [];
function ExportMenuStandIn(props: { items: readonly IExportItem[] }): React.ReactElement {
	exportItems = props.items;
	return <span data-component="ExportMenu" />;
}
const exportMenuPath = require.resolve('../src/components/ExportMenu');
require.cache[exportMenuPath] = { id: exportMenuPath, filename: exportMenuPath, loaded: true, exports: { __esModule: true, default: ExportMenuStandIn, ExportMenu: ExportMenuStandIn } } as never;

const { createSelectionStore } = require('../src/contract/bridge') as typeof import('../src/contract/bridge');
const { renderDocumentsTab } = require('./support/panels') as typeof import('./support/panels');
const { StatsAsOf, StatsStrip } = require('../src/components/StatsStrip') as typeof import('../src/components/StatsStrip');
const { OverviewView } = require('../src/components/OverviewPanel') as typeof import('../src/components/OverviewPanel');
const { StatsCharts } = require('../src/components/StatsCharts') as typeof import('../src/components/StatsCharts');
const { HealthPanel } = require('../src/components/HealthPanel') as typeof import('../src/components/HealthPanel');
const { healthSummary } = require('../src/vector/health') as typeof import('../src/vector/health');
const { readDialect } = require('../src/vector/results') as typeof import('../src/vector/results');
const { DocumentView } = require('../src/views/DocumentView') as typeof import('../src/views/DocumentView');
const { pagerApplyPage, pagerBegin, pagerFail, pagerInit } = require('../src/vector/documents') as typeof import('../src/vector/documents');
const { readDocumentsPage, readStats } = require('../src/vector/results') as typeof import('../src/vector/results');

const dialect = fixture<IDialectResult>('dialect_pgvector');
const noop = (): void => undefined;
const on = { enabled: true, reason: null };

/**
 * Assert a component's root is in a host's markup, and that it says "Not built yet" while it is a placeholder.
 *
 * @param html - The host's static markup.
 * @param name - The component.
 * @returns Where its root starts.
 */
function mounted(html: string, name: string): number {
	const at = html.search(new RegExp(`<[a-z]+[^>]*data-component="${name}"`));
	assert.ok(at >= 0, `${name} is mounted in its host`);
	if (html.slice(at, html.indexOf('>', at)).includes('data-placeholder')) assert.match(html.slice(at, at + 600), /Not built yet/, `${name} says it is not built yet`);
	return at;
}

test('the Documents tab: the ScopeBar is its filter row, with the path box first, above the grid', () => {
	const pager = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage(fixture('list_documents_page1')));
	const html = renderDocumentsTab({ directory: pager });
	const at = mounted(html, 'ScopeBar');
	const bar = html.slice(at, html.indexOf('</div>', at));
	assert.match(bar, /^<div[^>]*>(<div[^>]*>)?<input type="search" placeholder="Filter paths…" aria-label="Filter documents by path"/, 'the path box is its first field');
	assert.equal((html.match(/aria-label="Filter documents by path"/g) ?? []).length, 1, 'one path box');
	assert.ok(html.indexOf('data-component="ScopeBar"') < html.indexOf('aria-label="Stored documents"'));
});

/** An Overview over these rows, with nothing to call. */
function overview(rows: readonly IDocumentItem[], over: Partial<React.ComponentProps<typeof OverviewView>> = {}): string {
	const stats = { view: readStats(fixture('stats_pgvector')), status: 'ready' as const, error: null, lastAt: 0, mode: 'full' as const };
	const health = healthSummary(rows, { medianChunks: null, complete: true });
	return renderToStaticMarkup(<OverviewView stats={stats} dialect={dialect} readOnly={false} rows={rows} scopedRows={rows} loading={false} complete scoped={false} scopeLine={null} scopeFilter={null} sample={null} health={health} median={null} onChartScope={noop} onOpenDocument={noop} onOpenTab={noop} onNewQuery={noop} onAddDocuments={noop} fieldsRead={null} {...over} />);
}

test('the Overview: the cards on top, then Summary, Charts and Insights on a row of their own; Charts holds the StatsCharts', () => {
	const rows: IDocumentItem[] = readDocumentsPage(fixture('list_documents_page1')).items;
	const summary = overview(rows);
	assert.ok(summary.indexOf('aria-label="Database summary"') < summary.indexOf('role="tablist" aria-label="Overview"'), 'the cards first');
	assert.match(summary, /role="tab" aria-selected="true" tabindex="0"[^>]*data-overview-view="summary">Summary</);
	assert.match(summary, /data-overview-view="insights">Insights \(\d+\)</);
	assert.doesNotMatch(summary, /data-component="StatsCharts"/, 'the charts are drawn only on their view');
	mounted(overview(rows, { initialView: 'charts' }), 'StatsCharts');
});

test('the Overview renders with 130,000 loaded rows (Load more, 25 times): the charts bin them and Top folders counts them, without a RangeError', () => {
	const rows: IDocumentItem[] = Array.from({ length: 130_000 }, (_, i) => ({ objectId: `d${i}`, path: `C:/corp/f${i % 97}/d${i}.pdf`, chunks: 1 + (i % 40), has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: 1, modifyTime: null, ingestedAt: `2026-0${1 + (i % 9)}-15T00:00:00Z`, pointId: null }));
	assert.match(overview(rows, { initialView: 'charts' }), /aria-label="Chunks per document, 130,000 documents in /, 'every loaded row is binned');
	assert.match(overview(rows), /Other folders \(90\)/, 'seven folders named, the other 90 in one row');
});

test('while a scope is active the stats strip says what it covers on a second line', () => {
	const stats = { view: readStats(fixture('stats_pgvector')), status: 'ready' as const, error: null, lastAt: 0, mode: 'full' as const };
	const html = renderToStaticMarkup(<StatsStrip stats={stats} dialect={dialect} readOnly={false} scopeLine="Scope: 12 of 42 documents · 318 chunks (counted here)" />);
	assert.match(html, /role="status"[^>]*data-scope-line=""[^>]*>Scope: 12 of 42 documents · 318 chunks \(counted here\)<\/div>/);
	assert.doesNotMatch(renderToStaticMarkup(<StatsStrip stats={stats} dialect={dialect} readOnly={false} />), /data-scope-line/, 'no line without a scope');
});

test('the charts: four figures, each a labelled picture over real buttons for the bars the store can be asked for, and a table of every bin', () => {
	const rows: IDocumentItem[] = [...readDocumentsPage(fixture('list_documents_page1')).items, ...readDocumentsPage(fixture('list_documents_page2_last')).items];
	const html = renderToStaticMarkup(<StatsCharts rows={rows} total={42} dialect={dialect} onScope={noop} />);
	assert.doesNotMatch(html, /Not built yet/);
	for (const id of ['chunks', 'length', 'types', 'ingest']) assert.match(html, new RegExp(`data-chart="${id}"`), id);
	assert.equal((html.match(/<svg role="img" aria-label="/g) ?? []).length, 3, 'three pictures; chunk length waits for the sample');
	assert.match(html, /<svg role="img" aria-label="Chunks per document, 7 documents in 5 bins: most in 4–7 \(3\); the top bin is 16–31 \(2\)\."[^>]*><title>Chunks per document, 7 documents/);
	assert.match(html, /<button type="button" aria-label="16–31 chunks: 2 documents\. Scope the documents to these" aria-pressed="false"/);
	assert.match(html, /<span style="flex:1" aria-hidden="true"><\/span><span style="flex:1" aria-hidden="true"><\/span><button/, 'empty bins have no button');
	assert.match(html, /aria-label="pdf: 2 documents\. Scope the documents to these"/);
	assert.match(html, /Draw the map&#x27;s sample to see chunk lengths/);
	assert.match(html, /<caption>Chunks per document: 7 of 42 documents loaded · median 9 chunks<\/caption>/);
	assert.match(html, /<tr><td>4–7<\/td><td>3<\/td><\/tr>/);
	assert.match(html, /<tr><td>1<\/td><td>0<\/td><\/tr>/, 'empty bins are in the table too');
	assert.doesNotMatch(renderToStaticMarkup(<StatsCharts rows={rows} dialect={dialect} />), /<button/, 'no click handler: the bars are not buttons');
});

test('the charts mark the bar the scope selected (pressed, outlined) and say what they cannot draw', () => {
	const rows: IDocumentItem[] = readDocumentsPage(fixture('list_documents_page1')).items;
	const html = renderToStaticMarkup(<StatsCharts rows={rows} dialect={dialect} onScope={noop} scope={{ file_types: ['md'] }} />);
	assert.match(html, /aria-label="md: 2 documents\. Scope the documents to these" aria-pressed="true"/);
	assert.equal((html.match(/data-selected=""/g) ?? []).length, 1);
	const nostore = readDialect({ ...fixture('dialect_pgvector'), caveats: ['extras_not_stored'] });
	assert.match(renderToStaticMarkup(<StatsCharts rows={rows} dialect={nostore} />), /<p role="note"[^>]*>This store does not keep ingest times<\/p>/);
	const loading = renderToStaticMarkup(<StatsCharts rows={[]} dialect={dialect} loading />);
	assert.match(loading, /<svg aria-hidden="true"/, 'skeleton bars');
	assert.match(loading, /role="status"[^>]*>Loading documents…</);
	assert.match(renderToStaticMarkup(<StatsCharts rows={[]} dialect={dialect} />), /No documents to chart yet\./);
});

/** Every element in a React tree (function components are not called). */
function elementsOf(node: React.ReactNode, out: React.ReactElement[] = []): React.ReactElement[] {
	if (Array.isArray(node)) for (const child of node) elementsOf(child, out);
	else if (React.isValidElement(node)) {
		out.push(node);
		elementsOf((node.props as { children?: React.ReactNode }).children, out);
	}
	return out;
}

test("the strip's one-second clock re-renders only the 'counts as of' words; the charts are memoised and drawn apart", () => {
	const stats = { view: readStats(fixture('stats_pgvector')), status: 'ready' as const, error: null, lastAt: 0, mode: 'full' as const };
	const props = { stats, dialect, readOnly: false };
	// The strip itself keeps no state (called outside React, a hook would throw): the clock lives in StatsAsOf.
	const first = elementsOf(StatsStrip(props));
	const clock = first.filter((e) => e.type === StatsAsOf);
	assert.equal(clock.length, 1, 'one clock');
	assert.equal((clock[0]?.props as { view: unknown }).view, stats.view);
	assert.ok(!first.some((e) => e.type === StatsCharts), 'no chart under the clock');
	assert.equal((StatsCharts as unknown as { $$typeof: symbol }).$$typeof, Symbol.for('react.memo'));
	assert.match(renderToStaticMarkup(<StatsAsOf view={stats.view} stale={false} refreshing={false} />), /aria-live="off"/);
});

test('the ingest chart with one far-off ingest time: a few dozen bars, not ninety thousand', () => {
	const rows: IDocumentItem[] = [...readDocumentsPage(fixture('list_documents_page1')).items, { ...(readDocumentsPage(fixture('list_documents_page1')).items[0] as IDocumentItem), objectId: 'sentinel', ingestedAt: '9999-12-31T23:59:59Z' }];
	const started = performance.now();
	const html = renderToStaticMarkup(<StatsCharts rows={rows} total={null} dialect={dialect} onScope={noop} />);
	const took = performance.now() - started;
	const ingest = html.slice(html.indexOf('data-chart="ingest"'));
	assert.ok((ingest.match(/<rect /g) ?? []).length <= 62, `${(ingest.match(/<rect /g) ?? []).length} bars`);
	assert.match(ingest, /<tr><td>after \d{4}-\d{2}-\d{2}<\/td><td>1<\/td><\/tr>/);
	assert.ok(html.length < 100_000, `${html.length} characters`);
	assert.ok(took < 200, `rendered in ${took.toFixed(1)} ms`);
});

test('the strip: a Size card only when the store reports it; the cards say "—" for what the store did not count', () => {
	const stats = { view: readStats(fixture('stats_pgvector')), status: 'ready' as const, error: null, lastAt: 0, mode: 'full' as const };
	const enriched = readDialect(fixture('dialect_enriched'));
	assert.match(renderToStaticMarkup(<StatsStrip stats={stats} dialect={enriched} readOnly={false} />), /data-figure="size"[^>]*>46 MB</);
	assert.doesNotMatch(renderToStaticMarkup(<StatsStrip stats={stats} dialect={dialect} readOnly={false} />), /data-figure="size"/, 'never a dash for Size');
	const html = renderToStaticMarkup(<StatsStrip stats={stats} dialect={dialect} readOnly={false} />);
	for (const key of ['documents', 'chunks', 'avg', 'trash', 'model', 'index']) assert.match(html, new RegExp(`data-figure="${key}"`), key);
	const empty = { ...stats, view: readStats(fixture('stats_collection_missing_legacy')) };
	assert.match(overview([], { stats: empty, initialView: 'charts' }), /No documents to chart yet\./, 'an empty collection: nothing to chart, and it says so');
});

test('a document tab holds its HealthPanel', () => {
	const model: ConsoleModel = {
		connectionKey: 'doc-1',
		connection: { endpoint: { key: 'doc-1', nodeId: 'store_1', pipelineName: 'Vector demo', provider: 'postgres' } as ConsoleModel['connection']['endpoint'], dialect },
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
	const tools = { invoke: () => new Promise<never>(() => undefined) } as unknown as IRoleChannel;
	const channels: VectorChannels = { tools, chat: null, ingest: null };
	const actions: ConsoleActions = { openDocument: noop, showOnMap: noop, requestRemove: noop, askAbout: noop, documentsChanged: noop, announce: noop };
	const html = renderToStaticMarkup(<DocumentView model={model} channels={channels} selection={createSelectionStore('doc-1')} actions={actions} objectId="75b89d86-a64e-5143-bf50-55d4a7fd8cd2" path="C:/demo/handbooks/falcon_handbook.md" />);
	assert.match(html, /data-document="75b89d86-a64e-5143-bf50-55d4a7fd8cd2"/);
	mounted(html, 'HealthPanel');
});

test('the health panel: checking, the problems with their numbers, what this store does not report, and the on-demand count', () => {
	const legacy = readDocumentsPage(fixture('list_documents_filter_partial')).items[0] as IDocumentItem;
	assert.match(renderToStaticMarkup(<HealthPanel item={null} />), /role="status"[^>]*>Checking this document…</);
	const html = renderToStaticMarkup(<HealthPanel item={{ ...legacy, has_first_chunk: false, chunks: 30 }} listing="active" medianChunks={6} />);
	assert.doesNotMatch(html, /Not built yet/);
	assert.match(html, /<li [^>]*data-flag="no_first_chunk"><span[^>]*>no first chunk<\/span><span>Chunk 0 is not stored: the document was partly removed or partly ingested\.<\/span><\/li>/);
	assert.match(html, /data-flag="deleted_chunks"><span[^>]*>1 deleted chunk<\/span><span>1 soft-deleted chunk of this document is still stored\.<\/span>/);
	assert.doesNotMatch(html, /data-flag="gaps"/, 'the missing ids are chunk 0 and the deleted one');
	const qdrant = readDocumentsPage(fixture('list_documents_filter_client')).items[0] as IDocumentItem;
	const unreported = renderToStaticMarkup(<HealthPanel item={qdrant} medianChunks={10} />);
	assert.match(unreported, /No problem found in what this store reports\./);
	assert.match(unreported, /role="note"[^>]*>This store does not report chunk ids or soft-deleted chunks per document, so gaps and deleted chunks are not checked; pgvector stores report them\.</);
	const healthy = renderToStaticMarkup(<HealthPanel item={{ ...legacy, deleted_chunks: 0 }} listing="active" medianChunks={20} />);
	assert.match(healthy, /No problem found: the first chunk is stored, the chunk ids have no gap, no chunk is soft-deleted, the parse found text and the size is ordinary\./);
	assert.match(renderToStaticMarkup(<HealthPanel item={{ ...legacy, deleted_chunks: 0 }} listing="active" />), /Oversize is not checked until the console has loaded documents to compare with\./);
	const probe = renderToStaticMarkup(<HealthPanel item={qdrant} canProbe onProbe={noop} />);
	assert.match(probe, /<button type="button"[^>]*>Count deleted chunks<\/button>/);
	assert.match(renderToStaticMarkup(<HealthPanel item={qdrant} canProbe probe={{ status: 'done', deleted: 2 }} />), /role="status">2 soft-deleted chunks of this document are still stored\./);
	assert.match(renderToStaticMarkup(<HealthPanel item={qdrant} canProbe probe={{ status: 'done', deleted: null }} />), /The store did not count the chunks, so deleted chunks cannot be counted\./);
	assert.match(renderToStaticMarkup(<HealthPanel item={qdrant} canProbe probe={{ status: 'running' }} />), /disabled=""[^>]*>Counting…<\/button>/);
});

test('the Documents grid says a flagged document needs attention in its Health column and tooltip; the strip says how many', () => {
	const rows: IDocumentItem[] = [...readDocumentsPage(fixture('list_documents_page1')).items.map((r) => ({ ...r, max_chunk_id: (r.chunks ?? 1) - 1, deleted_chunks: 0 })), { ...(readDocumentsPage(fixture('list_documents_filter_partial')).items[0] as IDocumentItem), objectId: 'legacy-falcon' }];
	const pager = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage({ success: true, items: rows, next_cursor: null, total: rows.length, counts_exact: true, distinct: true, sorted: true, caveats: [] }));
	const html = renderDocumentsTab({ directory: pager });
	assert.match(html, /data-row-id="legacy-falcon"[^]*?role="gridcell"[^>]*><span title="1 soft-deleted chunk of this document is still stored\.">1 deleted chunk<\/span>/);
	assert.match(html, /title="[^"]*needs attention: 1 deleted chunk · objectId legacy-falcon"/);
	const stats = { view: readStats(fixture('stats_pgvector')), status: 'ready' as const, error: null, lastAt: 0, mode: 'full' as const };
	const strip = renderToStaticMarkup(<StatsStrip stats={stats} dialect={dialect} readOnly={false} health={healthSummary(rows, { medianChunks: 9, complete: true })} />);
	assert.match(strip, /data-chip="attention">1 needs attention</);
	// The Overview's Insights list the same documents: its count is the chip's.
	const health = healthSummary(rows, { medianChunks: 9, complete: true });
	const view = overview(rows, { health, median: 9, initialView: 'insights' });
	assert.match(view, /data-overview-view="insights">Insights \(1\)</);
	assert.equal((view.match(/<li><button type="button"/g) ?? []).length, 1, 'one row per document that needs attention');
	assert.match(view, /title="Open it in Documents"><span[^>]*>[^<]*<\/span><span[^>]*>1 deleted chunk</);
	assert.match(overview(rows, { health: { ...health, complete: false }, median: 9 }), /Insights \(1\+\)/, 'while more documents may need attention than the loaded ones');
});

test('the Summary: Top folders with their share of the chunks and what they were counted over, the document fields, and the quick actions this mount offers', () => {
	const rows: IDocumentItem[] = readDocumentsPage(fixture('list_documents_page1')).items;
	const html = overview(rows, { scoped: true, complete: false });
	assert.match(html, /<section aria-label="Top folders"/);
	const shares = [...html.matchAll(/>(\d+)%</g)].map((m) => Number(m[1]));
	assert.equal(shares.reduce((a, b) => a + b, 0), 100, 'the shares sum to 100');
	assert.match(html, /Within the current scope; over the 5 documents loaded so far\./);
	assert.match(html, /<section aria-label="Document fields"/);
	assert.match(html, />Read fields in Collection</);
	for (const action of ['Add documents', 'Browse documents', 'New query', 'Open map']) assert.match(html, new RegExp(`>${action}<`), action);
	assert.doesNotMatch(overview(rows, { onAddDocuments: null }), />Add documents</, 'a mount that cannot add documents does not offer it');
	assert.match(html, /Chunk metadata fields are read from a sample in Collection\./, 'before a sample, it says where the chunk fields come from');
	const read = overview(rows, { fieldsRead: { rows: [{ name: 'section', type: 'text', coverage: 18, of: 20, example: 'Intro', searchFilter: false, listFilter: false, source: 'chunks' }], chunksRead: 20, documentsRead: 5, at: 0 } });
	assert.match(read, /Chunk metadata, from 20 chunks read/);
	assert.match(read, /<td[^>]*>section<\/td><td[^>]*>text<\/td><td[^>]*>18 of 20<\/td>/, 'what Collection read, with what it was read over');
});

test('an oversize document keeps its folder and says "oversize" in its Health column; its tooltip does not say it needs attention', () => {
	const memo = (i: number): IDocumentItem => ({ objectId: `m${i}`, path: `C:/corp/memos/memo_${i}.txt`, chunks: 1, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: null, modifyTime: null, ingestedAt: null, pointId: null, max_chunk_id: 0, deleted_chunks: 0 });
	const manual: IDocumentItem = { ...memo(0), objectId: 'manual-1', path: 'C:/corp/handbooks/manual.pdf', chunks: 40, max_chunk_id: 39 };
	const rows = [...Array.from({ length: 20 }, (_, i) => memo(i)), manual];
	const pager = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage({ success: true, items: rows, next_cursor: null, total: rows.length, counts_exact: true, distinct: true, sorted: true, caveats: [] }));
	const html = renderDocumentsTab({ directory: pager });
	assert.match(html, /data-row-id="manual-1"[^]*?C:\/corp\/handbooks\/<\/div>/, 'listed in its folder');
	assert.doesNotMatch(html, /needs attention/);
	assert.match(html, /data-row-id="manual-1"[^]*?<span title="40 chunks: more than 10 times the median of 1 per document loaded\.">oversize<\/span>/);
	assert.match(html, /title="C:\/corp\/handbooks\/manual\.pdf · [^"]*· oversize · objectId manual-1"/);
});

/** A scope over a filter, on every surface unless told otherwise, not resolved yet. */
function scopeOf(filter: IScopeState['filter'], documents = true): IScopeState {
	return { filter, label: '', objectIds: null, overflow: null, applyTo: { documents, map: true, search: true, chat: true } };
}

test("a scope's listing before the store answers: the status line says it is loading, never what the store cannot filter; a failed first page leaves the error and Retry to the footer", () => {
	const filter = { path_prefix: 'C:/demo/greenhouse/', path_contains: 'orc' };
	const directory = (pager: ReturnType<typeof pagerInit>): string => renderDocumentsTab({ directory: pager, scope: scopeOf(filter) });
	const loading = pagerBegin(pagerInit(), filter);
	const html = directory(loading);
	assert.match(html, /role="status"[^>]*>Loading the documents in scope…<\/div>/);
	assert.doesNotMatch(html, /cannot filter|0 of 0 loaded/);
	const failed = directory(pagerFail(loading, { headline: 'The store did not answer in time.' }));
	assert.doesNotMatch(failed, /role="status">[^<]*(match|cannot filter|Loading)/, 'no status line about the scope');
	assert.match(failed, /<span>Loading stopped at 0 documents: The store did not answer in time\.<\/span><button[^>]*>Retry<\/button>/);
	assert.match(failed, /Store unreachable: The store did not answer in time\./, 'the grid says why it is empty');
});

test("the Documents tab's export with the Documents toggle off: 'Documents in scope' holds only the scope's documents, its count in the label", () => {
	const pager = pagerApplyPage(pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage(fixture('list_documents_page1'))), readDocumentsPage(fixture('list_documents_page2_last')));
	const prefix = 'C:/demo/greenhouse/';
	const html = renderDocumentsTab({ directory: pager, scope: scopeOf({ path_prefix: prefix }, false) });
	assert.match(html, /role="status"[^>]*>Not applied to this list\. Scope: 2 of 7 loaded match \(filtered here\)<\/div>/);
	assert.equal(exportItems.find((i) => i.id === 'directory-loaded')?.label, 'Loaded documents (7)', 'the list on screen');
	const scoped = exportItems.find((i) => i.id === 'directory-scope');
	assert.ok(scoped);
	const rows = scoped.rows?.().rows ?? [];
	assert.equal(scoped.label, `Documents in scope (${rows.length})`);
	assert.equal(rows.length, 2);
	assert.ok(
		rows.every((row) => String(row.path).startsWith(prefix)),
		'every exported row is in the scope'
	);
});

