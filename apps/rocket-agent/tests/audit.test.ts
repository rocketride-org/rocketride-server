/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditRecord, AuditSink, Auditor, InMemorySink, NdjsonSink, SaasSink, digestArgs, extractPipePaths } from '../src/audit';

async function tmpDir(): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), 'ra-audit-test-'));
}

const BASE_RECORD: Omit<AuditRecord, 'ts'> = {
	sessionId: 'sess-1',
	tenantId: 'tenant-1',
	userId: 'user-1',
	kind: 'mcp.tool',
	action: 'validate_pipeline',
	argsDigest: digestArgs({ pipe: { nodes: [] } }),
	status: 'ok',
	durationMs: 42,
};

describe('digestArgs / extractPipePaths', () => {
	test('digest is a 64-hex sha256 and is order-independent', () => {
		const a = digestArgs({ a: 1, b: 2 });
		const b = digestArgs({ b: 2, a: 1 });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	test('digest differs for different args', () => {
		expect(digestArgs({ a: 1 })).not.toBe(digestArgs({ a: 2 }));
	});

	test('extracts workspace-relative .pipe paths, ignores non-path strings and traversal', () => {
		const paths = extractPipePaths({
			pipePath: 'flows/my-flow.pipe',
			nested: { other: 'sub/dir/two.pipe', prose: 'this mentions a .pipe file but is not one' },
			bad: '../escape.pipe',
			notAPipe: 'hello world',
		});
		expect(paths.sort()).toEqual(['flows/my-flow.pipe', 'sub/dir/two.pipe']);
	});

	test('caps the number of extracted paths', () => {
		const many: Record<string, string> = {};
		for (let i = 0; i < 30; i++) many[`k${i}`] = `p${i}.pipe`;
		expect(extractPipePaths(many, 5)).toHaveLength(5);
	});
});

describe('Auditor', () => {
	test('record() stamps ts and forwards exactly one record to the sink', async () => {
		const sink = new InMemorySink();
		const auditor = new Auditor(sink);
		auditor.record(BASE_RECORD);
		await new Promise((r) => setImmediate(r)); // let the fire-and-forget write land
		expect(sink.records).toHaveLength(1);
		const rec = sink.records[0];
		expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(rec.sessionId).toBe('sess-1');
		expect(rec.action).toBe('validate_pipeline');
	});

	// Task brief: a throwing/broken sink must never break the request path it is auditing.
	test('a throwing sink never throws or rejects out of record()', async () => {
		class ThrowingSink implements AuditSink {
			async write(): Promise<void> {
				throw new Error('sink is on fire');
			}
			async flush(): Promise<void> {
				throw new Error('flush is on fire too');
			}
		}
		const auditor = new Auditor(new ThrowingSink());
		expect(() => auditor.record(BASE_RECORD)).not.toThrow();
		await expect(auditor.flush()).resolves.toBeUndefined();
	});

	test('a synchronously-throwing sink.write() is still caught', async () => {
		class SyncThrowSink implements AuditSink {
			write(): Promise<void> {
				throw new Error('sync boom');
			}
			async flush(): Promise<void> {
				/* noop */
			}
		}
		const auditor = new Auditor(new SyncThrowSink());
		expect(() => auditor.record(BASE_RECORD)).not.toThrow();
	});
});

describe('NdjsonSink', () => {
	let dir: string;
	let sink: NdjsonSink;

	beforeEach(async () => {
		dir = await tmpDir();
		sink = new NdjsonSink(dir);
	});

	afterEach(async () => {
		await sink.close();
		await fsp.rm(dir, { recursive: true, force: true });
	});

	test('appends one ndjson line per record under <dataDir>/audit/YYYY-MM-DD.ndjson', async () => {
		const ts = new Date().toISOString();
		await sink.write([{ ...BASE_RECORD, ts }, { ...BASE_RECORD, ts, action: 'run_pipeline' }]);
		await sink.flush();
		const file = path.join(dir, 'audit', `${ts.slice(0, 10)}.ndjson`);
		const content = await fsp.readFile(file, 'utf8');
		const lines = content.trim().split('\n');
		expect(lines).toHaveLength(2);
		expect((JSON.parse(lines[0]) as AuditRecord).action).toBe('validate_pipeline');
		expect((JSON.parse(lines[1]) as AuditRecord).action).toBe('run_pipeline');
	});

	test('appends across multiple write() calls (does not truncate)', async () => {
		const ts = new Date().toISOString();
		await sink.write([{ ...BASE_RECORD, ts }]);
		await sink.write([{ ...BASE_RECORD, ts, action: 'second' }]);
		await sink.flush();
		const file = path.join(dir, 'audit', `${ts.slice(0, 10)}.ndjson`);
		const lines = (await fsp.readFile(file, 'utf8')).trim().split('\n');
		expect(lines).toHaveLength(2);
	});

	test('routes records to the correct per-day file based on record.ts, not wall clock', async () => {
		const day1 = '2026-01-01T00:00:00.000Z';
		const day2 = '2026-01-02T00:00:00.000Z';
		await sink.write([{ ...BASE_RECORD, ts: day1 }, { ...BASE_RECORD, ts: day2 }]);
		await sink.flush();
		const f1 = await fsp.readFile(path.join(dir, 'audit', '2026-01-01.ndjson'), 'utf8');
		const f2 = await fsp.readFile(path.join(dir, 'audit', '2026-01-02.ndjson'), 'utf8');
		expect(f1.trim().split('\n')).toHaveLength(1);
		expect(f2.trim().split('\n')).toHaveLength(1);
	});
});

describe('SaasSink batching/flush', () => {
	test('flushes automatically once the batch reaches batchSize', async () => {
		const posted: Array<{ records: AuditRecord[] }> = [];
		const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
			posted.push(JSON.parse(init.body as string) as { records: AuditRecord[] });
			return { ok: true, status: 200 } as Response;
		}) as unknown as typeof fetch;
		const sink = new SaasSink({ url: 'http://audit.internal/records', serviceToken: 'tok', batchSize: 3, flushIntervalMs: 60_000, fetchImpl });
		const ts = new Date().toISOString();
		await sink.write([{ ...BASE_RECORD, ts }, { ...BASE_RECORD, ts }]);
		expect(fetchImpl).not.toHaveBeenCalled(); // below batchSize — not flushed yet
		await sink.write([{ ...BASE_RECORD, ts }]); // hits batchSize=3
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(posted[0].records).toHaveLength(3);
	});

	test('flushes on the timer even below batchSize', async () => {
		jest.useFakeTimers();
		try {
			const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 } as Response)) as unknown as typeof fetch;
			const sink = new SaasSink({ url: 'http://audit.internal/records', serviceToken: 'tok', batchSize: 100, flushIntervalMs: 5000, fetchImpl });
			await sink.write([{ ...BASE_RECORD, ts: new Date().toISOString() }]);
			expect(fetchImpl).not.toHaveBeenCalled();
			jest.advanceTimersByTime(5000);
			await Promise.resolve(); // let the scheduled flush's microtasks run
			await Promise.resolve();
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		} finally {
			jest.useRealTimers();
		}
	});

	test('sends the exact pinned contract: POST {records} with a Bearer service-token header', async () => {
		let seenUrl = '';
		let seenHeaders: Record<string, string> = {};
		let seenMethod = '';
		const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
			seenUrl = url;
			seenMethod = init.method ?? '';
			seenHeaders = init.headers as Record<string, string>;
			return { ok: true, status: 200 } as Response;
		}) as unknown as typeof fetch;
		const sink = new SaasSink({ url: 'http://audit.internal/records', serviceToken: 'the-service-token', batchSize: 1, fetchImpl });
		await sink.write([{ ...BASE_RECORD, ts: new Date().toISOString() }]);
		expect(seenUrl).toBe('http://audit.internal/records');
		expect(seenMethod).toBe('POST');
		expect(seenHeaders['content-type']).toBe('application/json');
		expect(seenHeaders.authorization).toBe('Bearer the-service-token');
	});

	// Task brief: on failure, log + retain (drop-oldest above 10k) — never throw into the request path.
	test('write() never throws when the upstream POST fails, and the batch is retained for retry', async () => {
		const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const fetchImpl = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
			const sink = new SaasSink({ url: 'http://audit.internal/records', serviceToken: 'tok', batchSize: 1, fetchImpl });
			await expect(sink.write([{ ...BASE_RECORD, ts: new Date().toISOString() }])).resolves.toBeUndefined();
			expect(errSpy).toHaveBeenCalled();

			// Retry succeeds once the upstream recovers.
			const posted: Array<{ records: AuditRecord[] }> = [];
			(sink as unknown as { fetchImpl: typeof fetch }).fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
				posted.push(JSON.parse(init.body as string) as { records: AuditRecord[] });
				return { ok: true, status: 200 } as Response;
			}) as unknown as typeof fetch;
			await sink.flush();
			expect(posted[0].records).toHaveLength(1);
		} finally {
			errSpy.mockRestore();
		}
	});

	test('drop-oldest once retained records exceed the 10k cap', async () => {
		const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const fetchImpl = jest.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
			const sink = new SaasSink({ url: 'http://audit.internal/records', serviceToken: 'tok', batchSize: 20_000, fetchImpl });
			const ts = new Date().toISOString();
			const records: AuditRecord[] = [];
			for (let i = 0; i < 10_050; i++) records.push({ ...BASE_RECORD, ts, action: `action-${i}` });
			await sink.write(records);
			await sink.flush();
			const buffered = (sink as unknown as { buffer: AuditRecord[] }).buffer;
			expect(buffered.length).toBeLessThanOrEqual(10_000);
			expect(buffered[0].action).not.toBe('action-0'); // oldest dropped
		} finally {
			errSpy.mockRestore();
		}
	});
});

// Task brief's mandatory negative test: an API key embedded in tool args must NEVER appear,
// verbatim, in any serialized record or sink output — only its digest does.
describe('privacy: raw args never leak', () => {
	const SECRET = 'sk-ant-XXXXsupersecretXXXX';

	test('AuditRecord constructed from secret-bearing args never contains the secret string', async () => {
		const sink = new InMemorySink();
		const auditor = new Auditor(sink);
		const args = { apiKey: SECRET, note: `use ${SECRET} to authenticate` };
		auditor.record({
			...BASE_RECORD,
			argsDigest: digestArgs(args),
			pipePaths: extractPipePaths(args).length ? extractPipePaths(args) : undefined,
		});
		await new Promise((r) => setImmediate(r));
		const serialized = JSON.stringify(sink.records);
		expect(serialized).not.toContain(SECRET);
		expect(sink.records[0].argsDigest).not.toContain(SECRET);
	});

	test('NdjsonSink file content never contains the secret string', async () => {
		const dir = await tmpDir();
		const sink = new NdjsonSink(dir);
		try {
			const args = { apiKey: SECRET };
			const ts = new Date().toISOString();
			await sink.write([{ ...BASE_RECORD, ts, argsDigest: digestArgs(args) }]);
			await sink.flush();
			const file = path.join(dir, 'audit', `${ts.slice(0, 10)}.ndjson`);
			const content = await fsp.readFile(file, 'utf8');
			expect(content).not.toContain(SECRET);
		} finally {
			await sink.close();
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	test('SaasSink POST body never contains the secret string', async () => {
		let sentBody = '';
		const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
			sentBody = init.body as string;
			return { ok: true, status: 200 } as Response;
		}) as unknown as typeof fetch;
		const sink = new SaasSink({ url: 'http://audit.internal/records', serviceToken: 'tok', batchSize: 1, fetchImpl });
		const args = { apiKey: SECRET };
		await sink.write([{ ...BASE_RECORD, ts: new Date().toISOString(), argsDigest: digestArgs(args) }]);
		expect(sentBody).not.toContain(SECRET);
	});
});
