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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { connectionDiscoveryPath, parseConnectionDiscovery, serializeConnectionDiscovery, isLoopbackDiscoveryUri, withDiscoveryLock, CONNECTION_DISCOVERY_FILENAME, CONST_DISCOVERY_LOCK_SUFFIX, type ConnectionDiscoveryInfo } from '../engine/local/connectionDiscovery';

const INFO: ConnectionDiscoveryInfo = {
	uri: 'http://localhost:54321',
	pid: 4242,
	updatedAt: '2026-08-05T12:00:00.000Z',
};

// --- connectionDiscoveryPath --------------------------------------------------

test('builds the discovery path under the given engine directory', () => {
	// path.join() (which connectionDiscoveryPath delegates to) uses '\' on
	// Windows -- build the expectation the same way rather than hard-coding
	// a POSIX separator that would fail there.
	const engineDir = '/Users/dev/Library/Application Support/RocketRide/engine';
	assert.equal(connectionDiscoveryPath(engineDir), path.join(engineDir, CONNECTION_DISCOVERY_FILENAME));
});

// --- serializeConnectionDiscovery / parseConnectionDiscovery round-trip ------

test('round-trips a well-formed info object', () => {
	const parsed = parseConnectionDiscovery(serializeConnectionDiscovery(INFO));
	assert.deepEqual(parsed, INFO);
});

test('serialized output is valid, human-readable JSON ending in a newline', () => {
	const text = serializeConnectionDiscovery(INFO);
	assert.ok(text.endsWith('\n'));
	assert.deepEqual(JSON.parse(text), INFO);
});

test('defaults a missing updatedAt to an empty string on parse', () => {
	const parsed = parseConnectionDiscovery(JSON.stringify({ uri: INFO.uri, pid: INFO.pid }));
	assert.deepEqual(parsed, { uri: INFO.uri, pid: INFO.pid, updatedAt: '' });
});

test('a serialized file no longer carries an apiKey field', () => {
	const text = serializeConnectionDiscovery(INFO);
	assert.equal(JSON.parse(text).apiKey, undefined);
});

// --- parseConnectionDiscovery must never throw on bad input ------------------

test('returns null for invalid JSON', () => {
	assert.equal(parseConnectionDiscovery('not json'), null);
});

test('returns null for JSON that is not an object', () => {
	assert.equal(parseConnectionDiscovery('42'), null);
	assert.equal(parseConnectionDiscovery('"a string"'), null);
	assert.equal(parseConnectionDiscovery('null'), null);
	assert.equal(parseConnectionDiscovery('[]'), null);
});

test('returns null when uri is missing, not a string, or not an absolute http(s) URI', () => {
	assert.equal(parseConnectionDiscovery(JSON.stringify({ pid: 1 })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: 123, pid: 1 })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: '', pid: 1 })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: 'localhost:54321', pid: 1 })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: 'ws://localhost:54321', pid: 1 })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: 'not a uri', pid: 1 })), null);
});

test('returns null when pid is missing, not a number, zero, negative, or fractional', () => {
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: INFO.uri })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: INFO.uri, pid: '4242' })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: INFO.uri, pid: 0 })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: INFO.uri, pid: -4242 })), null);
	assert.equal(parseConnectionDiscovery(JSON.stringify({ uri: INFO.uri, pid: 42.5 })), null);
});

test('ignores unknown extra fields from a future file version', () => {
	const parsed = parseConnectionDiscovery(JSON.stringify({ ...INFO, someFutureField: 'ignore me' }));
	assert.deepEqual(parsed, INFO);
});

test('ignores a legacy apiKey field from a pre-#1851-fix file', () => {
	const parsed = parseConnectionDiscovery(JSON.stringify({ ...INFO, apiKey: 'MYAPIKEY' }));
	assert.deepEqual(parsed, INFO);
});

// --- isLoopbackDiscoveryUri ---------------------------------------------------

test('accepts the standard loopback spellings', () => {
	assert.ok(isLoopbackDiscoveryUri('http://localhost:54321'));
	assert.ok(isLoopbackDiscoveryUri('http://127.0.0.1:54321'));
	assert.ok(isLoopbackDiscoveryUri('http://[::1]:54321'));
});

test('accepts alternate loopback encodings that normalize to the standard form', () => {
	assert.ok(isLoopbackDiscoveryUri('http://0177.0.0.1:54321')); // octal
	assert.ok(isLoopbackDiscoveryUri('http://2130706433:54321')); // decimal
	assert.ok(isLoopbackDiscoveryUri('http://127.1:54321')); // shortened
	assert.ok(isLoopbackDiscoveryUri('http://[0:0:0:0:0:0:0:1]:54321')); // expanded IPv6
});

test('rejects a non-loopback host', () => {
	assert.equal(isLoopbackDiscoveryUri('http://attacker.example.com:54321'), false);
	assert.equal(isLoopbackDiscoveryUri('http://192.168.1.5:54321'), false);
});

test('rejects a malformed URI rather than throwing', () => {
	assert.equal(isLoopbackDiscoveryUri('not a uri'), false);
	assert.equal(isLoopbackDiscoveryUri(''), false);
});

// --- withDiscoveryLock ---------------------------------------------------------

function withTempDiscoveryFile(fn: (filePath: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-discovery-lock-'));
	try {
		fn(path.join(dir, CONNECTION_DISCOVERY_FILENAME));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('runs fn and returns its result when the lock is free', () => {
	withTempDiscoveryFile((filePath) => {
		const result = withDiscoveryLock(filePath, () => 'ran');
		assert.equal(result, 'ran');
	});
});

test('removes the lock file after fn returns, so a later caller is not blocked', () => {
	withTempDiscoveryFile((filePath) => {
		withDiscoveryLock(filePath, () => undefined);
		assert.equal(fs.existsSync(`${filePath}${CONST_DISCOVERY_LOCK_SUFFIX}`), false);

		const second = withDiscoveryLock(filePath, () => 'second');
		assert.equal(second, 'second');
	});
});

test('removes the lock file even when fn throws', () => {
	withTempDiscoveryFile((filePath) => {
		assert.throws(() =>
			withDiscoveryLock(filePath, () => {
				throw new Error('boom');
			})
		);
		assert.equal(fs.existsSync(`${filePath}${CONST_DISCOVERY_LOCK_SUFFIX}`), false);
	});
});

test('skips fn and returns undefined when an already-held lock is not released in time', () => {
	withTempDiscoveryFile((filePath) => {
		// Simulate a concurrent holder: create the lock file ourselves and
		// never release it.
		const lockPath = `${filePath}${CONST_DISCOVERY_LOCK_SUFFIX}`;
		fs.writeFileSync(lockPath, '');

		let ran = false;
		const result = withDiscoveryLock(filePath, () => (ran = true), { maxWaitMs: 20, staleMs: 60_000 });

		assert.equal(result, undefined);
		assert.equal(ran, false);
	});
});

test('breaks a stale lock left behind by a crashed process, rather than skipping forever', () => {
	withTempDiscoveryFile((filePath) => {
		const lockPath = `${filePath}${CONST_DISCOVERY_LOCK_SUFFIX}`;
		fs.writeFileSync(lockPath, '');
		// Back-date the lock file so it reads as abandoned.
		const old = new Date(Date.now() - 10_000);
		fs.utimesSync(lockPath, old, old);

		const result = withDiscoveryLock(filePath, () => 'ran-after-breaking-stale-lock', {
			maxWaitMs: 200,
			staleMs: 1000,
		});

		assert.equal(result, 'ran-after-breaking-stale-lock');
	});
});

function sleepSyncMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('an already-held lock blocks a second caller until it is released', () => {
	// withDiscoveryLock is synchronous (Atomics.wait blocks the whole thread,
	// including the timer queue), so a same-process setTimeout can't release
	// a lock while a call is busy-waiting on it -- exercise the real
	// cross-process case with a worker thread holding the lock instead.
	withTempDiscoveryFile((filePath) => {
		const lockPath = `${filePath}${CONST_DISCOVERY_LOCK_SUFFIX}`;
		const holdMs = 150;

		const worker = new Worker(
			`
			const fs = require('node:fs');
			const { workerData } = require('node:worker_threads');
			fs.writeFileSync(workerData.lockPath, '');
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
			fs.unlinkSync(workerData.lockPath);
			`,
			{ eval: true, workerData: { lockPath, holdMs } }
		);

		try {
			// Poll for the worker to actually create the lock file (thread
			// startup time varies) before this thread starts trying to acquire
			// it -- a fixed sleep here would be flaky under CI load.
			for (let waited = 0; !fs.existsSync(lockPath); waited += 5) {
				assert.ok(waited < 2000, 'worker should have created the lock file by now');
				sleepSyncMs(5);
			}

			// If withDiscoveryLock raced past the still-held lock instead of
			// waiting for it, `wx` (exclusive create) would have thrown EEXIST
			// immediately and it would give up well before the worker's
			// `holdMs` release -- succeeding at all here means it genuinely
			// waited.
			const result = withDiscoveryLock(filePath, () => 'ran', { maxWaitMs: 2000, staleMs: 60_000 });
			assert.equal(result, 'ran');
		} finally {
			worker.terminate();
		}
	});
});
