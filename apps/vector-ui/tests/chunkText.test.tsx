// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CHUNK TEXT: the selected chunk's full text in the point inspector
// =============================================================================
//
// The inspector offers "Show full text" when the map can fetch it: the text
// comes from `chunks {object_id, after_chunk: id - 1, limit: 1}`, at most
// 20,000 characters, fetched ONCE per key (a per-connection cache, cleared
// on a change of identity), with the active query's words marked as text
// segments, never HTML, and Previous / Next chunk. The inspector also adds
// the point as a Recommend example and lists its spanning-tree neighbours.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IRoleChannel } from 'shared/explorer';
import { connectionCaches } from '../src/adapters/explorer';
import { ChunkTextPanel, ChunkTextSection, chunkTextInput, chunkTextScope, chunkTexts, createChunkTextCache, fetchChunkText, readChunkText } from '../src/components/ChunkTextPanel';
import type { ChunkTextSectionProps, IChunkText } from '../src/components/ChunkTextPanel';
import { PointInspector } from '../src/components/PointInspector';
import type { ExamplePolarity, IChunksResult, ToolOutcome, VectorKey } from '../src/contract/types';
import { CHUNK_TEXT_MAX } from '../src/vector/highlight';
import { fixture } from './support/fixtures';
import { loadSample, modelOf } from './support/map.samples';

const noop = (): void => undefined;
const sample = modelOf(loadSample('sample_demo_1000.json'));
const base = { sample, neighbours: null, querySim: null, writes: { enabled: true, reason: null }, onOpenDocument: noop, onFindSimilar: noop, onRemoveDocument: noop };
const html = (el: React.ReactElement): string => renderToStaticMarkup(el);
const KEY: VectorKey = ['falcon-object', 3];
const ok = (text: string): ToolOutcome<IChunkText> => ({ ok: true, value: { text, truncated: false } });

/** Elements of a rendered tree (plain JSX only). */
function elements(node: unknown, out: React.ReactElement[] = []): React.ReactElement[] {
	if (Array.isArray(node)) node.forEach((child) => elements(child, out));
	else if (React.isValidElement(node)) {
		out.push(node);
		elements((node.props as { children?: unknown }).children, out);
	}
	return out;
}

/** The text of an element's children. */
function textOf(node: unknown): string {
	if (node === null || node === undefined || typeof node === 'boolean') return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	if (React.isValidElement(node)) return textOf((node.props as { children?: unknown }).children);
	return '';
}

// =============================================================================
// FETCHED ONCE PER KEY
// =============================================================================

test('the full text is fetched once per key: a second ask, and asks in flight together, share one call', async () => {
	const cache = createChunkTextCache(8);
	let calls = 0;
	const fetchText = async (key: VectorKey): Promise<ToolOutcome<IChunkText>> => {
		calls += 1;
		return ok(`text of ${key[0]} #${key[1]}`);
	};
	const [a, b] = await Promise.all([cache.load('s-1', KEY, fetchText), cache.load('s-1', KEY, fetchText)]);
	assert.deepEqual(a, ok('text of falcon-object #3'));
	assert.deepEqual(b, a);
	assert.equal(calls, 1, 'two asks in flight: one call');
	await cache.load('s-1', ['falcon-object', 3], fetchText);
	assert.equal(calls, 1, 'asked again: no call');
	assert.deepEqual(cache.peek('s-1', KEY), { text: 'text of falcon-object #3', truncated: false });
	await cache.load('s-1', ['falcon-object', 4], fetchText);
	assert.equal(calls, 2, 'another key: its own call');
	await cache.load('s-2', KEY, fetchText);
	assert.equal(calls, 3, 'a new sample asks again (the store may have changed)');
});

test('a failed fetch is not kept, so asking again retries; the cache holds a bounded number of texts', async () => {
	const cache = createChunkTextCache(2);
	let calls = 0;
	const failing = async (): Promise<ToolOutcome<IChunkText>> => {
		calls += 1;
		return { ok: false, code: 'BUSY', message: 'busy' };
	};
	await cache.load('s', KEY, failing);
	await cache.load('s', KEY, failing);
	assert.equal(calls, 2);
	const fetchText = async (key: VectorKey) => ok(String(key[1]));
	await cache.load('s', ['o', 1], fetchText);
	await cache.load('s', ['o', 2], fetchText);
	await cache.load('s', ['o', 3], fetchText);
	assert.equal(cache.peek('s', ['o', 1]), undefined, 'the oldest text is dropped beyond the bound');
	assert.ok(cache.peek('s', ['o', 3]));
});

test('the cache is scoped by connection as well as sample: the same corpus and seed on two stores never share a text', async () => {
	// The node's sample id comes from the seed and the keys, so one corpus
	// ingested into two stores and sampled with the same seed has one id.
	const sampleId = 's-7-c6774b86';
	const cache = createChunkTextCache(8);
	const calls: string[] = [];
	const from =
		(store: string) =>
		async (key: VectorKey): Promise<ToolOutcome<IChunkText>> => {
			calls.push(store);
			return ok(`${store} text of #${key[1]}`);
		};
	const a = await cache.load(chunkTextScope('conn-pgvector', sampleId), KEY, from('pgvector'));
	const b = await cache.load(chunkTextScope('conn-qdrant', sampleId), KEY, from('qdrant'));
	assert.deepEqual(a, ok('pgvector text of #3'));
	assert.deepEqual(b, ok('qdrant text of #3'), "the second connection gets its own store's text, never the first one's");
	assert.deepEqual(calls, ['pgvector', 'qdrant'], 'one call per connection');
	await cache.load(chunkTextScope('conn-qdrant', sampleId), KEY, from('qdrant'));
	assert.equal(calls.length, 2, 'each connection asks once');
	assert.notEqual(chunkTextScope('a', 'b|c'), chunkTextScope('a|b', 'c'), 'no two connection and sample pairs share a scope');
	assert.notEqual(chunkTextScope(undefined, sampleId), chunkTextScope('conn-qdrant', sampleId), 'without a connection the scope is the sample alone');
});

test("the inspector's text cache is registered and emptied on a change of identity", async () => {
	await chunkTexts.load('s-r', KEY, async () => ok('kept'));
	assert.ok(chunkTexts.peek('s-r', KEY));
	assert.ok(connectionCaches.names().includes('chunk text'));
	connectionCaches.clearAll();
	assert.equal(chunkTexts.peek('s-r', KEY), undefined);
});

test("what is asked of the store: chunks after id - 1, one item; the text is that chunk's, cut to 20,000 characters", async () => {
	assert.deepEqual(chunkTextInput(KEY), { object_id: 'falcon-object', after_chunk: 2, limit: 1 });
	assert.deepEqual(chunkTextInput(['o', 0]), { object_id: 'o', after_chunk: -1, limit: 1 });
	const page = fixture<IChunksResult>('chunks_page');
	const item = page.items[0]!;
	assert.deepEqual(readChunkText(page, ['x', item.chunkId]), { text: item.content, truncated: false });
	assert.equal(readChunkText(page, ['x', 999999]), null, 'another chunk is not this one');
	const long = { ...page, items: [{ ...item, content: 'w'.repeat(CHUNK_TEXT_MAX + 10) }] };
	assert.deepEqual(readChunkText(long, ['x', item.chunkId])?.truncated, true);
	assert.equal(readChunkText(long, ['x', item.chunkId])?.text.length, CHUNK_TEXT_MAX);
	const sent: Array<[string, unknown, unknown]> = [];
	const channel = {
		invoke: async (tool: string, input: unknown, opts: unknown) => {
			sent.push([tool, input, opts]);
			return page;
		},
	} as unknown as Pick<IRoleChannel, 'invoke'>;
	assert.deepEqual(await fetchChunkText(channel, 'store_1', ['x', item.chunkId]), ok(item.content));
	assert.deepEqual(sent, [['chunks', { object_id: 'x', after_chunk: item.chunkId - 1, limit: 1 }, { nodeId: 'store_1' }]]);
	const missing = await fetchChunkText(channel, 'store_1', ['x', 999999]);
	assert.deepEqual(missing, { ok: false, code: 'NOT_FOUND', message: 'This document has no chunk 999999 in the store.' });
});

// =============================================================================
// THE PANEL
// =============================================================================

test("the panel marks the query's words with <mark>, says how many and that matching is lexical", () => {
	const out = html(<ChunkTextPanel chunkKey={KEY} label="C:/demo/handbooks/falcon_handbook.md #3" text="Drinking water at Falcon Station comes from the spring; the waters are tested." query="Where does Falcon Station get its water?" onPrevious={noop} onNext={noop} onClose={noop} />);
	assert.match(out, /data-component="ChunkTextPanel"/);
	assert.doesNotMatch(out, /data-placeholder/);
	assert.equal((out.match(/<mark/g) ?? []).length, 4);
	assert.match(out, /<mark[^>]*>water<\/mark>/);
	assert.match(out, /<mark[^>]*>Falcon<\/mark>/);
	assert.match(out, /4 matches of the query&#x27;s words \(falcon, station, water\)/);
	assert.match(out, /Lexical matches only; retrieval is by meaning/);
	assert.match(out, /Full text · C:\/demo\/handbooks\/falcon_handbook\.md #3/);
	assert.match(out, />Previous chunk</);
	assert.match(out, />Next chunk</);
	assert.match(out, />Close</);
});

test('the panel never renders the chunk as HTML', () => {
	const out = html(<ChunkTextPanel chunkKey={KEY} text={'<script>alert(1)</script> <b>water</b> &amp;'} query="water" />);
	assert.doesNotMatch(out, /<script>|<b>/);
	assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(out, /&lt;b&gt;<mark[^>]*>water<\/mark>&lt;\/b&gt; &amp;amp;/);
});

test('panel states: loading, an error, no query, no match, a cut text, the first chunk has no previous', () => {
	assert.match(html(<ChunkTextPanel chunkKey={KEY} text={null} />), /role="status"[^>]*>Loading the chunk&#x27;s text…/);
	assert.match(html(<ChunkTextPanel chunkKey={KEY} text={null} error="This document has no chunk 3 in the store." />), /This document has no chunk 3 in the store\./);
	const plain = html(<ChunkTextPanel chunkKey={KEY} text="Falcon water" query={null} />);
	assert.doesNotMatch(plain, /<mark|Lexical/);
	assert.match(plain, /Run a text query on the map to mark its words here\./);
	assert.match(html(<ChunkTextPanel chunkKey={KEY} text="Kestrels nest on the ridge." query="falcon water" />), /No word of the query appears in this chunk\./);
	assert.match(html(<ChunkTextPanel chunkKey={KEY} text="abc" truncated />), /Showing the first 20,000 characters of this chunk\./);
	assert.match(html(<ChunkTextPanel chunkKey={['o', 0]} text="abc" onPrevious={noop} onNext={noop} />), /<button[^>]*disabled=""[^>]*>Previous chunk<\/button>/);
});

// =============================================================================
// THE INSPECTOR
// =============================================================================

test('the inspector offers Show full text only when the map can fetch it; the panel opens on demand', () => {
	assert.doesNotMatch(html(<PointInspector {...base} index={0} />), /Show full text|data-component="ChunkTextPanel"/);
	const offered = html(<PointInspector {...base} index={0} loadText={async () => ok('x')} />);
	assert.match(offered, /aria-expanded="false"[^>]*>Show full text</);
	assert.doesNotMatch(offered, /data-component="ChunkTextPanel"/, 'closed until asked');
	assert.match(html(<PointInspector {...base} index={0} onShowText={noop} />), />Show full text</, 'a host that fetches the text itself');
	assert.doesNotMatch(html(<PointInspector {...base} index={null} loadText={async () => ok('x')} />), /Show full text/);
});

test('opened, the section shows the cached text of the selected chunk with the query marked, and steps through chunks', async () => {
	const key = [sample.result.docs[sample.result.points.doc[0] as number]!.objectId, sample.result.points.chunk[0] as number] as VectorKey;
	await chunkTexts.load(chunkTextScope(undefined, sample.sampleId), key, async () => ok('The spring feeds the water tank.'));
	const out = html(<ChunkTextSection sampleId={sample.sampleId} chunkKey={key} label="first #0" query="water" loadText={async () => ok('unused')} initialOpen />);
	assert.match(out, /aria-expanded="true"[^>]*>Hide full text</);
	assert.match(out, /<mark[^>]*>water<\/mark>/);
	assert.match(out, />Previous chunk</);
	assert.match(out, />Next chunk</);
	const hosted = html(<ChunkTextSection sampleId="s" chunkKey={key} label="first #0" query={null} hostText="Text the map fetched." onShowText={noop} initialOpen />);
	assert.match(hosted, /Text the map fetched\./);
	assert.doesNotMatch(hosted, /Previous chunk/, 'stepping needs the loader');
});

test('the section reads the cache under its connection, and the inspector hands it the connection', async () => {
	const key = [sample.result.docs[sample.result.points.doc[1] as number]!.objectId, sample.result.points.chunk[1] as number] as VectorKey;
	await chunkTexts.load(chunkTextScope('conn-a', sample.sampleId), key, async () => ok('Text as connection A stores it.'));
	const loader = async (): Promise<ToolOutcome<IChunkText>> => ok('unused');
	const onA = html(<ChunkTextSection connectionKey="conn-a" sampleId={sample.sampleId} chunkKey={key} label="a #1" query={null} loadText={loader} initialOpen />);
	assert.match(onA, /Text as connection A stores it\./);
	const onB = html(<ChunkTextSection connectionKey="conn-b" sampleId={sample.sampleId} chunkKey={key} label="a #1" query={null} loadText={loader} initialOpen />);
	assert.doesNotMatch(onB, /connection A/, "another connection with the same sample id never shows the first one's text");
	assert.match(onB, /Loading the chunk&#x27;s text…/, 'it asks its own store');
	const sectionOf = (connectionKey: string | undefined): React.ReactElement<ChunkTextSectionProps> => {
		const found = elements(PointInspector({ ...base, index: 1, loadText: loader, connectionKey })).find((el) => el.type === ChunkTextSection);
		assert.ok(found, 'the text section');
		return found as React.ReactElement<ChunkTextSectionProps>;
	};
	assert.equal(sectionOf('conn-b').props.connectionKey, 'conn-b');
	assert.equal(sectionOf('conn-b').key, chunkTextScope('conn-b', sample.sampleId), 'a fresh section per connection and sample');
	assert.notEqual(sectionOf('conn-a').key, sectionOf('conn-b').key);
	assert.equal(sectionOf(undefined).props.connectionKey, undefined, 'a host without a connection: the sample alone scopes the cache');
});

test("Add as example (+) and (−) hand the point's key to Recommend; its side is tagged", () => {
	const added: Array<[VectorKey, ExamplePolarity]> = [];
	const tree = PointInspector({ ...base, index: 0, onAddExample: (key, polarity) => added.push([key, polarity]) });
	const buttons = elements(tree).filter((el) => el.type === 'button');
	const plus = buttons.find((b) => (b.props as { 'aria-label'?: string })['aria-label'] === 'Add as a positive example for Recommend') as React.ReactElement<{ onClick(): void }>;
	const minus = buttons.find((b) => (b.props as { 'aria-label'?: string })['aria-label'] === 'Add as a negative example for Recommend') as React.ReactElement<{ onClick(): void }>;
	plus.props.onClick();
	minus.props.onClick();
	const key = [sample.result.docs[sample.result.points.doc[0] as number]!.objectId, sample.result.points.chunk[0] as number];
	assert.deepEqual(added, [
		[key, 'positive'],
		[key, 'negative'],
	]);
	assert.match(html(<PointInspector {...base} index={0} onAddExample={noop} />), />Add as example \(\+\)<[\s\S]*>Add as example \(−\)</);
	assert.match(html(<PointInspector {...base} index={0} onAddExample={noop} examplePolarity="positive" />), />positive example</);
	assert.doesNotMatch(html(<PointInspector {...base} index={0} />), /Add as example/);
});

test("with Tree edges drawn the inspector lists the point's tree neighbours, each selectable", () => {
	const selected: VectorKey[] = [];
	const tree = PointInspector({
		...base,
		index: 0,
		treeNeighbours: [
			{ i: 5, sim: 0.912 },
			{ i: 9, sim: 0.88 },
		],
		onSelectNeighbour: (key) => selected.push(key),
	});
	const out = renderToStaticMarkup(tree);
	assert.match(out, /Tree neighbours/);
	assert.match(out, /aria-label="Neighbours in the spanning tree"/);
	assert.match(out, /similarity 0\.912/);
	const path5 = sample.result.docs[sample.result.points.doc[5] as number]!.path;
	const btn = elements(tree).find((el) => el.type === 'button' && textOf(el).startsWith(`${path5} #`)) as React.ReactElement<{ onClick(): void }> | undefined;
	assert.ok(btn, 'a button per tree neighbour');
	btn.props.onClick();
	assert.deepEqual(selected, [[sample.result.docs[sample.result.points.doc[5] as number]!.objectId, sample.result.points.chunk[5] as number]]);
	assert.doesNotMatch(html(<PointInspector {...base} index={0} treeNeighbours={null} />), /Tree neighbours/);
	assert.doesNotMatch(html(<PointInspector {...base} index={0} treeNeighbours={[]} />), /Tree neighbours/);
});

test("on the last chunk of a document Next chunk is disabled: the inspector hands the section the document's chunk count", async () => {
	const r = sample.result;
	let index = -1;
	for (let i = 0; i < r.n && index < 0; i += 1) {
		const doc = r.docs[r.points.doc[i] as number]!;
		if (doc.chunks !== null && r.points.chunk[i] === doc.chunks - 1 && doc.chunks > 1) index = i;
	}
	assert.ok(index >= 0, 'a last chunk is in the sample');
	const doc = r.docs[r.points.doc[index] as number]!;
	const key: VectorKey = [doc.objectId, r.points.chunk[index] as number];
	await chunkTexts.load(chunkTextScope(undefined, sample.sampleId), key, async () => ok('last words'));
	const last = html(<ChunkTextSection sampleId={sample.sampleId} chunkKey={key} label={`${doc.path} #${key[1]}`} query={null} chunks={doc.chunks} loadText={async () => ok('x')} initialOpen />);
	assert.match(last, /<button[^>]*disabled=""[^>]*>Next chunk<\/button>/);
	const before: VectorKey = [doc.objectId, key[1] - 1];
	await chunkTexts.load(chunkTextScope(undefined, sample.sampleId), before, async () => ok('earlier words'));
	assert.doesNotMatch(html(<ChunkTextSection sampleId={sample.sampleId} chunkKey={before} label="x" query={null} chunks={doc.chunks} loadText={async () => ok('x')} initialOpen />), /<button[^>]*disabled=""[^>]*>Next chunk<\/button>/, 'before the last, Next is enabled');
	assert.doesNotMatch(html(<ChunkTextSection sampleId={sample.sampleId} chunkKey={key} label="x" query={null} loadText={async () => ok('x')} initialOpen />), /<button[^>]*disabled=""[^>]*>Next chunk<\/button>/, 'an unknown count leaves Next enabled');
	const inspector = html(<PointInspector {...base} index={index} loadText={async () => ok('x')} />);
	assert.match(inspector, /Show full text/);
});
