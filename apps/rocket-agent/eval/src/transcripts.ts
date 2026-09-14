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
 * Pure hashing utilities for the eval replay model server (Phase 5, Task 5.1b).
 *
 * `transcriptKey()` is the SINGLE tuning point (VERIFY V2) for what makes two model requests
 * "the same" during replay: a request recorded during `--mode live --record` must produce the
 * IDENTICAL key when the same brief is replayed later, even though the two HTTP requests are
 * never byte-identical (headers carry request ids, some client libraries stamp a request-scoped
 * `metadata` block, etc.). Nothing here touches the network, the model, or the filesystem.
 */

import { createHash } from 'node:crypto';

/**
 * Field names stripped anywhere in a request body's object tree before hashing/matching.
 * Deliberately an ALLOW-list of exact key names (not a suffix/prefix heuristic) — the request
 * body also carries semantically load-bearing fields that happen to end in "id"
 * (`providerID`, `modelID`, tool_use `id`s that must round-trip through conversation history
 * for the transcript to replay coherently), and a heuristic strip would silently swallow those.
 * Extend this set — and ONLY this set — when a new client library adds a new volatile field.
 */
const VOLATILE_KEYS = new Set([
	'metadata', // AI SDK / provider clients may stamp a per-run { user_id } block here
	'request_id',
	'requestId',
	'x-request-id',
	'nonce',
	'timestamp',
	'idempotency_key',
	'trace_id',
]);

/** Recursively strips `VOLATILE_KEYS` and sorts object keys so semantically-identical bodies hash identically regardless of client-library key ordering. */
export function normalizeRequestBody(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeRequestBody);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			if (VOLATILE_KEYS.has(key)) continue;
			out[key] = normalizeRequestBody((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/** Deterministic JSON.stringify — keys are already sorted by `normalizeRequestBody`, this just serializes. */
function stableStringify(value: unknown): string {
	return JSON.stringify(value);
}

/** sha256 hex digest of a stably-serialized JSON value, truncated to 20 hex chars (80 bits — ample for a per-brief recordings directory). */
export function stableDigest(value: unknown): string {
	return createHash('sha256').update(stableStringify(normalizeRequestBody(value))).digest('hex').slice(0, 20);
}

/**
 * VERIFY V2: the replay lookup key for a single model turn. Scoped by `briefId` so two briefs
 * that happen to send byte-identical requests (e.g. both send an empty system prompt on turn
 * zero) never collide — each brief's recordings live in their own `eval/recordings/<briefId>/`
 * directory, but folding briefId into the digest too is a free extra guard against a future
 * refactor that flattens the directory layout.
 */
export function transcriptKey(briefId: string, requestBody: unknown): string {
	return stableDigest({ briefId, request: requestBody });
}
