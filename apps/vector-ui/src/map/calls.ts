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
// MAP - TOOL CALLS (one shape for every outcome)
// =============================================================================
//
// A vector store tool can fail two ways, depending on the check the app's tool
// table gives it: the call resolves with the failure envelope
// `{success: false, code, error}`, or it rejects with the shared library's
// ExplorerToolError (whose `code` is set when the SDK kept it). The map needs
// the code either way (SAMPLE_EXPIRED re-samples, BUSY waits), so every call
// goes through `callTool`, which never throws.
//
// The error is read by shape (kind, code, message), not by class, so this
// module imports no value from the shared library.
//
// The additive tools (contract section 4.4) have typed helpers here, so every
// panel that calls them goes through this one module: `recommend` (examples
// as keys; the one vector it may carry is the query vector the view holds,
// passed through untouched) and `similarity_matrix` (keys only).
// =============================================================================

import type { IGenerationTicket, IRoleChannel } from 'shared/explorer';
import type { IRecommendInput, IRecommendResult, ISimilarityMatrixInput, ISimilarityMatrixResult } from '../contract/types';

/** The outcome of one tool call. */
export type ToolAnswer<T> = { ok: true; value: T } | { ok: false; code: string | undefined; message: string; stale: boolean };

/** Options of a call; the node id is always given (bare tool names are dispatched by node). */
export interface ICallOptions {
	nodeId: string;
	timeoutMs?: number | null;
	generation?: IGenerationTicket;
}

/**
 * Call a tool and read its outcome.
 *
 * @param channel - The role channel (tools, or chat on a read-only connection).
 * @param tool - Bare tool name.
 * @param input - Tool input.
 * @param opts - Node id, wait, generation.
 * @returns The value, or the code and sentence of the failure.
 */
export async function callTool<T>(channel: Pick<IRoleChannel, 'invoke'>, tool: string, input: Record<string, unknown>, opts: ICallOptions): Promise<ToolAnswer<T>> {
	try {
		const value = await channel.invoke<T>(tool, input, { nodeId: opts.nodeId, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.generation ? { generation: opts.generation } : {}) });
		if (value && typeof value === 'object' && (value as { success?: unknown }).success === false) {
			const envelope = value as { code?: unknown; error?: unknown };
			return { ok: false, code: typeof envelope.code === 'string' ? envelope.code : undefined, message: typeof envelope.error === 'string' ? envelope.error : `${tool} failed`, stale: false };
		}
		return { ok: true, value };
	} catch (error) {
		const shaped = (error ?? {}) as { kind?: unknown; code?: unknown; message?: unknown };
		return {
			ok: false,
			code: typeof shaped.code === 'string' && shaped.code !== '' ? shaped.code : undefined,
			message: typeof shaped.message === 'string' ? shaped.message : String(error),
			stale: shaped.kind === 'stale',
		};
	}
}

/**
 * Whether an answer says the node no longer holds the sample.
 *
 * @param answer - A call outcome.
 * @returns True for SAMPLE_EXPIRED.
 */
export function isExpired(answer: ToolAnswer<unknown>): boolean {
	return !answer.ok && answer.code === 'SAMPLE_EXPIRED';
}

/**
 * Call `recommend` on the store node: chunks of the whole collection like the
 * positive examples and unlike the negative ones (contract section 4.4-D).
 *
 * @param channel - The role channel.
 * @param input - Example keys (and, at most, the query vector the view holds).
 * @param opts - Node id, wait, generation.
 * @returns The ranked rows, or the code and sentence of the failure.
 */
export function callRecommend(channel: Pick<IRoleChannel, 'invoke'>, input: IRecommendInput, opts: ICallOptions): Promise<ToolAnswer<IRecommendResult>> {
	return callTool<IRecommendResult>(channel, 'recommend', { ...input }, opts);
}

/**
 * Call `similarity_matrix` on the store node: the pairwise similarities of
 * these keys by the store's metric (contract section 4.4-E). Keys, never
 * sample indices, so a re-drawn sample cannot shift the matrix.
 *
 * @param channel - The role channel.
 * @param input - 2 to `limits.matrix_keys_max` keys.
 * @param opts - Node id, wait, generation.
 * @returns The matrix over the keys the store holds, or the code and sentence of the failure.
 */
export function callSimilarityMatrix(channel: Pick<IRoleChannel, 'invoke'>, input: ISimilarityMatrixInput, opts: ICallOptions): Promise<ToolAnswer<ISimilarityMatrixResult>> {
	return callTool<ISimilarityMatrixResult>(channel, 'similarity_matrix', { ...input }, opts);
}
