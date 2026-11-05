// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LAYOUT CORE: the seeded neighbour-graph force layout the worker runs
// =============================================================================
//
// The last tests pin the console's own layout (src/vector/layout.ts): the
// Search surface opens inside the chat panel, so the console's ratios stay.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORCE_TICKS, LAYOUT_UNIT, createForceJob, neighbourLinks, normaliseInit, runJob, seededRandom } from '../src/map/layout.core';
import type { IForceLayoutInput, ILayoutClock } from '../src/map/layout.core';
import { knnFromRows, loadSample, pcaXY } from './support/map.samples';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONSOLE_LAYOUT, consoleColumns } from '../src/vector/layout';

const native = loadSample('sample_native_knn.json');

/** The force input of a sample (PCA start, its kNN graph). */
function inputOf(sample = native, extra: Partial<IForceLayoutInput> = {}): IForceLayoutInput {
	return { n: sample.n, init: pcaXY(sample), knn: sample.knn, seed: 7, ...extra };
}

/** A clock that advances `stepMs` on every reading. */
function steppingClock(stepMs: number): ILayoutClock {
	let t = 0;
	return { now: () => (t += stepMs) };
}

const forever = 3_600_000;

test('same input and seed give byte-identical positions', () => {
	const a = runJob(createForceJob(inputOf()), forever);
	const b = runJob(createForceJob(inputOf()), forever);
	assert.equal(a.positions.length, native.n * 2);
	assert.deepEqual(Array.from(a.positions), Array.from(b.positions));
});

test('the layout moves the points away from the PCA start (it is not a copy of PCA)', () => {
	const run = runJob(createForceJob(inputOf()), forever);
	const start = normaliseInit(pcaXY(native), native.n);
	let moved = 0;
	for (let i = 0; i < native.n * 2; i += 1) moved += Math.abs((run.positions[i] as number) - (start[i] as number));
	assert.ok(moved / native.n > 0.5 * LAYOUT_UNIT, `mean movement ${moved / native.n}`);
});

test('it runs exactly the requested ticks when the budget allows, and every position is finite', () => {
	const job = createForceJob(inputOf(native, { ticks: 60 }));
	assert.equal(job.total, 60);
	const run = runJob(job, forever, undefined, 25);
	assert.equal(run.ticks, 60);
	assert.equal(job.done, true);
	assert.equal(run.timedOut, false);
	assert.equal(run.cancelled, false);
	assert.ok(run.positions.every((v) => Number.isFinite(v)));
	assert.equal(createForceJob(inputOf()).total, FORCE_TICKS);
});

test('the budget stops it with the positions so far (timedOut), never an exception', () => {
	const run = runJob(createForceJob(inputOf()), 2_500, steppingClock(1_000), 10);
	assert.equal(run.timedOut, true);
	assert.ok(run.ticks > 0 && run.ticks < FORCE_TICKS, `ticks ${run.ticks}`);
	assert.ok(run.positions.every((v) => Number.isFinite(v)));
});

test('Cancel stops it between steps', () => {
	let asked = 0;
	const run = runJob(createForceJob(inputOf()), forever, undefined, 10, () => (asked += 1) > 2);
	assert.equal(run.cancelled, true);
	assert.equal(run.ticks, 20);
});

test('the input is never mutated (the fixture is frozen; d3 mutates only its own copies)', () => {
	const init = pcaXY(native);
	const before = Array.from(init);
	runJob(createForceJob({ n: native.n, init, knn: native.knn, seed: 3 }), forever);
	assert.deepEqual(Array.from(init), before);
});

test('links are undirected and deduplicated; self, out-of-range and hidden ends are dropped; weights are 0..1 per row', () => {
	const knn = knnFromRows([[1, 2, 0], [0, 2], [0, 9], [1]]);
	const links = neighbourLinks(knn, 4, new Uint8Array([0, 0, 0, 1]));
	const pairs = links.map((l) => `${l.source}-${l.target}`).sort();
	assert.deepEqual(pairs, ['0-1', '0-2', '1-2']);
	for (const l of links) assert.ok(l.w >= 0 && l.w <= 1, `w ${l.w}`);
	// Row 0's best neighbour (1) gets the top weight of its row.
	assert.equal(links.find((l) => l.source === 0 && l.target === 1)?.w, 1);
});

test('the PCA start is scaled to a radius that grows with sqrt(n); a degenerate start becomes a deterministic spiral', () => {
	const scaled = normaliseInit(new Float32Array([0, 0, 2, 0, 0, -4, 1, 1]), 4);
	let max = 0;
	for (const v of scaled) max = Math.max(max, Math.abs(v));
	assert.ok(Math.abs(max - LAYOUT_UNIT * 2) < 1e-9, `max ${max}`);
	const flat = normaliseInit(new Float32Array(8), 4);
	assert.ok(new Set(Array.from(flat).map((v) => v.toFixed(6))).size > 1, 'points are spread');
	assert.deepEqual(Array.from(flat), Array.from(normaliseInit(new Float32Array(8), 4)));
});

test('the seeded random source is deterministic and uniform in [0, 1)', () => {
	const a = seededRandom(42);
	const b = seededRandom(42);
	const draws = Array.from({ length: 1000 }, () => a());
	assert.deepEqual(
		draws.slice(0, 5),
		Array.from({ length: 5 }, () => b())
	);
	assert.ok(draws.every((v) => v >= 0 && v < 1));
	const mean = draws.reduce((s, v) => s + v, 0) / draws.length;
	assert.ok(Math.abs(mean - 0.5) < 0.05);
});

test('empty and single-point samples lay out without error', () => {
	assert.equal(runJob(createForceJob({ n: 0, init: new Float32Array(0), knn: { offsets_row: [0], cols: [], sims: [] }, seed: 1 }), forever).positions.length, 0);
	const one = runJob(createForceJob({ n: 1, init: new Float32Array([0.3, 0.1]), knn: { offsets_row: [0, 0], cols: [], sims: [] }, seed: 1 }), forever);
	assert.equal(one.positions.length, 2);
	assert.ok(one.positions.every((v) => Number.isFinite(v)));
});

// ── The console's layout: Search lives inside the chat's 55 % ──────────────

test("the console's panel ratios are unchanged: documents 38 %, right column 62 % split 45 % ingest / 55 % chat", () => {
	assert.deepEqual({ ...CONSOLE_LAYOUT }, { left: 0.38, right: 0.62, ingest: 0.45, chat: 0.55, stackBelowPx: 900 });
	assert.deepEqual(consoleColumns(1440), { stacked: false, left: '38%', right: '62%', ingest: '45%', chat: '55%' });
	assert.equal(consoleColumns(800).stacked, true);
});

test('the Search toggle swaps what the chat panel shows, not the console layout: neither panel sizes itself', () => {
	const src = (relative: string): string => readFileSync(path.join(__dirname, '..', 'src', 'components', relative), 'utf8');
	for (const file of ['ChatPanel.tsx', 'SearchPanel.tsx', 'QueryCompare.tsx']) {
		const text = src(file);
		assert.doesNotMatch(text, /vector\/layout|CONSOLE_LAYOUT|consoleColumns/, `${file} reads the console layout`);
		assert.doesNotMatch(text, /\b(width|minWidth|maxWidth|flexBasis)\s*:\s*['"]?(?!100%)\d+(\.\d+)?(%|vw)/, `${file} sets its own share of the console`);
	}
	// The search body sits in the chat panel's own flex column, in the space the thread uses.
	assert.match(src('ChatPanel.tsx'), /<div hidden=\{!searching\} data-surface="search" style=\{S\.surface\}>/);
});
