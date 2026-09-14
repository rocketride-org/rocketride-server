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

/**
 * The eval stub engine (Phase 5, Task 5.1b) — a keyless, deterministic Streamable HTTP MCP
 * server implementing only what the rr-builder agent actually calls:
 *
 *  - `validate_pipeline` — replays a recorded verdict keyed by a digest of the submitted pipe
 *    JSON (`<verdictsDir>/<digest>.json`, written during a `--record` run against the real
 *    engine). On a miss it runs 5.1a's `structuralChecks` for the current brief as a LOCAL
 *    APPROXIMATION of the real engine and flags the result `approximated: true` — every
 *    failing check is reported (not just the first), which is the 5.1a deferred minor.
 *  - `run_pipeline` — canned `{ token, id, publicToken }` (V6). Never actually runs anything.
 *  - `list_components` / `describe_component` — served from the vendored
 *    `eval/fixtures/services-catalog.json` snapshot.
 *  - `log_*` — `log_pipeline_trace` / `log_run_output`, recorded (if present under
 *    `verdictsDir/logs/`) or empty.
 *
 * Speaks a deliberately minimal subset of MCP Streamable HTTP: a single POST endpoint that
 * accepts one JSON-RPC 2.0 message (request or notification) and responds with a single JSON
 * message — no server-initiated SSE stream, since every tool here answers synchronously and
 * fast. `initialize` + `tools/list` + `tools/call` cover everything opencode's remote-MCP
 * client needs to discover and invoke these tools; `notifications/initialized` (no `id`) is
 * accepted and acknowledged with 202 per the JSON-RPC notification contract.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { BRIEFS } from './briefs';
import { structuralChecks } from './score';
import type { Pipe } from './types';
import { stableDigest } from './transcripts';

export interface StubEngineOpts {
	/** Current brief id — selects which brief's `structural` checks approximate an unrecorded verdict. */
	briefId: string;
	/** `eval/recordings/<briefId>/verdicts` — recorded `validate_pipeline` verdicts from a prior `--record` run against the real engine, keyed by pipe digest. */
	verdictsDir: string;
	/** Path to the vendored services-catalog.json snapshot. */
	catalogPath: string;
}

export interface StubEngine {
	url: string;
	close(): Promise<void>;
}

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

interface RecordedVerdict {
	ok: boolean;
	errors: string[];
}

interface CatalogEntry {
	name: string;
	[key: string]: unknown;
}

interface ToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const TOOL_DEFS: ToolDef[] = [
	{ name: 'validate_pipeline', description: 'Validate one or more .pipe documents against the engine.', inputSchema: { type: 'object', properties: { pipe: {}, pipes: { type: 'array' } } } },
	{ name: 'run_pipeline', description: 'Start a pipeline run and return its token/id.', inputSchema: { type: 'object', properties: { pipeline: {} } } },
	{ name: 'list_components', description: 'List every available component provider.', inputSchema: { type: 'object', properties: {} } },
	{ name: 'describe_component', description: 'Describe a single component provider by name.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
	{ name: 'log_pipeline_trace', description: 'Fetch the execution trace for a pipeline run.', inputSchema: { type: 'object', properties: { token: { type: 'string' } } } },
	{ name: 'log_run_output', description: 'Fetch captured output for a pipeline run.', inputSchema: { type: 'object', properties: { token: { type: 'string' } } } },
];

function toolResult(payload: unknown, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
	return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

/** Runs every one of `brief.structural`'s checks (not just the first failure) — the 5.1a deferred minor, folded in here since the runner is the natural place to surface ALL violations to a human debugging a failed brief. */
function approximateValidate(pipes: Pipe[], briefId: string): RecordedVerdict {
	const brief = BRIEFS.find((b) => b.id === briefId);
	if (!brief) return { ok: pipes.length > 0 && pipes.every((p) => Array.isArray(p.components) && p.components.length > 0), errors: [] };
	const errors: string[] = [];
	for (const checkName of brief.structural) {
		const check = structuralChecks[checkName];
		if (!check) {
			errors.push(`${checkName}: unknown structural check`);
			continue;
		}
		const failure = check(pipes, brief);
		if (failure) errors.push(`${checkName}: ${failure}`);
	}
	return { ok: errors.length === 0, errors };
}

function loadCatalog(catalogPath: string): CatalogEntry[] {
	return JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as CatalogEntry[];
}

function loadRecordedVerdict(verdictsDir: string, digest: string): RecordedVerdict | undefined {
	const file = `${verdictsDir}/${digest}.json`;
	if (!fs.existsSync(file)) return undefined;
	return JSON.parse(fs.readFileSync(file, 'utf8')) as RecordedVerdict;
}

function pipesFromArgs(args: Record<string, unknown> | undefined): Pipe[] {
	if (!args) return [];
	if (Array.isArray(args.pipes)) return args.pipes as Pipe[];
	if (args.pipe) return [args.pipe as Pipe];
	return [];
}

function randomEvalId(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function dispatchTool(opts: StubEngineOpts, name: string, args: Record<string, unknown> | undefined): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
	switch (name) {
		case 'validate_pipeline': {
			const pipes = pipesFromArgs(args);
			const digest = stableDigest(args ?? {});
			const recorded = loadRecordedVerdict(opts.verdictsDir, digest);
			if (recorded) return toolResult(recorded);
			const approximated = approximateValidate(pipes, opts.briefId);
			return toolResult({ ...approximated, approximated: true });
		}
		case 'run_pipeline':
			return toolResult({ token: randomEvalId('eval-token'), id: randomEvalId('eval-run'), publicToken: randomEvalId('eval-public') });
		case 'list_components':
			return toolResult(loadCatalog(opts.catalogPath));
		case 'describe_component': {
			const wanted = args?.name;
			const entry = loadCatalog(opts.catalogPath).find((c) => c.name === wanted);
			if (!entry) return toolResult({ error: `unknown component "${String(wanted)}"` }, true);
			return toolResult(entry);
		}
		case 'log_pipeline_trace':
		case 'log_run_output':
			return toolResult({ logs: [] });
		default:
			return toolResult({ error: `unknown tool "${name}"` }, true);
	}
}

async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

function handleRpc(opts: StubEngineOpts, msg: JsonRpcRequest): unknown {
	switch (msg.method) {
		case 'initialize':
			return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rr-eval-stub-engine', version: '0.1.0' } };
		case 'tools/list':
			return { tools: TOOL_DEFS };
		case 'tools/call': {
			const name = String(msg.params?.name ?? '');
			const args = msg.params?.arguments as Record<string, unknown> | undefined;
			return dispatchTool(opts, name, args);
		}
		default:
			throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
	}
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close((err) => (err ? reject(err) : resolve(port)));
		});
		srv.on('error', reject);
	});
}

export async function startStubEngine(opts: StubEngineOpts): Promise<StubEngine> {
	const server = http.createServer((req, res) => {
		if (req.method !== 'POST') {
			res.writeHead(405, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'method not allowed — this stub only accepts single-message Streamable HTTP POSTs' }));
			return;
		}
		void (async () => {
			let msg: JsonRpcRequest;
			try {
				msg = JSON.parse((await readRawBody(req)).toString('utf8')) as JsonRpcRequest;
			} catch {
				res.writeHead(400, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } }));
				return;
			}
			// Notification (no id): JSON-RPC forbids a response body — 202 Accepted, empty.
			if (msg.id === undefined) {
				res.writeHead(202);
				res.end();
				return;
			}
			try {
				const result = handleRpc(opts, msg);
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
			} catch (err) {
				const code = (err as { code?: number }).code ?? -32603;
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message: (err as Error).message } }));
			}
		})();
	});
	const port = await freePort();
	await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
