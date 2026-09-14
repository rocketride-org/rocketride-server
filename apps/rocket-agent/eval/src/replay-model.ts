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
 * The eval replay model server (Phase 5, Task 5.1b).
 *
 * Speaks the provider wire format opencode's anthropic client sends (VERIFY V1 — confirmed
 * against the pinned opencode release's own docs: "Providers > Config > Base URL" documents
 * `provider.anthropic.options.baseURL` as the supported override point, default
 * `https://api.anthropic.com/v1`; the underlying `@ai-sdk/anthropic` client appends `/messages`
 * to that base). This server does NOT hardcode that path — it keys every request purely on its
 * JSON body (`transcriptKey()`), so it is agnostic to which exact path the client posts to,
 * which also makes it a drop-in openai-compatible fallback (VERIFY V1 note: an
 * `@ai-sdk/openai-compatible` custom provider would hit `/chat/completions` instead — same
 * body-keyed replay logic applies unchanged).
 *
 * Two modes:
 *  - `replay` (KEYLESS, deterministic, the CI/regression path): looks up
 *    `eval/recordings/<briefId>/<transcriptKey>.json`. A miss means the brief's prompt/model/
 *    tool-set drifted since the transcript was recorded — this is a HARD failure, not a
 *    fallback: respond 404 and invoke `onMiss` synchronously so the runner can fail fast
 *    instead of burning the full per-brief timeout waiting on a session that can never
 *    progress.
 *  - `proxy-record` (the ONLY path that touches a real key, opt-in via `--record`, never run in
 *    CI/replay): forwards verbatim to the real provider and persists the exact
 *    request/response pair keyed the same way, so a later replay run hits it.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { transcriptKey } from './transcripts';

export interface RecordedTranscript {
	briefId: string;
	transcriptKey: string;
	/** Debug aid only — never consulted for matching. Helps a human `ls`+skim recordings and re-record the right one. */
	debugSummary?: string;
	status: number;
	/** Response headers to replay, already stripped of hop-by-hop headers. */
	headers: Record<string, string>;
	stream: boolean;
	/** Non-stream response body, raw text (verbatim). */
	bodyText?: string;
	/** Stream response body, raw SSE bytes (verbatim) — replayed exactly as recorded, frame for frame. */
	sseRaw?: string;
}

export interface ReplayModelOpts {
	mode: 'replay' | 'proxy-record';
	briefId: string;
	/** `eval/recordings/<briefId>` — recordings live directly in this directory, one file per transcriptKey. */
	recordingsDir: string;
	/** proxy-record only: real provider base (e.g. `https://api.anthropic.com`). */
	realBaseUrl?: string;
	/** proxy-record only: the team key forwarded to the real provider. Never logged, never persisted alongside the recording. */
	realApiKey?: string;
	/** replay only: fired synchronously on a transcript miss, before the 404 is written — lets the runner fail fast instead of waiting out the full per-brief timeout. */
	onMiss?: (info: { briefId: string; key: string; message: string }) => void;
}

export interface ReplayModelServer {
	url: string;
	close(): Promise<void>;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding']);

function recordingPath(recordingsDir: string, key: string): string {
	return path.join(recordingsDir, `${key}.json`);
}

function missMessage(briefId: string, key: string): string {
	return (
		`[replay-model] no recorded transcript for brief "${briefId}" (transcriptKey ${key}). ` +
		`The prompt, model, or tool set has drifted since this transcript was recorded — ` +
		`re-record it with: pnpm --filter rocket-agent eval:record -- --brief ${briefId}`
	);
}

async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

function filteredResponseHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((v, k) => {
		if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
	});
	return out;
}

async function handleReplay(opts: ReplayModelOpts, req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer): Promise<void> {
	let parsedBody: unknown;
	try {
		parsedBody = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
	} catch {
		parsedBody = { __unparsable: rawBody.toString('utf8') };
	}
	const key = transcriptKey(opts.briefId, parsedBody);
	const file = recordingPath(opts.recordingsDir, key);
	if (!fs.existsSync(file)) {
		const message = missMessage(opts.briefId, key);
		console.error(message);
		opts.onMiss?.({ briefId: opts.briefId, key, message });
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message } }));
		return;
	}
	const recorded = JSON.parse(await fsp.readFile(file, 'utf8')) as RecordedTranscript;
	res.writeHead(recorded.status, recorded.headers);
	res.end(recorded.stream ? (recorded.sseRaw ?? '') : (recorded.bodyText ?? ''));
}

async function handleProxyRecord(opts: ReplayModelOpts, req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer): Promise<void> {
	if (!opts.realBaseUrl || !opts.realApiKey) {
		res.writeHead(500, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'proxy-record mode requires realBaseUrl + realApiKey' } }));
		return;
	}
	let parsedBody: unknown;
	try {
		parsedBody = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
	} catch {
		parsedBody = {};
	}
	const key = transcriptKey(opts.briefId, parsedBody);

	const forwardHeaders: Record<string, string> = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (typeof v !== 'string') continue;
		if (['host', 'content-length', 'x-api-key', 'authorization'].includes(k.toLowerCase())) continue;
		forwardHeaders[k] = v;
	}
	// The real provider auth header — the ONLY place a real key is ever used in this whole module.
	forwardHeaders['x-api-key'] = opts.realApiKey;

	let upstream: Response;
	try {
		upstream = await fetch(`${opts.realBaseUrl}${req.url ?? ''}`, { method: req.method, headers: forwardHeaders, body: rawBody.length ? rawBody : undefined });
	} catch (err) {
		res.writeHead(502, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `proxy-record upstream unreachable: ${String(err)}` } }));
		return;
	}

	const isStream = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
	const bodyBuf = Buffer.from(await upstream.arrayBuffer());
	const headers = filteredResponseHeaders(upstream.headers);

	const recorded: RecordedTranscript = {
		briefId: opts.briefId,
		transcriptKey: key,
		debugSummary: summarizeForDebug(parsedBody),
		status: upstream.status,
		headers,
		stream: isStream,
		...(isStream ? { sseRaw: bodyBuf.toString('utf8') } : { bodyText: bodyBuf.toString('utf8') }),
	};
	await fsp.mkdir(opts.recordingsDir, { recursive: true });
	await fsp.writeFile(recordingPath(opts.recordingsDir, key), JSON.stringify(recorded, null, 2), 'utf8');

	res.writeHead(upstream.status, headers);
	res.end(bodyBuf);
}

/** Best-effort last-user-text-message summary, purely so a human skimming `eval/recordings/<brief>/*.json` can tell turns apart. Never consulted for matching. */
function summarizeForDebug(body: unknown): string | undefined {
	const messages = (body as { messages?: unknown[] } | undefined)?.messages;
	if (!Array.isArray(messages) || messages.length === 0) return undefined;
	const last = messages[messages.length - 1] as { role?: string; content?: unknown };
	const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
	return `${last.role ?? '?'}: ${text.slice(0, 120)}`;
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

export async function startReplayModelServer(opts: ReplayModelOpts): Promise<ReplayModelServer> {
	if (opts.mode === 'replay') await fsp.mkdir(opts.recordingsDir, { recursive: true }).catch(() => undefined);
	const server = http.createServer((req, res) => {
		void (async () => {
			try {
				const rawBody = await readRawBody(req);
				if (opts.mode === 'replay') await handleReplay(opts, req, res, rawBody);
				else await handleProxyRecord(opts, req, res, rawBody);
			} catch (err) {
				console.error('[replay-model] request handler failed', err);
				if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'replay-model internal error' } }));
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
