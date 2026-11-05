// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LAYOUT WORKER: the serving loop, the main-thread client and how it is started
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createLayoutServer } from '../src/map/layout.server';
import { LAYOUT_REQUEST_KEYS, budgetFor, toLayoutRequest } from '../src/map/protocol';
import type { ILayoutRequest, ILayoutResult, LayoutWorkerOut } from '../src/map/protocol';
import { FORCE_BUDGET_MS } from '../src/map/layout.core';
import { TSNE_BUDGET_MS } from '../src/map/tsne.core';
import { createLayoutClient } from '../src/map/workerClient';
import type { ILayoutTimers, ILayoutWorkerLike } from '../src/map/workerClient';
import { LayoutUnavailableError, chooseWorkerStrategy, devShimSource } from '../src/map/workerStrategy';
import { loadSample } from './support/map.samples';

const SRC = path.resolve(__dirname, '..', 'src', 'map');
const native = loadSample('sample_native_knn.json');
const demo = loadSample('sample_demo_1000.json');
const light = loadSample('sample_light_5000.json');

// -----------------------------------------------------------------------------
// Request building
// -----------------------------------------------------------------------------

test('a layout request carries the PCA start and the kNN graph as typed arrays, and nothing else of the sample', () => {
	const request = toLayoutRequest(native, { requestId: 3, algorithm: 'force', seed: 9, hidden: null });
	assert.deepEqual(Object.keys(request).sort(), [...LAYOUT_REQUEST_KEYS].sort());
	assert.equal(request.n, native.n);
	assert.ok(request.init instanceof Float32Array && request.init.length === native.n * 2);
	assert.equal(request.init[2], Math.fround(native.points.x[1] as number));
	assert.equal(request.init[3], Math.fround(native.points.y[1] as number));
	assert.ok(request.offsets instanceof Int32Array && request.cols instanceof Int32Array && request.sims instanceof Float32Array);
	assert.equal(request.qualityK, 15);
	assert.equal(request.budgetMs, FORCE_BUDGET_MS);
	assert.equal(budgetFor('tsne'), TSNE_BUDGET_MS);
	assert.equal(toLayoutRequest(light, { requestId: 1, algorithm: 'force', seed: 1, hidden: null }).qualityK, 10);
});

// -----------------------------------------------------------------------------
// Serving loop (what layout.worker.ts runs)
// -----------------------------------------------------------------------------

/** A server whose posts are recorded and whose yields are real (so messages interleave). */
function server(now: () => number = () => performance.now()) {
	const posted: LayoutWorkerOut[] = [];
	const srv = createLayoutServer({ post: (m) => posted.push(m), now, yieldToQueue: () => new Promise((r) => setImmediate(r)) });
	return { srv, posted };
}

test('a force request posts progress, then one result with both overlaps (the layout beating PCA)', async () => {
	const { srv, posted } = server();
	srv.receive(toLayoutRequest(native, { requestId: 1, algorithm: 'force', seed: 7, hidden: null }));
	await srv.idle();
	const results = posted.filter((m): m is ILayoutResult => m.type === 'result');
	assert.equal(results.length, 1);
	const result = results[0] as ILayoutResult;
	assert.equal(result.requestId, 1);
	assert.equal(result.positions.length, native.n * 2);
	assert.equal(result.ticks, 300);
	assert.equal(result.timedOut, false);
	assert.ok(result.overlap > result.pcaOverlap + 0.1, `${result.overlap} vs ${result.pcaOverlap}`);
	assert.ok(posted.some((m) => m.type === 'progress' && m.requestId === 1));
});

test('t-SNE above 1,000 points answers a refusal sentence, not a result', async () => {
	const { srv, posted } = server();
	srv.receive(toLayoutRequest(light, { requestId: 2, algorithm: 'tsne', seed: 1, hidden: null }));
	await srv.idle();
	assert.equal(posted.length, 1);
	const error = posted[0] as Extract<LayoutWorkerOut, { type: 'error' }>;
	assert.equal(error.type, 'error');
	assert.equal(error.tooLarge, true);
	assert.match(error.message, /^t-SNE is limited to 1,000 points; this sample has 5,000\./);
});

test('a newer request supersedes the running one silently; a cancel stops it without an answer', async () => {
	const { srv, posted } = server();
	srv.receive(toLayoutRequest(demo, { requestId: 1, algorithm: 'force', seed: 7, hidden: null }));
	srv.receive(toLayoutRequest(native, { requestId: 2, algorithm: 'tsne', seed: 7, hidden: null }));
	await srv.idle();
	assert.deepEqual(posted.filter((m) => m.type !== 'progress').map((m) => m.requestId), [2]);
	posted.length = 0;
	srv.receive(toLayoutRequest(demo, { requestId: 3, algorithm: 'force', seed: 7, hidden: null }));
	srv.receive({ type: 'cancel', requestId: 3 });
	await srv.idle();
	assert.equal(posted.filter((m) => m.type !== 'progress').length, 0);
});

test('the budget ends a run with the positions so far, flagged timedOut, still measured', async () => {
	let t = 0;
	const { srv, posted } = server(() => (t += 2_000));
	srv.receive(toLayoutRequest(native, { requestId: 5, algorithm: 'force', seed: 7, hidden: null }));
	await srv.idle();
	const result = posted.find((m): m is ILayoutResult => m.type === 'result') as ILayoutResult;
	assert.equal(result.timedOut, true);
	assert.ok(result.ticks < 300);
	assert.ok(Number.isFinite(result.overlap) && Number.isFinite(result.pcaOverlap));
});

test('past its budget a large sample stops within a couple of ticks, and only one overlap is left to measure (the watchdog grace is not eaten)', async () => {
	// The clock reads 0 for the start and the first budget check, then the whole budget is gone.
	let calls = 0;
	const { srv, posted } = server(() => (calls++ < 2 ? 0 : FORCE_BUDGET_MS));
	srv.receive(toLayoutRequest(light, { requestId: 6, algorithm: 'force', seed: 7, hidden: null }));
	await srv.idle();
	const result = posted.find((m): m is ILayoutResult => m.type === 'result') as ILayoutResult;
	assert.equal(result.timedOut, true);
	assert.ok(result.ticks >= 1 && result.ticks <= 2, `${result.ticks} ticks ran past the budget check at 5,000 points (at most 2)`);
	// The PCA overlap does not depend on the run, so it is measured before the loop, not after the budget.
	const text = fs.readFileSync(path.join(SRC, 'layout.server.ts'), 'utf8');
	assert.ok(text.indexOf('const pcaOverlap = knnOverlap(') < text.indexOf('while (!job.done)'), 'PCA overlap first');
});

test('the worker entry wires the server to the worker scope and imports nothing of the app', () => {
	const entry = fs.readFileSync(path.join(SRC, 'layout.worker.ts'), 'utf8');
	const imports = [...entry.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
	assert.deepEqual(imports.sort(), ['./layout.server', './protocol'].sort());
	const code = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	assert.doesNotMatch(code, /react|'shell'|shared\//);
});

// -----------------------------------------------------------------------------
// Client (main thread)
// -----------------------------------------------------------------------------

/** A worker the test answers by hand. */
class FakeWorker implements ILayoutWorkerLike {
	onmessage: ((event: { data: LayoutWorkerOut }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	posted: Array<ILayoutRequest | { type: 'cancel'; requestId: number }> = [];
	terminated = 0;
	postMessage(message: ILayoutRequest | { type: 'cancel'; requestId: number }): void {
		this.posted.push(message);
	}
	terminate(): void {
		this.terminated += 1;
	}
	answer(data: LayoutWorkerOut): void {
		this.onmessage?.({ data });
	}
	lastRequest(): ILayoutRequest {
		return this.posted.filter((m): m is ILayoutRequest => m.type === 'layout').at(-1) as ILayoutRequest;
	}
	resultFor(request: ILayoutRequest, extra: Partial<ILayoutResult> = {}): ILayoutResult {
		return { type: 'result', requestId: request.requestId, algorithm: request.algorithm, positions: new Float32Array(request.n * 2).fill(1), ticks: 300, total: 300, elapsedMs: 10, timedOut: false, overlap: 0.5, pcaOverlap: 0.2, ...extra };
	}
}

/** Timers fired by hand. */
class ManualTimers implements ILayoutTimers {
	pending = new Map<number, () => void>();
	private next = 1;
	set(callback: () => void): unknown {
		const id = this.next++;
		this.pending.set(id, callback);
		return id;
	}
	clear(handle: unknown): void {
		this.pending.delete(handle as number);
	}
	fireAll(): void {
		for (const [id, cb] of [...this.pending]) {
			this.pending.delete(id);
			cb();
		}
	}
}

function setup(createWorker?: () => ILayoutWorkerLike) {
	const workers: FakeWorker[] = [];
	const timers = new ManualTimers();
	const client = createLayoutClient({
		createWorker:
			createWorker ??
			(() => {
				const w = new FakeWorker();
				workers.push(w);
				return w;
			}),
		timers,
	});
	return { client, workers, timers };
}

const spec = (sample = native, algorithm: 'force' | 'tsne' = 'force') => ({ sample, algorithm, seed: 7, hidden: null });

test('a good answer resolves done and reports progress on the way', async () => {
	const { client, workers } = setup();
	const progress: Array<[number, number]> = [];
	const pending = client.run(spec(), (ticks, total) => progress.push([ticks, total]));
	const worker = workers[0] as FakeWorker;
	const request = worker.lastRequest();
	worker.answer({ type: 'progress', requestId: request.requestId, ticks: 100, total: 300 });
	worker.answer(worker.resultFor(request));
	const outcome = await pending;
	assert.equal(outcome.kind, 'done');
	assert.deepEqual(progress, [[100, 300]]);
	assert.equal(client.busy, false);
});

test('only the current request is answered; a second run supersedes the first', async () => {
	const { client, workers } = setup();
	const first = client.run(spec());
	const worker = workers[0] as FakeWorker;
	const r1 = worker.lastRequest();
	const second = client.run(spec(native, 'tsne'));
	assert.deepEqual((await first).kind, 'superseded');
	const r2 = worker.lastRequest();
	assert.notEqual(r1.requestId, r2.requestId);
	worker.answer(worker.resultFor(r1));
	assert.equal(client.busy, true, 'the stale answer is ignored');
	worker.answer(worker.resultFor(r2));
	assert.equal((await second).kind, 'done');
	assert.equal(workers.length, 1, 'the same worker serves both');
});

test('Cancel terminates the worker at once (a busy worker only yields between steps) and the next run starts a new one', async () => {
	const { client, workers } = setup();
	const pending = client.run(spec(demo));
	client.cancel();
	assert.equal((await pending).kind, 'cancelled');
	assert.equal((workers[0] as FakeWorker).terminated, 1);
	const next = client.run(spec());
	assert.equal(workers.length, 2);
	const w2 = workers[1] as FakeWorker;
	w2.answer(w2.resultFor(w2.lastRequest()));
	assert.equal((await next).kind, 'done');
});

test('the watchdog gives up on a silent worker after its budget: failed, terminated', async () => {
	const { client, workers, timers } = setup();
	const pending = client.run(spec());
	timers.fireAll();
	const outcome = await pending;
	assert.equal(outcome.kind, 'failed');
	assert.match((outcome as { message: string }).message, /did not finish/);
	assert.equal((workers[0] as FakeWorker).terminated, 1);
});

test('a worker that cannot be started makes every run unavailable, with the reason', async () => {
	let attempts = 0;
	const { client } = setup(() => {
		attempts += 1;
		throw new LayoutUnavailableError('This browser does not support Web Workers.');
	});
	const a = await client.run(spec());
	const b = await client.run(spec());
	assert.deepEqual([a.kind, b.kind], ['unavailable', 'unavailable']);
	assert.equal((a as { message: string }).message, 'This browser does not support Web Workers.');
	assert.equal(attempts, 1);
});

test('a worker error mid-run fails the run and the next run gets a new worker', async () => {
	const { client, workers } = setup();
	const pending = client.run(spec());
	(workers[0] as FakeWorker).onerror?.({ message: 'boom' });
	assert.equal((await pending).kind, 'failed');
	const next = client.run(spec());
	assert.equal(workers.length, 2);
	const w2 = workers[1] as FakeWorker;
	w2.answer(w2.resultFor(w2.lastRequest()));
	assert.equal((await next).kind, 'done');
});

test('a refusal answer becomes refused; a malformed result becomes failed', async () => {
	const { client, workers } = setup();
	const pending = client.run(spec(light, 'tsne'));
	const worker = workers[0] as FakeWorker;
	worker.answer({ type: 'error', requestId: worker.lastRequest().requestId, message: 't-SNE is limited to 1,000 points; this sample has 5,000.', tooLarge: true });
	assert.equal((await pending).kind, 'refused');
	for (const bad of [new Float32Array(3), new Float32Array(native.n * 2).fill(Number.NaN)]) {
		const run = client.run(spec());
		worker.answer(worker.resultFor(worker.lastRequest(), { positions: bad }));
		assert.equal((await run).kind, 'failed');
	}
});

test('dispose cancels the pending run, terminates the worker and refuses further work', async () => {
	const { client, workers } = setup();
	const pending = client.run(spec());
	client.dispose();
	assert.equal((await pending).kind, 'cancelled');
	assert.equal((workers[0] as FakeWorker).terminated, 1);
	assert.equal((await client.run(spec())).kind, 'unavailable');
});

test('the client never imports the layouts: the main thread cannot run them', () => {
	const client = fs.readFileSync(path.join(SRC, 'workerClient.ts'), 'utf8');
	assert.doesNotMatch(client, /from '\.\/(layout\.core|tsne\.core|layout\.server)'|d3-force/);
});

// -----------------------------------------------------------------------------
// Starting the worker
// -----------------------------------------------------------------------------

test('the layout worker is spawned with the literal inline form the bundler requires', () => {
	const spawn = fs.readFileSync(path.join(SRC, 'spawnWorker.ts'), 'utf8');
	assert.match(spawn, /new Worker\(new URL\('\.\/layout\.worker\.ts', import\.meta\.url\)/);
});

test('same origin starts directly; cross-origin is unavailable in production and wrapped only in development', () => {
	const page = 'http://127.0.0.1:5590/apps/x/';
	assert.deepEqual(chooseWorkerStrategy({ workerUrl: '/static/w.js', pageHref: page, production: true, hasWorker: true }), { kind: 'direct' });
	const cross = chooseWorkerStrategy({ workerUrl: 'http://localhost:3103/w.js', pageHref: page, production: true, hasWorker: true });
	assert.equal(cross.kind, 'unavailable');
	assert.deepEqual(chooseWorkerStrategy({ workerUrl: 'http://localhost:3103/w.js', pageHref: page, production: false, hasWorker: true }), { kind: 'dev-shim' });
	assert.equal(chooseWorkerStrategy({ workerUrl: '/w.js', pageHref: page, production: true, hasWorker: false }).kind, 'unavailable');
	assert.equal(chooseWorkerStrategy({ workerUrl: 'http://[bad', pageHref: page, production: true, hasWorker: true }).kind, 'unavailable');
	const shim = devShimSource('http://localhost:3103/static/js/w.js');
	assert.match(shim, /Object\.defineProperty\(self, 'location'/);
	assert.match(shim, /importScripts\(/);
	assert.ok(shim.indexOf('defineProperty') < shim.indexOf('importScripts'));
});

test('nothing the main thread loads reaches the layouts or d3-force, even indirectly (they live in the worker chunk)', () => {
	const ROOT = path.resolve(__dirname, '..', 'src');
	const seen = new Set<string>();
	const resolve = (from: string, spec: string): string | null => {
		if (!spec.startsWith('.')) return null;
		const base = path.resolve(path.dirname(from), spec);
		for (const ext of ['.ts', '.tsx', '/index.ts']) if (fs.existsSync(base + ext)) return base + ext;
		return null;
	};
	const external = new Set<string>();
	const walk = (file: string): void => {
		if (seen.has(file)) return;
		seen.add(file);
		const source = fs.readFileSync(file, 'utf8');
		for (const m of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)) {
			if (m[1]) continue;
			const target = resolve(file, m[2] as string);
			if (target) walk(target);
			else external.add(m[2] as string);
		}
	};
	walk(path.join(ROOT, 'views', 'MapView.tsx'));
	// POSIX names: path.relative uses backslashes on Windows.
	const names = [...seen].map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
	for (const banned of ['map/layout.core.ts', 'map/tsne.core.ts', 'map/layout.server.ts', 'map/layout.worker.ts']) assert.ok(!names.includes(banned), `${banned} is reachable from MapView`);
	assert.ok(!external.has('d3-force'), 'd3-force is reachable from MapView');
	assert.ok(names.includes('map/workerClient.ts') && names.includes('map/spawnWorker.ts'), 'the walk reached the client');
});
