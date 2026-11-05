// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// REVIEW PANELS: what the duplicates queue and the outlier review show and hand on
// =============================================================================
//
// Statically rendered (no effects run): what a person and a screen reader
// are told in each state. The panels' bodies are plain functions of their
// state, so the tests also call them directly and press their buttons to see
// what each one hands to the host (no DOM harness).
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DuplicatesBody, DuplicatesPanel, requestRemoval } from '../src/components/DuplicatesPanel';
import { OutliersBody, OutliersPanel } from '../src/components/OutliersPanel';
import { RecommendBody, RecommendPanel } from '../src/components/RecommendPanel';
import type { RecommendBodyProps } from '../src/components/RecommendPanel';
import type { Availability, IDocumentItem, IDocumentRowsSource, IKnnBlock, IRecommendResult, ISampleModel, ISampleResult, IVectorCapabilities, IVectorLimits, VectorKey } from '../src/contract/types';
import { copyVerdict, dedupeView, docInfo, queueInit, queueReducer, queued } from '../src/map/dedupe';
import { outlierKey, outlierRows, outliersScope } from '../src/map/outliers';
import { EMPTY_EXAMPLES, recommendRows, resolvedLine } from '../src/map/recommend';
import { fixture } from './support/fixtures';
import { loadSample, modelOf } from './support/map.samples';

const noop = (): void => undefined;
const on: Availability = { enabled: true, reason: null };
const off: Availability = { enabled: false, reason: 'Removing documents is turned off on this store node (allow_writes).' };
const html = (el: React.ReactElement): string => renderToStaticMarkup(el);
const demo = modelOf(loadSample('sample_demo_1000.json'));

/** Elements of a rendered tree (plain JSX only; the bodies call no component with hooks). */
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

/** The button whose text starts with `label`. */
function button(tree: React.ReactElement, label: string): React.ReactElement<{ onClick(): void; disabled?: boolean; title?: string }> {
	const found = elements(tree).find((el) => el.type === 'button' && textOf(el).trim().startsWith(label));
	assert.ok(found, `a "${label}" button`);
	return found as React.ReactElement<{ onClick(): void; disabled?: boolean; title?: string }>;
}

// A two-chunk handbook and its copy (both sampled whole), a one-chunk kestrel copy and a paragraph repeated inside one memo.
function small(): ISampleResult {
	const docs: Array<[string, string, number]> = [
		['oa', 'C:/demo/handbooks/falcon_handbook.md', 2],
		['ob', 'C:/demo/handbooks/falcon_handbook_rev2.md', 2],
		['oc', 'C:/demo/field/kestrel_field_guide.md', 1],
		['od', 'C:/demo/archive/kestrel_field_guide_copy.md', 1],
		['oe', 'C:/demo/ops/memo_q1.txt', 4],
	];
	const points = [0, 0, 1, 1, 2, 3, 4, 4].map((doc, i) => ({ doc, chunk: [0, 1, 0, 1, 0, 0, 0, 2][i] as number }));
	const rows: Array<Array<[number, number]>> = [[[2, 0.993]], [[3, 0.981]], [[0, 0.993]], [[1, 0.981]], [[5, 0.975]], [[4, 0.975]], [[7, 0.99]], [[6, 0.99]]];
	const knn: IKnnBlock = { k: 1, offsets_row: [0], cols: [], sims: [] };
	for (const r of rows) {
		for (const [j, s] of r) {
			knn.cols.push(j);
			knn.sims.push(s);
		}
		knn.offsets_row.push(knn.cols.length);
	}
	const base = loadSample('sample_demo_1000.json');
	return {
		...base,
		n: 8,
		n_requested: 8,
		docs: docs.map(([objectId, path, chunks], i) => ({ i, objectId, path, chunks, in_sample: points.filter((p) => p.doc === i).length })),
		points: { doc: points.map((p) => p.doc), chunk: points.map((p) => p.chunk), x: points.map(() => 0), y: points.map(() => 0), len: points.map(() => 90), snip: points.map(() => 'text'), pinned: points.map(() => 0) },
		knn,
		density: points.map(() => 0.5),
		outliers: [],
		duplicates: [],
	};
}
const SMALL = modelOf(small());

/** Directory rows for the small sample. */
const ROWS: IDocumentItem[] = [
	{ objectId: 'oa', path: 'C:/demo/handbooks/falcon_handbook.md', chunks: 2, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: 4096, modifyTime: null, ingestedAt: '2026-10-02T09:00:00Z', pointId: null },
	{ objectId: 'ob', path: 'C:/demo/handbooks/falcon_handbook_rev2.md', chunks: 2, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: 5120, modifyTime: null, ingestedAt: '2026-10-01T09:00:00Z', pointId: null },
];
const rowsSource: IDocumentRowsSource = { getRows: () => ROWS, subscribe: () => noop };

// =============================================================================
// DUPLICATES QUEUE
// =============================================================================

test('the queue: one fieldset per group with its documents, Keep radios labelled by path, its pairs and its similarity range', () => {
	const out = html(<DuplicatesPanel sample={demo} writes={on} onSelect={noop} onRemoveDocument={noop} />);
	assert.equal((out.match(/<fieldset/g) ?? []).length, 3);
	assert.match(out, /Group 1 · 4 documents · similarity 0\.9991–0\.9992/);
	assert.match(out, /Group 2 · 2 documents · similarity 0\.9998/);
	assert.equal((out.match(/type="radio"/g) ?? []).length, 8);
	assert.match(out, /aria-label="Keep C:\/demo\/field\/field_008\.md"/);
	assert.equal((out.match(/<li/g) ?? []).length, demo.result.duplicates.length, 'one row per pair');
	assert.match(out, /type="range"[^>]*aria-valuetext="similarity 0\.97"/);
	assert.match(out, /min="0\.9"[^>]*max="0\.995"|max="0\.995"[^>]*min="0\.9"/);
	assert.match(out, /Pairs among each point&#x27;s 15 nearest neighbours in this sample/);
	assert.match(out, /Within this sample of 1,000 chunks; draw a larger or light sample to cover more\./);
	assert.match(out, /role="status"[^>]*>No document queued/);
	assert.match(out, /<button[^>]*disabled=""[^>]*>Move all queued to the trash \(0 documents\)<\/button>/);
	assert.match(out, /Keep oldest ingest/);
	assert.match(out, /Keep shortest path/);
	assert.match(out, /Keep most chunks/);
	assert.match(out, /Choose manually/);
});

test('a policy fills every group: the kept document is checked, the others are tagged queued, and the count is spoken', () => {
	const out = html(<DuplicatesPanel sample={SMALL} writes={on} documents={rowsSource} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'shortest-path' }} />);
	assert.match(out, /role="status"[^>]*>2 documents queued/);
	assert.match(out, /<button[^>]*>Move all queued to the trash \(2 documents\)<\/button>/);
	assert.match(out, /checked=""[^>]*aria-label="Keep C:\/demo\/handbooks\/falcon_handbook\.md"|aria-label="Keep C:\/demo\/handbooks\/falcon_handbook\.md"[^>]*checked=""/);
	assert.equal((out.match(/>queued</g) ?? []).length, 2);
	assert.match(out, /2 chunks · ingested 2026-10-02 · 4 KB · 2 of 2 sampled chunks match/);
	assert.match(out, /Repeated text inside one document/);
	assert.match(out, /C:\/demo\/ops\/memo_q1\.txt/);
});

test('writes off: Keep radios and every Remove disabled, and the reason shown as text', () => {
	const out = html(<DuplicatesPanel sample={SMALL} writes={off} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'shortest-path' }} />);
	assert.equal((out.match(/type="radio"/g) ?? []).length, 4);
	assert.equal((out.match(/type="radio"[^>]*disabled=""|disabled=""[^>]*type="radio"/g) ?? []).length, 4);
	assert.match(out, /<button[^>]*disabled=""[^>]*>Move all queued to the trash \(2 documents\)<\/button>/);
	assert.match(out, /<button[^>]*disabled=""[^>]*>Move the other to the trash<\/button>/);
	assert.ok(out.includes(off.reason as string));
});

test('no pair at the threshold: the sentence names the threshold', () => {
	const none = modelOf({ ...SMALL.result, knn: { k: 0, offsets_row: SMALL.result.knn.offsets_row.map(() => 0), cols: [], sims: [] } });
	assert.match(html(<DuplicatesPanel sample={none} writes={on} onSelect={noop} onRemoveDocument={noop} />), /No near-duplicate pairs at similarity 0\.97 or above in this sample\./);
	assert.match(html(<DuplicatesPanel sample={SMALL} writes={on} onSelect={noop} onRemoveDocument={noop} initial={{ threshold: 0.995 }} />), /No near-duplicate pairs at similarity 0\.995 or above/);
});

test('a group inside one document offers Show and Open, never a Remove or a Keep', () => {
	const sample = small();
	const view = dedupeView(sample, 0.97);
	const tree = DuplicatesBody({ sample: modelOf(sample), writes: on, view, info: docInfo(sample, null), state: queueInit(), reviewed: new Set(), queue: queued(view.groups, queueInit(), docInfo(sample, null), new Set()), done: null, bulk: true, onThreshold: noop, onPolicy: noop, onKeep: noop, onShow: noop, onReview: noop, onRemove: noop, onOpenDocument: noop });
	const repeated = elements(tree).find((el) => (el.props as { 'data-repeated'?: string })['data-repeated'] !== undefined);
	assert.ok(repeated, 'the repeated-text section');
	const inside = elements(repeated);
	assert.ok(inside.some((el) => el.type === 'button' && textOf(el) === 'Open'));
	assert.ok(!inside.some((el) => el.type === 'button' && /Remove|trash/.test(textOf(el))));
	assert.ok(!inside.some((el) => el.type === 'input'));
});

test("buttons hand the host what they say: Show the group's points, Mark reviewed its documents, Remove the others and Remove all queued their objectIds", () => {
	const sample = small();
	const info = docInfo(sample, ROWS);
	const view = dedupeView(sample, 0.97);
	const state = queueReducer(queueInit(), { type: 'policy', value: 'shortest-path' });
	const shown: number[][] = [];
	const reviewed: Array<[string[], boolean]> = [];
	const removed: string[][] = [];
	const tree = DuplicatesBody({ sample: modelOf(sample), writes: on, view, info, state, reviewed: new Set(), queue: queued(view.groups, state, info, new Set()), done: null, bulk: true, onThreshold: noop, onPolicy: noop, onKeep: noop, onShow: (points) => shown.push([...points]), onReview: (group, value) => reviewed.push([[...group.objectIds], value]), onRemove: (ids) => removed.push([...ids]) });
	button(tree, 'Show group').props.onClick();
	button(tree, 'Mark reviewed').props.onClick();
	button(tree, 'Move the other to the trash').props.onClick();
	button(tree, 'Move all queued to the trash').props.onClick();
	assert.deepEqual(shown, [[0, 1, 2, 3]]);
	assert.deepEqual(reviewed, [[['oa', 'ob'], true]]);
	assert.deepEqual(removed, [['ob'], ['ob', 'od']]);
});

test('reviewed groups leave the queue and can be reviewed again; the done line counts what the console removed', () => {
	const sample = small();
	const info = docInfo(sample, ROWS);
	const view = dedupeView(sample, 0.97);
	const state = queueReducer(queueInit(), { type: 'policy', value: 'shortest-path' });
	const done = new Set(['oa', 'ob']);
	const tree = DuplicatesBody({ sample: modelOf(sample), writes: on, view, info, state, reviewed: done, queue: queued(view.groups, state, info, done), done: 'Moved 1 document to the trash (5 chunks)', bulk: true, onThreshold: noop, onPolicy: noop, onKeep: noop, onShow: noop, onReview: noop, onRemove: noop });
	const out = renderToStaticMarkup(tree);
	assert.match(out, /Reviewed \(1 group\)/);
	assert.match(out, /Review again/);
	assert.match(out, /1 document queued/);
	assert.match(out, /Moved 1 document to the trash \(5 chunks\)/);
});

test('requestRemoval: one document through the single dialog when that is all the host has, several only through the batched one', () => {
	const single: string[] = [];
	const many: string[][] = [];
	assert.equal(requestRemoval(['ob'], { onRemoveDocument: (id) => single.push(id) }), true);
	assert.deepEqual(single, ['ob']);
	assert.equal(requestRemoval(['ob', 'od'], { onRemoveDocument: (id) => single.push(id) }), false, 'never one dialog per document');
	assert.deepEqual(single, ['ob']);
	assert.equal(requestRemoval(['ob', 'od'], { onRemoveDocument: (id) => single.push(id), onRemoveDocuments: (ids) => many.push([...ids]) }), true);
	assert.equal(requestRemoval(['ob'], { onRemoveDocument: (id) => single.push(id), onRemoveDocuments: (ids) => many.push([...ids]) }), true);
	assert.deepEqual(many, [['ob', 'od'], ['ob']]);
	assert.equal(requestRemoval([], { onRemoveDocument: noop }), false);
});

test('without the batched remove, the bulk button is disabled with its reason', () => {
	const out = html(<DuplicatesPanel sample={SMALL} writes={on} onSelect={noop} onRemoveDocument={noop} initial={{ policy: 'shortest-path' }} />);
	assert.match(out, /<button[^>]*disabled=""[^>]*title="This view cannot move several documents to the trash at once\."[^>]*>Move all queued to the trash \(2 documents\)<\/button>/);
});

test("the sample model's removed documents leave the groups", () => {
	const sample: ISampleModel = { ...SMALL, removed: ['ob'] };
	const out = html(<DuplicatesPanel sample={sample} writes={on} onSelect={noop} onRemoveDocument={noop} />);
	assert.doesNotMatch(out, /falcon_handbook_rev2/);
	assert.equal((out.match(/<fieldset/g) ?? []).length, 2, 'the kestrel pair and the repeated memo');
});

test('after the console removed queued documents the panel says how many, with the chunks as the document list counts them', () => {
	const sample: ISampleModel = { ...SMALL, removed: ['ob'] };
	const out = html(<DuplicatesPanel sample={sample} writes={on} documents={rowsSource} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ requested: ['ob', 'od'] }} />);
	assert.match(out, /Moved 1 document to the trash \(2 chunks as listed\)/);
	assert.doesNotMatch(out, /still stored/, 'a cancelled dialog and a stopped batch look the same from here: nothing is said about the rest');
	const all: ISampleModel = { ...SMALL, removed: ['ob', 'od'] };
	assert.match(html(<DuplicatesPanel sample={all} writes={on} documents={rowsSource} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ requested: ['ob', 'od'] }} />), /Moved 2 documents to the trash \(3 chunks as listed\)/);
	const unknown: ISampleModel = { ...modelOf({ ...small(), docs: small().docs.map((d) => ({ ...d, chunks: null })) }), removed: ['ob'] };
	assert.match(html(<DuplicatesPanel sample={unknown} writes={on} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ requested: ['ob', 'od'] }} />), /Moved 1 document to the trash</, 'no count when the list does not have one');
});

test('a removal that resolves the last group still says what was removed, beside the sentence that no pair is left', () => {
	// The handbook pair alone: no kestrel copy, no repeated memo.
	const only = small();
	const knn: IKnnBlock = { k: 1, offsets_row: [0], cols: [], sims: [] };
	const rows: Array<Array<[number, number]>> = [[[2, 0.993]], [[3, 0.981]], [[0, 0.993]], [[1, 0.981]], [], [], [], []];
	for (const r of rows) {
		for (const [j, s] of r) {
			knn.cols.push(j);
			knn.sims.push(s);
		}
		knn.offsets_row.push(knn.cols.length);
	}
	const sample: ISampleModel = { ...modelOf({ ...only, knn }), removed: ['ob'] };
	const out = html(<DuplicatesPanel sample={sample} writes={on} documents={rowsSource} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'shortest-path', requested: ['ob'] }} />);
	assert.match(out, /No near-duplicate pairs at similarity 0\.97 or above in this sample\./, 'the only group is resolved');
	assert.match(out, /Moved 1 document to the trash \(2 chunks as listed\)/, 'and the panel says what the removal did');
	assert.doesNotMatch(html(<DuplicatesPanel sample={modelOf({ ...only, knn })} writes={on} onSelect={noop} onRemoveDocument={noop} />), /Moved \d+ documents? to the trash|Removed/, 'nothing moved, nothing said');
});

test('the reviewed documents of a connection come from its cache, so the queue keeps them across tab switches', () => {
	const cache = new Map<string, ReadonlySet<string>>([['conn-r', new Set(['oa', 'ob'])]]);
	const out = html(<DuplicatesPanel sample={SMALL} writes={on} connectionKey="conn-r" reviewedCache={cache} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'shortest-path' }} />);
	assert.match(out, /Reviewed \(1 group\)/);
	assert.match(out, /role="status"[^>]*>1 document queued/);
	assert.match(html(<DuplicatesPanel sample={SMALL} writes={on} connectionKey="conn-other" reviewedCache={cache} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'shortest-path' }} />), /2 documents queued/, 'another connection has its own set');
});

test('groups of shared passages say so; a policy keeps one document in each and queues nothing, and the others say why', () => {
	const out = html(<DuplicatesPanel sample={demo} writes={on} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} />);
	// One shared chunk of documents with many sampled (the second group's 7-chunk note is not ruled out as a whole copy).
	assert.equal((out.match(/Shared passages only: this sample shows that each of these documents holds text the others do not\./g) ?? []).length, 2);
	assert.equal((out.match(/Not every document here is a copy of the others: this sample shows that at least one holds text the others do not\./g) ?? []).length, 1);
	assert.equal((out.match(/A keep policy queues a document only when this sample shows that the kept one holds it\./g) ?? []).length, 3);
	assert.doesNotMatch(out, /to queue the others/, 'the note never invites queueing whole documents over a shared paragraph');
	const policy = html(<DuplicatesPanel sample={demo} writes={on} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'shortest-path' }} />);
	assert.match(policy, /role="status"[^>]*>No document queued: this sample does not show that a kept document holds another one\./, 'a policy queues nothing from shared passages');
	assert.equal((policy.match(/checked=""/g) ?? []).length, 3, 'the policy keeps one document per group');
	assert.equal((policy.match(/>queued</g) ?? []).length, 0);
	assert.ok((policy.match(/holds text the kept document does not, so not queued/g) ?? []).length >= 4, 'the documents it leaves say they hold text of their own');
	assert.match(policy, /<button[^>]*disabled=""[^>]*title="This sample does not show that the kept document holds the others\."[^>]*>Move the others to the trash<\/button>/);
	assert.doesNotMatch(html(<DuplicatesPanel sample={SMALL} writes={on} onSelect={noop} onRemoveDocument={noop} />), /Shared passages only/, 'a copy shares most of its chunks');
	assert.match(out, /<button[^>]*disabled=""[^>]*title="Choose the document to keep first"[^>]*>Move the others to the trash<\/button>/);
});

test('two long files sampled once each through the shared paragraph: the panel says it cannot tell, and a policy queues nothing', () => {
	const base = loadSample('sample_demo_1000.json');
	const knn: IKnnBlock = { k: 1, offsets_row: [0, 1, 2], cols: [1, 0], sims: [0.996, 0.996] };
	const sparse: ISampleResult = {
		...base,
		n: 2,
		n_requested: 2,
		docs: [
			{ i: 0, objectId: 'long-a', path: 'C:/corp/legal/contracts/master_services_agreement_2024.pdf', chunks: 120, in_sample: 1 },
			{ i: 1, objectId: 'long-b', path: 'C:/corp/hr/policies/leave.md', chunks: 80, in_sample: 1 },
		],
		points: { doc: [0, 1], chunk: [119, 79], x: [0, 0], y: [0, 0], len: [400, 400], snip: ['text', 'text'], pinned: [0, 0] },
		knn,
		density: [0.5, 0.5],
		outliers: [],
		duplicates: [],
	};
	const out = html(<DuplicatesPanel sample={modelOf(sparse)} writes={on} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'shortest-path' }} />);
	assert.match(out, /This sample holds too few chunks of these documents to tell copies from shared text\. A keep policy queues a document only when this sample shows that the kept one holds it\./);
	assert.doesNotMatch(out, /Shared passages only|Not every document here is a copy/);
	assert.match(out, /role="status"[^>]*>No document queued/);
	assert.match(out, /<button[^>]*disabled=""[^>]*>Move all queued to the trash \(0 documents\)<\/button>/);
	assert.match(out, /this sample does not show that the kept document holds it, so not queued/, 'the document the policy leaves says why');
});

/**
 * One group across many documents: each of `docs` documents of `per` chunks
 * opens with the same cover sheet (a licence header, a mail disclaimer). A
 * stratified sample takes every chunk 0 and the kNN rows join the cover
 * sheets into one group; the rest of each document is its own text.
 *
 * @param docs - Documents.
 * @param per - Chunks of each, all in the sample.
 * @returns The sample and the directory rows.
 */
function coverSheets(docs: number, per: number): { sample: ISampleResult; rows: IDocumentItem[] } {
	const doc: number[] = [];
	const chunk: number[] = [];
	for (let d = 0; d < docs; d += 1) {
		for (let c = 0; c < per; c += 1) {
			doc.push(d);
			chunk.push(c);
		}
	}
	const k = 15;
	const knn: IKnnBlock = { k, offsets_row: [0], cols: [], sims: [] };
	doc.forEach((d, i) => {
		for (let t = 1; t <= k; t += 1) {
			// A cover sheet's nearest are other documents' cover sheets; body text neighbours far text.
			knn.cols.push(chunk[i] === 0 ? ((d + t * 37) % docs) * per : ((d + t) % docs) * per + 1);
			knn.sims.push(chunk[i] === 0 ? 0.995 + ((d * 7 + t) % 40) / 10000 : 0.3);
		}
		knn.offsets_row.push(knn.cols.length);
	});
	const name = (d: number): string => String(d).padStart(4, '0');
	const base = small();
	const sample: ISampleResult = {
		...base,
		n: doc.length,
		n_requested: doc.length,
		docs: Array.from({ length: docs }, (_, d) => ({ i: d, objectId: `mail-${name(d)}`, path: `C:/mail/2026/${name(d)}.eml`, chunks: per, in_sample: per })),
		points: { doc, chunk, x: doc.map(() => 0), y: doc.map(() => 0), len: doc.map(() => 90), snip: doc.map(() => 'text'), pinned: doc.map(() => 0) },
		knn,
		density: doc.map(() => 0.5),
	};
	const rows = sample.docs.map((x, d): IDocumentItem => ({ objectId: x.objectId, path: x.path, chunks: per, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: null, modifyTime: null, ingestedAt: `2026-01-${String((d % 28) + 1).padStart(2, '0')}T00:00:00Z`, pointId: null }));
	return { sample, rows };
}

test('one group across 1,000 documents: the first 20 are listed with the count of the rest, the panel renders in 50 ms or less and a re-render costs little', () => {
	const { sample, rows } = coverSheets(1000, 5);
	const documents: IDocumentRowsSource = { getRows: () => rows, subscribe: () => noop };
	const model = modelOf(sample);
	/** The best of five runs after one to warm up (the suites run side by side, so one run can be slow). */
	const bestOf = (run: () => string): { ms: number; out: string } => {
		let out = run();
		let ms = Infinity;
		for (let i = 0; i < 5; i += 1) {
			const started = performance.now();
			out = run();
			ms = Math.min(ms, performance.now() - started);
		}
		return { ms, out };
	};
	// The whole panel, as a slider step draws it: grouping, verdicts, queue and markup.
	const panel = bestOf(() => html(<DuplicatesPanel sample={model} writes={on} documents={documents} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'shortest-path' }} />));
	const out = panel.out;
	assert.match(out, /Group 1 · 1,000 documents/);
	assert.equal((out.match(/type="radio"/g) ?? []).length, 20, 'twenty Keep radios, not a thousand');
	assert.match(out, /and 980 more documents, none of them queued\. Show group selects the whole group on the map\./);
	assert.match(out, /Shared passages only/, 'each mail holds text of its own');
	assert.match(out, />Show group</);
	assert.ok(panel.ms <= 50, `the panel rendered in ${panel.ms.toFixed(1)} ms`);
	// A re-render with what the panel keeps (a keep click, Mark reviewed): no verdict or queue is worked out again.
	const view = dedupeView(sample, 0.97);
	const info = docInfo(sample, rows);
	const state = queueReducer(queueInit(), { type: 'policy', value: 'shortest-path' });
	const queue = queued(view.groups, state, info, new Set());
	const verdicts = new Map(view.groups.map((g) => [g.key, copyVerdict(g, info)] as const));
	const again = bestOf(() => renderToStaticMarkup(DuplicatesBody({ sample: model, writes: on, view, info, state, reviewed: new Set(), queue, done: null, bulk: true, verdicts, onThreshold: noop, onPolicy: noop, onKeep: noop, onShow: noop, onReview: noop, onRemove: noop })));
	assert.equal(again.out, out, 'the same markup');
	assert.ok(again.ms <= 15, `a re-render took ${again.ms.toFixed(1)} ms`);
});

test("a group's kept document is listed even when it is not among the first 20, and the rest count what they queue", () => {
	const { sample, rows } = coverSheets(40, 1);
	const view = dedupeView(sample, 0.97);
	const info = docInfo(sample, rows);
	const [group] = view.groups;
	assert.equal(group?.objectIds.length, 40);
	// Kept by hand: the 31st mail; every other one is queued by that choice.
	const state = queueReducer(queueInit(), { type: 'keep', group: group!.key, objectId: 'mail-0030' });
	const out = renderToStaticMarkup(DuplicatesBody({ sample: modelOf(sample), writes: on, view, info, state, reviewed: new Set(), queue: queued(view.groups, state, info, new Set()), done: null, bulk: true, onThreshold: noop, onPolicy: noop, onKeep: noop, onShow: noop, onReview: noop, onRemove: noop }));
	assert.equal((out.match(/type="radio"/g) ?? []).length, 20);
	assert.match(out, /aria-label="Keep C:\/mail\/2026\/0030\.eml" checked=""/, 'the kept document is listed');
	assert.doesNotMatch(out, /aria-label="Keep C:\/mail\/2026\/0019\.eml"/, 'the 20th place goes to the kept one');
	// Each cover sheet pairs with 30 others in the kNN rows: the ones that never pair with the kept one are queued by that choice alone.
	const listed = new Set([...group!.objectIds.slice(0, 19), 'mail-0030']);
	const unshown = [...(queued(view.groups, state, info, new Set()).unshown.get(group!.key)?.keys() ?? [])].filter((id) => !listed.has(id)).length;
	assert.ok(unshown > 0 && unshown < 20, `${unshown} of the 20 left out are not shown held`);
	assert.match(out, new RegExp(`and 20 more documents, all 20 of them queued, ${unshown} by your choice although this sample does not show that the kept document holds them\\. Show group selects the whole group on the map\\.`));
	assert.match(out, /role="status"[^>]*>39 documents queued/);
	assert.match(out, />Move the others to the trash \(39\)</);
});

// =============================================================================
// OUTLIER REVIEW
// =============================================================================

test('the outlier review: a percentile select, one row per outlier with why, and the count spoken', () => {
	const out = html(<OutliersPanel sample={demo} onSelect={noop} onShowNeighbours={noop} onRemoveDocument={noop} writes={on} />);
	assert.equal((out.match(/<li/g) ?? []).length, 10);
	assert.match(out, /Lowest density/);
	assert.match(out, /<option value="1" selected="">1 %<\/option><option value="2">2 %<\/option><option value="5">5 %<\/option>/);
	assert.match(out, /role="status"[^>]*>10 points: the lowest 1 % by density/);
	assert.match(out, /C:\/demo\/finance\/ocr_scan_junk\.txt #\d+/);
	assert.match(out, /density 0\.24 vs sample median 0\.68; nearest neighbour 0\.\d\d in /);
	assert.equal((out.match(/>Show neighbours</g) ?? []).length, 10);
	assert.equal((out.match(/>Mark reviewed</g) ?? []).length, 10);
	assert.equal((out.match(/<button[^>]*>Move to trash<\/button>/g) ?? []).length, 10);
	assert.doesNotMatch(out, /<button[^>]*disabled=""[^>]*>Move to trash<\/button>/);
});

test('a larger percentile lists more rows from the same sample', () => {
	assert.equal((html(<OutliersPanel sample={demo} onSelect={noop} initial={{ percentile: 5 }} />).match(/<li/g) ?? []).length, 50);
	assert.match(html(<OutliersPanel sample={demo} onSelect={noop} initial={{ percentile: 2 }} />), /20 points: the lowest 2 % by density/);
});

test('Remove document is disabled with the reason when writes are off, and absent without a remove handler', () => {
	const out = html(<OutliersPanel sample={demo} onSelect={noop} onRemoveDocument={noop} writes={off} />);
	assert.equal((out.match(/<button[^>]*disabled=""[^>]*>Move to trash<\/button>/g) ?? []).length, 10);
	assert.ok(out.includes(off.reason as string));
	assert.equal((html(<OutliersPanel sample={demo} onSelect={noop} onRemoveDocument={noop} />).match(/<button[^>]*disabled=""[^>]*>Move to trash<\/button>/g) ?? []).length, 10, 'no writes given: closed');
	assert.doesNotMatch(html(<OutliersPanel sample={demo} onSelect={noop} />), /Move to trash|Show neighbours/);
});

test('the outlier buttons hand the host the point or its document', () => {
	const rows = outlierRows(demo.result, 1);
	const picked: number[] = [];
	const neighbours: number[] = [];
	const reviewed: Array<[string, boolean]> = [];
	const removed: string[] = [];
	const tree = OutliersBody({ rows, percentile: 1, writes: on, canRemove: true, canShowNeighbours: true, onPercentile: noop, onSelect: (i) => picked.push(i), onReview: (id, value) => reviewed.push([id, value]), onRemove: (id) => removed.push(id), onShowNeighbours: (i) => neighbours.push(i) });
	button(tree, 'C:/demo/finance/ocr_scan_junk.txt').props.onClick();
	button(tree, 'Show neighbours').props.onClick();
	button(tree, 'Mark reviewed').props.onClick();
	button(tree, 'Move to trash').props.onClick();
	assert.deepEqual(picked, [262]);
	assert.deepEqual(neighbours, [262]);
	assert.deepEqual(reviewed, [[outlierKey(rows[0]!), true]], 'Mark reviewed marks the chunk');
	assert.deepEqual(removed, [rows[0]!.objectId]);
});

test("reviewed outliers are tagged and counted per chunk, from the connection's cache", () => {
	const first = outlierRows(demo.result, 1)[0]!;
	const cache = new Map<string, ReadonlySet<string>>([
		[outliersScope('conn-o'), new Set([outlierKey(first)])],
		['conn-o', new Set([first.objectId])],
	]);
	const out = html(<OutliersPanel sample={demo} onSelect={noop} connectionKey="conn-o" reviewedCache={cache} />);
	assert.equal((out.match(/>reviewed</g) ?? []).length, 1, 'the one chunk marked, not every outlier of its document');
	assert.equal((out.match(/>Review again</g) ?? []).length, 1);
	assert.match(out, /10 points: the lowest 1 % by density · 1 reviewed/);
});

test('no outliers: the sentence, and nothing to pick', () => {
	const none = modelOf({ ...demo.result, outliers: [] });
	const out = html(<OutliersPanel sample={none} onSelect={noop} />);
	assert.match(out, /No outliers in this sample\./);
	assert.doesNotMatch(out, /<select/);
});

test('an outlier of a removed document leaves the list', () => {
	const ocr = demo.result.docs[demo.result.points.doc[262] as number]!.objectId;
	const out = html(<OutliersPanel sample={{ ...demo, removed: [ocr] }} onSelect={noop} />);
	assert.doesNotMatch(out, /ocr_scan_junk/);
});

// =============================================================================
// RECOMMEND
// =============================================================================

const ENRICHED = fixture<{ limits: IVectorLimits; capabilities: IVectorCapabilities }>('dialect_enriched');
const OLD_LIMITS: IVectorLimits = (({ recommend_examples_max: _r, matrix_keys_max: _m, max_components: _c, ...rest }) => rest)(ENRICHED.limits);
const DOC0 = demo.result.docs[0]!;
const POS: VectorKey = [DOC0.objectId, 3];
const NEG: VectorKey = ['greenhouse-object-id', 1];
const run = async () => ({ ok: false as const, code: undefined, message: 'not run' });

test('Recommend on a node without the tool says to update the node and offers nothing else', () => {
	const out = html(<RecommendPanel sample={demo} limits={OLD_LIMITS} capabilities={ENRICHED.capabilities} examples={EMPTY_EXAMPLES} onExamplesChange={noop} queryText={null} onRun={run} onSelect={noop} onPin={noop} />);
	assert.match(out, /data-component="RecommendPanel"/);
	assert.doesNotMatch(out, /data-placeholder/);
	assert.match(out, /This store node does not recommend from examples; update the node\./);
	assert.doesNotMatch(out, /<button/);
});

test('Recommend with no example: Run disabled with the sentence; how to add examples is said', () => {
	const out = html(<RecommendPanel sample={demo} limits={ENRICHED.limits} capabilities={ENRICHED.capabilities} examples={EMPTY_EXAMPLES} onExamplesChange={noop} queryText={null} onRun={run} onSelect={noop} onPin={noop} />);
	assert.match(out, /<button[^>]*disabled=""[^>]*>Run<\/button>/);
	assert.match(out, /Add at least one positive example/);
	assert.match(out, /Add as example \(\+\) or \(−\)/);
	assert.match(out, /type="checkbox"[^>]*disabled=""/, 'no query on the map: the query cannot count');
	assert.match(out, /\+ current query \(run a text query on the map to count it as a positive\)/);
});

test('Recommend with examples: removable chips per side, the query offered, Best score disabled where the store cannot rank, k and Run', () => {
	const examples = { positive: [POS], negative: [NEG], withQuery: false };
	const out = html(<RecommendPanel sample={demo} limits={ENRICHED.limits} capabilities={ENRICHED.capabilities} examples={examples} onExamplesChange={noop} queryText="falcon water" onRun={run} onSelect={noop} onPin={noop} />);
	assert.ok(out.includes(`aria-label="Remove positive example: ${DOC0.path} #3"`));
	assert.match(out, /aria-label="Remove negative example: greenhou… #1"/);
	assert.match(out, /\+ current query “falcon water” as a positive/);
	assert.match(out, /<option value="best_score" disabled="">Best score \(only where the store ranks examples itself\)<\/option>/);
	assert.match(out, /<option value="12" selected="">12<\/option>/);
	assert.match(out, /<button[^>]*>Run<\/button>/);
	assert.doesNotMatch(out, /<button[^>]*disabled=""[^>]*>Run<\/button>/);
	const qdrant = html(<RecommendPanel sample={demo} limits={ENRICHED.limits} capabilities={{ ...ENRICHED.capabilities, recommend_best_score: true }} examples={examples} onExamplesChange={noop} queryText={null} onRun={run} onSelect={noop} onPin={noop} />);
	assert.match(qdrant, /<option value="best_score">Best score \(ranked by the store\)<\/option>/);
});

/** A body with defaults. */
function recommendBody(over: Partial<RecommendBodyProps>): React.ReactElement {
	return RecommendBody({ available: true, examples: { positive: [POS], negative: [], withQuery: false }, labelOf: (key) => `${key[0]} #${key[1]}`, strategy: 'average_vector', k: 12, bestScore: false, queryText: null, blocker: null, note: null, busy: false, outcome: null, pinMax: 200, onStrategy: noop, onK: noop, onWithQuery: noop, onRemoveExample: noop, onClear: noop, onRun: noop, onSelect: noop, onPin: noop, ...over });
}

test('Recommend results: ranked rows with their similarity and preview, what was used, outside points pinned on request', () => {
	const answer = fixture<IRecommendResult>('recommend_ok');
	const rows = recommendRows(answer, (key) => key[1] === 7);
	const selected: VectorKey[] = [];
	const pinned: VectorKey[][] = [];
	const tree = recommendBody({ outcome: { kind: 'rows', rows, resolved: resolvedLine(answer), notFound: '1 example is no longer in the store: x #1', stale: false }, onSelect: (key) => selected.push(key), onPin: (keys) => pinned.push([...keys]) });
	const out = renderToStaticMarkup(tree);
	assert.match(out, /Ranked by 2 positive and 1 negative examples \(average vector, computed by the store node\)\./);
	assert.match(out, /1 example is no longer in the store: x #1/);
	assert.equal((out.match(/<li/g) ?? []).length, 6);
	assert.match(out, /1\. C:\/demo\/handbooks\/falcon_handbook\.md #7/);
	assert.match(out, /similarity 0\.710/);
	assert.match(out, /Falcon Station draws its drinking water/);
	assert.equal((out.match(/>outside the sample</g) ?? []).length, 5);
	button(tree, '1. C:/demo/handbooks/falcon_handbook.md #7').props.onClick();
	button(tree, 'Pin results on the map (5 outside the sample)').props.onClick();
	assert.deepEqual(selected, [['75b89d86-a64e-5143-bf50-55d4a7fd8cd2', 7]]);
	assert.deepEqual(pinned, [rows.filter((r) => !r.inSample).map((r) => r.key)]);
	const capped = renderToStaticMarkup(recommendBody({ pinMax: 2, outcome: { kind: 'rows', rows, resolved: '', notFound: null, stale: false } }));
	assert.match(capped, /Pin results on the map \(the first 2 of 5 outside the sample\)/);
});

test('Recommend states: busy, a failure, results of examples changed since, negatives only', () => {
	assert.match(renderToStaticMarkup(recommendBody({ busy: true })), /role="status"[^>]*>Finding chunks like the examples…/);
	assert.match(renderToStaticMarkup(recommendBody({ busy: true })), /<button[^>]*disabled=""[^>]*>Run<\/button>/, 'one run at a time');
	assert.match(renderToStaticMarkup(recommendBody({ outcome: { kind: 'error', message: 'The store is answering another neighbour search; try again in a moment.' } })), /another neighbour search/);
	assert.match(renderToStaticMarkup(recommendBody({ outcome: { kind: 'rows', rows: [], resolved: 'Ranked by 1 positive example (average vector, computed by the store node).', notFound: null, stale: true } })), /These results are for the examples before your last change; run again\./);
	assert.match(renderToStaticMarkup(recommendBody({ outcome: { kind: 'rows', rows: [], resolved: '', notFound: null, stale: false } })), /The store returned no chunk for these examples\./);
	assert.match(renderToStaticMarkup(recommendBody({ strategy: 'best_score', bestScore: true, note: 'Only negatives: showing the least similar chunks' })), /Only negatives: showing the least similar chunks/);
});

test('Recommend buttons: a chip removes its example, Clear removes all, Run runs, the query box counts the query', () => {
	const removed: VectorKey[] = [];
	let cleared = 0;
	let ran = 0;
	const query: boolean[] = [];
	const tree = recommendBody({ queryText: 'falcon', onRemoveExample: (key) => removed.push(key), onClear: () => (cleared += 1), onRun: () => (ran += 1), onWithQuery: (value) => query.push(value) });
	const chip = elements(tree).find((el) => el.type === 'button' && String((el.props as { 'aria-label'?: string })['aria-label']).startsWith('Remove positive example'));
	(chip as React.ReactElement<{ onClick(): void }>).props.onClick();
	button(tree, 'Clear examples').props.onClick();
	button(tree, 'Run').props.onClick();
	const box = elements(tree).find((el) => el.type === 'input' && (el.props as { type?: string }).type === 'checkbox') as React.ReactElement<{ onChange(e: { currentTarget: { checked: boolean } }): void }>;
	box.props.onChange({ currentTarget: { checked: true } });
	assert.deepEqual(removed, [POS]);
	assert.equal(cleared, 1);
	assert.equal(ran, 1);
	assert.deepEqual(query, [true]);
});

/**
 * Two 100-chunk copies drawn on their own at 40%: chunk 0 and 39 more of each,
 * 15 of those drawn in both (the twins pair at 0.996).
 *
 * @param pinned - Chunks of each copy pinned by include_keys (none drawn).
 * @returns The sample.
 */
function halfDrawn(): ISampleResult {
	const a = [0, ...Array.from({ length: 39 }, (_, i) => i + 1)];
	const b = [0, ...Array.from({ length: 39 }, (_, i) => i + 25)];
	const points = [...a.map((chunk) => ({ doc: 0, chunk })), ...b.map((chunk) => ({ doc: 1, chunk }))];
	const at = new Map(points.map((p, i) => [`${p.doc}:${p.chunk}`, i] as const));
	const knn: IKnnBlock = { k: 1, offsets_row: [0], cols: [], sims: [] };
	for (const p of points) {
		const twin = at.get(`${1 - p.doc}:${p.chunk}`);
		if (twin !== undefined) {
			knn.cols.push(twin);
			knn.sims.push(0.996);
		}
		knn.offsets_row.push(knn.cols.length);
	}
	const base = small();
	return {
		...base,
		n: points.length,
		n_requested: points.length,
		docs: [
			{ i: 0, objectId: 'pa', path: 'C:/corp/archive/policy_copy.md', chunks: 100, in_sample: a.length },
			{ i: 1, objectId: 'pb', path: 'C:/corp/policy.md', chunks: 100, in_sample: b.length },
		],
		points: { doc: points.map((p) => p.doc), chunk: points.map((p) => p.chunk), x: points.map(() => 0), y: points.map(() => 0), len: points.map(() => 90), snip: points.map(() => 'text'), pinned: points.map(() => 0) },
		knn,
		density: points.map(() => 0.5),
	};
}

test('a group the sample holds part of says it cannot tell yet; "too few chunks" is kept for too few', () => {
	const out = html(<DuplicatesPanel sample={modelOf(halfDrawn())} writes={on} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'shortest-path' }} />);
	assert.match(out, /16 of 40 sampled chunks match/);
	assert.match(out, /This sample cannot tell yet whether these documents are whole copies of each other: it holds part of each, and part of a document may be text the others do not have\./);
	assert.doesNotMatch(out, /too few chunks|Shared passages only|Not every document/, 'identical files are never said to hold text of their own');
	assert.match(out, /A keep policy queues a document only when this sample shows that the kept one holds it\./);
	assert.match(out, /role="status"[^>]*>No document queued/);
	assert.match(out, /this sample does not show that the kept document holds it, so not queued/);
});

test('a keep picked by hand queues a document the sample does not show to be held, and its line says so', () => {
	const sample = halfDrawn();
	const view = dedupeView(sample, 0.97);
	const info = docInfo(sample, null);
	const state = queueReducer(queueInit(), { type: 'keep', group: view.groups[0]!.key, objectId: 'pb' });
	const out = renderToStaticMarkup(DuplicatesBody({ sample: modelOf(sample), writes: on, view, info, state, reviewed: new Set(), queue: queued(view.groups, state, info, new Set()), done: null, bulk: true, onThreshold: noop, onPolicy: noop, onKeep: noop, onShow: noop, onReview: noop, onRemove: noop }));
	assert.match(out, /role="status"[^>]*>1 document queued/);
	assert.match(out, /queued by your choice; this sample does not show that the kept document holds it/);
});

test('a revision that added chapters: keeping the original queues nothing and the revision says it holds text of its own', () => {
	// The original is 4 chunks, the revision 8 (its first 4 the original's), both sampled whole.
	const points = [...[0, 1, 2, 3].map((chunk) => ({ doc: 0, chunk })), ...[0, 1, 2, 3, 4, 5, 6, 7].map((chunk) => ({ doc: 1, chunk }))];
	const knn: IKnnBlock = { k: 1, offsets_row: [0], cols: [], sims: [] };
	points.forEach((p) => {
		if (p.chunk < 4) {
			knn.cols.push(p.doc === 0 ? 4 + p.chunk : p.chunk);
			knn.sims.push(0.999);
		}
		knn.offsets_row.push(knn.cols.length);
	});
	const base = small();
	const revision: ISampleResult = {
		...base,
		n: points.length,
		n_requested: points.length,
		docs: [
			{ i: 0, objectId: 'orig', path: 'C:/h/orig.md', chunks: 4, in_sample: 4 },
			{ i: 1, objectId: 'rev', path: 'C:/h/archive/revision.md', chunks: 8, in_sample: 8 },
		],
		points: { doc: points.map((p) => p.doc), chunk: points.map((p) => p.chunk), x: points.map(() => 0), y: points.map(() => 0), len: points.map(() => 90), snip: points.map(() => 'text'), pinned: points.map(() => 0) },
		knn,
		density: points.map(() => 0.5),
	};
	const out = html(<DuplicatesPanel sample={modelOf(revision)} writes={on} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'shortest-path' }} />);
	assert.match(out, /role="status"[^>]*>No document queued/);
	assert.match(out, /<button[^>]*disabled=""[^>]*>Move all queued to the trash \(0 documents\)<\/button>/);
	assert.match(out, /8 chunks · 4 of 8 sampled chunks match · holds text the kept document does not, so not queued/);
	assert.match(out, /Not every document here is a copy of the others/);
	const most = html(<DuplicatesPanel sample={modelOf(revision)} writes={on} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy: 'most-chunks' }} />);
	assert.match(most, /role="status"[^>]*>1 document queued/, 'keeping the revision queues the original it holds');
});

/**
 * A 450-chunk handbook printing a 150-chunk section three times, beside a
 * 300-chunk document holding that section once and 150 chunks of its own (the
 * handbook holds half of it). Drawn by the node's own vx_math.stratified_pick
 * (seed 0, 12 other documents of 300 chunks, n = 2,000): 143 chunks of each.
 *
 * @returns The sample and the directory rows (the handbook is older, shorter and longer).
 */
function repeatedSection(): { sample: ISampleResult; rows: IDocumentItem[] } {
	const steps = (text: string): number[] => {
		let at = -1;
		return text.split('.').map((step) => (at += parseInt(step, 16)));
	};
	const kept = steps('1.1.1.3.2.2.2.1.5.3.d.2.6.2.2.7.1.a.5.1.a.5.4.6.2.6.3.2.7.4.1.1.7.3.2.8.3.2.1.1.1.4.3.1.3.2.5.4.6.1.1.b.1.1.4.1.1.3.3.2.1.2.4.3.1.2.2.1.2.3.4.6.1.1.2.1.2.2.4.3.7.4.1.1.1.d.2.2.1.3.4.9.1.1.3.3.1.6.1.3.3.1.5.1.1.1.7.6.1.1.a.3.1.4.4.3.3.2.1.1.4.3.6.3.1.3.1.1.c.1.2.1.3.1.2.5.2.1.1.4.4.2.1');
	const other = steps('1.2.5.4.1.1.1.2.1.2.1.1.3.1.1.1.2.4.1.1.1.2.4.2.3.3.3.2.3.5.3.1.1.1.6.3.1.1.3.2.3.4.1.1.1.2.4.3.3.1.1.1.1.2.3.3.1.1.1.3.1.1.3.1.4.2.3.3.2.2.2.4.5.2.1.1.1.4.2.3.2.6.2.1.3.1.2.4.4.1.1.1.5.2.2.4.2.1.1.1.3.5.1.1.1.1.1.2.2.2.1.4.2.2.1.4.1.1.1.1.1.2.3.2.1.1.2.2.2.1.1.1.1.a.3.1.1.2.1.2.1.1.1');
	const points = [...kept.map((chunk) => ({ doc: 0, chunk })), ...other.map((chunk) => ({ doc: 1, chunk }))];
	// The text a chunk holds: the section's chunk s, or text of its own.
	const textOf = (p: { doc: number; chunk: number }): string => (p.doc === 0 ? `s${p.chunk % 150}` : p.chunk < 150 ? `s${p.chunk}` : `own${p.chunk}`);
	// Rows hold the twins only (shorter than k, so never crowded with near-duplicates).
	const knn: IKnnBlock = { k: 15, offsets_row: [0], cols: [], sims: [] };
	points.forEach((p, i) => {
		points.forEach((q, j) => {
			if (j !== i && textOf(q) === textOf(p)) {
				knn.cols.push(j);
				knn.sims.push(0.999);
			}
		});
		knn.offsets_row.push(knn.cols.length);
	});
	const base = small();
	const sample: ISampleResult = {
		...base,
		n: points.length,
		n_requested: points.length,
		docs: [
			{ i: 0, objectId: 'hb', path: 'C:/hb/handbook.md', chunks: 450, in_sample: kept.length },
			{ i: 1, objectId: 'cc', path: 'C:/hb/archive/conduct_notes.md', chunks: 300, in_sample: other.length },
		],
		points: { doc: points.map((p) => p.doc), chunk: points.map((p) => p.chunk), x: points.map(() => 0), y: points.map(() => 0), len: points.map(() => 90), snip: points.map(() => 'text'), pinned: points.map(() => 0) },
		knn,
		density: points.map(() => 0.5),
	};
	const row = (objectId: string, path: string, chunks: number, ingestedAt: string): IDocumentItem => ({ objectId, path, chunks, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: null, modifyTime: null, ingestedAt, pointId: null });
	return { sample, rows: [row('hb', 'C:/hb/handbook.md', 450, '2026-01-01T00:00:00Z'), row('cc', 'C:/hb/archive/conduct_notes.md', 300, '2026-03-01T00:00:00Z')] };
}

test('a kept handbook that prints a section three times: no policy queues the document holding that section once, and the panel says it cannot tell', () => {
	const { sample, rows } = repeatedSection();
	const documents: IDocumentRowsSource = { getRows: () => rows, subscribe: () => noop };
	for (const policy of ['oldest', 'shortest-path', 'most-chunks'] as const) {
		const out = html(<DuplicatesPanel sample={modelOf(sample)} writes={on} documents={documents} onSelect={noop} onRemoveDocument={noop} onRemoveDocuments={noop} initial={{ policy }} />);
		assert.match(out, /aria-label="Keep C:\/hb\/handbook\.md" checked=""/, `${policy} keeps the handbook`);
		assert.match(out, /role="status"[^>]*>No document queued/, `${policy}: nothing queued`);
		assert.match(out, /<button[^>]*disabled=""[^>]*>Move all queued to the trash \(0 documents\)<\/button>/, `${policy}: the bulk remove is disabled`);
		assert.match(out, /300 chunks · ingested 2026-03-01 · \d+ of 143 sampled chunks match · this sample does not show that the kept document holds it, so not queued/, `${policy}: the document says why it is left`);
		assert.match(out, /This sample cannot tell yet whether these documents are whole copies of each other/, `${policy}: the group is not called copies`);
	}
});

test('another connection starts a fresh duplicates queue (its choices are keyed by the connection)', () => {
	const a = DuplicatesPanel({ sample: SMALL, writes: on, onSelect: noop, onRemoveDocument: noop, connectionKey: 'conn-a' });
	const b = DuplicatesPanel({ sample: SMALL, writes: on, onSelect: noop, onRemoveDocument: noop, connectionKey: 'conn-b' });
	assert.equal(a.key, 'conn-a');
	assert.equal(b.key, 'conn-b');
});

// =============================================================================
// THE MAP'S WIRING (the host passes the values; checked once both sides are merged)
// =============================================================================

/** The source of a src file, comments stripped. */
function source(rel: string): string {
	const fs = require('node:fs') as typeof import('node:fs');
	const path = require('node:path') as typeof import('node:path');
	return fs
		.readFileSync(path.resolve(__dirname, '..', 'src', rel), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

/** The JSX element `<Name ... />` in a source (up to its first self-closing end). */
function element(text: string, name: string): string {
	const found = new RegExp(`<${name}\\b[\\s\\S]*?\\/>`).exec(text);
	assert.ok(found, `<${name}> in the source`);
	return found[0];
}

/**
 * True while views/MapView.tsx is still the day-0 mount (its Recommend tab
 * answers "Not built yet."): the map's own lane is not merged, so its wiring
 * cannot be checked yet. Once the map is merged these checks run, and a
 * missing prop fails them.
 */
function dayZeroMap(): boolean {
	return /'Not built yet\.'/.test(source('views/MapView.tsx'));
}

const NEEDS_MAP: string | false = dayZeroMap() ? 'views/MapView.tsx is still the day-0 mount: checked once the map is merged' : false;

test('the map hands the duplicates queue its connection, the console rows and the batched, confirmed removal', { skip: NEEDS_MAP }, () => {
	const panel = element(source('views/MapView.tsx'), 'DuplicatesPanel');
	for (const prop of ['connectionKey=', 'documents=', 'onRemoveDocuments=', 'onOpenDocument=']) assert.ok(panel.includes(prop), prop);
	assert.match(panel, /onRemoveDocuments=\{[^}]*requestRemove\(/);
	assert.doesNotMatch(panel, /\.slice\(0, limits\.write_ids_max\)/, 'the queue is never cut to write_ids_max');
});

test('the map hands the outlier review its connection, writes, the confirmed removal and Show neighbours', { skip: NEEDS_MAP }, () => {
	const panel = element(source('views/MapView.tsx'), 'OutliersPanel');
	for (const prop of ['connectionKey=', 'writes=', 'onRemoveDocument=', 'onShowNeighbours=']) assert.ok(panel.includes(prop), prop);
	assert.match(panel, /onRemoveDocument=\{[^}]*requestRemove\(\[/);
});

test("the map runs Recommend on the store node and keeps the examples in the connection's cache", { skip: NEEDS_MAP }, () => {
	const view = source('views/MapView.tsx');
	assert.match(element(view, 'RecommendPanel'), /onRun=\{/);
	assert.match(view, /runRecommendCall\(|callRecommend\(/, "Recommend reaches the store's recommend tool");
	assert.match(view, /recallExamples\(recommendExamples, |recommendExamples\.get\(/, "the examples are read from the connection's cache");
	assert.match(view, /rememberExamples\(recommendExamples, |recommendExamples\.set\(/, 'and kept there');
});

test('the inspector gets the full text with its loader, its connection and the query whose words it marks, Add as example with its side, and the tree neighbours', { skip: NEEDS_MAP }, () => {
	const inspector = element(source('views/MapView.tsx'), 'PointInspector');
	for (const prop of ['connectionKey=', 'query=', 'onAddExample=', 'examplePolarity=', 'treeNeighbours=']) {
		assert.ok(inspector.includes(prop), `<PointInspector> is given ${prop}`);
		assert.doesNotMatch(inspector, new RegExp(`\\b${prop}\\{\\s*(null|undefined)\\s*\\}`), `<PointInspector> is given ${prop} a value, not a bare null or undefined`);
	}
	assert.ok(/loadText=\{[\s\S]*fetchChunkText\(/.test(inspector) || inspector.includes('onShowText='), '<PointInspector> is given loadText (fetchChunkText) or onShowText');
});

test('the matrix can show its pair on the map and hand its rows to the export', { skip: NEEDS_MAP }, () => {
	const matrix = element(source('views/MapView.tsx'), 'SimilarityMatrix');
	for (const prop of ['onShowPair=', 'onExport=']) assert.ok(matrix.includes(prop), prop);
});

test('the Points table numbers each point through the frozen groupOf of map/dedupe', { skip: NEEDS_MAP }, () => {
	const both = source('views/MapView.tsx') + source('components/PointsTable.tsx');
	assert.match(both, /duplicateGroupOf\(|groupOf\(/);
});
