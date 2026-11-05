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
// chatIngest.render — what the chat and ingest panels put on screen
// =============================================================================
//
// Server-rendered smoke tests (there is no DOM harness): each panel renders
// its available and unavailable states with the right sentences, accessible
// names and controls. The shell's components are replaced by plain stand-ins
// that render their text, loaded before the panels are, and the panels' JSX
// runtime records sibling elements keyed alike (React only warns about those
// in the browser).
// =============================================================================

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IExplorerEndpoint, IProbeResult, IRoleChannel } from 'shared/explorer';
import { fakeWorld, manualClock, projectRows, vectorComponents } from 'shared/explorer/connect/testing';
import type { ConsoleActions, ConsoleModel, IChatSource, IDialectResult, IScopeState, ISearchResult, VectorChannels, VectorKey } from '../src/contract/types';
import { createSelectionStore } from '../src/contract/bridge';
import type { UploadRow } from '../src/vector/uploads';
import { QUERY_NEEDS_EMBED } from '../src/map/wording';
import { classifyRetrieval } from '../src/vector/retrieval';
import { classifyAt, runWorkbench, sliderRange } from '../src/vector/searchWorkbench';
import type { ChatPrefill, WorkbenchDeps, WorkbenchRun } from '../src/vector/searchWorkbench';

/** Most a test here may take: they await fakes, so a regression must fail, not hang the run. */
const TEST_TIMEOUT_MS = 10_000;

/**
 * Declare a test bounded by {@link TEST_TIMEOUT_MS}.
 *
 * @param name - What it checks.
 * @param fn - The test.
 */
function test(name: string, fn: () => void | Promise<void>): void {
	void nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

// ── Shell stand-ins (installed before any panel module loads) ────────────────

const h = React.createElement;
const shellStandIn = {
	commonStyles: new Proxy({}, { get: () => ({}) }),
	EmptyState: ({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) => h('div', { 'data-empty-state': '' }, h('strong', null, title), description ? h('p', null, description) : null, action ?? null),
	Banner: ({ variant, children }: { variant: string; children: React.ReactNode }) => h('div', { 'data-banner': variant }, children),
	ConfirmDialog: (props: { title: string; message: React.ReactNode; confirmLabel?: string; cancelLabel?: string }) => h('div', { role: 'dialog', 'aria-label': props.title }, props.message, h('button', null, props.cancelLabel ?? 'Cancel'), h('button', null, props.confirmLabel ?? 'Save')),
	useShellEvent: () => undefined,
};
// ── Sibling keys (the panels' JSX runtime, installed with the stand-ins) ─────
//
// In the browser React warns "Encountered two children with the same key" when
// one children array holds two elements keyed alike, and may then drop or
// repeat rows. renderToStaticMarkup never reconciles, so it never says so: the
// panels' JSX runtime is wrapped to record such pairs as they render here.

/** The JSX runtime's two factories. */
type JsxFactory = (type: unknown, props: { children?: unknown } | null, key?: unknown) => unknown;
const jsxRuntime = require('react/jsx-runtime') as { jsx: JsxFactory; jsxs: JsxFactory };
/** Sibling elements rendered with a key already used in their array, as "<parent>: <key>". */
const keyClashes: string[] = [];
/** Elements the panels created through the wrapped runtime (proves the check ran). */
let checkedElements = 0;

/**
 * Record the keys used twice in one children array, as React's reconciler
 * would warn about them (each nested array is its own set of siblings).
 *
 * @param parent - The element type the children belong to.
 * @param children - Its children.
 */
function recordKeyClashes(parent: unknown, children: unknown): void {
	if (!Array.isArray(children)) return;
	const seen = new Set<string>();
	for (const child of children) {
		if (Array.isArray(child)) {
			recordKeyClashes(parent, child);
		} else if (React.isValidElement(child) && child.key !== null) {
			const key = String(child.key);
			if (seen.has(key)) keyClashes.push(`${typeof parent === 'function' ? parent.name : String(parent)}: ${key}`);
			seen.add(key);
		}
	}
}

/**
 * A JSX factory that checks the children's keys before creating the element.
 *
 * @param factory - The runtime's factory.
 * @returns The checked factory.
 */
function checked(factory: JsxFactory): JsxFactory {
	return (type, props, key) => {
		checkedElements += 1;
		recordKeyClashes(type, props?.children);
		return factory(type, props, key);
	};
}
const checkedJsxRuntime = { ...jsxRuntime, jsx: checked(jsxRuntime.jsx), jsxs: checked(jsxRuntime.jsxs) };

const moduleWithLoad = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean): unknown {
	if (request === 'shell') return shellStandIn;
	if (request === 'react/jsx-runtime') return checkedJsxRuntime;
	return originalLoad.call(this, request, parent, isMain);
};

const { IngestPanel, NO_INGEST_SENTENCE } = require('../src/components/IngestPanel') as typeof import('../src/components/IngestPanel');
const { ChatPanel, NO_CHAT_SENTENCE } = require('../src/components/ChatPanel') as typeof import('../src/components/ChatPanel');
const { SourcesPanel } = require('../src/components/SourcesPanel') as typeof import('../src/components/SourcesPanel');
const { RetrievalDebugger, RetrievalTable } = require('../src/components/RetrievalDebugger') as typeof import('../src/components/RetrievalDebugger');
const { ScoreHistogram } = require('../src/components/ScoreHistogram') as typeof import('../src/components/ScoreHistogram');
const { SearchPanel, SearchResults, SHOWING_SEARCH } = require('../src/components/SearchPanel') as typeof import('../src/components/SearchPanel');
const { QueryCompare } = require('../src/components/QueryCompare') as typeof import('../src/components/QueryCompare');
const { UploadList } = require('../src/components/UploadList') as typeof import('../src/components/UploadList');
const { IngestDropZone } = require('../src/components/IngestDropZone') as typeof import('../src/components/IngestDropZone');
const { ReplaceConfirmDialog } = require('../src/ingest/ReplaceConfirmDialog') as typeof import('../src/ingest/ReplaceConfirmDialog');
const { chatSessionFor, forgetChatAndIngest } = require('../src/chat/registry') as typeof import('../src/chat/registry');
const { parseChatResult } = require('../src/vector/chatResult') as typeof import('../src/vector/chatResult');
const { replaceQuestion } = require('../src/vector/uploads') as typeof import('../src/vector/uploads');
const { buildConsoleModel } = require('../src/vector/consoleModel') as typeof import('../src/vector/consoleModel');
const { makeVectorEndpointStore } = require('../src/adapters/explorer') as typeof import('../src/adapters/explorer');

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Read a provisional fixture.
 *
 * @param name - File name.
 * @returns The parsed JSON.
 */
function fixture<T>(name: string): T {
	return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'provisional', name), 'utf8')) as T;
}

const dialect = fixture<IDialectResult>('dialect_pgvector.json');
const chatAnswer = fixture<Record<string, unknown>>('chat_result_with_documents.json');

/**
 * A console model for one connection.
 *
 * @param overrides - Fields to replace.
 * @returns The model.
 */
function model(overrides: Partial<ConsoleModel> = {}): ConsoleModel {
	return {
		connectionKey: 'render-1',
		connection: { endpoint: { key: 'render-1', anchorRole: 'tools', readOnly: false, nodeId: 'store_1', pipelineName: 'Vector demo' } as unknown as IExplorerEndpoint, dialect },
		nodes: { store: 'store_1', embed: 'embed_1', llm: 'llm_1', llmName: 'Local stub LLM' },
		collection: 'vx_demo_docs',
		stats: null,
		limits: dialect.limits,
		capabilities: dialect.capabilities,
		writes: { enabled: true, reason: null },
		ingest: { enabled: true, reason: null },
		chat: { enabled: true, reason: null },
		embed: { enabled: true, reason: null },
		readOnly: false,
		...overrides,
	};
}

/**
 * A channel that answers nothing (rendering never calls it).
 *
 * @param role - The role.
 * @returns The channel.
 */
function idleChannel(role: string): IRoleChannel {
	return { role, bound: true, sendFiles: async () => [], ask: async () => ({}), invoke: async <T>() => ({}) as T };
}

const channels: VectorChannels = { tools: idleChannel('tools'), chat: idleChannel('chat'), ingest: idleChannel('ingest') };

/** Actions that record nothing (rendering never calls them). */
const actions: ConsoleActions = {
	openDocument: () => undefined,
	showOnMap: () => undefined,
	requestRemove: () => undefined,
	askAbout: () => undefined,
	documentsChanged: () => undefined,
	announce: () => undefined,
};

/**
 * Render an element to static markup.
 *
 * @param element - The element.
 * @returns The markup.
 */
function render(element: React.ReactElement): string {
	return renderToStaticMarkup(element);
}

// ── Ingest ──────────────────────────────────────────────────────────────────

test('IngestPanel: the drop zone names the collection, offers files and folders, and the prefix box', () => {
	forgetChatAndIngest();
	const html = render(h(IngestPanel, { model: model(), channels, actions, alsoReaches: [] }));
	assert.match(html, /Drop files or folders here to add them to vx_demo_docs/);
	assert.match(html, /PDF, DOCX, PPTX, XLSX, ODT, RTF, TXT, MD, CSV, HTML, JSON · up to 20 files · 50 MB each/);
	assert.match(html, /<input[^>]*type="file"[^>]*multiple=""[^>]*accept="\.pdf,\.docx/);
	assert.match(html, /<input[^>]*aria-label="Choose a folder to add to vx_demo_docs"[^>]*webkitdirectory=""/);
	assert.match(html, />Add files</);
	assert.match(html, />Add folder</);
	assert.match(html, /Store under folder/);
	assert.doesNotMatch(html, /also reaches/);
	forgetChatAndIngest();
});

test('IngestPanel: names the other stores the ingest source feeds', () => {
	forgetChatAndIngest();
	const html = render(h(IngestPanel, { model: model(), channels, actions, alsoReaches: ['Archive store'] }));
	assert.match(html, /This pipeline&#x27;s ingest also reaches: Archive store/);
	forgetChatAndIngest();
});

test('IngestPanel: without an Ingest source, or on a read-only connection, it says why', () => {
	forgetChatAndIngest();
	const none = render(h(IngestPanel, { model: model(), channels: { ...channels, ingest: null }, actions, alsoReaches: [] }));
	assert.match(none, /Adding documents is not available/);
	assert.ok(none.includes(NO_INGEST_SENTENCE.replace(/'/g, '&#x27;')));
	assert.doesNotMatch(none, /type="file"/);
	const readOnly = render(h(IngestPanel, { model: model({ readOnly: true, ingest: { enabled: false, reason: 'No Tools source: documents cannot be added or removed from here' } }), channels, actions, alsoReaches: [] }));
	assert.match(readOnly, /No Tools source: documents cannot be added or removed from here/);
	forgetChatAndIngest();
});

test('IngestDropZone: disabled shows the reason and disables both pickers', () => {
	const html = render(h(IngestDropZone, { collection: 'c', disabledReason: 'The folder may not contain ..', onDrop: () => undefined, onPick: () => undefined }));
	assert.match(html, /The folder may not contain \.\./);
	assert.equal((html.match(/<button[^>]*disabled=""/g) ?? []).length, 2);
	assert.match(html, /aria-disabled="true"/);
});

test('UploadList: each row shows its path and words; uploading rows have a progress bar; failures keep the engine text behind a disclosure', () => {
	const base: UploadRow = { id: 'u1', path: 'docs/a.md', name: 'a.md', objectId: 'o', size: 100, status: 'uploading', bytesSent: 40, fileSize: 100, chunks: null, existingChunks: null, message: null, detail: null };
	const html = render(
		h(UploadList, {
			rows: [base, { ...base, id: 'u2', path: 'b.pdf', status: 'failed', message: "Failed. The engine did not return the reason; the pipeline's run log may. The document was not added.", detail: 'Pipe closed with an error' }, { ...base, id: 'u3', path: 'c.md', status: 'done', chunks: 7 }],
			notes: ['Skipped 1 hidden or system file.'],
			onClearFinished: () => undefined,
		})
	);
	assert.match(html, /aria-label="Uploads"/);
	assert.match(html, /role="progressbar" aria-label="Uploading docs\/a.md" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"/);
	assert.match(html, /Uploading… 40%/);
	assert.match(html, /Failed\. The engine did not return the reason/);
	assert.match(html, /<details[^>]*><summary>What the engine said<\/summary>Pipe closed with an error<\/details>/);
	assert.match(html, /7 chunks added/);
	assert.match(html, /Skipped 1 hidden or system file\./);
	assert.match(html, />Clear finished</);
	assert.equal(render(h(UploadList, { rows: [], notes: [], onClearFinished: () => undefined })), '');
});

test('ReplaceConfirmDialog: the question, the list of paths and both buttons', () => {
	const one = render(h(ReplaceConfirmDialog, { question: replaceQuestion([{ rowId: 'r', path: 'report.pdf', state: 'exists', chunks: 19 }]), onReplace: () => undefined, onCancel: () => undefined }));
	assert.match(one, /Replace existing &#x27;report.pdf&#x27; \(19 chunks\)\? The old chunks are removed when the new file is stored\./);
	assert.match(one, />Cancel</);
	assert.match(one, />Replace document</);
	const many = render(
		h(ReplaceConfirmDialog, {
			question: replaceQuestion([
				{ rowId: 'a', path: 'a.md', state: 'exists', chunks: 2 },
				{ rowId: 'b', path: 'b.md', state: 'exists', chunks: 3 },
			]),
			onReplace: () => undefined,
			onCancel: () => undefined,
		})
	);
	assert.match(many, /<li[^>]*>a\.md \(2 chunks\)<\/li>/);
	assert.match(many, /Cancel sends none of these files/);
});

// ── Chat ────────────────────────────────────────────────────────────────────

test('ChatPanel: an answer with its sources, the stub mark, the threshold and "Why these?"', async () => {
	forgetChatAndIngest();
	const session = chatSessionFor('render-1', { ask: async () => chatAnswer, makeQuestion: (text) => ({ text }), now: () => 0, announce: () => undefined });
	await session.send('Where does Falcon Station get its drinking water?', null);
	const html = render(h(ChatPanel, { model: model(), channels, selection: createSelectionStore('render-1'), actions, scope: null, onClearScope: () => undefined }));
	assert.match(html, /Answers by Local stub LLM/);
	assert.match(html, /You:<\/span>Where does Falcon Station get its drinking water\?/);
	assert.match(html, /data-markdown="answer"/);
	assert.match(html, /\[STUB-LLM\] deterministic answer/);
	assert.match(html, />Stub LLM</);
	assert.match(html, /3 sources · 0\.58 top/);
	assert.match(html, /threshold 0\.30/);
	assert.match(html, /aria-expanded="false"[^>]*>Why these\?</);
	assert.match(html, /aria-label="Open C:\/demo\/handbooks\/falcon_handbook.md at chunk 0"/);
	assert.match(html, /aria-label="Show chunk 4 of C:\/demo\/handbooks\/falcon_handbook.md on the map"/);
	assert.match(html, /aria-label="Ask about these documents"/);
	assert.match(html, /maxLength="4000"/i);
	forgetChatAndIngest();
});

test('ChatPanel: no "Why these?" without the embedding node; the scope chip when asking about chosen documents', async () => {
	forgetChatAndIngest();
	const session = chatSessionFor('render-1', { ask: async () => chatAnswer, makeQuestion: (text) => ({ text }), now: () => 0, announce: () => undefined });
	await session.send('q', null);
	const html = render(h(ChatPanel, { model: model({ embed: { enabled: false, reason: 'Text queries need the embedding node reachable from the Tools source' } }), channels, selection: createSelectionStore('render-1'), actions, scope: ['o1', 'o2'], onClearScope: () => undefined }));
	assert.doesNotMatch(html, /Why these\?/);
	assert.match(html, /Asking about 2 documents only/);
	assert.match(html, />Ask about all documents</);
	forgetChatAndIngest();
});

test('ChatPanel: a Search toggle in the header; the SearchPanel is mounted in the same space, hidden until it is on', async () => {
	forgetChatAndIngest();
	const html = render(h(ChatPanel, { model: model(), channels, selection: createSelectionStore('render-1'), actions, scope: null, onClearScope: () => undefined }));
	assert.match(html, /<button[^>]*aria-pressed="false"[^>]*>Search<\/button>/);
	const at = html.search(/<[a-z]+[^>]*data-component="SearchPanel"/);
	assert.ok(at >= 0, 'the panel is mounted');
	assert.match(html.slice(0, at), /<div hidden=""[^>]*>$/, 'inside a hidden wrapper while Search is off');
	if (html.slice(at, html.indexOf('>', at)).includes('data-placeholder')) assert.match(html.slice(at, at + 600), /Not built yet/);
	assert.match(html, /aria-label="Ask about these documents"/, 'the chat stays the panel shown');
	forgetChatAndIngest();
});

test('ChatPanel: without a Chat source it says so and offers no composer', () => {
	forgetChatAndIngest();
	const html = render(h(ChatPanel, { model: model(), channels: { ...channels, chat: null }, selection: createSelectionStore('render-1'), actions, scope: null, onClearScope: () => undefined }));
	assert.match(html, /Chat is not available/);
	assert.ok(html.includes(NO_CHAT_SENTENCE));
	assert.doesNotMatch(html, /<textarea/);
	forgetChatAndIngest();
});

// ── Without a Chat source: Search needs no LLM ──────────────────────────────
//
// The console mounts this panel on every open connection, so a pipeline with
// a Tools source and an embedding node but no running Chat source still
// reaches Search: the header's toggle, the SearchPanel behind it, and an
// action in the chat body's empty state that shows it.

/** The console model of a connection whose Chat source is not running (as consoleModel builds it). */
function noChatModel(overrides: Partial<ConsoleModel> = {}): ConsoleModel {
	return model({ chat: { enabled: false, reason: NO_CHAT_SENTENCE }, nodes: { store: 'store_1', embed: 'embed_1', llm: null, llmName: null }, ...overrides });
}

/** The channels of that connection: no chat channel. */
const noChatChannels: VectorChannels = { ...channels, chat: null };

/**
 * The radio inputs of the SearchPanel's mode choice, by value.
 *
 * @param html - The rendered markup.
 * @returns Each mode and whether its radio is disabled.
 */
function modeRadios(html: string): Record<string, boolean> {
	const radios: Record<string, boolean> = {};
	for (const [tag] of html.matchAll(/<input type="radio"[^>]*\/>/g)) {
		const value = /value="([a-z]+)"/.exec(tag)?.[1];
		if (value !== undefined) radios[value] = tag.includes('disabled=""');
	}
	return radios;
}

/**
 * The chat body's empty state.
 *
 * @param html - The rendered markup.
 * @returns Its markup, or '' when there is none.
 */
function chatEmptyState(html: string): string {
	const body = html.slice(html.indexOf('data-surface="chat"'));
	const at = body.indexOf('<div data-empty-state="">');
	if (at < 0) return '';
	return body.slice(at, body.indexOf('</div>', at) + '</div>'.length);
}

test('ChatPanel: without a Chat source the Search toggle, the SearchPanel and a "Search without the LLM" action stay', () => {
	forgetChatAndIngest();
	const html = render(h(ChatPanel, { model: noChatModel(), channels: noChatChannels, selection: createSelectionStore('render-1'), actions, scope: null, onClearScope: () => undefined }));
	assert.match(html, /<button[^>]*aria-pressed="false"[^>]*>Search<\/button>/, 'the header toggle does not depend on the chat');
	const at = html.search(/<[a-z]+[^>]*data-component="SearchPanel"/);
	assert.ok(at >= 0, 'the SearchPanel is mounted');
	assert.match(html.slice(0, at), /<div hidden=""[^>]*>$/, 'hidden until Search is on');
	assert.doesNotMatch(html, /Answers by/, 'no LLM to name');
	assert.doesNotMatch(html, /<textarea/, 'no composer');
	const empty = chatEmptyState(html);
	assert.match(empty, /<strong>Chat is not available<\/strong>/);
	assert.ok(empty.includes(NO_CHAT_SENTENCE));
	assert.match(empty, /<button type="button"[^>]*>Search without the LLM<\/button>/, 'the empty state offers Search');
	forgetChatAndIngest();
});

test('ChatPanel: without a Chat source, Search on shows the SearchPanel with every mode the store can run', () => {
	forgetChatAndIngest();
	const html = render(h(ChatPanel, { model: noChatModel(), channels: noChatChannels, selection: createSelectionStore('render-1'), actions, scope: null, onClearScope: () => undefined, initialSearch: true }));
	assert.match(html, /<button[^>]*aria-pressed="true"[^>]*>Search<\/button>/);
	const at = html.search(/<[a-z]+[^>]*data-component="SearchPanel"/);
	assert.ok(at >= 0);
	assert.doesNotMatch(html.slice(html.lastIndexOf('<div', at - 1), at), /hidden=""/, 'the SearchPanel is shown');
	assert.deepEqual(modeRadios(html), { semantic: false, keyword: false, hybrid: false, auto: false }, 'no mode needs the chat');
	assert.match(html, /<div data-surface="chat" style="display:none">/, 'the empty chat body is hidden behind Search');
	forgetChatAndIngest();
});

test('ChatPanel: without a Chat source and with no search the store can run, the empty state offers no Search action', () => {
	forgetChatAndIngest();
	const nothing = noChatModel({ embed: { enabled: false, reason: QUERY_NEEDS_EMBED }, nodes: { store: 'store_1', embed: null, llm: null, llmName: null }, capabilities: { ...dialect.capabilities, search_keyword: false } });
	const html = render(h(ChatPanel, { model: nothing, channels: noChatChannels, selection: createSelectionStore('render-1'), actions, scope: null, onClearScope: () => undefined }));
	const empty = chatEmptyState(html);
	assert.match(empty, /Chat is not available/);
	assert.doesNotMatch(empty, /<button/, 'nothing to offer');
	assert.match(html, /<button[^>]*aria-pressed="false"[^>]*>Search<\/button>/, 'the toggle stays; the SearchPanel says why nothing runs');
	forgetChatAndIngest();
});

test("ChatPanel: on the console's own model of a connection with a Tools source and no Chat source, Search runs every mode", async () => {
	forgetChatAndIngest();
	const qdrant = fixture<IDialectResult>('dialect_qdrant.json');
	const world = fakeWorld(projectRows(['ingest_1', 'tools_1'], vectorComponents('qdrant')), (call) => (call.tool === 'dialect' ? qdrant : {}));
	const clock = manualClock();
	const store = makeVectorEndpointStore({ clock, debounceMs: 0 });
	const refreshing = store.refresh(world.client);
	await clock.advance(0);
	await refreshing;
	await clock.settle();
	const { endpoints, probes } = store.getState();
	assert.equal(endpoints.length, 1, 'the store is one card');
	const endpoint: IExplorerEndpoint = endpoints[0];
	const probe: IProbeResult | undefined = probes[endpoint.key];
	const built = buildConsoleModel(endpoint, probe, null);
	assert.equal(built.chat.enabled, false, 'no Chat source: the chat is off');
	assert.equal(built.embed.enabled, true, 'the Tools source reaches the embedding node');
	const key = built.connectionKey;
	const off = render(h(ChatPanel, { model: built, channels: noChatChannels, selection: createSelectionStore(key), actions, scope: null, onClearScope: () => undefined }));
	assert.match(off, /<button[^>]*aria-pressed="false"[^>]*>Search<\/button>/);
	assert.match(off, /data-component="SearchPanel"/);
	assert.match(chatEmptyState(off), /Search without the LLM/);
	const on = render(h(ChatPanel, { model: built, channels: noChatChannels, selection: createSelectionStore(key), actions, scope: null, onClearScope: () => undefined, initialSearch: true }));
	assert.deepEqual(modeRadios(on), { semantic: false, keyword: false, hybrid: false, auto: false });
	forgetChatAndIngest();
});

test('SourcesPanel: chunk text is text, not markup; scores carry their formula', () => {
	const sources: IChatSource[] = parseChatResult({ documents: [{ page_content: '<script>alert(1)</script> water', score: 0.5757, metadata: { objectId: 'o1', chunkId: 2, parent: 'a/b.md' } }] }).sources;
	const html = render(h(SourcesPanel, { sources, score: dialect.score, onOpen: () => undefined, onShowOnMap: () => undefined }));
	assert.doesNotMatch(html, /<script/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; water/);
	assert.match(html, /title="Score 0\.5757 \(1 - cosine_distance\)"/);
	assert.match(html, />0\.58</);
	assert.match(html, /#2/);
	assert.match(render(h(SourcesPanel, { sources: [], score: null, onOpen: () => undefined, onShowOnMap: () => undefined })), /The answer cited no stored chunks\./);
});

test('RetrievalDebugger: starts by embedding; renders nothing without the embedding node', () => {
	const on = render(h(RetrievalDebugger, { model: model(), channels, question: 'q', topK: 3, onClose: () => undefined }));
	assert.match(on, /aria-label="Why these sources"/);
	assert.match(on, /Embedding…/);
	const off = render(h(RetrievalDebugger, { model: model({ embed: { enabled: false, reason: 'x' } }), channels, question: 'q', topK: 3, onClose: () => undefined }));
	assert.equal(off, '');
});

test('ScoreHistogram: bars for the non-empty bins, the threshold and floor lines, a text alternative', () => {
	const html = render(h(ScoreHistogram, { scores: [0.5433, 0.5247, 0.19, 0.09], range: [-1, 1], threshold: 0.3, floor: 0.2 }));
	assert.equal((html.match(/<rect /g) ?? []).length, 4);
	assert.match(html, /data-line="threshold"/);
	assert.match(html, /data-line="floor"/);
	assert.match(html, /role="img" aria-label="Scores of 4 results from -1\.00 to 1\.00; threshold 0\.30, floor 0\.20\."/);
});

// ── Search (without the LLM) ────────────────────────────────────────────────

const enriched = fixture<IDialectResult>('dialect_enriched.json');
const embedOk = fixture<Record<string, unknown>>('embed_ok.json');

/**
 * A console model over another dialect.
 *
 * @param d - The dialect.
 * @param overrides - Fields to replace.
 * @returns The model.
 */
function modelOn(d: IDialectResult, overrides: Partial<ConsoleModel> = {}): ConsoleModel {
	const base = model();
	return model({ connection: { ...base.connection, dialect: d }, limits: d.limits, capabilities: d.capabilities, ...overrides });
}

/**
 * Deps whose calls answer from queues (render tests run the pure workbench, never the panel's effects).
 *
 * @param answers - Answers per tool.
 * @returns The deps.
 */
function answering(answers: Record<string, Array<Record<string, unknown>>>): WorkbenchDeps {
	return {
		call: async (tool) => {
			const value = answers[tool]?.shift();
			return value === undefined ? { ok: false, code: null, message: 'none', kind: null, error: null } : { ok: true, value };
		},
	};
}

/**
 * A finished run of `question` over a search answer.
 *
 * @param question - The question.
 * @param mode - The mode.
 * @param search - The search answers, in call order.
 * @param chat - What "Open in Search" brought (by default this question, citing ops_005 #67).
 * @param objectIds - The run's scope, or null.
 * @returns The run.
 */
async function finishedRun(question: string, mode: 'semantic' | 'keyword' | 'hybrid', search: ISearchResult[], chat: ChatPrefill | null = { question, cited: [['ef35cb9c-f98f-e472-d795-298a40a5cb2b', 67]] }, objectIds: string[] | null = null): Promise<WorkbenchRun> {
	const deps = answering({ embed: [embedOk], search: search.map((s) => s as unknown as Record<string, unknown>) });
	const outcome = await runWorkbench(deps, { question, mode, topK: 50, limits: dialect.limits, storeNode: 'store_1', embedNode: 'embed_1', objectIds, chat });
	assert.ok(outcome.ok);
	return outcome.run;
}

/**
 * Twenty rows: 7 at or above 0.42, 11 at or above the node's 0.30, 3 under the floor 0.20.
 *
 * @returns The answer.
 */
function twentyRows(): ISearchResult {
	const scores = [0.62, 0.58, 0.55, 0.51, 0.48, 0.45, 0.43, 0.4, 0.38, 0.36, 0.33, 0.295, 0.29, 0.27, 0.25, 0.22, 0.21, 0.19, 0.15, 0.12];
	return { success: true, total: 20, mode_used: 'semantic', warnings: [], results: scores.map((score, i) => ({ content: `chunk ${i} about <b>water</b>`, score, metadata: { objectId: `doc${i}`, chunkId: i, parent: `C:/demo/doc${i}.md` }, rank: i + 1, raw_score: score, sim: score, below_threshold: score < 0.3, below_floor: score < 0.2 })) };
}

/** No-op handlers of SearchResults. */
const resultHandlers = { onThreshold: () => undefined, onCopySetting: () => undefined, copied: null, onOpen: () => undefined, onMap: () => undefined, onAsk: () => undefined, canAsk: true };

test('SearchPanel: the question box, the four modes, top k, the keyword caption and Compare; Run waits for a question', () => {
	const html = render(h(SearchPanel, { model: modelOn(enriched), channels, selection: createSelectionStore('render-1'), actions }));
	assert.match(html, /<section[^>]*aria-label="Search"[^>]*data-component="SearchPanel"/);
	assert.doesNotMatch(html.slice(0, html.indexOf('>') + 1), /data-placeholder/);
	assert.match(html, /<input type="search"[^>]*aria-label="Search question"/);
	for (const label of ['Semantic', 'Keyword', 'Hybrid', 'Auto']) assert.match(html, new RegExp(`<input type="radio"[^>]*value="${label.toLowerCase()}"[^>]*/>${label}</label>`));
	assert.match(html, /<input type="radio"[^>]*checked=""[^>]*value="semantic"/);
	assert.match(html, /Keyword search matches text fragments on this store/);
	assert.match(html, /<select[^>]*aria-label="Results to show \(top k\)"/);
	assert.deepEqual(
		[...html.matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1])),
		[5, 10, 25, 50]
	);
	assert.match(html, /<option value="10" selected="">/);
	assert.match(html, /<button type="button"[^>]*aria-pressed="false"[^>]*>Compare<\/button>/);
	assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Run<\/button>/);
	assert.match(html, /data-component="ExportMenu"/);
});

test('SearchPanel: a store without keyword search (Pinecone) disables Keyword and Hybrid with the sentence', () => {
	const pinecone = { ...enriched, keyword_match: null, capabilities: { ...enriched.capabilities, search_keyword: false } };
	const html = render(h(SearchPanel, { model: modelOn(pinecone), channels, selection: createSelectionStore('render-1'), actions }));
	assert.match(html, /<input type="radio"[^>]*disabled=""[^>]*value="keyword"/);
	assert.match(html, /<input type="radio"[^>]*disabled=""[^>]*value="hybrid"/);
	assert.match(html, /Keyword: This store cannot search by keyword/);
	assert.doesNotMatch(html, /Keyword search matches/);
});

test('SearchPanel: without the embedding node only Keyword is offered, and it is chosen', () => {
	const html = render(h(SearchPanel, { model: modelOn(enriched, { embed: { enabled: false, reason: null }, nodes: { store: 'store_1', embed: null, llm: null, llmName: null } }), channels, selection: createSelectionStore('render-1'), actions }));
	for (const mode of ['semantic', 'hybrid', 'auto']) assert.match(html, new RegExp(`<input type="radio"[^>]*disabled=""[^>]*value="${mode}"`));
	assert.match(html, /<input type="radio"[^>]*checked=""[^>]*value="keyword"/);
	assert.ok(html.includes(`Semantic, Hybrid, Auto: ${QUERY_NEEDS_EMBED}`));
});

test('SearchPanel: a scope above the cap turns Run off with its sentence; a scope within it is named', () => {
	const over: IScopeState = { filter: {}, label: 'folder is under C:/demo/', objectIds: null, overflow: 2340, applyTo: { documents: true, map: true, search: true, chat: true } };
	const big = render(h(SearchPanel, { model: modelOn(enriched, { scope: over }), channels, selection: createSelectionStore('render-1'), actions }));
	assert.match(big, /Scope too large for the map, search and chat \(2,340 documents; at most 2,000\)\. Narrow the folder\./);
	assert.match(big, /<button type="submit"[^>]*disabled=""[^>]*>Run<\/button>/);
	const within = render(h(SearchPanel, { model: modelOn(enriched, { scope: { ...over, objectIds: ['a', 'b'], overflow: null } }), channels, selection: createSelectionStore('render-1'), actions }));
	assert.match(within, /Searching 2 documents in scope: folder is under C:\/demo\//);
});

test('SearchPanel: "Open in Search" fills the question and the k "Why these?" used; the "From the chat" line waits for a run of it', () => {
	const cited: VectorKey[] = [
		['a', 0],
		['b', 1],
		['c', 2],
	];
	const html = render(h(SearchPanel, { model: modelOn(enriched), channels, selection: createSelectionStore('render-1'), actions, prefill: { question: 'Where does Falcon Station get its water?', cited, topK: 13, objectIds: null } }));
	assert.match(html, /<input type="search"[^>]*value="Where does Falcon Station get its water\?"/);
	assert.deepEqual(
		[...html.matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1])),
		[5, 10, 13, 25, 50]
	);
	assert.match(html, /<option value="13" selected="">/);
	// The line describes a run's rows; before the run there are none.
	assert.doesNotMatch(html, /From the chat/);
	assert.match(html, /<button type="submit"(?![^>]*disabled)[^>]*>Run<\/button>/);
});

test('SearchResults: "From the chat" and the cited mark on a run of the brought question only', async () => {
	const water = 'Where does Falcon Station get its water?';
	const brought: ChatPrefill = { question: water, cited: [['ef35cb9c-f98f-e472-d795-298a40a5cb2b', 67]] };
	const vector = fixture<ISearchResult>('search_vector.json');
	const same = await finishedRun(water, 'semantic', [vector], brought);
	const shown = render(h(SearchResults, { run: same, view: classifyAt(same.rows, 0.3, dialect.score), score: dialect.score, range: sliderRange(dialect.score), ...resultHandlers }));
	assert.match(shown, /<p[^>]*data-from-chat=""[^>]*>From the chat: the chunk its answer cited is marked “cited”\.<\/p>/);
	assert.match(shown, /#67 · cited/);
	const other = await finishedRun('greenhouse orchid pressure', 'semantic', [vector], brought);
	const otherHtml = render(h(SearchResults, { run: other, view: classifyAt(other.rows, 0.3, dialect.score), score: dialect.score, range: sliderRange(dialect.score), ...resultHandlers }));
	assert.match(otherHtml, /#67</, 'the chunk is listed');
	assert.doesNotMatch(otherHtml, /· cited|From the chat/);
	const keyword = await finishedRun('falcon', 'keyword', [fixture<ISearchResult>('search_keyword_fallback_warning.json')], brought);
	assert.doesNotMatch(render(h(SearchResults, { run: keyword, view: classifyAt(keyword.rows, 0.3, dialect.score), score: dialect.score, range: sliderRange(dialect.score), ...resultHandlers })), /· cited|From the chat/);
	// The console's scope is on and this run searched within it; the answer did not.
	const scoped = await finishedRun(water, 'semantic', [vector], brought, ['d1', 'd2']);
	assert.match(render(h(SearchResults, { run: scoped, view: classifyAt(scoped.rows, 0.3, dialect.score), score: dialect.score, range: sliderRange(dialect.score), scopeOn: true, ...resultHandlers })), /Searched within the scope; the answer was not\./);
});

test("SearchResults: the slider over the store's range, its count beside the node setting, the histogram, and a table whose 'passes' rows match the count", async () => {
	const run = await finishedRun('water', 'semantic', [twentyRows()]);
	const range = sliderRange(dialect.score);
	for (const at of [-1, 0.1, 0.3, 0.42, 0.6, 1]) {
		const view = classifyAt(run.rows, at, dialect.score);
		const html = render(h(SearchResults, { run, view, score: dialect.score, range, ...resultHandlers }));
		const shown = Number(/At [-\d.]+: (\d+) of 20/.exec(html)?.[1]);
		assert.equal(shown, (html.match(/<tr[^>]*data-status="used"/g) ?? []).length, `at ${at}`);
		assert.match(html, new RegExp(`<input type="range"[^>]*aria-label="Threshold"[^>]*min="-1"[^>]*max="1"[^>]*step="0.01"[^>]*aria-valuetext="${at.toFixed(2)}: ${shown} of 20 pass"[^>]*value="${at}"`));
	}
	const html = render(h(SearchResults, { run, view: classifyAt(run.rows, 0.42, dialect.score), score: dialect.score, range, ...resultHandlers }));
	assert.match(html, /<output[^>]*role="status"[^>]*>At 0\.42: 7 of 20 would pass \(today&#x27;s node setting 0\.30 passes 11\)<\/output>/);
	assert.match(html, />Copy as node setting</);
	assert.match(html, /Set this on the store node in the pipeline editor; this console cannot change node settings\./);
	assert.match(html, /data-line="threshold"/);
	assert.match(html, /data-line="setting"/);
	assert.match(html, /<caption[^>]*>Semantic search: 20 results/);
	assert.match(html, /title="Score 0\.62 \(1 - cosine_distance\)"/);
	assert.match(html, /chunk 0 about &lt;b&gt;water&lt;\/b&gt;/, 'chunk text is text, not markup');
	assert.match(html, /aria-label="Open C:\/demo\/doc0\.md at chunk 0"/);
	assert.match(html, /aria-label="Show chunk 0 of C:\/demo\/doc0\.md on the map"/);
	assert.match(html, /aria-label="Ask about C:\/demo\/doc0\.md"/);
	assert.match(html, /near miss: below the threshold/);
	assert.match(html, /below the floor \(the store drops it\)/);
});

test('SearchResults: without a Chat source every "ask about this" is off and says why; open and map stay', async () => {
	const run = await finishedRun('water', 'semantic', [twentyRows()]);
	const html = render(h(SearchResults, { run, view: classifyAt(run.rows, 0.3, dialect.score), score: dialect.score, range: sliderRange(dialect.score), ...resultHandlers, canAsk: false, askReason: NO_CHAT_SENTENCE }));
	const asks = [...html.matchAll(/<button[^>]*aria-label="Ask about [^"]*"[^>]*>/g)].map(([tag]) => tag);
	assert.equal(asks.length, 20);
	for (const tag of asks) {
		assert.ok(tag.includes('disabled=""'), tag);
		assert.ok(tag.includes(`title="${NO_CHAT_SENTENCE}"`), tag);
	}
	const others = [...html.matchAll(/<button[^>]*aria-label="(?:Open|Show chunk) [^"]*"[^>]*>/g)].map(([tag]) => tag);
	assert.equal(others.length, 40, 'open and map on every row');
	assert.ok(
		others.every((tag) => !tag.includes('disabled=""')),
		'open and map do not need the chat'
	);
});

test('SearchResults: keyword rows have no slider; hybrid says it was fused here; the cited mark; warnings', async () => {
	const keyword = await finishedRun('KX4471', 'keyword', [fixture<ISearchResult>('search_keyword_fallback_warning.json')]);
	const kw = render(h(SearchResults, { run: keyword, view: classifyAt(keyword.rows, 0.3, dialect.score), score: dialect.score, range: sliderRange(dialect.score), ...resultHandlers }));
	assert.doesNotMatch(kw, /type="range"/);
	assert.match(kw, /Keyword results carry no similarity, so the threshold does not apply\./);
	assert.match(kw, /keyword match \(no similarity\)/);
	assert.match(kw, /<caption[^>]*>Keyword search: 3 results/);
	const hybrid = await finishedRun('water', 'hybrid', [fixture<ISearchResult>('search_vector.json'), fixture<ISearchResult>('search_keyword_fallback_warning.json')]);
	const hy = render(h(SearchResults, { run: hybrid, view: classifyAt(hybrid.rows, 0.3, dialect.score), score: dialect.score, range: sliderRange(dialect.score), ...resultHandlers }));
	assert.match(hy, /<caption[^>]*>Hybrid search: 8 results, hybrid \(fused here\) by reciprocal rank fusion \(k = 60\)/);
	assert.match(hy, /semantic #1 · keyword #1/);
	assert.match(hy, /#67 · cited/);
	const mismatch = await finishedRun('water', 'semantic', [fixture<ISearchResult>('search_model_mismatch_warning.json')]);
	assert.match(render(h(SearchResults, { run: mismatch, view: classifyAt(mismatch.rows, 0.3, dialect.score), score: dialect.score, range: sliderRange(dialect.score), ...resultHandlers })), /data-banner="warning">The chat embedding model differs/);
	const fallback = await finishedRun('water', 'semantic', [fixture<ISearchResult>('search_keyword_fallback_warning.json')]);
	assert.match(render(h(SearchResults, { run: fallback, view: classifyAt(fallback.rows, 0.3, dialect.score), score: dialect.score, range: sliderRange(dialect.score), ...resultHandlers })), /The store fell back to a keyword search, so these scores are not similarities\./);
	const empty = await finishedRun('nothing', 'semantic', [{ success: true, results: [], total: 0, warnings: [], mode_used: 'semantic' }]);
	const none = render(h(SearchResults, { run: empty, view: classifyAt(empty.rows, 0.3, dialect.score), score: dialect.score, range: sliderRange(dialect.score), ...resultHandlers }));
	assert.match(none, /No chunks matched “nothing”\./);
	assert.doesNotMatch(none, /type="range"|Keyword results carry no similarity/, 'an empty semantic run has no slider and is no keyword run');
});

test('QueryCompare: A and B side by side, the shared count and the Jaccard index, and both stars on the map', async () => {
	const a = await finishedRun('water', 'semantic', [fixture<ISearchResult>('search_vector.json')]);
	const vector = fixture<ISearchResult>('search_vector.json');
	const b = await finishedRun('kestrel survey', 'semantic', [{ ...vector, results: vector.results.slice(2) }]);
	const html = render(h(QueryCompare, { a: { run: a, view: classifyAt(a.rows, 0.3, dialect.score) }, b: { run: b, view: classifyAt(b.rows, 0.3, dialect.score) }, score: dialect.score, onShowBoth: () => undefined, onOpen: () => undefined }));
	assert.match(html, /<p[^>]*role="status"[^>]*data-compare-summary=""[^>]*>A and B share 6 of 8 results \(Jaccard 0\.75\); 1 document only in A, 0 only in B<\/p>/, 'ops_005 is only in A; ops_021 is in B through another chunk');
	assert.match(html, /aria-label="A: water"/);
	assert.match(html, /aria-label="B: kestrel survey"/);
	assert.match(html, /A ★/);
	assert.match(html, /B ☆/);
	assert.match(html, />Show A ★ and B ☆ on the map</);
	assert.equal((html.match(/data-side="only-a"/g) ?? []).length, 2);
	assert.equal((html.match(/data-side="both"/g) ?? []).length, 12);
});

test('QueryCompare: the column of the brought question says "From the chat" and marks its cited chunk; the other does not', async () => {
	const water = 'Where does Falcon Station get its water?';
	const brought: ChatPrefill = { question: water, cited: [['ef35cb9c-f98f-e472-d795-298a40a5cb2b', 67]] };
	const vector = fixture<ISearchResult>('search_vector.json');
	const a = await finishedRun(water, 'semantic', [vector], brought);
	const b = await finishedRun('kestrel survey', 'semantic', [vector], brought);
	const html = render(h(QueryCompare, { a: { run: a, view: classifyAt(a.rows, 0.3, dialect.score) }, b: { run: b, view: classifyAt(b.rows, 0.3, dialect.score) }, score: dialect.score, onShowBoth: () => undefined, onOpen: () => undefined }));
	const column = (letter: 'A' | 'B'): string => html.slice(html.indexOf(`data-run="${letter}"`), letter === 'A' ? html.indexOf('data-run="B"') : undefined);
	assert.match(column('A'), /From the chat: the chunk its answer cited is marked “cited”\./);
	assert.match(column('A'), /#67<\/button> · cited/);
	assert.doesNotMatch(column('B'), /From the chat|· cited/);
});

/**
 * Render an element and collect the sibling elements it keyed alike.
 *
 * @param element - The element.
 * @returns The markup and the clashes.
 */
function renderCheckingKeys(element: React.ReactElement): { html: string; clashes: string[] } {
	keyClashes.length = 0;
	const before = checkedElements;
	const html = render(element);
	assert.ok(checkedElements > before, 'the panel rendered through the checked JSX runtime');
	return { html, clashes: [...keyClashes] };
}

/**
 * The result rows of some markup (the header rows carry no status).
 *
 * @param html - The markup.
 * @returns How many.
 */
function resultRows(html: string): number {
	return (html.match(/<tr[^>]*data-status="/g) ?? []).length;
}

test('SearchResults, QueryCompare and the "Why these?" table: an answer that repeats a chunk, or carries no chunk ids, lists every row and keys no two alike', async () => {
	const vector = fixture<ISearchResult>('search_vector.json');
	const [first, second] = vector.results;
	const repeated: ISearchResult = { ...vector, total: 3, results: [first, { ...first, rank: 2, score: first.score - 0.01 }, { ...second, rank: 3 }] };
	// Without objectId and chunkId every row reads as the same chunk ("#-1").
	const bare: ISearchResult = {
		success: true,
		mode_used: 'semantic',
		warnings: [],
		total: 2,
		results: [
			{ content: 'one', score: 0.5, metadata: {} },
			{ content: 'two', score: 0.45, metadata: {} },
		],
	};
	const clashes: Record<string, string[]> = {};
	for (const [name, answer] of [
		['repeated chunk', repeated],
		['no chunk ids', bare],
	] as const) {
		const run = await finishedRun('water', 'semantic', [answer]);
		const view = classifyAt(run.rows, 0.3, dialect.score);
		const results = renderCheckingKeys(h(SearchResults, { run, view, score: dialect.score, range: sliderRange(dialect.score), ...resultHandlers }));
		clashes[`SearchResults, ${name}`] = results.clashes;
		assert.equal(resultRows(results.html), answer.results.length, `SearchResults, ${name}: every row`);
		const compare = renderCheckingKeys(h(QueryCompare, { a: { run, view }, b: { run, view }, score: dialect.score, onShowBoth: () => undefined, onOpen: () => undefined }));
		clashes[`QueryCompare, ${name}`] = compare.clashes;
		assert.equal(resultRows(compare.html), 2 * answer.results.length, `QueryCompare, ${name}: every row of A and of B`);
		const table = renderCheckingKeys(h(RetrievalTable, { view: classifyRetrieval(answer, dialect.score, []) }));
		clashes[`"Why these?", ${name}`] = table.clashes;
		assert.equal(resultRows(table.html), answer.results.length, `"Why these?", ${name}: every row`);
		if (answer === repeated) {
			// The acceptance scripts read the chunk from data-key; it stays the chunk's own.
			assert.equal((results.html.match(new RegExp(`data-key="${first.metadata.objectId}#${first.metadata.chunkId}"`, 'g')) ?? []).length, 2);
		}
	}
	assert.deepEqual(clashes, {
		'SearchResults, repeated chunk': [],
		'QueryCompare, repeated chunk': [],
		'"Why these?", repeated chunk': [],
		'SearchResults, no chunk ids': [],
		'QueryCompare, no chunk ids': [],
		'"Why these?", no chunk ids': [],
	});
	// The chat's sources are read once per chunk (parseChatResult), so their keys cannot repeat.
	const doc = { page_content: 'water', score: 0.5, metadata: { objectId: 'o1', chunkId: 2, parent: 'a/b.md' } };
	const sources = parseChatResult({ documents: [doc, doc, { ...doc, metadata: { ...doc.metadata, chunkId: 3 } }] }).sources;
	assert.equal(sources.length, 2);
	assert.deepEqual(renderCheckingKeys(h(SourcesPanel, { sources, score: dialect.score, onOpen: () => undefined, onShowOnMap: () => undefined })).clashes, []);
});

test('RetrievalDebugger: says when it searches only the documents the question was asked about', () => {
	const one = render(h(RetrievalDebugger, { model: model(), channels, question: 'q', topK: 3, onClose: () => undefined, scope: ['d1'] }));
	assert.match(one, /Searched only the document the question was asked about\./);
	const all = render(h(RetrievalDebugger, { model: model(), channels, question: 'q', topK: 3, onClose: () => undefined, scope: null }));
	assert.doesNotMatch(all, /Searched only/);
});

test('ChatPanel: Search on swaps the body in the same space; the chat (thread and draft) stays mounted, hidden, and comes back', async () => {
	forgetChatAndIngest();
	const session = chatSessionFor('render-1', { ask: async () => chatAnswer, makeQuestion: (text) => ({ text }), now: () => 0, announce: () => undefined });
	await session.send('Where does Falcon Station get its drinking water?', null);
	const props = { model: model(), channels, selection: createSelectionStore('render-1'), actions, scope: null, onClearScope: () => undefined };
	const off = render(h(ChatPanel, props));
	const on = render(h(ChatPanel, { ...props, initialSearch: true }));
	assert.match(on, /<button[^>]*aria-pressed="true"[^>]*>Search<\/button>/);
	assert.ok(on.includes(SHOWING_SEARCH));
	assert.equal(SHOWING_SEARCH, 'Showing Search; the chat is one click away');
	assert.doesNotMatch(off, /Showing Search/);
	// The search body is shown; the chat body is hidden but still rendered (thread, composer).
	assert.match(on, /<div data-surface="search"[^>]*><section[^>]*data-component="SearchPanel"/);
	assert.doesNotMatch(on, /<div data-surface="search" hidden=""/);
	assert.match(on, /<div data-surface="chat" style="display:none">/);
	assert.match(on, /aria-label="Ask about these documents"/);
	assert.match(on, /Where does Falcon Station get its drinking water\?/);
	// Same tree in both states: only the two wrappers change, so React keeps the composer's draft and the thread.
	const chatBody = (html: string): string => html.slice(html.indexOf('<div data-surface="chat"')).replace(/^<div data-surface="chat"[^>]*>/, '');
	assert.equal(chatBody(on), chatBody(off));
	forgetChatAndIngest();
});

test('RetrievalDebugger: "Open in Search" when the chat offers it', () => {
	const sources: IChatSource[] = parseChatResult(chatAnswer).sources;
	const withSearch = render(h(RetrievalDebugger, { model: model(), channels, question: 'q', topK: 3, onClose: () => undefined, answerSources: sources, onOpenInSearch: () => undefined }));
	assert.match(withSearch, /<button[^>]*>Open in Search<\/button>/);
	const without = render(h(RetrievalDebugger, { model: model(), channels, question: 'q', topK: 3, onClose: () => undefined }));
	assert.doesNotMatch(without, /Open in Search/);
});

test("ScoreHistogram: the store node's setting as a second line when the slider moved away from it", () => {
	const html = render(h(ScoreHistogram, { scores: [0.5433, 0.5247, 0.19, 0.09], range: [-1, 1], threshold: 0.42, floor: 0.2, setting: 0.3 }));
	assert.match(html, /data-line="setting"/);
	assert.match(html, /aria-label="Scores of 4 results from -1\.00 to 1\.00; threshold 0\.42, floor 0\.20, node setting 0\.30\."/);
	assert.doesNotMatch(render(h(ScoreHistogram, { scores: [0.5], range: [-1, 1], threshold: 0.3, floor: 0.2, setting: 0.3 })), /data-line="setting"/);
});
