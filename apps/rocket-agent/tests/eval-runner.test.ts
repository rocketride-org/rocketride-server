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

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeRequestBody, transcriptKey } from '../eval/src/transcripts';
import { startReplayModelServer } from '../eval/src/replay-model';
import { startStubEngine } from '../eval/src/stub-engine';
import { startToolCallRecorder, startEngineForBrief, runBrief } from '../eval/src/runner';
import { BRIEFS } from '../eval/src/briefs';
import { evaluateExitCode } from '../eval/run';
import type { SuiteReport } from '../eval/src/types';

const CATALOG_PATH = path.join(__dirname, '..', 'eval', 'fixtures', 'services-catalog.json');

function tmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function rpc(url: string, body: unknown): Promise<{ status: number; json: any }> {
	const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** A minimal fake JSON-RPC HTTP server standing in for "the real engine" — records every request it receives so a test can assert routing without needing a real engine. */
async function startFakeJsonRpcServer(handler: (msg: any) => unknown): Promise<{ url: string; received: any[]; close: () => Promise<void> }> {
	const received: any[] = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			const msg = raw ? JSON.parse(raw) : undefined;
			received.push(msg);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id: msg?.id, result: handler(msg) }));
		});
	});
	const port: number = await new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.listen(0, '127.0.0.1', () => {
			const p = (probe.address() as net.AddressInfo).port;
			probe.close((err) => (err ? reject(err) : resolve(p)));
		});
	});
	await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
	return { url: `http://127.0.0.1:${port}`, received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ---------------------------------------------------------------------------
// transcripts.ts (VERIFY V2)
// ---------------------------------------------------------------------------

describe('transcriptKey / normalizeRequestBody (V2)', () => {
	test('same semantic body, different key order -> identical key', () => {
		const a = { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] };
		const b = { messages: [{ content: 'hi', role: 'user' }], model: 'claude-x' };
		expect(transcriptKey('brief-a', a)).toBe(transcriptKey('brief-a', b));
	});

	test('volatile fields (metadata, request_id, nonce) are stripped before hashing', () => {
		const withVolatile = { model: 'claude-x', metadata: { user_id: 'abc123' }, request_id: 'req-1', messages: [] };
		const withoutVolatile = { model: 'claude-x', messages: [] };
		expect(transcriptKey('brief-a', withVolatile)).toBe(transcriptKey('brief-a', withoutVolatile));
	});

	test('semantically load-bearing id-like fields (providerID, modelID, tool_use id) are NOT stripped', () => {
		const withIds = { model: { providerID: 'anthropic', modelID: 'claude-x' }, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1' }] }] };
		const changedIds = { model: { providerID: 'anthropic', modelID: 'claude-y' }, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1' }] }] };
		expect(transcriptKey('brief-a', withIds)).not.toBe(transcriptKey('brief-a', changedIds));
	});

	test('different briefId -> different key for the identical body', () => {
		const body = { model: 'claude-x', messages: [] };
		expect(transcriptKey('brief-a', body)).not.toBe(transcriptKey('brief-b', body));
	});

	test('normalizeRequestBody drops metadata recursively, including nested objects', () => {
		const normalized = normalizeRequestBody({ a: { metadata: { x: 1 }, b: 2 } }) as any;
		expect(normalized.a.metadata).toBeUndefined();
		expect(normalized.a.b).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Step 1: stub-engine.ts — spawn on an ephemeral port, drive with raw JSON-RPC
// ---------------------------------------------------------------------------

describe('stub-engine (Streamable HTTP MCP, keyless)', () => {
	let engineUrl: string;
	let close: () => Promise<void>;
	let verdictsDir: string;

	beforeEach(async () => {
		verdictsDir = tmpDir('rr-eval-verdicts-');
		const engine = await startStubEngine({ briefId: 'webhook-transform', verdictsDir, catalogPath: CATALOG_PATH });
		engineUrl = engine.url;
		close = engine.close;
	});

	afterEach(async () => {
		await close();
		fs.rmSync(verdictsDir, { recursive: true, force: true });
	});

	test('initialize + tools/list describe every rr-builder tool', async () => {
		const init = await rpc(engineUrl, { jsonrpc: '2.0', id: 1, method: 'initialize' });
		expect(init.status).toBe(200);
		expect(init.json.result.capabilities.tools).toBeDefined();

		const list = await rpc(engineUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const names = list.json.result.tools.map((t: { name: string }) => t.name);
		expect(names).toEqual(expect.arrayContaining(['validate_pipeline', 'run_pipeline', 'list_components', 'describe_component', 'log_pipeline_trace', 'log_run_output']));
	});

	test('a notification (no id) gets 202 and no JSON-RPC body', async () => {
		const res = await fetch(engineUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
		expect(res.status).toBe(202);
		expect(await res.text()).toBe('');
	});

	test('validate_pipeline: unknown digest runs the static structural approximation, flagged approximated:true', async () => {
		const badPipe = { components: [{ id: 'x', provider: 'webhook', config: {} }], project_id: 'not-a-guid', version: 1, source: 'x' };
		const res = await rpc(engineUrl, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'validate_pipeline', arguments: { pipe: badPipe } } });
		const payload = JSON.parse(res.json.result.content[0].text);
		expect(payload.approximated).toBe(true);
		expect(payload.ok).toBe(false);
		expect(payload.errors.length).toBeGreaterThan(1); // surfaces ALL violations, not just the first (5.1a deferred minor)
		expect(payload.errors.some((e: string) => e.startsWith('project-id-guid'))).toBe(true);
	});

	test('validate_pipeline: a recorded verdict for the exact digest is replayed verbatim (no approximated flag)', async () => {
		const goodPipe = {
			components: [
				{ id: 'webhook_1', provider: 'webhook', config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' }, ui: { position: { x: 0, y: 100 } } },
				{ id: 'transform_1', provider: 'transform', config: {}, input: [{ lane: 'tags', from: 'webhook_1' }], ui: { position: { x: 300, y: 100 } } },
				{ id: 'response_text_1', provider: 'response_text', config: {}, input: [{ lane: 'text', from: 'transform_1' }], ui: { position: { x: 600, y: 100 } } },
			],
			project_id: '11111111-1111-4111-8111-111111111111',
			version: 1,
			source: 'webhook_1',
		};
		const args = { pipe: goodPipe };
		const { stableDigest } = await import('../eval/src/transcripts');
		const digest = stableDigest(args);
		fs.mkdirSync(verdictsDir, { recursive: true });
		fs.writeFileSync(path.join(verdictsDir, `${digest}.json`), JSON.stringify({ ok: true, errors: [] }), 'utf8');

		const res = await rpc(engineUrl, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'validate_pipeline', arguments: args } });
		const payload = JSON.parse(res.json.result.content[0].text);
		expect(payload).toEqual({ ok: true, errors: [] }); // no `approximated` key — real recorded verdict
	});

	test('run_pipeline returns a canned {token, id, publicToken}', async () => {
		const res = await rpc(engineUrl, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_pipeline', arguments: {} } });
		const payload = JSON.parse(res.json.result.content[0].text);
		expect(typeof payload.token).toBe('string');
		expect(typeof payload.id).toBe('string');
		expect(typeof payload.publicToken).toBe('string');
	});

	test('list_components / describe_component serve the vendored catalog snapshot', async () => {
		const list = await rpc(engineUrl, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_components', arguments: {} } });
		const components = JSON.parse(list.json.result.content[0].text);
		expect(components.some((c: { name: string }) => c.name === 'webhook')).toBe(true);

		const describe = await rpc(engineUrl, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'describe_component', arguments: { name: 'webhook' } } });
		const entry = JSON.parse(describe.json.result.content[0].text);
		expect(entry.name).toBe('webhook');

		const missing = await rpc(engineUrl, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'describe_component', arguments: { name: 'nonexistent_provider' } } });
		expect(missing.json.result.isError).toBe(true);
	});

	test('log_* tools return empty logs when nothing was recorded', async () => {
		const res = await rpc(engineUrl, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'log_pipeline_trace', arguments: {} } });
		expect(JSON.parse(res.json.result.content[0].text)).toEqual({ logs: [] });
	});

	test('an unknown JSON-RPC method returns a JSON-RPC error', async () => {
		const res = await rpc(engineUrl, { jsonrpc: '2.0', id: 10, method: 'not/a/real/method' });
		expect(res.json.error).toBeDefined();
		expect(res.json.error.code).toBe(-32601);
	});
});

// ---------------------------------------------------------------------------
// Step 2: replay-model.ts — replay hit/miss, and proxy-record against a local fake provider
// ---------------------------------------------------------------------------

describe('replay-model server', () => {
	test('replay mode: an exact-match recorded body is replayed verbatim', async () => {
		const dir = tmpDir('rr-eval-recordings-');
		const briefId = 'webhook-transform';
		const requestBody = { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] };
		const key = transcriptKey(briefId, requestBody);
		fs.writeFileSync(
			path.join(dir, `${key}.json`),
			JSON.stringify({ briefId, transcriptKey: key, status: 200, headers: { 'content-type': 'application/json' }, stream: false, bodyText: JSON.stringify({ hello: 'world' }) }),
			'utf8',
		);
		const server = await startReplayModelServer({ mode: 'replay', briefId, recordingsDir: dir });
		try {
			const res = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody) });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ hello: 'world' });
		} finally {
			await server.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('replay mode: a miss returns 404 with a fail-fast message naming the brief, and fires onMiss', async () => {
		const dir = tmpDir('rr-eval-recordings-');
		let missed: { briefId: string; key: string; message: string } | undefined;
		const server = await startReplayModelServer({ mode: 'replay', briefId: 'webhook-transform', recordingsDir: dir, onMiss: (info) => { missed = info; } });
		try {
			const res = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'never-recorded' }) });
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: { message: string } };
			expect(body.error.message).toMatch(/webhook-transform/);
			expect(body.error.message).toMatch(/re-record/);
			expect(missed?.briefId).toBe('webhook-transform');
			expect(missed?.message).toMatch(/re-record/);
		} finally {
			await server.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('proxy-record mode: forwards to the real provider and persists the exact pair for later replay', async () => {
		// A local fake "real provider" — proves the forward + persist + pass-through logic
		// without touching the network or a real key.
		const fake = http.createServer((req, res) => {
			let raw = '';
			req.on('data', (c) => (raw += c));
			req.on('end', () => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ echoedApiKey: req.headers['x-api-key'], sawBody: JSON.parse(raw) }));
			});
		});
		const fakePort: number = await new Promise((resolve, reject) => {
			const probe = net.createServer();
			probe.listen(0, '127.0.0.1', () => {
				const p = (probe.address() as net.AddressInfo).port;
				probe.close((err) => (err ? reject(err) : resolve(p)));
			});
		});
		await new Promise<void>((resolve) => fake.listen(fakePort, '127.0.0.1', resolve));

		const dir = tmpDir('rr-eval-recordings-');
		const briefId = 'webhook-transform';
		const server = await startReplayModelServer({ mode: 'proxy-record', briefId, recordingsDir: dir, realBaseUrl: `http://127.0.0.1:${fakePort}`, realApiKey: 'sk-real-team-key-should-never-leak' });
		try {
			const requestBody = { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] };
			const res = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody) });
			expect(res.status).toBe(200);
			const passedThrough = (await res.json()) as { echoedApiKey: string };
			expect(passedThrough.echoedApiKey).toBe('sk-real-team-key-should-never-leak');

			const key = transcriptKey(briefId, requestBody);
			const persisted = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'));
			expect(persisted.status).toBe(200);
			expect(JSON.parse(persisted.bodyText).sawBody).toEqual(requestBody);
			// The recorded RESPONSE headers (the only place a key could leak into the persisted
			// pair — the request itself, including its x-api-key header, is never persisted) must
			// never carry the real key.
			expect(JSON.stringify(persisted.headers)).not.toContain('sk-real-team-key-should-never-leak');
		} finally {
			await server.close();
			await new Promise((resolve) => fake.close(resolve));
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// ToolCallRecorder tap (reused by 5.2a)
// ---------------------------------------------------------------------------

describe('ToolCallRecorder', () => {
	test('records tools/call requests as {tool, ok} while forwarding responses unchanged', async () => {
		const upstream = http.createServer((req, res) => {
			let raw = '';
			req.on('data', (c) => (raw += c));
			req.on('end', () => {
				const msg = JSON.parse(raw);
				if (msg.params?.name === 'validate_pipeline') {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{}' }] } }));
				} else {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{}' }], isError: true } }));
				}
			});
		});
		const upstreamPort: number = await new Promise((resolve, reject) => {
			const probe = net.createServer();
			probe.listen(0, '127.0.0.1', () => {
				const p = (probe.address() as net.AddressInfo).port;
				probe.close((err) => (err ? reject(err) : resolve(p)));
			});
		});
		await new Promise<void>((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));

		const recorder = await startToolCallRecorder(`http://127.0.0.1:${upstreamPort}`);
		try {
			const ok = await rpc(recorder.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'validate_pipeline', arguments: {} } });
			expect(ok.status).toBe(200);
			const failing = await rpc(recorder.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_pipeline', arguments: {} } });
			expect(failing.status).toBe(200);

			expect(recorder.calls).toEqual([
				{ tool: 'validate_pipeline', ok: true },
				{ tool: 'run_pipeline', ok: false },
			]);

			// Task 5.2a unification: the same two calls, as AuditRecords, via the shared Auditor
			// seam production's MCP proxy tap uses — proves eval and production don't diverge.
			expect(recorder.auditRecords).toHaveLength(2);
			expect(recorder.auditRecords[0]).toMatchObject({ kind: 'mcp.tool', action: 'validate_pipeline', status: 'ok' });
			expect(recorder.auditRecords[1]).toMatchObject({ kind: 'mcp.tool', action: 'run_pipeline', status: 'error' });
			expect(recorder.auditRecords[0].argsDigest).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			await recorder.close();
			await new Promise((resolve) => upstream.close(resolve));
		}
	});

	test('surfaces approximated:true on a validate_pipeline call whose result payload carries it (5.1c fix-up)', async () => {
		const fake = await startFakeJsonRpcServer((msg) => {
			if (msg?.params?.name === 'validate_pipeline') return { content: [{ type: 'text', text: JSON.stringify({ ok: true, errors: [], approximated: true }) }] };
			return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
		});
		const recorder = await startToolCallRecorder(fake.url);
		try {
			await rpc(recorder.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'validate_pipeline', arguments: {} } });
			expect(recorder.calls).toEqual([{ tool: 'validate_pipeline', ok: true, approximated: true }]);
		} finally {
			await recorder.close();
			await fake.close();
		}
	});

	test('does NOT set approximated when the payload omits it (a real recorded/live verdict)', async () => {
		const fake = await startFakeJsonRpcServer(() => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, errors: [] }) }] }));
		const recorder = await startToolCallRecorder(fake.url);
		try {
			await rpc(recorder.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'validate_pipeline', arguments: {} } });
			expect(recorder.calls).toEqual([{ tool: 'validate_pipeline', ok: true }]);
			expect(recorder.calls[0].approximated).toBeUndefined();
		} finally {
			await recorder.close();
			await fake.close();
		}
	});
});

// ---------------------------------------------------------------------------
// startEngineForBrief — the live-mode "must never silently use the stub" guard
// (Phase 5, Task 5.1c fix-up).
// ---------------------------------------------------------------------------

describe('startEngineForBrief (live-mode engine wiring guard)', () => {
	test('replay mode always starts the keyless stub engine', async () => {
		const dir = tmpDir('rr-eval-recordings-');
		const engine = await startEngineForBrief({ mode: 'replay' }, 'webhook-transform', dir);
		try {
			expect(engine.usedStub).toBe(true);
			expect(engine.upstreamUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		} finally {
			await engine.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('live mode with a real upstream routes there and NEVER starts the stub', async () => {
		const fake = await startFakeJsonRpcServer(() => ({ ok: true }));
		const dir = tmpDir('rr-eval-recordings-');
		try {
			const engine = await startEngineForBrief({ mode: 'live', liveMcpUpstream: fake.url }, 'webhook-transform', dir);
			expect(engine.usedStub).toBe(false);
			expect(engine.upstreamUrl).toBe(fake.url);
			await engine.close();

			// End-to-end at the HTTP layer: a tools/call routed through the ToolCallRecorder tap
			// (exactly what runBrief wires up) must land on the FAKE "real engine", not any stub.
			const recorder = await startToolCallRecorder(engine.upstreamUrl);
			try {
				await rpc(recorder.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'validate_pipeline', arguments: { pipe: { components: [] } } } });
				expect(fake.received).toHaveLength(1);
				expect(fake.received[0].params.name).toBe('validate_pipeline');
			} finally {
				await recorder.close();
			}
		} finally {
			await fake.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('live mode with NO liveMcpUpstream throws immediately — refuses to fall back to the stub', async () => {
		const dir = tmpDir('rr-eval-recordings-');
		try {
			await expect(startEngineForBrief({ mode: 'live' }, 'webhook-transform', dir)).rejects.toThrow(/requires a real engine MCP upstream/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('runBrief itself rejects live mode with no liveMcpUpstream before touching any resource (no OPENCODE_BIN needed to observe this)', async () => {
		const brief = BRIEFS.find((b) => b.id === 'webhook-transform')!;
		// This must reject with the engine-wiring error, NOT a "scored as a failed brief" result —
		// an infra misconfiguration is not the same thing as the agent doing badly.
		await expect(runBrief(brief, { mode: 'live' })).rejects.toThrow(/requires a real engine MCP upstream/);
	});
});

// ---------------------------------------------------------------------------
// evaluateExitCode (eval/run.ts) — the CLI's own decision about what an
// approximated verdict means for the exit code, in both modes.
// ---------------------------------------------------------------------------

describe('evaluateExitCode (Phase 5, Task 5.1c fix-up)', () => {
	function report(overrides: Partial<SuiteReport>): SuiteReport {
		return { mode: 'replay', results: [], passRate: 1, gate: true, approximatedCount: 0, ...overrides };
	}

	test('replay: a clean run (approximatedCount 0) with no baseline passes', () => {
		expect(evaluateExitCode('replay', report({}), undefined).failed).toBe(false);
	});

	test('replay: ANY approximated verdict fails, even with passRate 1.0 and no baseline to compare against', () => {
		const r = evaluateExitCode('replay', report({ passRate: 1, approximatedCount: 2, results: [{} as any, {} as any] }), undefined);
		expect(r.failed).toBe(true);
		expect(r.reason).toMatch(/NOT a clean regression baseline/);
	});

	test('replay: a real regression against a committed baseline fails (when not approximated)', () => {
		const r = evaluateExitCode('replay', report({ passRate: 0.5 }), { passRate: 0.9 });
		expect(r.failed).toBe(true);
		expect(r.reason).toMatch(/REGRESSION/);
	});

	test('live: gate===false fails', () => {
		const r = evaluateExitCode('live', report({ mode: 'live', gate: false, passRate: 0.5 }), undefined);
		expect(r.failed).toBe(true);
		expect(r.reason).toMatch(/GA gate FAILED/);
	});

	test('live: ANY approximated verdict fails even when gate===true — a stub-backed live run must never be trusted', () => {
		const r = evaluateExitCode('live', report({ mode: 'live', gate: true, passRate: 1, approximatedCount: 1 }), undefined);
		expect(r.failed).toBe(true);
		expect(r.reason).toMatch(/APPROXIMATED/);
		expect(r.reason).toMatch(/LIVE mode/);
	});

	test('live: a clean gate===true run with no approximation passes', () => {
		expect(evaluateExitCode('live', report({ mode: 'live', gate: true, passRate: 1 }), undefined)).toEqual({ failed: false });
	});
});

// ---------------------------------------------------------------------------
// Step 4: full runner integration — B01 end to end in replay mode against the
// hand-authored recording. Needs the pinned opencode binary (OPENCODE_BIN),
// same gating convention as Phase 3's opencode.test.ts.
// ---------------------------------------------------------------------------

const IT = process.env.OPENCODE_BIN ? describe : describe.skip;

if (!process.env.OPENCODE_BIN) {
	console.warn('[eval-runner.test] OPENCODE_BIN not set — skipping the B01 runner integration test. Set OPENCODE_BIN to the pinned opencode binary to run it.');
}

IT('runBrief (integration, needs OPENCODE_BIN)', () => {
	test('B01 webhook-transform replays end to end against the hand-authored recording', async () => {
		const brief = BRIEFS.find((b) => b.id === 'webhook-transform')!;
		const result = await runBrief(brief, { mode: 'replay', opencodeBin: process.env.OPENCODE_BIN });
		expect(result.briefId).toBe('webhook-transform');
		expect(result.toolCalls.length).toBeGreaterThan(0);
		// The checked-in recording ships a matching eval/recordings/webhook-transform/verdicts/
		// entry for this exact pipe digest — a real recorded verdict, not the approximation
		// fallback — so a real run against it must never be flagged approximated.
		expect(result.approximated).toBeUndefined();
	}, 90_000);
});
