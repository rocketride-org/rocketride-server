// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// AGENT API — authenticated fetch wrapper + SSE reader for rocket-agent
// =============================================================================
//
// Thin client over the rocket-agent HTTP API (Phase 3). No EventSource: it
// cannot send an Authorization header, and every rocket-agent SSE stream is
// Bearer-authenticated, so `readSse` drives a fetch + ReadableStream reader
// by hand. Every request goes through `call`, which never lets the token
// leak into a thrown error message.
// =============================================================================

import { ConnectionManager } from 'shell';
import type { AgentSessionRecord } from './agentTypes';

/** rocket-agent base: same-origin in SaaS; OSS dev override baked in via rsbuild define. */
export function agentBase(): string {
	return (process.env.REACT_APP_AGENT_URL as string | undefined) ?? ConnectionManager.getInstance().getHttpUrl();
}

/**
 * A failed rocket-agent HTTP call, carrying the response status so callers
 * can branch on it (429 tenant cap, 412 no inference key, 401/403/404
 * owner-scoped errors) without parsing the message string. `message` never
 * contains the request's headers or Bearer token.
 */
export class AgentApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'AgentApiError';
	}
}

async function call<T>(method: string, path: string, body?: unknown, rawBody?: string, signal?: AbortSignal): Promise<T> {
	const outBody = rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined);
	const res = await fetch(`${agentBase()}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${ConnectionManager.getInstance().loadToken()}`,
			...(outBody !== undefined ? { 'content-type': 'application/json' } : {}),
		},
		// exactOptionalPropertyTypes: RequestInit.body/signal have no explicit
		// `| undefined`, so the keys must be omitted rather than set to
		// undefined when there's no body / no caller-supplied signal.
		...(outBody !== undefined ? { body: outBody } : {}),
		...(signal !== undefined ? { signal } : {}),
	});
	if (res.status === 204) return undefined as T;
	if (!res.ok) throw new AgentApiError(res.status, `agent api ${method} ${path}: ${res.status} ${await res.text().catch(() => '')}`);
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		return text as unknown as T;
	}
}

export const agentApi = {
	list: (signal?: AbortSignal) => call<AgentSessionRecord[]>('GET', '/agent/sessions', undefined, undefined, signal),
	create: (opts: { pipePath?: string; title?: string }, signal?: AbortSignal) => call<AgentSessionRecord & { url: string }>('POST', '/agent/sessions', opts, undefined, signal),
	resume: (id: string, signal?: AbortSignal) => call<AgentSessionRecord & { url: string }>('POST', `/agent/sessions/${id}/resume`, undefined, undefined, signal),
	archive: (id: string, signal?: AbortSignal) => call<void>('DELETE', `/agent/sessions/${id}`, undefined, undefined, signal),
	/** Hard-delete: removes the transcript + workspace and drops the record (NOT resumable). `archive` keeps it resumable. */
	remove: (id: string, signal?: AbortSignal) => call<void>('DELETE', `/agent/sessions/${id}?purge=true`, undefined, undefined, signal),
	rename: (id: string, title: string, signal?: AbortSignal) => call<AgentSessionRecord>('PATCH', `/agent/sessions/${id}`, { title }, undefined, signal),
	health: (id: string, signal?: AbortSignal) => call<{ status: string; opencode: boolean; engine?: 'real' | 'stub' }>('GET', `/agent/sessions/${id}/health`, undefined, undefined, signal),
	save: (id: string, signal?: AbortSignal) => call<{ pipes: string[] }>('POST', `/agent/sessions/${id}/save`, undefined, undefined, signal), // D2
	turns: (id: string, signal?: AbortSignal) => call<Array<{ sha: string; label: string; at: number }>>('GET', `/agent/sessions/${id}/turns`, undefined, undefined, signal), // D3
	revert: (id: string, sha: string, signal?: AbortSignal) => call<{ sha: string }>('POST', `/agent/sessions/${id}/revert`, { sha }, undefined, signal), // D3
	writeFile: (id: string, rel: string, content: string, signal?: AbortSignal) => call<{ ok: true; snapshot: string | null }>('PUT', `/agent/sessions/${id}/files/${rel}`, undefined, content, signal),
	oc: <T>(id: string, method: string, suffix: string, body?: unknown, signal?: AbortSignal) => call<T>(method, `/agent/sessions/${id}/opencode${suffix}`, body, undefined, signal),
	/** Visibility: the opencode agents this session loaded — if rr-builder is absent, seeding failed. */
	listAgents: (id: string, signal?: AbortSignal) => call<Array<{ name: string; mode?: string }>>('GET', `/agent/sessions/${id}/opencode/agent`, undefined, undefined, signal),
};

/**
 * Bearer-authenticated SSE reader.
 *
 * EventSource cannot send an Authorization header, so every rocket-agent SSE
 * endpoint is read via fetch + a manual ReadableStream pump instead. Frames
 * are nameless `data:` lines; callers key off the parsed payload's `.type`.
 * The read loop stops as soon as `signal` aborts — callers own cleanup by
 * aborting on unmount/session change, which also cancels the underlying
 * fetch and releases the reader.
 *
 * @param path - Path appended to {@link agentBase}, e.g. `/agent/sessions/:id/events`.
 * @param onEvent - Called with each parsed JSON frame; non-JSON frames (comments) are ignored.
 * @param signal - Aborts the fetch and ends the read loop.
 */
export async function readSse(path: string, onEvent: (e: unknown) => void, signal: AbortSignal): Promise<void> {
	const res = await fetch(`${agentBase()}${path}`, {
		headers: { authorization: `Bearer ${ConnectionManager.getInstance().loadToken()}`, accept: 'text/event-stream' },
		signal,
	});
	if (!res.ok || !res.body) throw new AgentApiError(res.status, `sse ${path}: ${res.status}`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break; // any unterminated trailing frame left in `buf` is dropped — the server always ends frames with \n\n
			buf += decoder.decode(value, { stream: true });
			let idx: number;
			// A single chunk can hold several buffered frames, which would
			// otherwise all drain synchronously before the next reader.read()
			// has a chance to observe an abort fired mid-chunk.
			while (!signal.aborted && (idx = buf.indexOf('\n\n')) >= 0) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const data = frame
					.split('\n')
					.filter((l) => l.startsWith('data: '))
					.map((l) => l.slice(6))
					.join('\n');
				if (!data) continue;
				try {
					onEvent(JSON.parse(data));
				} catch {
					/* comment / non-JSON frame */
				}
			}
		}
	} finally {
		// Abort (unmount/session change) rejects reader.read() and lands here;
		// release the lock so the aborted fetch's stream can fully tear down.
		reader.releaseLock();
	}
}
