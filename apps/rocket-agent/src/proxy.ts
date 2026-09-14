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

import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { log } from './log';

/**
 * Task 5.2a: reads a raw Express request body fully into memory. Only used on the two proxy
 * paths that carry small, single JSON-RPC (or JSON) control messages — MCP `tools/call` and
 * the opencode `prompt_async`/`permissions` replies — never on a route that could see a real
 * upload. Once consumed, `req`'s own stream is spent; hand the returned buffer back to
 * `forward()`'s `bodyOverride` to actually deliver it upstream.
 */
export async function readRequestBody(req: Request): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

export interface JsonRpcRequestFrame {
	method?: string;
	params?: { name?: string; arguments?: Record<string, unknown> };
}

/** Parses a JSON-RPC request body, tolerantly — undefined for anything that isn't valid JSON (empty bodies, non-JSON-RPC noise). */
export function parseJsonRpcRequest(raw: Buffer): JsonRpcRequestFrame | undefined {
	if (raw.length === 0) return undefined;
	try {
		return JSON.parse(raw.toString('utf8')) as JsonRpcRequestFrame;
	} catch {
		return undefined;
	}
}

/**
 * True when a parsed frame is a `tools/call` invocation with a tool name — the one MCP method
 * both the production audit tap (index.ts) and 5.1b's eval ToolCallRecorder (eval/src/runner.ts)
 * tap. Sharing this (and `parseJsonRpcRequest`/`isToolCallResponseOk` below) is Task 5.2a's
 * "one seam, not two" unification: both taps parse the wire format the same way.
 */
export function isToolCallRequest(
	frame: JsonRpcRequestFrame | undefined,
): frame is JsonRpcRequestFrame & { method: 'tools/call'; params: { name: string; arguments?: Record<string, unknown> } } {
	return frame?.method === 'tools/call' && typeof frame.params?.name === 'string';
}

/**
 * Best-effort ok/error read of a `tools/call` JSON-RPC response body (the MCP tool-result
 * envelope: `{error}` or `{result:{isError}}`). `fallback` is returned for a non-JSON or
 * unparseable body — callers pass their own HTTP-status-derived signal so a stream they never
 * buffered still gets a reasonable answer.
 */
export function isToolCallResponseOk(raw: string, fallback: boolean): boolean {
	try {
		const parsed = JSON.parse(raw) as { error?: unknown; result?: { isError?: boolean } };
		return !parsed.error && !parsed.result?.isError;
	} catch {
		return fallback;
	}
}

// Response headers we never mirror back verbatim (connection-management + the
// content-encoding fetch already transparently decoded for us).
const HOP_BY_HOP_RESPONSE = new Set([
	'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
	'proxy-authorization', 'te', 'trailer', 'content-encoding', 'content-length',
]);

/**
 * Request headers forwarded toward the session's own opencode server. Deliberately an
 * ALLOW-list (not a deny-list): the browser's SaaS/Zitadel session cookie and its raw
 * `authorization` bearer must never reach the sandboxed opencode child. `authorization`
 * is re-added by the caller's `setHeaders` (stamped Basic auth) after this filter runs.
 */
export const PANEL_TO_OPENCODE_HEADERS = new Set(['content-type', 'accept']);

/**
 * Request headers forwarded from opencode toward the EAAS MCP upstream. Same allow-list
 * rationale: opencode never had a cookie to begin with, but keep this an explicit list
 * (not "everything opencode sends") so nothing new leaks in without a deliberate change here.
 * `last-event-id` is part of the MCP Streamable HTTP spec's SSE-resumption handshake —
 * dropping it silently would break reconnects after a dropped stream.
 */
export const OPENCODE_TO_MCP_HEADERS = new Set(['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']);

/** JSON-Schema keywords OpenAI's function-calling forbids at the TOP LEVEL of a tool's parameters. */
const OPENAI_UNSUPPORTED_TOP_LEVEL = ['anyOf', 'oneOf', 'allOf', 'not', 'enum', 'const'] as const;

/**
 * Make one tool inputSchema OpenAI-compatible. OpenAI requires the top-level parameters schema to be
 * `type:"object"` with none of {@link OPENAI_UNSUPPORTED_TOP_LEVEL} at the top level (NESTED uses are
 * fine and left untouched). Several RocketRide engine tools (e.g. `deploy_add`, `validate_pipeline`)
 * express "field A OR field B required" as a top-level `anyOf` — valid JSON Schema, but it makes
 * OpenAI reject the ENTIRE request. Stripping the top-level keyword drops only the cross-field
 * constraint; the `properties` (what the model actually fills in) remain intact.
 */
function sanitizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const out = { ...schema };
	for (const k of OPENAI_UNSUPPORTED_TOP_LEVEL) delete out[k];
	out.type = 'object';
	if (out.properties === undefined) out.properties = {};
	return out;
}

/**
 * Rewrite a buffered MCP `tools/list` SSE response so every tool's inputSchema is OpenAI-compatible
 * (see {@link sanitizeToolSchema}). Each `data: {json}` frame carrying a `result.tools` array is
 * rewritten in place; every other frame passes through untouched, and any JSON parse failure leaves
 * the frame as-is (fails open to the pre-shim behavior). rocket-agent is the BYO-agent gateway, so
 * this is the right layer to make the engine's tools usable by strict OpenAI-family models.
 */
export function sanitizeMcpToolSchemas(rawSse: string): string {
	return rawSse.replace(/^(data: )(.+)$/gm, (full, prefix: string, json: string) => {
		try {
			const obj = JSON.parse(json) as { result?: { tools?: Array<{ inputSchema?: Record<string, unknown> }> } };
			const tools = obj?.result?.tools;
			if (Array.isArray(tools)) {
				for (const t of tools) if (t && t.inputSchema && typeof t.inputSchema === 'object') t.inputSchema = sanitizeToolSchema(t.inputSchema);
				return prefix + JSON.stringify(obj);
			}
		} catch {
			/* not the tools/list result frame — leave untouched */
		}
		return full;
	});
}

/**
 * Final-review fix (Important 5): opencode resolves the locked config's
 * `{env:AGENT_ANTHROPIC_KEY}` / `{env:AGENT_OPENAI_KEY}` placeholders into
 * `provider.<id>.options.apiKey` and serves the RESOLVED value on GET /config and
 * /config/providers — confirmed live against the pinned binary through the actual
 * pass-through proxy. The browser never needs this value (inference calls happen
 * server-side inside the opencode child), so it is redacted wherever it appears,
 * recursively, regardless of which endpoint or future opencode version surfaces it.
 */
export function redactApiKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactApiKeys);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = k === 'apiKey' && typeof v === 'string' && v ? '[redacted]' : redactApiKeys(v);
		}
		return out;
	}
	return value;
}

/**
 * Stream-forward a request. Bodies and SSE responses are piped, never buffered.
 * `setHeaders` are stamped AFTER the allow-list filter — this is where server-side
 * credential injection happens (basic auth toward opencode, Bearer toward EAAS MCP).
 *
 * Never rejects: upstream connect failures and mid-stream upstream errors are caught
 * here and turned into a 502 (or, once the response has already started, a clean
 * `res.destroy()`) — Express 4 does not forward async-handler rejections to any error
 * middleware, so an unhandled rejection here would crash the whole process, not just
 * this session (a dead opencode child or unreachable MCP upstream would otherwise take
 * every tenant down with it).
 *
 * Aborts the upstream request/stream the moment the client disconnects (`res` 'close'),
 * so a reloaded panel tab never leaks a held-open SSE connection to opencode/MCP.
 *
 * `bodyOverride` (Task 5.2a): when the caller already consumed `req`'s stream itself (to peek
 * a small JSON-RPC control message for the audit tap), it hands the buffered bytes back here
 * instead of re-streaming `req` — which is spent by that point. Every other caller leaves this
 * unset and keeps the original zero-copy streaming behavior.
 */
export async function forward(
	req: Request,
	res: Response,
	targetUrl: string,
	setHeaders: Record<string, string>,
	allowRequestHeaders: ReadonlySet<string>,
	bodyOverride?: Buffer,
	/**
	 * When set, the upstream response is BUFFERED and passed through this transform before being
	 * sent (instead of streamed). Used to rewrite the MCP `tools/list` response (schema shim) —
	 * only for small control messages; never for streaming tool results.
	 */
	transformBody?: (raw: string) => string,
): Promise<number> {
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (typeof v === 'string' && allowRequestHeaders.has(k.toLowerCase())) headers[k] = v;
	}
	Object.assign(headers, setHeaders);

	const controller = new AbortController();
	const abortOnClientClose = () => controller.abort();
	res.once('close', abortOnClientClose);

	const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, signal: controller.signal };
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		if (bodyOverride) {
			// Node 22 undici throws "Cannot perform ArrayBuffer.prototype.slice on a detached
			// ArrayBuffer" when a BINARY body (Uint8Array/Buffer/ArrayBuffer) is sent to an upstream
			// that replies with a streamed/SSE response — which the real engine's /mcp does (the dev
			// stub replied with plain JSON, so this only surfaced against the real engine). A string
			// body sidesteps it, and bodyOverride is always UTF-8 JSON-RPC here (buffered by the MCP
			// route for the audit tap), so decoding to text is lossless.
			init.body = bodyOverride.toString('utf8');
		} else {
			init.body = Readable.toWeb(req) as unknown as RequestInit['body'];
			init.duplex = 'half';
		}
	}

	let upstream: Awaited<ReturnType<typeof fetch>>;
	try {
		upstream = await fetch(targetUrl, init);
	} catch (err) {
		// Visibility: a dead/unreachable upstream (engine MCP down, wrong URL) previously returned
		// a bare 502 with no trace of WHY — log the reason (secrets auto-redacted by `log`).
		log.error(`[proxy] upstream fetch failed (${targetUrl}):`, (err as Error).message);
		res.off('close', abortOnClientClose);
		if (!res.headersSent) res.status(502).json({ error: 'upstream unavailable' });
		else if (!res.writableEnded) res.end();
		return 502;
	}

	res.status(upstream.status);
	upstream.headers.forEach((v, k) => {
		// When transforming, the body length/encoding changes — never copy content-length or a
		// content-encoding (fetch already decoded the body), or the client would mis-read it.
		if (HOP_BY_HOP_RESPONSE.has(k)) return;
		if (transformBody && (k === 'content-length' || k === 'content-encoding')) return;
		res.setHeader(k, v);
	});

	// Buffered transform path (e.g. MCP tools/list schema shim): read the whole response, rewrite
	// it, and send in one shot. Only used for small control messages.
	if (transformBody) {
		res.off('close', abortOnClientClose);
		const raw = await upstream.text();
		let out = raw;
		try {
			out = transformBody(raw);
		} catch (err) {
			log.error('[proxy] response transform failed — passing through unmodified:', (err as Error).message);
		}
		res.end(out);
		return upstream.status;
	}

	res.flushHeaders();

	if (!upstream.body) {
		res.off('close', abortOnClientClose);
		res.end();
		return upstream.status;
	}

	// Past this point the request phase is over — hand disconnect-cleanup off to the
	// live Node Readable directly (destroying it cancels the underlying fetch reader,
	// which is simpler and more direct than relying on the (still-armed) AbortController).
	res.off('close', abortOnClientClose);

	return new Promise<number>((resolve) => {
		const src = Readable.fromWeb(upstream.body as never);
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			res.off('close', onClientDisconnect);
			resolve(upstream.status);
		};
		const onClientDisconnect = () => { if (!src.destroyed) src.destroy(); };
		res.once('close', onClientDisconnect);
		// A mid-stream upstream failure must NOT crash the process (unhandled 'error' on
		// an EventEmitter with no listener throws) — destroy the client response cleanly.
		src.on('error', () => { if (!res.writableEnded) res.destroy(); finish(); });
		src.on('close', finish);
		src.pipe(res);
	});
}
