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
 * Task 5.2a — per-session tool-call audit trail.
 *
 * Deliberate privacy stance (pinned by the task brief): raw tool/prompt arguments are NEVER
 * stored — they can embed document text or, worse, a secret pasted into a prompt. Only a
 * sha256 digest of the canonicalized args (+ an allowlisted set of workspace-relative `.pipe`
 * paths) is kept. This is the *action* trail (who/what/when); the per-turn git log (Phase 3,
 * see workspace.ts) remains the *content* trail.
 */

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { log } from './log';

export interface AuditRecord {
	ts: string; // ISO
	sessionId: string;
	tenantId: string; // org id
	userId: string;
	kind: 'mcp.tool' | 'agent.prompt' | 'agent.permission' | 'lifecycle';
	action: string; // e.g. 'validate_pipeline', 'run_pipeline', 'session.create'
	argsDigest: string; // sha256 of canonicalized args — WHO/WHAT/WHEN without payload
	pipePaths?: string[]; // workspace-relative .pipe files referenced (allowlisted detail)
	status: 'ok' | 'error' | 'denied';
	durationMs?: number;
}

export interface AuditSink {
	write(records: AuditRecord[]): Promise<void>;
	flush(): Promise<void>;
}

/** Recursively sorts object keys so semantically-identical args digest identically regardless of client key order — mirrors eval/src/transcripts.ts's normalizeRequestBody, kept independent (production code must never import from eval/). */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = canonicalize((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/**
 * sha256 hex digest of a canonicalized value. This is the ONLY trace tool-call / prompt
 * arguments leave in the audit trail — see the module docstring's privacy stance. Full 64-hex
 * digest (not truncated, unlike eval's lookup-key `stableDigest`): this one is meant as
 * tamper-evidence, not a cache key.
 */
export function digestArgs(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(canonicalize(value ?? null))).digest('hex');
}

/**
 * Extracts bare, workspace-relative `*.pipe` path strings referenced anywhere in a tool
 * call's args — the one allowlisted detail kept alongside the digest. The regex only matches
 * whole strings that LOOK like a relative path ending in `.pipe` (no leading `/`, no `..`
 * segments) — it can never match arbitrary prose or embedded document text, so this stays
 * privacy-safe even though it walks into the args tree.
 */
export function extractPipePaths(value: unknown, cap = 20): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const visit = (v: unknown, depth: number): void => {
		if (found.length >= cap || depth > 6) return;
		if (typeof v === 'string') {
			if (/^[A-Za-z0-9][\w.-]*(\/[A-Za-z0-9][\w.-]*)*\.pipe$/.test(v) && !v.includes('..') && !seen.has(v)) {
				seen.add(v);
				found.push(v);
			}
			return;
		}
		if (Array.isArray(v)) {
			for (const item of v) visit(item, depth + 1);
			return;
		}
		if (v && typeof v === 'object') {
			for (const val of Object.values(v as Record<string, unknown>)) visit(val, depth + 1);
		}
	};
	visit(value, 0);
	return found;
}

/**
 * `<dataDir>/audit/YYYY-MM-DD.ndjson`, append-only, one file per UTC day. The day is taken
 * from the record's own `ts` (not wall-clock-at-write), so a burst of records queued right at
 * midnight never splits non-deterministically across two files.
 */
export class NdjsonSink implements AuditSink {
	private handle: fsp.FileHandle | undefined;
	private handleDate = '';

	constructor(private readonly dataDir: string) {}

	private async ensureHandle(date: string): Promise<fsp.FileHandle> {
		if (this.handle && this.handleDate === date) return this.handle;
		if (this.handle) await this.handle.close().catch(() => undefined);
		const dir = path.join(this.dataDir, 'audit');
		await fsp.mkdir(dir, { recursive: true });
		this.handle = await fsp.open(path.join(dir, `${date}.ndjson`), 'a');
		this.handleDate = date;
		return this.handle;
	}

	async write(records: AuditRecord[]): Promise<void> {
		if (records.length === 0) return;
		const byDate = new Map<string, AuditRecord[]>();
		for (const r of records) {
			const date = r.ts.slice(0, 10);
			const bucket = byDate.get(date);
			if (bucket) bucket.push(r);
			else byDate.set(date, [r]);
		}
		for (const [date, bucket] of byDate) {
			const handle = await this.ensureHandle(date);
			const lines = bucket.map((r) => JSON.stringify(r)).join('\n') + '\n';
			await handle.appendFile(lines, 'utf8');
		}
	}

	/** fsync the currently-open day file — the durability guarantee `record()` callers rely on when they explicitly flush. */
	async flush(): Promise<void> {
		if (this.handle) await this.handle.sync();
	}

	/** Test-only: release the open file handle. Not part of AuditSink — callers that need it never leak a fd across suites. */
	async close(): Promise<void> {
		if (this.handle) {
			await this.handle.close();
			this.handle = undefined;
			this.handleDate = '';
		}
	}
}

/** In-memory sink: tests, and eval's ToolCallRecorder (Task 5.2a unifies the two `tools/call` taps — see eval/src/runner.ts). No I/O. */
export class InMemorySink implements AuditSink {
	readonly records: AuditRecord[] = [];

	async write(records: AuditRecord[]): Promise<void> {
		this.records.push(...records);
	}

	async flush(): Promise<void> {
		/* nothing buffered — write() already appended synchronously */
	}
}

export interface SaasSinkOpts {
	url: string;
	/** Bearer token for the internal service-auth header — same static-token pattern as `google_oauth.py`'s `RR_LAMBDA_SERVICE_TOKEN` guard (see `RR_AGENT_SERVICE_TOKEN` in config.ts). */
	serviceToken: string;
	batchSize?: number;
	flushIntervalMs?: number;
	/** Test seam — defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * Batches records and POSTs `{records: AuditRecord[]}` to `RR_AUDIT_URL` (cluster-internal
 * ALB route). Flushes at `batchSize` (default 100) or every `flushIntervalMs` (default 5s),
 * whichever comes first.
 *
 * NEVER throws into the request path: `write()` only ever enqueues in memory and returns —
 * the network call happens later, off a timer, and every failure there is caught, logged, and
 * the batch is RETAINED (oldest records dropped once the retry buffer exceeds
 * `MAX_RETAINED`) rather than lost silently or re-thrown at a caller who has long since moved
 * on to the next request.
 */
export class SaasSink implements AuditSink {
	private static readonly MAX_RETAINED = 10_000;
	private buffer: AuditRecord[] = [];
	private timer: NodeJS.Timeout | undefined;
	private readonly batchSize: number;
	private readonly flushIntervalMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly opts: SaasSinkOpts) {
		this.batchSize = opts.batchSize ?? 100;
		this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	private retain(records: AuditRecord[]): void {
		this.buffer.push(...records);
		if (this.buffer.length > SaasSink.MAX_RETAINED) {
			this.buffer.splice(0, this.buffer.length - SaasSink.MAX_RETAINED); // drop-oldest
		}
	}

	async write(records: AuditRecord[]): Promise<void> {
		if (records.length === 0) return;
		this.retain(records);
		if (this.buffer.length >= this.batchSize) {
			await this.flush();
			return;
		}
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, this.flushIntervalMs);
		this.timer.unref();
	}

	/** Sends everything currently buffered (up to `batchSize` at a time), retrying the rest on the interval. Never throws — a POST failure is logged and the batch goes back on the buffer for the next attempt. */
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		while (this.buffer.length > 0) {
			const batch = this.buffer.splice(0, this.batchSize);
			try {
				const res = await this.fetchImpl(this.opts.url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.serviceToken}` },
					body: JSON.stringify({ records: batch }),
				});
				if (!res.ok) throw new Error(`audit POST failed: ${res.status}`);
			} catch (err) {
				log.error('[audit] SaasSink flush failed — retaining batch for retry', err);
				this.retain(batch); // put it back (oldest-first) and stop draining for this call
				this.scheduleFlush();
				return;
			}
		}
	}
}

export class Auditor {
	constructor(private readonly sink: AuditSink) {}

	/**
	 * Fire-and-forget: stamps `ts` and hands the record to the sink. NEVER throws or rejects
	 * into the caller — a broken (or deliberately throwing, see the isolation test) sink must
	 * never break the request path it is auditing.
	 */
	record(r: Omit<AuditRecord, 'ts'>): void {
		const record: AuditRecord = { ...r, ts: new Date().toISOString() };
		try {
			const result = this.sink.write([record]);
			void Promise.resolve(result).catch((err) => log.error('[audit] sink write rejected', err));
		} catch (err) {
			log.error('[audit] sink write threw synchronously', err);
		}
	}

	async flush(): Promise<void> {
		try {
			await this.sink.flush();
		} catch (err) {
			log.error('[audit] sink flush failed', err);
		}
	}
}
