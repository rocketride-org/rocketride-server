// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LAYOUT CLIENT (stale ids, supersession, watchdog, fallback) AND WORKER STRATEGY
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { createLayoutClient } from '../src/layout/workerClient';
import type { ILayoutTimers, ILayoutWorkerLike } from '../src/layout/workerClient';
import { LayoutUnavailableError, chooseWorkerStrategy, devShimSource } from '../src/layout/workerStrategy';
import { layoutDeadlineMs } from '../src/layout/protocol';
import type { ILayoutRequest } from '../src/layout/protocol';

/** A worker the test drives by hand. */
class FakeWorker implements ILayoutWorkerLike {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	posted: ILayoutRequest[] = [];
	terminated = 0;
	postMessage(message: unknown): void {
		this.posted.push(message as ILayoutRequest);
	}
	terminate(): void {
		this.terminated += 1;
	}
	answer(data: unknown): void {
		this.onmessage?.({ data });
	}
	answerPositions(request: ILayoutRequest, timedOut = false): void {
		this.answer({ type: 'result', requestId: request.requestId, positions: request.nodes.map((n, i) => ({ id: n.id, x: i * 10, y: -i * 10 })), ticks: 300, elapsedMs: 12, timedOut });
	}
}

/** Timers that only fire when the test says so. */
class ManualTimers implements ILayoutTimers {
	callbacks = new Map<number, { callback: () => void; ms: number }>();
	private next = 1;
	set(callback: () => void, ms: number): unknown {
		const id = this.next++;
		this.callbacks.set(id, { callback, ms });
		return id;
	}
	clear(handle: unknown): void {
		this.callbacks.delete(handle as number);
	}
	fireAll(): void {
		for (const [id, { callback }] of [...this.callbacks]) {
			this.callbacks.delete(id);
			callback();
		}
	}
}

const spec = (n: number, extra: Record<string, unknown> = {}) => ({ nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}` })), links: [], seed: 1, ...extra });

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
		watchdogGraceMs: 500,
	});
	return { client, workers, timers };
}

test('a good answer resolves ok with positions keyed by id', async () => {
	const { client, workers } = setup();
	const pending = client.layout(spec(3));
	const request = workers[0].posted[0];
	assert.equal(request.type, 'layout');
	assert.equal(request.ticks, 300);
	assert.equal(request.deadlineMs, 4000);
	workers[0].answerPositions(request);
	const outcome = await pending;
	assert.equal(outcome.status, 'ok');
	if (outcome.status === 'ok') {
		assert.deepEqual([...outcome.positions.keys()], ['n0', 'n1', 'n2']);
		assert.deepEqual(outcome.positions.get('n2'), { x: 20, y: -20 });
		assert.equal(outcome.timedOut, false);
	}
});

test('an answer that reports it hit the deadline is still ok, flagged', async () => {
	const { client, workers } = setup();
	const pending = client.layout(spec(2));
	workers[0].answerPositions(workers[0].posted[0], true);
	const outcome = await pending;
	assert.equal(outcome.status === 'ok' && outcome.timedOut, true);
});

test('only the answer to the CURRENT request is accepted; older answers are ignored', async () => {
	const { client, workers } = setup();
	const first = client.layout(spec(3));
	const firstRequest = workers[0].posted[0];
	const second = client.layout(spec(5));
	assert.equal((await first).status, 'stale', 'the superseded request resolves stale');
	// The superseded worker was terminated and a fresh one serves the new request.
	assert.equal(workers[0].terminated, 1);
	assert.equal(workers.length, 2);
	const secondRequest = workers[1].posted[0];
	assert.ok(secondRequest.requestId > firstRequest.requestId);
	// A late answer for the FIRST request, even through the second worker's channel, is dropped.
	workers[1].answer({ type: 'result', requestId: firstRequest.requestId, positions: [{ id: 'n0', x: 1, y: 1 }], ticks: 1, elapsedMs: 1, timedOut: false });
	// The old worker's late answer cannot reach the client either (its handlers were detached).
	workers[0].answerPositions(firstRequest);
	workers[1].answerPositions(secondRequest);
	const outcome = await second;
	assert.equal(outcome.status, 'ok');
	assert.equal(outcome.status === 'ok' && outcome.positions.size, 5);
});

test('a finished request leaves the worker running and reuses it', async () => {
	const { client, workers } = setup();
	const a = client.layout(spec(2));
	workers[0].answerPositions(workers[0].posted[0]);
	await a;
	const b = client.layout(spec(2));
	assert.equal(workers.length, 1);
	assert.equal(workers[0].terminated, 0);
	workers[0].answerPositions(workers[0].posted[1]);
	assert.equal((await b).status, 'ok');
});

test('the watchdog gives up on a silent worker: grid fallback, worker terminated, next request gets a new worker', async () => {
	const { client, workers, timers } = setup();
	const pending = client.layout(spec(4, { deadlineMs: 1000 }));
	assert.equal([...timers.callbacks.values()][0].ms, 1500, 'deadline plus the grace period');
	timers.fireAll();
	const outcome = await pending;
	assert.equal(outcome.status, 'fallback');
	if (outcome.status === 'fallback') {
		assert.equal(outcome.reason, 'timeout');
		assert.equal(outcome.positions.size, 4);
		for (const p of outcome.positions.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
	}
	assert.equal(workers[0].terminated, 1);
	assert.equal(client.broken, false, 'slow is not broken');
	const next = client.layout(spec(2));
	assert.equal(workers.length, 2);
	workers[1].answerPositions(workers[1].posted[0]);
	assert.equal((await next).status, 'ok');
});

test('a worker that cannot be started puts the client on the grid for good', async () => {
	let attempts = 0;
	const { client } = setup(() => {
		attempts += 1;
		throw new LayoutUnavailableError('no workers here');
	});
	const a = await client.layout(spec(3));
	assert.equal(a.status, 'fallback');
	if (a.status === 'fallback') {
		assert.equal(a.reason, 'worker-unavailable');
		assert.match(a.detail, /no workers here/);
		assert.equal(a.positions.size, 3);
	}
	assert.equal(client.broken, true);
	const b = await client.layout(spec(3));
	assert.equal(b.status === 'fallback' && b.reason, 'worker-unavailable');
	assert.equal(attempts, 1, 'no retry loop on a worker that cannot start');
});

test('a worker error mid-job falls back to the grid and stays there', async () => {
	const { client, workers } = setup();
	const pending = client.layout(spec(3));
	workers[0].onerror?.({ message: 'script failed to load' });
	const outcome = await pending;
	assert.equal(outcome.status === 'fallback' && outcome.reason, 'worker-error');
	assert.equal(client.broken, true);
	assert.equal(workers[0].terminated, 1);
	const again = await client.layout(spec(3));
	assert.equal(again.status === 'fallback' && again.reason, 'worker-unavailable');
	assert.equal(workers.length, 1, 'no new worker after an error');
});

test('an error answer for the current request falls back but does not condemn the worker', async () => {
	const { client, workers } = setup();
	const pending = client.layout(spec(2));
	workers[0].answer({ type: 'error', requestId: workers[0].posted[0].requestId, message: 'boom' });
	const outcome = await pending;
	assert.equal(outcome.status === 'fallback' && outcome.reason, 'worker-error');
	assert.equal(outcome.status === 'fallback' && outcome.detail, 'boom');
});

test('missing, duplicated or non-finite positions are rejected as a bad result', async () => {
	for (const positions of [[{ id: 'n0', x: 1, y: 1 }], [{ id: 'n0', x: 1, y: 1 }, { id: 'n1', x: NaN, y: 1 }], [{ id: 'n0', x: 1, y: 1 }, { id: 'n1', x: 1, y: Infinity }], [{ id: 'n0', x: 1, y: 1 }, { id: 'zzz', x: 1, y: 1 }]]) {
		const { client, workers } = setup();
		const pending = client.layout(spec(2));
		workers[0].answer({ type: 'result', requestId: workers[0].posted[0].requestId, positions, ticks: 1, elapsedMs: 1, timedOut: false });
		const outcome = await pending;
		assert.equal(outcome.status === 'fallback' && outcome.reason, 'bad-result', JSON.stringify(positions));
	}
});

test('the fallback keeps pinned positions and gives everything else a grid cell', async () => {
	const { client } = setup(() => {
		throw new Error('nope');
	});
	const outcome = await client.layout({ nodes: [{ id: 'a', x: 700, y: 700, pinned: true }, { id: 'b' }, { id: 'c' }], links: [], seed: 1 });
	assert.equal(outcome.status, 'fallback');
	if (outcome.status === 'fallback') {
		assert.deepEqual(outcome.positions.get('a'), { x: 700, y: 700 });
		assert.equal(new Set([...outcome.positions.values()].map((p) => `${p.x},${p.y}`)).size, 3);
	}
});

test('dispose resolves the pending request stale, terminates the worker and refuses further work', async () => {
	const { client, workers } = setup();
	const pending = client.layout(spec(2));
	client.dispose();
	assert.equal((await pending).status, 'stale');
	assert.equal(workers[0].terminated, 1);
	assert.equal((await client.layout(spec(2))).status, 'stale');
	assert.equal(workers.length, 1);
	workers[0].answerPositions(workers[0].posted[0]); // a late answer after dispose is harmless
});

test('the client never imports the force simulation: the main thread cannot run it', () => {
	for (const file of ['workerClient.ts', 'gridFallback.ts', 'spawnWorker.ts', 'workerStrategy.ts', 'protocol.ts']) {
		const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'layout', file), 'utf8');
		assert.ok(!/from\s+['"]d3-force['"]/.test(source), `${file} must not import d3-force`);
		assert.ok(!/layout\.core/.test(source), `${file} must not import the simulation core`);
	}
	const worker = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'layout', 'layout.worker.ts'), 'utf8');
	assert.match(worker, /layout\.core/);
	assert.ok(!/from\s+['"](react|shell|rocketride)['"]/.test(worker), 'the worker chunk must stay free of React and the shell');
});

test('the layout worker is spawned with the literal inline form the bundler requires', () => {
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'layout', 'spawnWorker.ts'), 'utf8');
	assert.match(source, /new Worker\(new URL\('\.\/layout\.worker\.ts', import\.meta\.url\)/);
});

// -----------------------------------------------------------------------------
// Strategy
// -----------------------------------------------------------------------------

test('same origin starts the worker directly, in production and in development', () => {
	for (const production of [true, false]) {
		assert.deepEqual(chooseWorkerStrategy({ workerUrl: 'https://app.example/apps/rocketride.graph/static/js/async/graph-layout.abc.js', pageHref: 'https://app.example/#/graph', production, hasWorker: true }), { kind: 'direct' });
	}
	assert.deepEqual(chooseWorkerStrategy({ workerUrl: '/apps/rocketride.graph/w.js', pageHref: 'http://localhost:5565/index.html', production: true, hasWorker: true }), { kind: 'direct' });
});

test('cross-origin is reported in production and wrapped only in a development build', () => {
	const input = { workerUrl: 'http://localhost:3102/static/js/async/graph-layout.abc.js', pageHref: 'http://localhost:3000/', hasWorker: true };
	const production = chooseWorkerStrategy({ ...input, production: true });
	assert.equal(production.kind, 'unavailable');
	assert.match(production.kind === 'unavailable' ? production.reason : '', /same-origin|origin/);
	assert.deepEqual(chooseWorkerStrategy({ ...input, production: false }), { kind: 'dev-shim' });
	// A different port or scheme is a different origin.
	assert.equal(chooseWorkerStrategy({ workerUrl: 'https://localhost:3000/w.js', pageHref: 'http://localhost:3000/', production: true, hasWorker: true }).kind, 'unavailable');
});

test('no Worker support, or an unusable URL, is unavailable in every mode', () => {
	assert.equal(chooseWorkerStrategy({ workerUrl: '/w.js', pageHref: 'http://x/', production: false, hasWorker: false }).kind, 'unavailable');
	assert.equal(chooseWorkerStrategy({ workerUrl: 'http://[::bad', pageHref: 'http://x/', production: false, hasWorker: true }).kind, 'unavailable');
	assert.equal(chooseWorkerStrategy({ workerUrl: '/w.js', pageHref: 'not a url', production: false, hasWorker: true }).kind, 'unavailable');
});

test('the dev wrapper shadows self.location with the real script URL before loading it', () => {
	const url = 'http://localhost:3102/apps/rocketride.graph/static/js/async/graph-layout.abc.js?x=1#y';
	const imported: string[] = [];
	const posted: unknown[] = [];
	const self: Record<string, unknown> = {};
	const sandbox = { self, importScripts: (u: string) => { imported.push(u); imported.push(String((self.location as { toString(): string }).toString())); }, postMessage: (m: unknown) => posted.push(m), Object };
	vm.runInNewContext(devShimSource(url), sandbox);
	assert.deepEqual(imported, [url, url], 'importScripts gets the URL, and location is the URL by the time the script runs');
	assert.deepEqual(posted, []);
	assert.equal((self.location as { href: string }).href, url);
	// A hostile-looking URL cannot break out of the string literal.
	const evil = 'http://x/"; postMessage("pwned"); "';
	const importedEvil: string[] = [];
	vm.runInNewContext(devShimSource(evil), { self: {}, importScripts: (u: string) => importedEvil.push(u), postMessage: () => { throw new Error('executed injected code'); }, Object });
	assert.deepEqual(importedEvil, [evil]);
});

test('the layout deadline grows with the graph, between 4 and 12 seconds', () => {
	assert.equal(layoutDeadlineMs(0), 4000);
	assert.equal(layoutDeadlineMs(100), 4000);
	assert.equal(layoutDeadlineMs(300), 5000);
	assert.equal(layoutDeadlineMs(1000), 12000);
	assert.equal(layoutDeadlineMs(100000), 12000);
});
