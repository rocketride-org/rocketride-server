// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SAVED VIEWS: the map toolbar's Views menu
// =============================================================================
//
// A view keeps the sample's size, mode and seed, the layout, the colouring,
// the edges, the minimum cluster size, the text query, the scope's saved
// filter, the selection (at most scope_keys_max keys) and the camera: never a
// token, never a vector. Views live in memory per connection (at most 20) in
// the 'saved views' cache, which the identity change empties.
//
// Applying a view draws the sample again with its seed and scope and pins at
// most project_keys_max (200) saved keys through include_keys; the selection
// is then restored by key lookup in the new sample, at most 200 keys missing
// from it are drawn hollow through `project {keys}`, the rest are dropped,
// and the menu says how many of each.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { connectionCaches } from '../src/adapters/explorer';
import { savedViews } from '../src/adapters/connections';
import { SavedViewsMenu, SavedViewsPanel } from '../src/components/SavedViewsMenu';
import type { ISavedFilter, ISavedView, ISavedViewState, IVectorLimits, VectorKey } from '../src/contract/types';
import { DEFAULT_LIMITS } from '../src/vector/results';
import { SAVED_VIEWS_MAX, deleteView, keepSentence, listViews, planApply, resolveScope, restoreSelection, restoreSentence, saveView, viewSummary } from '../src/vector/savedViews';

const LIMITS: IVectorLimits = { ...DEFAULT_LIMITS, project_keys_max: 200, scope_keys_max: 2000, sample_max: 2000, sample_max_light: 5000 };

/** `count` distinct keys. */
function keys(count: number, prefix = 'doc'): VectorKey[] {
	return Array.from({ length: count }, (_, i) => [`${prefix}-${Math.floor(i / 10)}`, i % 10] as VectorKey);
}

/** A view state with a selection of `selected` keys. */
function state(selected = 300, extra: Partial<ISavedViewState> = {}): ISavedViewState {
	return {
		n: 1000,
		mode: 'detailed',
		seed: 7,
		layout: 'tsne',
		colourBy: 'cluster',
		edges: 'neighbours',
		edgesM: 5,
		minClusterSize: 5,
		query: 'where does Falcon Station get its water?',
		scopeFilterId: 'f-handbooks',
		selection: keys(selected),
		camera: { mode: '2d', cx: 0.5, cy: -0.25, scale: 312 },
		...extra,
	};
}

/** A fresh in-memory store (the tests that do not exercise the shared cache). */
function store(): Map<string, readonly ISavedView[]> {
	return new Map();
}

test('a view round-trips: saved under a name, listed with its state, deleted', () => {
	const s = store();
	const saved = saveView(s, 'conn-a', 'dupes', state(), LIMITS, { now: 1_760_000_000_000, id: 'v1' });
	assert.equal(saved.ok, true);
	if (!saved.ok) return;
	assert.equal(saved.replaced, false);
	assert.equal(saved.kept, 300);
	const list = listViews(s, 'conn-a');
	assert.equal(list.length, 1);
	const view = list[0]!;
	assert.deepEqual({ ...view }, { ...state(), selection: state().selection, id: 'v1', name: 'dupes', savedAt: 1_760_000_000_000 });
	assert.equal(viewSummary(view), '1,000 points · detailed · seed 7 · t-SNE · Colour by cluster · 5 neighbours · 300 selected · scoped · query');
	assert.equal(deleteView(s, 'conn-a', 'v1'), true);
	assert.deepEqual(listViews(s, 'conn-a'), []);
	assert.equal(deleteView(s, 'conn-a', 'v1'), false);
});

test('at most 20 views a connection; saving under a used name replaces that view', () => {
	const s = store();
	assert.equal(SAVED_VIEWS_MAX, 20);
	for (let i = 0; i < SAVED_VIEWS_MAX; i += 1) assert.equal(saveView(s, 'c', `v${i}`, state(1), LIMITS, { now: i, id: `id${i}` }).ok, true);
	const full = saveView(s, 'c', 'one more', state(1), LIMITS, { now: 99, id: 'x' });
	assert.deepEqual(full, { ok: false, reason: '20 views are kept per connection; delete one to save another.' });
	const again = saveView(s, 'c', ' V3 ', state(2), LIMITS, { now: 100, id: 'y' });
	assert.ok(again.ok && again.replaced, 'the same name (trimmed, any case) replaces');
	assert.equal(listViews(s, 'c').length, SAVED_VIEWS_MAX);
	assert.equal(listViews(s, 'c').find((v) => v.name === 'V3')!.selection.length, 2);
});

test('a view is validated: a name, a sample size the store allows, known modes; the selection capped at scope_keys_max', () => {
	const s = store();
	assert.deepEqual(saveView(s, 'c', '   ', state(), LIMITS, { now: 1, id: 'a' }), { ok: false, reason: 'Give the view a name.' });
	assert.deepEqual(saveView(s, 'c', 'x'.repeat(61), state(), LIMITS, { now: 1, id: 'a' }), { ok: false, reason: 'A view name is at most 60 characters.' });
	assert.equal(saveView(s, 'c', 'big', state(1, { n: 2001 }), LIMITS, { now: 1, id: 'a' }).ok, false, 'detailed samples stop at sample_max');
	assert.equal(saveView(s, 'c', 'light', state(1, { n: 5000, mode: 'light' }), LIMITS, { now: 1, id: 'b' }).ok, true);
	assert.equal(saveView(s, 'c', 'bad', state(1, { layout: 'umap' as never }), LIMITS, { now: 1, id: 'c' }).ok, false);
	assert.equal(saveView(s, 'c', 'bad', state(1, { seed: 1.5 }), LIMITS, { now: 1, id: 'c' }).ok, false);
	const many = saveView(s, 'c', 'many', state(2400), LIMITS, { now: 1, id: 'd' });
	assert.ok(many.ok);
	if (many.ok) {
		assert.equal(many.kept, 2000);
		assert.equal(many.dropped, 400);
		assert.equal(many.view.selection.length, 2000);
	}
	const odd = saveView(s, 'c', 'odd', state(1, { minClusterSize: 7 }), LIMITS, { now: 1, id: 'e' });
	assert.ok(odd.ok && odd.view.minClusterSize === 5, 'an unknown minimum size falls back to 5');
});

test('a view keeps no token and no vector, whatever the state handed to it carried', () => {
	const s = store();
	const vector = Array.from({ length: 384 }, (_, i) => Math.cos(i) / 7);
	// A stand-in for a session token, assembled so secret scanners do not mistake the test for a leak.
	const token = ['fake', 'session', 'marker', '7'].join('-');
	const leaky = { ...state(3), token, queryVector: vector, camera: { mode: '2d', cx: 1, cy: 2, scale: 3, matrix: vector, auth: token }, selection: [...keys(2), ['o', 0.5], [7, 1], 'nope'] } as unknown as ISavedViewState;
	const saved = saveView(s, 'c', 'leaky', leaky, LIMITS, { now: 1, id: 'a' });
	assert.ok(saved.ok);
	if (!saved.ok) return;
	const text = JSON.stringify(saved.view);
	assert.ok(!text.includes(token), 'no token');
	assert.doesNotMatch(text, /(-?\d+\.\d+,){7,}/, 'no run of 8 decimals');
	assert.deepEqual(Object.keys(saved.view).sort(), ['camera', 'colourBy', 'edges', 'edgesM', 'id', 'layout', 'minClusterSize', 'mode', 'n', 'name', 'query', 'savedAt', 'scopeFilterId', 'seed', 'selection'].sort());
	assert.deepEqual(saved.view.camera, { mode: '2d', cx: 1, cy: 2, scale: 3 });
	assert.deepEqual(saved.view.selection, keys(2), 'only well-formed keys');
	const orbit = saveView(s, 'c', 'orbit', state(1, { camera: { mode: '3d', target: [1, 2, 3], yaw: 0.1, pitch: 0.2, distance: 4, fov: 0.8 } }), LIMITS, { now: 1, id: 'b' });
	assert.ok(orbit.ok && JSON.stringify(orbit.view.camera) === JSON.stringify({ mode: '3d', target: [1, 2, 3], yaw: 0.1, pitch: 0.2, distance: 4, fov: 0.8 }), 'the 3D camera is kept');
});

test('views are per connection, survive switching connections and are emptied through the cache registry on sign-out', () => {
	savedViews.clear();
	assert.ok(connectionCaches.names().includes('saved views'));
	assert.ok(saveView(savedViews, 'conn-a', 'dupes', state(300), LIMITS, { now: 1, id: 'a1' }).ok);
	assert.ok(saveView(savedViews, 'conn-b', 'other', state(1), LIMITS, { now: 2, id: 'b1' }).ok);
	assert.deepEqual(
		listViews(savedViews, 'conn-a').map((v) => v.name),
		['dupes']
	);
	assert.deepEqual(
		listViews(savedViews, 'conn-b').map((v) => v.name),
		['other']
	);
	assert.deepEqual(
		listViews(savedViews, 'conn-a').map((v) => v.name),
		['dupes'],
		'switching back lists it again'
	);
	connectionCaches.clearAll();
	assert.equal(savedViews.size, 0);
	assert.deepEqual(listViews(savedViews, 'conn-a'), []);
});

test('applying re-samples with the saved size, mode, seed and scope, pinning at most project_keys_max saved keys', () => {
	const s = store();
	const saved = saveView(s, 'c', 'big lasso', state(1900), LIMITS, { now: 1, id: 'a' });
	assert.ok(saved.ok);
	if (!saved.ok) return;
	const plan = planApply(saved.view, LIMITS);
	assert.deepEqual([plan.n, plan.mode, plan.seed, plan.scopeFilterId, plan.layout, plan.colourBy, plan.edges, plan.edgesM, plan.minClusterSize], [1000, 'detailed', 7, 'f-handbooks', 'tsne', 'cluster', 'neighbours', 5, 5]);
	assert.equal(plan.includeKeys.length, 200, 'include_keys never exceeds project_keys_max');
	assert.deepEqual(plan.includeKeys, keys(1900).slice(0, 200));
	assert.equal(plan.query, 'where does Falcon Station get its water?', 'handed back, run again only on request');
	assert.equal(planApply(saved.view, { ...LIMITS, project_keys_max: 50 }).includeKeys.length, 50);
	const smaller = planApply({ ...saved.view, n: 1800 }, { ...LIMITS, sample_max: 1500 });
	assert.equal(smaller.n, 1500, 'a store that now allows fewer points gets its maximum');
	const filters: ISavedFilter[] = [{ id: 'f-handbooks', name: 'handbooks', filter: { path_prefix: 'C:/demo/handbooks/' }, savedAt: 1 }];
	assert.deepEqual(resolveScope(saved.view, filters), { filter: filters[0], missing: false });
	assert.deepEqual(resolveScope(saved.view, []), { filter: null, missing: true });
	assert.deepEqual(resolveScope({ ...saved.view, scopeFilterId: null }, []), { filter: null, missing: false });
});

test('the selection is restored by key lookup; at most 200 missing keys are drawn hollow and the rest dropped, with the counts said', () => {
	const saved = keys(1900);
	const index = new Map<string, number>();
	// The new sample holds the first 200 (pinned through include_keys) and 1,140 others.
	saved.forEach((k, i) => {
		if (i < 200 || (i >= 560 && i < 1700)) index.set(`${k[0]}#${k[1]}`, i + 10);
	});
	const restored = restoreSelection(saved, index, LIMITS);
	assert.deepEqual(restored.counts, { selected: 1900, restored: 1340, hollow: 200, dropped: 360 });
	assert.equal(restored.indices.length, 1340);
	assert.equal(restored.indices[0], 10);
	assert.deepEqual(restored.hollow, saved.slice(200, 400), 'the first missing keys, in saved order');
	assert.equal(restored.hollow.length, LIMITS.project_keys_max);
	assert.equal(restoreSentence(restored.counts), '1,340 of 1,900 selected points restored; 200 drawn hollow; 360 dropped');
	assert.equal(restoreSentence({ selected: 300, restored: 300, hollow: 0, dropped: 0 }), '300 of 300 selected points restored');
	assert.equal(restoreSentence({ selected: 0, restored: 0, hollow: 0, dropped: 0 }), 'The view had no selection');
	assert.equal(keepSentence(LIMITS), 'Selections of up to 2,000 points are kept; up to 200 points not in the new sample are drawn hollow, the rest are dropped.');
	const repeat = restoreSelection([...saved.slice(0, 3), saved[0]!], index, LIMITS);
	assert.equal(repeat.counts.selected, 3, 'a repeated key counts once');
});

test('the menu: a built component with its button; the open panel lists views, saves and says why it cannot', () => {
	const html = renderToStaticMarkup(React.createElement(SavedViewsMenu, { connectionKey: 'menu-1', limits: LIMITS, current: () => null, onApply: async () => null }));
	assert.match(html, /data-component="SavedViewsMenu"/);
	assert.doesNotMatch(html, /data-placeholder|Not built yet/);
	assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>Views/);
	const s = store();
	saveView(s, 'c', 'dupes', state(300), LIMITS, { now: Date.UTC(2026, 9, 15, 9, 5), id: 'v1' });
	const base = { id: 'p', limits: LIMITS, views: listViews(s, 'c'), name: '', busyId: null, status: null, saveDisabled: null, onName: (): void => undefined, onSave: (): void => undefined, onApply: (): void => undefined, onDelete: (): void => undefined };
	const open = renderToStaticMarkup(React.createElement(SavedViewsPanel, base));
	assert.match(open, /data-view-id="v1"[\s\S]*dupes[\s\S]*300 selected/);
	assert.match(open, /<button[^>]*aria-label="Apply view dupes"/);
	assert.match(open, /<button[^>]*aria-label="Delete view dupes"/);
	assert.match(open, /Selections of up to 2,000 points are kept; up to 200 points not in the new sample are drawn hollow, the rest are dropped\./);
	assert.match(open, /<input[^>]*aria-label="View name"[^>]*maxLength="60"|<input[^>]*maxLength="60"[^>]*aria-label="View name"/);
	const none = renderToStaticMarkup(React.createElement(SavedViewsPanel, { ...base, views: [] }));
	assert.match(none, /No saved views yet\./);
	const full = renderToStaticMarkup(React.createElement(SavedViewsPanel, { ...base, saveDisabled: '20 views are kept per connection; delete one to save another.' }));
	assert.match(full, /<button[^>]*disabled=""[^>]*>Save</);
	assert.match(full, /20 views are kept per connection; delete one to save another\./);
	const busy = renderToStaticMarkup(React.createElement(SavedViewsPanel, { ...base, busyId: 'v1', status: 'Applying dupes…' }));
	assert.match(busy, /role="status"[^>]*>Applying dupes…/);
	assert.match(busy, /<button[^>]*disabled=""[^>]*aria-label="Apply view dupes"|<button[^>]*aria-label="Apply view dupes"[^>]*disabled=""/);
});
