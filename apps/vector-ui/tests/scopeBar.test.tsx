// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// THE SCOPE BAR: one row with no scope, chips and toggles with one, the cap, Add condition and Saved
// =============================================================================

import Module from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IDocumentItem, IScopeState, ISavedFilter } from '../src/contract/types';
import type { IPagerState } from '../src/vector/documents';
import type { IDocumentsPageView } from '../src/vector/results';
import { fixture } from './support/fixtures';

// The shell's building blocks exist only inside a running shell: plain stand-ins that render their text.
const shellStandIn = {
	commonStyles: new Proxy({}, { get: () => ({}) }),
	Button: (p: { children?: React.ReactNode; disabled?: boolean }) => (
		<button type="button" disabled={p.disabled}>
			{p.children}
		</button>
	),
	BxTrash: () => <svg aria-hidden="true" />,
};
const moduleWithLoad = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleWithLoad._load;
/** The SDK's Question as the chat builds it: its text and its filter. */
class QuestionStandIn {
	filter: Record<string, unknown> | undefined = undefined;
	texts: string[] = [];
	addQuestion(text: string): void {
		this.texts.push(text);
	}
}
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean): unknown {
	if (request === 'shell') return shellStandIn;
	if (request === 'rocketride') return { Question: QuestionStandIn };
	return originalLoad.call(this, request, parent, isMain);
};

const { ScopeBar, draftCondition } = require('../src/components/ScopeBar') as typeof import('../src/components/ScopeBar');
const { DocumentDirectory } = require('../src/components/DocumentDirectory') as typeof import('../src/components/DocumentDirectory');
const { pagerApplyPage, pagerBegin, pagerInit } = require('../src/vector/documents') as typeof import('../src/vector/documents');
const { readDocumentsPage, readStats } = require('../src/vector/results') as typeof import('../src/vector/results');
const { FILTER_TEXT_MAX, SCOPE_FAILED_TEXT, listingFilter, resolveScope, scopeFromFilter, tooLargeText } = require('../src/vector/filters') as typeof import('../src/vector/filters');
const { consoleScope } = require('../src/vector/consoleModel') as typeof import('../src/vector/consoleModel');
const { createConsoleStore } = require('../src/vector/consoleStore') as typeof import('../src/vector/consoleStore');
const { buildQuestion } = require('../src/chat/useVectorChat') as typeof import('../src/chat/useVectorChat');
const { manualClock } = require('shared/explorer/connect/testing') as typeof import('shared/explorer/connect/testing');
const { ExplorerToolError } = require('shared/explorer') as typeof import('shared/explorer');

const noop = (): void => undefined;
const on = { enabled: true, reason: null };

/** A scope over some conditions. */
function scopeOf(filter: IScopeState['filter'], over: Partial<IScopeState> = {}): IScopeState {
	return { filter, label: '', objectIds: null, overflow: null, applyTo: { documents: true, map: true, search: true, chat: true }, ...over };
}

/** The markup of a bar. */
function bar(props: Partial<React.ComponentProps<typeof ScopeBar>> = {}): string {
	return renderToStaticMarkup(<ScopeBar text="" onText={noop} scope={null} onScope={noop} {...props} />);
}

/** Count the matches of a pattern. */
function count(html: string, re: RegExp): number {
	return (html.match(re) ?? []).length;
}

// The idle bar, exactly: the path box first, then Add condition and Saved, on one row.
const IDLE =
	'<div data-component="ScopeBar"><div style="display:flex;gap:8px;padding:8px 12px;align-items:center">' +
	'<input type="search" placeholder="Filter paths…" aria-label="Filter documents by path" style="flex:1;min-width:0;padding:5px 8px;font-size:12.5px;color:var(--rr-text-primary);background:var(--rr-bg-default);border:1px solid var(--rr-border-input);border-radius:4px" value=""/>' +
	'<button type="button" aria-haspopup="menu" aria-expanded="false" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;font-size:12px;line-height:18px;white-space:nowrap;color:var(--rr-text-primary);background:var(--rr-bg-paper);border:1px solid var(--rr-border-input);border-radius:4px;cursor:pointer;opacity:1">Add condition</button>' +
	'<button type="button" aria-haspopup="menu" aria-expanded="false" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;font-size:12px;line-height:18px;white-space:nowrap;color:var(--rr-text-primary);background:var(--rr-bg-paper);border:1px solid var(--rr-border-input);border-radius:4px;cursor:pointer;opacity:1">Saved</button>' +
	'</div></div>';

test('no scope: the bar is one row (snapshot), the path box its first field, nothing else', () => {
	assert.equal(bar(), IDLE);
});

test("the directory header with no scope: the title row, then the bar's one row, then the list", () => {
	const pager = pagerApplyPage(pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage(fixture('list_documents_page1'))), readDocumentsPage(fixture('list_documents_page2_last')));
	assert.equal(pager.status, 'done');
	const html = renderToStaticMarkup(<DocumentDirectory pager={pager} selectedId={null} writes={on} onSelect={noop} onRemove={noop} onLoadMore={noop} onRetry={noop} />);
	const start = html.indexOf('<div data-component="ScopeBar">');
	assert.ok(start > 0);
	assert.equal(html.slice(start, start + IDLE.length), IDLE, 'the directory mounts the idle bar unchanged');
	const between = html.slice(start + IDLE.length, html.indexOf('aria-label="Stored documents"'));
	assert.doesNotMatch(between, /role="status"/, 'no status line without a filter or a scope');
	assert.doesNotMatch(between, /Remove condition|Apply to/);
});

test('with conditions: one chip each that removes itself, the Apply to toggles all on, Save and Clear', () => {
	const scope = scopeOf({ path_prefix: 'C:/demo/handbooks/', file_types: ['md'] }, { objectIds: ['a'] });
	const html = bar({ scope, onSave: () => null });
	assert.match(html, /aria-label="Remove condition: folder is under C:\/demo\/handbooks\/"/);
	assert.match(html, /aria-label="Remove condition: type is md"/);
	assert.equal(count(html, /aria-label="Remove condition: /g), 2);
	assert.match(html, /role="group" aria-label="Apply the scope to"/);
	for (const label of ['Documents', 'Map', 'Search', 'Chat']) assert.match(html, new RegExp(`aria-pressed="true"[^>]*>${label}</button>`), label);
	assert.match(html, />Save…<\/button>/);
	assert.match(html, />Clear<\/button>/);
	assert.ok(html.indexOf('aria-label="Filter documents by path"') < html.indexOf('Remove condition'), 'the path box stays first');
});

test('a toggle turned off is not pressed; the path box text joins the chips only as the box', () => {
	const scope = scopeOf({ path_prefix: 'C:/demo/', path_contains: 'falcon' }, { applyTo: { documents: true, map: false, search: true, chat: true } });
	const html = bar({ scope, text: 'falcon' });
	assert.match(html, /aria-pressed="false"[^>]*>Map<\/button>/);
	assert.equal(count(html, /aria-label="Remove condition: /g), 1, 'the path box is not a chip');
	assert.match(html, /value="falcon"/);
});

test('above the cap: Map, Search and Chat disabled with the sentence, which is shown; Documents stays on', () => {
	const sentence = tooLargeText(2_340, 2_000);
	const html = bar({ scope: scopeOf({ path_prefix: 'C:/demo/' }, { overflow: 2_340 }), cap: 2_000 });
	for (const label of ['Map', 'Search', 'Chat']) assert.match(html, new RegExp(`aria-pressed="false" disabled="" title="${sentence.replace(/[().]/g, '\\$&')}"[^>]*>${label}</button>`), label);
	assert.match(html, /aria-pressed="true"[^>]*>Documents<\/button>/);
	assert.match(html, new RegExp(`role="status"[^>]*>${sentence.replace(/[().]/g, '\\$&')}</div>`));
	assert.equal(sentence, 'Scope too large for the map, search and chat (2,340 documents; at most 2,000). Narrow the folder.');
});

test('Add condition: a menu of the seven kinds; one the store cannot answer is disabled with its sentence', () => {
	const html = bar({ initial: { menu: 'add' }, available: { ingestedAfter: { enabled: false, reason: 'This store does not keep ingest times' }, ingestedBefore: { enabled: false, reason: 'This store does not keep ingest times' } } });
	assert.match(html, /role="menu" aria-label="Add condition"/);
	assert.equal(count(html, /role="menuitem"/g), 7);
	for (const title of ['Folder is under', 'File type is', 'Chunks between', 'Has tables', 'Missing first chunk']) assert.match(html, new RegExp(`role="menuitem" aria-disabled="false"[^>]*>${title}</button>`), title);
	assert.match(html, /role="menuitem" aria-disabled="true" disabled="" title="This store does not keep ingest times"[^>]*>Ingested after: This store does not keep ingest times<\/button>/);
	assert.match(html, /aria-expanded="true"[^>]*>Add condition<\/button>/);
});

test('each editor names its fields: folder (with the loaded folders), file types, dates, chunk counts, tables', () => {
	const folder = bar({ initial: { editor: 'folder' }, folders: ['C:/demo/handbooks/', 'C:/demo/field/'] });
	assert.match(folder, /role="group" aria-label="Folder is under"/);
	assert.match(folder, /aria-label="Folder the paths start with"/);
	assert.match(folder, /<option value="C:\/demo\/handbooks\/"><\/option><option value="C:\/demo\/field\/"><\/option>/);
	const types = bar({ initial: { editor: 'fileType' } });
	assert.equal(count(types, /type="checkbox"/g), 11, 'one per accepted file type');
	assert.match(bar({ initial: { editor: 'ingestedAfter' } }), /type="date"[^>]*aria-label="Ingested on or after \(UTC\)"/);
	const chunks = bar({ initial: { editor: 'chunks' } });
	assert.match(chunks, /aria-label="At least this many chunks"/);
	assert.match(chunks, /aria-label="At most this many chunks"/);
	assert.equal(count(bar({ initial: { editor: 'hasTables' } }), /type="radio"/g), 2);
});

test("an editor's draft makes its condition, or says what is missing", () => {
	const empty = { prefix: '', types: [], date: '', min: '', max: '', tables: true };
	assert.deepEqual(draftCondition('folder', { ...empty, prefix: ' C:/demo/ ' }), { kind: 'folder', prefix: 'C:/demo/' });
	assert.deepEqual(draftCondition('folder', empty), { error: 'Type or choose a folder.' });
	assert.deepEqual(draftCondition('fileType', { ...empty, types: ['md', 'pdf'] }), { kind: 'fileType', types: ['md', 'pdf'] });
	assert.deepEqual(draftCondition('fileType', empty), { error: 'Choose at least one file type.' });
	assert.deepEqual(draftCondition('ingestedAfter', { ...empty, date: '2026-10-01' }), { kind: 'ingestedAfter', at: '2026-10-01T00:00:00Z' });
	assert.deepEqual(draftCondition('ingestedBefore', empty), { error: 'Choose a date.' });
	assert.deepEqual(draftCondition('chunks', { ...empty, min: '2', max: '' }), { kind: 'chunks', min: 2, max: null });
	assert.deepEqual(draftCondition('chunks', { ...empty, min: '2.5' }), { error: 'Chunk counts are whole numbers, 0 or more.' });
	assert.deepEqual(draftCondition('chunks', empty), { error: 'Give a smallest or a largest chunk count.' });
	assert.deepEqual(draftCondition('hasTables', { ...empty, tables: false }), { kind: 'hasTables', value: false });
	assert.deepEqual(draftCondition('firstChunk', empty), { kind: 'firstChunk', present: false });
});

test("Saved: the connection's filters with Apply and Delete, or a sentence when there are none", () => {
	const saved: ISavedFilter[] = [{ id: 'f1', name: 'handbooks', filter: { path_prefix: 'C:/demo/handbooks/' }, savedAt: 1 }];
	const html = bar({ initial: { menu: 'saved' }, saved });
	assert.match(html, /aria-expanded="true"[^>]*>Saved \(1\)<\/button>/);
	assert.match(html, /aria-label="Apply saved filter handbooks"/);
	assert.match(html, /aria-label="Delete saved filter handbooks"/);
	assert.match(html, /folder is under C:\/demo\/handbooks\//);
	assert.match(bar({ initial: { menu: 'saved' } }), /No saved filters for this connection yet\. Add a condition, then Save\./);
});

test('Save opens a name box (the scope must have a condition)', () => {
	const html = bar({ scope: scopeOf({ min_chunks: 64 }), onSave: () => null, initial: { saving: true } });
	assert.match(html, /role="group" aria-label="Save these conditions"/);
	assert.match(html, /aria-label="Name of the saved filter"/);
	assert.doesNotMatch(bar({ initial: { saving: true }, onSave: () => null }), /Save these conditions/, 'nothing to save without a scope');
});

test('the directory with a scope: its status line says what the store applied', () => {
	const filter = { path_prefix: 'C:/demo/greenhouse/' };
	const pager = pagerApplyPage(pagerBegin(pagerInit(), filter), readDocumentsPage(fixture('list_documents_filter_server')));
	const html = renderToStaticMarkup(<DocumentDirectory pager={pager} selectedId={null} writes={on} onSelect={noop} onRemove={noop} onLoadMore={noop} onRetry={noop} scope={scopeOf(filter)} onScope={noop} />);
	assert.match(html, /role="status"[^>]*>2 documents match \(store\)</);
	assert.match(html, /aria-label="Remove condition: folder is under C:\/demo\/greenhouse\/"/);
	assert.match(html, /aria-label="Folder C:\/demo\/greenhouse\/"/);
});

// =============================================================================
// WHILE THE SCOPE'S DOCUMENTS ARE NOT ALL KNOWN
// =============================================================================

/** 600 documents in storage order, every third under C:/demo/handbooks/ (200 in scope). */
function row(i: number): IDocumentItem {
	return { objectId: `d${String(i).padStart(4, '0')}`, path: i % 3 === 0 ? `C:/demo/handbooks/doc_${i}.md` : `C:/demo/other/doc_${i}.md`, chunks: 4, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: 10, modifyTime: null, ingestedAt: null, pointId: null };
}

/** A Qdrant-like page: the store filters nothing ('none'). */
function clientPage(from: number, n: number, next: string | null, total: number | null = 600): IDocumentsPageView {
	return readDocumentsPage({ success: true, items: Array.from({ length: n }, (_, k) => row(from + k)), next_cursor: next, total, counts_exact: true, distinct: true, sorted: false, caveats: ['documents_filter_client'], filter_applied: 'none', filter_ignored: ['path_prefix'] });
}

/** A sentence as a literal in a regular expression. */
function literal(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The Chat toggle of a rendered bar: pressed, disabled and its title. */
function chatToggle(html: string): { pressed: boolean; disabled: boolean; title: string | null } {
	const tag = html.match(/<button[^>]*>Chat<\/button>/)?.[0] ?? '';
	assert.ok(tag !== '', 'the Chat toggle is there');
	return { pressed: /aria-pressed="true"/.test(tag), disabled: /disabled=""/.test(tag), title: tag.match(/title="([^"]*)"/)?.[1]?.replace(/&#x27;/g, "'") ?? null };
}

test('the toggles while the listing pages: Map, Search and Chat off and disabled with the sentence, which is shown', () => {
	const filter = { path_prefix: 'C:/demo/handbooks/' };
	const half = pagerApplyPage(pagerBegin(pagerInit(), filter), clientPage(0, 500, 'c1'));
	const html = bar({ scope: scopeOf(filter), listing: half, cap: 2_000 }).replace(/&#x27;/g, "'");
	const sentence = literal("Waiting for the scope's documents (500 of 600 loaded); the map, search and chat are not scoped yet.");
	for (const label of ['Map', 'Search', 'Chat']) assert.match(html, new RegExp(`aria-pressed="false" disabled="" title="${sentence}"[^>]*>${label}</button>`), label);
	assert.match(html, /aria-pressed="true"[^>]*>Documents<\/button>/);
	assert.match(html, new RegExp(`role="status"[^>]*>${sentence}</div>`));
	// Without the listing the bar cannot tell how far it is, but it never shows an unresolved scope as applied.
	assert.deepEqual(chatToggle(bar({ scope: scopeOf(filter), cap: 2_000 })), { pressed: false, disabled: true, title: "Waiting for the scope's documents; the map, search and chat are not scoped yet." });
});

test("the directory over a listing that stopped short: the loaded rows' empty match is said to be of the loaded rows, and the toggles say why they are off", () => {
	const legal = { path_prefix: 'C:/corp/legal/' };
	let pager: IPagerState = pagerBegin(pagerInit(), legal);
	for (let p = 0; p < 10; p += 1) pager = pagerApplyPage(pager, clientPage(p * 500, 500, `c${p + 1}`, 12_000));
	assert.equal(pager.status, 'capped');
	const html = renderToStaticMarkup(<DocumentDirectory pager={pager} selectedId={null} writes={on} onSelect={noop} onRemove={noop} onLoadMore={noop} onRetry={noop} scope={scopeOf(legal)} onScope={noop} cap={2_000} />);
	assert.match(html, />No loaded document matches these conditions \(5,000 of 12,000 loaded\)\.</);
	assert.doesNotMatch(html, /No documents? match(es)? these conditions/);
	assert.deepEqual(chatToggle(html), { pressed: false, disabled: true, title: "Only 5,000 of 12,000 documents are loaded, so the scope's documents are not all known: the map, search and chat are not scoped. Load more to include the other 7,000 (5,000 at a time)." });
	assert.match(html, />Load more</);
});

test('the path box under a scope: text the node would refuse is not sent, and the bar says so', () => {
	const scope = scopeOf({ path_prefix: 'C:/demo/' }, { objectIds: ['a'] });
	const long = 'x'.repeat(FILTER_TEXT_MAX + 1);
	assert.match(bar({ scope, text: long, scopeText: long }), /role="alert"[^>]*>The path text is longer than 1,024 characters, so it is not sent with the scope\. Shorten it\.</);
	assert.doesNotMatch(bar({ scope, text: 'x'.repeat(FILTER_TEXT_MAX), scopeText: 'x'.repeat(FILTER_TEXT_MAX) }), /role="alert"/);
	assert.doesNotMatch(bar({ text: long, scopeText: long }), /role="alert"/, 'without a scope the box only filters the loaded rows');
});

test("the console's scope over a paging and a failed listing: no question goes out unscoped while the Chat toggle reads on", async () => {
	const CAP = 2_000;
	const folder = 'C:/demo/handbooks/';
	const inScope = Array.from({ length: 600 }, (_, i) => row(i))
		.filter((r) => r.path.startsWith(folder))
		.map((r) => r.objectId)
		.sort();
	let release: () => void = noop;
	let failFirst = false;
	const clock = manualClock(Date.parse('2026-10-16T09:00:00Z'));
	const store = createConsoleStore(
		{
			stats: async () => readStats(fixture('stats_pgvector')),
			documents: async (cursor) => {
				if (failFirst) throw new ExplorerToolError({ kind: 'timeout', tool: 'documents', message: 'Stopped waiting for documents after 40 s.' });
				if (cursor === null) return clientPage(0, 500, 'c1');
				await new Promise<void>((resolve) => (release = resolve));
				return clientPage(500, 100, null);
			},
			chunks: async () => {
				throw new Error('not asked');
			},
			trash: async () => {
				throw new Error('not asked');
			},
			restore: async () => {
				throw new Error('not asked');
			},
			remove: async () => {
				throw new Error('not asked');
			},
			announce: noop,
			clock,
		},
		{ pageSize: 500, chunkPage: 100, writeBatch: 100 }
	);
	// What the console does: the ScopeBar sets the scope, the listing asks for it, and the scope resolves from the listing.
	let scope = scopeFromFilter({ conditions: [{ kind: 'folder', prefix: folder }], text: '' }, null);
	assert.ok(scope);
	const seen: Array<{ status: string; chatOn: boolean; sent: number | null; notice: string | null }> = [];
	const observe = (): void => {
		const dir = store.getState().directory;
		scope = resolveScope(scope as IScopeState, dir, CAP);
		const html = renderToStaticMarkup(<DocumentDirectory pager={dir} selectedId={null} writes={on} onSelect={noop} onRemove={noop} onLoadMore={noop} onRetry={noop} scope={scope} onScope={noop} cap={CAP} />);
		const toggle = chatToggle(html);
		const wiring = consoleScope(null, scope, dir, CAP);
		const question = buildQuestion('What is the falcon intake?', wiring.chat) as unknown as QuestionStandIn;
		const sent = (question.filter?.objectIds as string[] | undefined) ?? null;
		if (toggle.pressed) assert.deepEqual([...(sent ?? [])].sort(), inScope, `${dir.status}: the toggle reads on, so the question is asked of the scope's documents`);
		else {
			assert.equal(sent, null);
			assert.ok(toggle.disabled && toggle.title !== null, `${dir.status}: the toggle says why`);
			assert.equal(wiring.chatNotice, `${toggle.title} A question asked now goes to every document.`, 'and the chat says so');
		}
		seen.push({ status: dir.status, chatOn: toggle.pressed, sent: sent?.length ?? null, notice: wiring.chatNotice });
	};
	const unsubscribe = store.subscribe(observe);
	store.setFilter(listingFilter((scope as IScopeState).filter));
	store.open();
	await clock.settle();
	observe();
	const paging = seen[seen.length - 1];
	assert.deepEqual(paging, { status: 'loading', chatOn: false, sent: null, notice: "Waiting for the scope's documents (500 of 600 loaded); the map, search and chat are not scoped yet. A question asked now goes to every document." });
	release();
	await clock.settle();
	observe();
	assert.deepEqual(seen[seen.length - 1], { status: 'done', chatOn: true, sent: 200, notice: null });
	// A new listing whose first page fails: off and said until Retry lists it.
	failFirst = true;
	store.refresh();
	await clock.settle();
	observe();
	const failed = seen[seen.length - 1];
	assert.equal(failed?.status, 'error');
	assert.equal(failed?.chatOn, false);
	assert.equal(failed?.notice, `${SCOPE_FAILED_TEXT} A question asked now goes to every document.`);
	failFirst = false;
	store.retryDocuments();
	await clock.settle();
	release();
	await clock.settle();
	observe();
	assert.deepEqual(seen[seen.length - 1], { status: 'done', chatOn: true, sent: 200, notice: null });
	assert.ok(
		seen.every((s) => s.chatOn === (s.sent !== null)),
		'never on and unscoped, never scoped and off'
	);
	unsubscribe();
	store.dispose();
});
