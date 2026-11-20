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
// VECTOR-UI — TOOL CALLS of the chat and ingest panels
// =============================================================================
//
// The chat and ingest panels call a handful of tools (the upload collision
// probe, the chunk count after an upload, `embed` and `search` for "Why
// these?"). A tool can fail two ways: the call rejects (an ExplorerToolError
// from the role channel) or it answers a failure envelope `{success: false,
// code, error}`. The panels branch on `code` (NOT_FOUND means "not stored
// yet", RATE_LIMITED carries retry_after_s), so both shapes are folded into
// one outcome that keeps the code whichever way it came.
//
// Calls go through the connection's Tools source; in read-only mode (no
// Tools source running) through the source the connection is anchored on.
// Never retried.
// =============================================================================

import type { IGenerationTicket, IRoleChannel } from 'shared/explorer';
import type { ConsoleModel, VectorChannels } from '../contract/types';

/** A tool call's outcome: the answer, or why there is none. */
export type CallOutcome =
	| { ok: true; value: Record<string, unknown> }
	| {
			ok: false;
			/** The envelope's or the error's machine-readable code, when there is one. */
			code: string | null;
			/** One sentence (the error's headline or the envelope's `error`). */
			message: string;
			detail?: string;
			/** The ExplorerToolError kind when the call rejected ('timeout', 'stale', …), else null. */
			kind: string | null;
			/** The raw failure: the envelope or what was thrown. */
			error: unknown;
	  };

/** Per-call options. */
export interface CallOptions {
	timeoutMs?: number;
	generation?: IGenerationTicket;
}

/**
 * Whether a value is a plain object.
 *
 * @param value - Anything.
 * @returns True for non-null, non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The failure outcome of whatever a call threw.
 *
 * @param error - The rejection.
 * @returns The outcome.
 */
export function outcomeFromError(error: unknown): Extract<CallOutcome, { ok: false }> {
	if (error !== null && typeof error === 'object') {
		const record = error as Record<string, unknown>;
		const message = typeof record.headline === 'string' && record.headline !== '' ? record.headline : typeof record.message === 'string' ? record.message : String(error);
		return {
			ok: false,
			code: typeof record.code === 'string' && record.code !== '' ? record.code : null,
			message,
			...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
			kind: typeof record.kind === 'string' ? record.kind : null,
			error,
		};
	}
	return { ok: false, code: null, message: String(error), kind: null, error };
}

/**
 * Call one tool on one node and fold every failure shape into an outcome.
 *
 * @param channel - The role channel to call through, or null when there is none.
 * @param tool - The tool name.
 * @param input - Its input.
 * @param nodeId - The node to call (the store, or the embedding node).
 * @param options - Timeout and generation.
 * @returns The outcome; never throws.
 */
export async function callTool(channel: IRoleChannel | null, tool: string, input: Record<string, unknown>, nodeId: string | null, options: CallOptions = {}): Promise<CallOutcome> {
	if (channel === null) {
		return { ok: false, code: null, message: 'No Tools source is running for this connection.', kind: 'unavailable', error: null };
	}
	if (nodeId === null || nodeId === '') {
		return { ok: false, code: null, message: `There is no node to call ${tool} on.`, kind: 'malformed', error: null };
	}
	let value: unknown;
	try {
		value = await channel.invoke(tool, input, { nodeId, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.generation !== undefined ? { generation: options.generation } : {}) });
	} catch (error) {
		return outcomeFromError(error);
	}
	if (!isRecord(value)) {
		return { ok: false, code: null, message: `${tool} answered with something other than an object.`, kind: 'malformed', error: value };
	}
	if (value.success === false) {
		return {
			ok: false,
			code: typeof value.code === 'string' ? value.code : null,
			message: typeof value.error === 'string' && value.error !== '' ? value.error : `${tool} reported a failure without saying why.`,
			...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
			kind: null,
			error: value,
		};
	}
	return { ok: true, value };
}

/**
 * The channel the panels call tools through: the Tools source, or in
 * read-only mode the source the connection is anchored on.
 *
 * @param model - The console model.
 * @param channels - The connection's role channels.
 * @returns The channel, or null when none can call tools.
 */
export function toolChannelFor(model: ConsoleModel, channels: VectorChannels): IRoleChannel | null {
	if (channels.tools !== null) return channels.tools;
	if (!model.readOnly) return null;
	const anchor = model.connection.endpoint.anchorRole;
	if (anchor === 'ingest') return channels.ingest ?? channels.chat;
	return channels.chat ?? channels.ingest;
}
