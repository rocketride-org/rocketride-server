// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The newest-read-wins rule the DEPLOY page's refreshes follow: a superseded
 * read that lands last never overwrites the newer answer.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLatestGate } from './latestGate';
import type { ILatestGate } from './latestGate';

/** A read whose answer the test releases by hand, in any order. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** The pattern both refresh sites use: take a ticket, await, write only while newest. */
async function read<T>(gate: ILatestGate, answer: Promise<T>, write: (value: T) => void): Promise<void> {
	const ticket = gate.take();
	const value = await answer;
	if (gate.isLatest(ticket)) write(value);
}

test('a superseded read that lands last does not overwrite the newer answer', async () => {
	const gate = createLatestGate();
	const written: string[] = [];
	const older = deferred<string>();
	const newer = deferred<string>();
	const first = read(gate, older.promise, (v) => written.push(v));
	const second = read(gate, newer.promise, (v) => written.push(v));
	// The newer read answers first, then the stale one lands
	newer.resolve('v5 in review');
	await second;
	older.resolve('v5 draft');
	await first;
	assert.deepEqual(written, ['v5 in review']);
});

test('reads that do not overlap each write', async () => {
	const gate = createLatestGate();
	const written: number[] = [];
	await read(gate, Promise.resolve(1), (v) => written.push(v));
	await read(gate, Promise.resolve(2), (v) => written.push(v));
	assert.deepEqual(written, [1, 2]);
});

test('each gate counts on its own', () => {
	const a = createLatestGate();
	const b = createLatestGate();
	const ticket = a.take();
	b.take();
	b.take();
	assert.equal(a.isLatest(ticket), true);
	assert.equal(b.isLatest(ticket), false);
});
