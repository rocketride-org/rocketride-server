// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CAPABILITY HONESTY: what the app says follows what the node reported. A score
// with no range or direction is a number and nothing more; a metric the app does
// not know is shown as the node spelled it and claims no similarity; an empty
// collection stops being empty once fresh stats say so; a count the store marks
// inexact is not presented as exact; the map and its table agree on the points;
// a dialog that closes returns the focus where the person was.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PointCanvas } from '../src/components/PointCanvas';
import { PointsTable } from '../src/components/PointsTable';
import { createSelectionStore } from '../src/contract/bridge';
import type { IScoreInfo } from '../src/contract/types';
import { hiddenMask } from '../src/map/model';
import { documentFocus, firstFocusable, focusAdrift, focusLost } from '../src/vector/focus';
import type { IFocusCandidate } from '../src/vector/focus';
import { directoryHeading, pagerApplyPage, pagerBegin, pagerInit } from '../src/vector/documents';
import { overviewCards } from '../src/vector/overview';
import { readDialect, readDocumentsPage, readStats } from '../src/vector/results';
import { scoreBar, scoreHeading, sliderRange } from '../src/vector/searchWorkbench';
import { collectionMissing, statsFigures } from '../src/vector/stats';
import { fixture } from './support/fixtures';
import { loadSample, modelOf, pcaXY } from './support/map.samples';

const noop = (): void => undefined;

/** The dialect fixture with some of its fields replaced. */
function dialectWith(over: Record<string, unknown>) {
	const read = readDialect({ ...(fixture('dialect_pgvector') as Record<string, unknown>), ...over });
	assert.ok(read, 'the dialect reads');
	return read;
}

test('a score with no range and no direction is a number and nothing more: no bar, the 0-1 slider, a plain heading', () => {
	const none: IScoreInfo | null = null;
	assert.equal(scoreBar(none, 0.7), null, 'no range, no bar');
	assert.deepEqual(sliderRange(none), { min: 0, max: 1, step: 0.01 });
	const noRange = { formula: 'raw', range: null, higher_is_better: true, floor: 0.2, threshold: 0.5 } as unknown as IScoreInfo;
	assert.equal(scoreBar(noRange, 0.7), null, 'a store with no range shows the number alone');
	assert.ok(scoreHeading(noRange, []), 'the heading still says what the column is');
});

test('a score the store says is lower-is-closer is drawn inverted, within its range only', () => {
	const inverted = { formula: 'l2 distance', range: [0, 2], higher_is_better: false, floor: 0, threshold: 1 } as unknown as IScoreInfo;
	assert.equal(scoreBar(inverted, 0), 1, 'distance 0 is the closest');
	assert.equal(scoreBar(inverted, 2), 0);
	assert.equal(scoreBar(inverted, 5), 0, 'clamped, never past the ends');
	assert.equal(scoreBar(inverted, Number.NaN), null);
});

test('a metric the app does not know is not guessed (the dialect reads it as none); no metric means no figure and no claim', () => {
	const weird = dialectWith({ metric: 'hamming-ish' });
	assert.equal(weird.metric, null, 'an unknown metric is not one of the three the app understands');
	const cards = overviewCards(null, weird);
	const index = cards.find((c) => c.key === 'index');
	assert.match(index?.value ?? '', /^384-d · — · HNSW$/, `the metric slot says nothing rather than something else: ${index?.value}`);
	assert.doesNotMatch(index?.value ?? '', /cosine|l2|ip|similarity/i, 'the app puts no meaning in its place');
	const known = overviewCards(null, dialectWith({ metric: 'cosine' })).find((c) => c.key === 'index');
	assert.match(known?.value ?? '', /cosine/, 'a metric it knows is shown');
	const bare = dialectWith({ metric: null, dimension: null, index: null });
	const bareCards = overviewCards(null, bare);
	const bareIndex = bareCards.find((c) => c.key === 'index');
	assert.equal(bareIndex?.missing, true, 'nothing reported: the card says so');
	assert.match(bareIndex?.tooltip ?? '', /does not report|Not read yet/);
	assert.ok(statsFigures(null, bare).some((f) => f.key === 'metric' && f.missing), 'the strip marks the missing metric');
});

test('an empty collection stops being empty once fresh stats say it exists (an upload just landed)', () => {
	const empty = dialectWith({ health: { collection_exists: false, control_record: null, model_mismatch: null, meta_column: null } });
	assert.equal(collectionMissing(empty, null), true, 'found empty at discovery');
	const populated = readStats({ ...(fixture('stats_pgvector') as Record<string, unknown>), collection_exists: true });
	assert.equal(collectionMissing(empty, populated), false, 'fresh stats win over the dialect read at discovery');
	const gone = readStats(fixture('stats_collection_missing_legacy') as Record<string, unknown>);
	assert.equal(collectionMissing(dialectWith({}), gone), true, 'and fresh stats that say missing win too');
	const cards = overviewCards(populated, empty);
	assert.equal(cards.find((c) => c.key === 'documents')?.missing, false, 'the documents figure comes from the stats, not the stale dialect');
});

test('a total the store marks inexact is "about", never presented as the count of what is stored', () => {
	const page = readDocumentsPage({ ...(fixture('list_documents_page1') as Record<string, unknown>), total: 1200, counts_exact: false });
	const state = pagerApplyPage(pagerBegin(pagerInit()), page);
	assert.match(directoryHeading(state), /^about 1,200 documents$/);
	const exact = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage({ ...(fixture('list_documents_page1') as Record<string, unknown>), total: 1200, counts_exact: true }));
	assert.equal(directoryHeading(exact), '1,200 documents');
	const unknown = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage({ ...(fixture('list_documents_page1') as Record<string, unknown>), total: null }));
	assert.doesNotMatch(directoryHeading(unknown), /about/, 'no total: what is loaded, said as loaded');
});

test('the map and its table alternative agree on how many points there are, with and without hidden ones', () => {
	const result = loadSample('sample_demo_1000.json');
	const sample = modelOf(result);
	const canvas = (hidden?: Uint8Array): string => {
		const props: React.ComponentProps<typeof PointCanvas> = { sample, positions: pcaXY(result), dimensions: 2, colours: Array.from({ length: result.n }, () => '#888888'), selection: createSelectionStore(), lasso: false, onHover: noop, onPick: noop, onLasso: noop, ...(hidden ? { hidden } : {}) };
		return renderToStaticMarkup(<PointCanvas {...props} />);
	};
	const table = (hidden?: Uint8Array): string => renderToStaticMarkup(<PointsTable sample={sample} querySims={null} selected={null} onSelect={noop} {...(hidden ? { hidden } : {})} />);
	const drawn = (markup: string): number => Number(/data-points="(\d+)"/.exec(markup)?.[1]);
	const listed = (markup: string): number => Number((/Rows [\d,]+–[\d,]+ of ([\d,]+)/.exec(markup)?.[1] ?? '').replace(/,/g, ''));
	assert.equal(listed(table()), drawn(canvas()), 'every point drawn is a row');
	const hidden = new Uint8Array(result.n);
	hidden[3] = hidden[10] = hidden[999] = 1;
	assert.equal(listed(table(hidden)), drawn(canvas(hidden)), 'a removed document leaves the map and the table together');
	assert.equal(listed(table(hidden)), result.n - 3);
	assert.equal(hiddenMask(sample) === null || hiddenMask(sample)!.every((v) => v === 0), true, 'nothing is hidden by the sample itself');
});

/** An element-like object for the focus rules. */
function element(over: Partial<IFocusCandidate> & { name?: string } = {}): IFocusCandidate & { name: string; focused: number } {
	const node = { name: over.name ?? 'el', isConnected: true, offsetParent: {}, disabled: false, focused: 0, focus() { node.focused += 1; }, ...over };
	return node;
}

test('focus after a dialog closes: back to the opener while it is shown, else the next shown control, never the page body', () => {
	const opener = element({ name: 'opener' });
	const tabs = element({ name: 'tab' });
	const first = element({ name: 'first' });
	const root = { querySelector: (selector: string) => (selector.includes('data-document-tabs') ? tabs : null), querySelectorAll: () => [first] };
	assert.equal(documentFocus(root, opener), opener, 'the opener, while it is still shown');
	assert.equal(documentFocus(root, element({ name: 'gone', isConnected: false })), tabs, 'the opener left the page: the document\'s own tabs');
	assert.equal(documentFocus(root, element({ name: 'hidden', offsetParent: null })), tabs, 'hidden counts as gone');
	assert.equal(documentFocus(root, element({ name: 'off', disabled: true })), tabs, 'a disabled opener cannot take it');
	assert.equal(documentFocus({ querySelector: () => null, querySelectorAll: () => [first] }, null), first, 'else the first control');
	assert.equal(documentFocus(null, null), null, 'no surface, no opener: nothing to give it to');
	// When is the focus lost at all: nothing has it, the body has it, or it is inside the region that went away.
	const body = {};
	const inside = {};
	const region = { contains: (node: unknown) => node === inside };
	assert.equal(focusLost(null, body, region), true);
	assert.equal(focusLost(body, body, region), true);
	assert.equal(focusLost(inside, body, region), true);
	assert.equal(focusLost({}, body, region), false, 'focus elsewhere is left alone');
	assert.equal(focusAdrift(element({ isConnected: false }), body), true);
	assert.equal(firstFocusable([null, element({ offsetParent: null }), element({ name: 'ok' })])?.name, 'ok');
});
