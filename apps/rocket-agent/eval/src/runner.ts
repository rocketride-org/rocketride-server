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
 * The eval runner (Phase 5, Task 5.1b) — drives a real opencode session end to end for one
 * golden brief (`runBrief`) or the whole suite (`runSuite`), then hands the result to 5.1a's
 * pure `scorePipe`/`scoreSuite`. This module never re-implements scoring.
 *
 * Deliberately does NOT import `../../src/index` (which pulls in `rocketride` — a workspace
 * package that ships no `dist/` in a fresh checkout, see the 4 pre-existing failing suites
 * noted in the task brief). It imports `SessionManager` directly from `../../src/session` and
 * supplies its own `storeFactory` (fixture-file-backed, only ever invoked for D-brief seeding),
 * so the whole replay path is provable without a built `rocketride` package — the only thing
 * this module needs from the environment is the pinned `opencode` binary (`OPENCODE_BIN`).
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditRecord, Auditor, digestArgs, extractPipePaths, InMemorySink } from '../../src/audit';
import { loadConfig } from '../../src/config';
import { authHeader } from '../../src/opencode';
import { isToolCallRequest, isToolCallResponseOk, parseJsonRpcRequest } from '../../src/proxy';
import { SessionManager } from '../../src/session';
import { MemorySessionIndex } from '../../src/sessionIndex';
import type { Identity, InferenceSettings, KeyResolver, LiveSession, StoreFs } from '../../src/types';
import { BRIEFS } from './briefs';
import { startReplayModelServer } from './replay-model';
import { scorePipe, scoreSuite } from './score';
import { startStubEngine } from './stub-engine';
import type { BriefResult, EvalBrief, Pipe, SuiteReport, ToolCall } from './types';

const CATALOG_PATH = path.join(__dirname, '..', 'fixtures', 'services-catalog.json');
const SEED_FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'broken');
const RECORDINGS_ROOT = path.join(__dirname, '..', 'recordings');

// ---------------------------------------------------------------------------
// ToolCallRecorder — a tiny reverse-proxy tap sitting between rocket-agent's
// `/internal/mcp` forwarder and the real MCP upstream (the stub engine in replay
// mode, or a live docker engine in live mode). Records every `tools/call` as a
// `ToolCall` (scoring input) while forwarding every request/response unchanged.
//
// Task 5.2a unifies the parsing side of this with the production MCP proxy tap
// (src/index.ts's `/internal/mcp/:id/:secret` route): both parse the JSON-RPC wire
// format through the SAME `parseJsonRpcRequest` / `isToolCallRequest` /
// `isToolCallResponseOk` helpers in `../../src/proxy`, and this recorder additionally
// runs every `tools/call` through a real `Auditor` (in-memory sink) — the exact
// machinery production uses — so `auditRecords` below is provably the same shape
// production would emit for the same call. `url`/`calls`/`close()` keep their
// original contract unchanged (additive only): 5.1b pinned "keep its contract
// stable", and every existing caller of `calls`/`url`/`close` is untouched.
// ---------------------------------------------------------------------------

export interface ToolCallRecorder {
	/** Point `RR_MCP_UPSTREAM` (or this eval's `cfg.mcpUpstream`) at this URL instead of the real upstream. */
	url: string;
	/** Append-only, in call order. */
	calls: ToolCall[];
	/** Task 5.2a: the same `tools/call` events, as `AuditRecord`s, collected via the shared `Auditor` seam production's MCP proxy tap uses. */
	auditRecords: AuditRecord[];
	close(): Promise<void>;
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

async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

/**
 * Buffers each request/response pair (no SSE pass-through) — every tool this eval suite calls
 * answers synchronously with a single JSON message, so this is a deliberate simplification, not
 * a spec gap. A future upstream that streams `tools/call` results would need this tap extended.
 */
export async function startToolCallRecorder(upstreamUrl: string): Promise<ToolCallRecorder> {
	const calls: ToolCall[] = [];
	const auditSink = new InMemorySink();
	const auditor = new Auditor(auditSink);
	const server = http.createServer((req, res) => {
		void (async () => {
			const start = Date.now();
			const rawBody = await readRawBody(req);
			// Same wire-format parse the production MCP proxy tap uses (src/index.ts via
			// src/proxy.ts) — one seam, not two.
			const frame = parseJsonRpcRequest(rawBody);
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(req.headers)) {
				if (typeof v === 'string' && !['host', 'content-length'].includes(k.toLowerCase())) headers[k] = v;
			}
			let upstream: Response;
			try {
				upstream = await fetch(`${upstreamUrl}${req.url ?? ''}`, { method: req.method, headers, body: rawBody.length ? rawBody : undefined });
			} catch (err) {
				res.writeHead(502, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: `tool-call-recorder: upstream unreachable: ${String(err)}` }));
				return;
			}
			const text = await upstream.text();
			if (isToolCallRequest(frame)) {
				const ok = isToolCallResponseOk(text, upstream.ok);
				let approximated: boolean | undefined;
				try {
					// validate_pipeline's payload (JSON-encoded inside content[0].text, the
					// standard MCP tool-result envelope) carries `approximated: true` whenever the
					// engine answering this call was the stub's local structural-check fallback
					// rather than a real recorded/live verdict — surface it onto the ToolCall so
					// scorePipe (5.1a's score.ts) can flag the BriefResult instead of a silently
					// "real-looking" pass/fail. Eval-scoring-specific; the shared ok/error parse
					// above stops at isToolCallResponseOk() — this extra field is eval-only.
					if (frame.params.name === 'validate_pipeline') {
						const respJson = JSON.parse(text) as { result?: { content?: Array<{ type?: string; text?: string }> } };
						const textBlock = respJson.result?.content?.[0]?.text;
						if (textBlock) {
							const payload = JSON.parse(textBlock) as { approximated?: boolean };
							if (payload.approximated === true) approximated = true;
						}
					}
				} catch {
					/* non-JSON response — no approximated flag to read */
				}
				calls.push({ tool: frame.params.name, ok, ...(approximated ? { approximated: true } : {}) });
				// Task 5.2a: the same event, as an AuditRecord, through the exact `Auditor` seam
				// production uses. No real session/tenant/user context exists at this bare
				// reverse-proxy tap — 'eval' is a fixed placeholder, never a real identity.
				const pipePaths = extractPipePaths(frame.params.arguments);
				auditor.record({
					sessionId: 'eval', tenantId: 'eval', userId: 'eval',
					kind: 'mcp.tool', action: frame.params.name,
					argsDigest: digestArgs(frame.params.arguments),
					pipePaths: pipePaths.length ? pipePaths : undefined,
					status: ok ? 'ok' : 'error',
					durationMs: Date.now() - start,
				});
			}
			const resHeaders: Record<string, string> = {};
			upstream.headers.forEach((v, k) => {
				if (!['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding'].includes(k.toLowerCase())) resHeaders[k] = v;
			});
			res.writeHead(upstream.status, resHeaders);
			res.end(text);
		})();
	});
	const port = await freePort();
	await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		auditRecords: auditSink.records,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

// ---------------------------------------------------------------------------
// runBrief
// ---------------------------------------------------------------------------

export interface RunnerOpts {
	mode: 'replay' | 'live';
	/** live mode only: proxy-record model turns through `replay-model.ts` and persist them for future replay. */
	record?: boolean;
	/** Defaults to `process.env.OPENCODE_BIN ?? 'opencode'`. */
	opencodeBin?: string;
	/**
	 * live mode ONLY: the real engine's MCP endpoint (e.g. `http://localhost:8080/mcp`, the
	 * engine/mcp/qdrant docker-compose stack `.github/workflows/rocket-agent-eval-live.yml`
	 * brings up). REQUIRED in live mode — see `startEngineForBrief()`, which throws rather than
	 * ever falling back to the stub engine when this is missing. Ignored in replay mode (replay
	 * always uses the stub).
	 */
	liveMcpUpstream?: string;
	/** Overrides the default `eval/recordings` root — tests use a scratch directory. */
	recordingsRoot?: string;
}

function timeoutMsFor(mode: 'replay' | 'live'): number {
	return mode === 'replay' ? 60_000 : 10 * 60_000;
}

/**
 * Resolves which MCP engine a brief run's tool calls hit — and, in live mode, whether that's even
 * allowed to proceed at all.
 *
 * `replay` mode always spins up the keyless, deterministic stub engine (`stub-engine.ts`).
 *
 * `live` mode NEVER starts the stub engine — there is deliberately no code path below that can
 * fall through to `startStubEngine()` once `opts.mode === 'live'` is true. A GA `passRate`
 * computed against the stub's local structural-check approximation is worse than no number at
 * all (silently indistinguishable from a real engine verdict — see `ToolCall.approximated`), so a
 * missing `liveMcpUpstream` is an infrastructure error, not a brief-scoring failure: it throws
 * immediately, before any session/workspace/process is created.
 */
export async function startEngineForBrief(
	opts: Pick<RunnerOpts, 'mode' | 'liveMcpUpstream'>,
	briefId: string,
	briefRecordingsDir: string,
): Promise<{ upstreamUrl: string; usedStub: boolean; close: () => Promise<void> }> {
	if (opts.mode === 'live') {
		if (!opts.liveMcpUpstream) {
			throw new Error(
				'live mode requires a real engine MCP upstream (liveMcpUpstream / RR_MCP_UPSTREAM) — refusing ' +
					'to fall back to the stub engine. A live GA passRate computed against the stub/local-' +
					'approximation is not a real number. Set RR_MCP_UPSTREAM to the live engine\'s MCP endpoint ' +
					'(e.g. http://localhost:8080/mcp — see .github/workflows/rocket-agent-eval-live.yml) before ' +
					'running --mode live.',
			);
		}
		return { upstreamUrl: opts.liveMcpUpstream, usedStub: false, close: async () => undefined };
	}
	const engine = await startStubEngine({ briefId, verdictsDir: path.join(briefRecordingsDir, 'verdicts'), catalogPath: CATALOG_PATH });
	return { upstreamUrl: engine.url, usedStub: true, close: engine.close };
}

/** D-brief seeding: a StoreFs backed by the local `eval/fixtures/broken/<file>` fixture, never a real project store. `fsWriteString` is a no-op — the runner reads the final `.pipe` straight off the workspace filesystem, it never round-trips through save-back. */
function fixtureStoreFactory(seedFile: string): () => Promise<StoreFs> {
	return async () => ({
		fsReadString: async () => fs.readFileSync(path.join(SEED_FIXTURES_DIR, seedFile), 'utf8'),
		fsWriteString: async () => undefined,
		close: async () => undefined,
	});
}

async function createOpencodeSession(live: LiveSession, title: string): Promise<string> {
	const res = await fetch(`${live.baseUrl}/session`, {
		method: 'POST',
		headers: { authorization: authHeader(live.password), 'content-type': 'application/json' },
		body: JSON.stringify({ title }),
	});
	if (!res.ok) throw new Error(`failed to create opencode session: ${res.status} ${await res.text()}`);
	const session = (await res.json()) as { id: string };
	return session.id;
}

/** Sends the brief's verbatim prompt through the rr-builder agent. `promptAsync` (POST /session/{id}/prompt_async) returns 204 immediately — the actual turn runs async, tracked via `waitForIdle`. */
async function sendPromptAsync(live: LiveSession, sessionId: string, prompt: string): Promise<void> {
	const res = await fetch(`${live.baseUrl}/session/${sessionId}/prompt_async`, {
		method: 'POST',
		headers: { authorization: authHeader(live.password), 'content-type': 'application/json' },
		body: JSON.stringify({ agent: 'rr-builder', parts: [{ type: 'text', text: prompt }] }),
	});
	if (res.status !== 204) throw new Error(`prompt_async rejected: ${res.status} ${await res.text()}`);
}

/**
 * Subscribes to `/global/event` (same envelope opencode's SessionManager.watchFileEdits()
 * already relies on: `{ payload: { type, properties } }`) and resolves once this session goes
 * idle AFTER having been observed busy at least once — guards against trivially resolving on
 * the session's initial (pre-work) idle state. Rejects on the per-brief timeout, or immediately
 * if `isAborted()` starts returning a reason (the replay-model transcript-miss fast-fail path).
 */
async function waitForIdle(opts: { baseUrl: string; password: string; sessionId: string; timeoutMs: number; isAborted: () => string | undefined }): Promise<void> {
	const controller = new AbortController();
	const timeoutTimer = setTimeout(() => controller.abort(), opts.timeoutMs);
	const abortPoll = setInterval(() => {
		if (opts.isAborted()) controller.abort();
	}, 200);
	let sawBusy = false;
	try {
		const res = await fetch(`${opts.baseUrl}/global/event`, { headers: { authorization: authHeader(opts.password), accept: 'text/event-stream' }, signal: controller.signal });
		if (!res.ok || !res.body) throw new Error(`event stream failed to open: ${res.status}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
				if (!data) continue;
				let evt: { payload?: { type?: string; properties?: { sessionID?: string; status?: { type?: string } } } };
				try {
					evt = JSON.parse(data);
				} catch {
					continue;
				}
				const props = evt.payload?.properties;
				if (props?.sessionID !== opts.sessionId) continue;
				const type = evt.payload?.type;
				const statusType = type === 'session.status' ? props?.status?.type : type === 'session.idle' ? 'idle' : undefined;
				if (statusType && statusType !== 'idle') sawBusy = true;
				if (statusType === 'idle' && sawBusy) return;
			}
		}
		throw new Error('event stream ended before the session went idle');
	} catch (err) {
		const abortReason = opts.isAborted();
		if (abortReason) throw new Error(abortReason);
		if (controller.signal.aborted) throw new Error(`timed out waiting for session idle after ${opts.timeoutMs}ms`);
		throw err;
	} finally {
		clearTimeout(timeoutTimer);
		clearInterval(abortPoll);
		controller.abort();
	}
}

async function readWorkspacePipes(workspaceDir: string): Promise<Pipe[]> {
	const files = (await fsp.readdir(workspaceDir)).filter((f) => f.endsWith('.pipe')).sort();
	const pipes: Pipe[] = [];
	for (const file of files) {
		const text = await fsp.readFile(path.join(workspaceDir, file), 'utf8');
		const pipe = JSON.parse(text) as Pipe;
		pipe.sourceFile = file;
		pipes.push(pipe);
	}
	return pipes;
}

function failedResult(briefId: string, reason: string): BriefResult {
	return { briefId, validatePass: false, structuralFailures: [`runner: ${reason}`], nodeCountOk: false, providersOk: false, toolCalls: [], pass: false };
}

export async function runBrief(brief: EvalBrief, opts: RunnerOpts): Promise<BriefResult> {
	const recordingsRoot = opts.recordingsRoot ?? RECORDINGS_ROOT;
	const briefRecordingsDir = path.join(recordingsRoot, brief.id);

	// Resolved FIRST, before any workspace/temp-dir/process is created: live mode with no real
	// engine wired up is an infrastructure error that must abort immediately, not leak a temp dir
	// on its way out.
	const engine = await startEngineForBrief(opts, brief.id, briefRecordingsDir);
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `rr-eval-${brief.id}-`));
	const recorder = await startToolCallRecorder(engine.upstreamUrl);

	let missReason: string | undefined;
	let modelServer: { url: string; close(): Promise<void> } | undefined;
	let anthropicKey = 'dummy-replay-key';
	if (opts.mode === 'replay') {
		modelServer = await startReplayModelServer({
			mode: 'replay',
			briefId: brief.id,
			recordingsDir: briefRecordingsDir,
			onMiss: (info) => {
				missReason = info.message;
			},
		});
	} else if (opts.record) {
		anthropicKey = process.env.RR_EVAL_TEAM_ANTHROPIC_KEY ?? process.env.AGENT_ANTHROPIC_KEY ?? '';
		modelServer = await startReplayModelServer({
			mode: 'proxy-record',
			briefId: brief.id,
			recordingsDir: briefRecordingsDir,
			realBaseUrl: 'https://api.anthropic.com',
			realApiKey: anthropicKey,
		});
	} else {
		anthropicKey = process.env.AGENT_ANTHROPIC_KEY ?? '';
	}

	const cfg = loadConfig({
		RR_MCP_UPSTREAM: recorder.url,
		RR_AGENT_DATA_DIR: dataDir,
		OPENCODE_BIN: opts.opencodeBin ?? process.env.OPENCODE_BIN ?? 'opencode',
	});
	// VERIFY V1: additive-only — buildConfigContent() (src/opencode.ts) merges this into
	// provider.anthropic.options.baseURL AFTER the deny-wall/fail-closed checks already passed.
	if (modelServer) cfg.providerBaseUrlOverride = { anthropic: `${modelServer.url}/v1` };

	const keys: KeyResolver = { resolve: async (): Promise<InferenceSettings> => ({ keys: { anthropic: anthropicKey } }) };
	const index = new MemorySessionIndex();
	const manager = new SessionManager({
		cfg,
		keys,
		index,
		storeFactory: brief.seedPipe ? fixtureStoreFactory(brief.seedPipe) : async () => ({ fsReadString: async () => '', fsWriteString: async () => undefined, close: async () => undefined }),
	});

	const identity: Identity = { ownerId: 'eval', tenantId: 'eval' };
	let sessionId: string | undefined;
	try {
		const record = await manager.create({
			identity,
			credential: 'eval-credential',
			pipePath: brief.seedPipe ? `eval-seed/${brief.seedPipe}` : undefined,
			title: brief.id,
		});
		sessionId = record.sessionId;
		const live = manager.getLive(record.sessionId);
		if (!live) throw new Error('SessionManager.create() succeeded but left no live session — infra error');

		const opencodeSessionId = await createOpencodeSession(live, brief.id);
		await sendPromptAsync(live, opencodeSessionId, brief.prompt);
		await waitForIdle({
			baseUrl: live.baseUrl,
			password: live.password,
			sessionId: opencodeSessionId,
			timeoutMs: timeoutMsFor(opts.mode),
			isAborted: () => missReason,
		});

		const pipes = await readWorkspacePipes(live.workspaceDir);
		const lastValidate = [...recorder.calls].reverse().find((c) => c.tool === 'validate_pipeline');
		const validatePass = lastValidate?.ok ?? false;

		let result: BriefResult;
		try {
			result = scorePipe(pipes, brief, validatePass, recorder.calls);
		} catch (err) {
			result = failedResult(brief.id, `scorePipe threw: ${String(err)}`);
			result.toolCalls = recorder.calls;
		}
		if (opts.mode === 'live' && brief.runnable) {
			result.runSuccess = recorder.calls.some((c) => c.tool === 'run_pipeline' && c.ok);
		}
		return result;
	} catch (err) {
		return failedResult(brief.id, String(err instanceof Error ? err.message : err));
	} finally {
		if (sessionId) await manager.destroy(sessionId).catch(() => undefined);
		await recorder.close().catch(() => undefined);
		await engine.close().catch(() => undefined);
		await modelServer?.close().catch(() => undefined);
		await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export interface RunSuiteOpts extends RunnerOpts {
	briefs?: EvalBrief[];
}

export async function runSuite(opts: RunSuiteOpts): Promise<SuiteReport> {
	const briefs = opts.briefs ?? BRIEFS;
	const results: BriefResult[] = [];
	for (const brief of briefs) {
		results.push(await runBrief(brief, opts));
	}
	return scoreSuite(opts.mode, results);
}
