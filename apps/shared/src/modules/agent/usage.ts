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
// USAGE — what a turn's model requests cost, estimated, and the cost limit
// =============================================================================

/**
 * The browser never sees token counts: the model pipeline answers with text
 * only (known bug 15). So a turn's usage is estimated from characters, 4 to
 * a token, input and output apart, and priced from one dated table. The same
 * estimate is what the chat shows ("~$0.42 est.") and what the cost limit
 * checks. The meter takes characters now; a reply that reports its tokens
 * can feed it later without a change to ModelCall.
 *
 * createChatModel feeds the meter once per model request, the retry after a
 * pipeline restart included, and runAgent feeds it for a model a test
 * passes. Before each request the meter reserves the request's input
 * estimate and an output allowance. A request that would take the turn past
 * its limit is not sent (CostLimitError). After the reply, the allowance
 * becomes the reply's own estimate. A request that failed keeps its whole
 * reservation, since what the provider billed for it is unknown.
 *
 * The prompt start that a question marks with cachePrefix (role,
 * instructions and history) gets the provider's cache rates only when its
 * row says the provider caches it. The first request of a turn writes it.
 * Later requests read it, until more than five minutes pass after the last
 * request that wrote or read it; the next one then writes it again. The rest
 * of a question is always at the full input rate. The browser cannot see
 * whether the provider hit its cache, so the cost is an estimate.
 */

import type { QuestionSpec } from './wave/plan';

// =============================================================================
// PRICES
// =============================================================================

/** One model's prices, in USD per million tokens. */
export interface PriceRow {
	/** The model, as its model node's profile names it. */
	model: string;
	/** Input tokens. */
	input: number;
	/** Input tokens written to the prompt cache (5-minute entries). */
	cacheWrite: number;
	/** Input tokens read from the prompt cache. */
	cacheRead: number;
	/** Output tokens. */
	output: number;
	/** Whether the provider's model node caches the prompt start a question marks with cachePrefix. */
	cachesPrefix: boolean;
}

/** Where the prices come from, and the day they were read there. */
export const PRICES_SOURCE = { url: 'https://platform.claude.com/docs/en/about-claude/pricing', read: '2026-10-27' } as const;

/**
 * The prices the meter knows. One row: the stand-in's model (standin.ts),
 * from Anthropic's price page. Anthropic's model node marks the cached start
 * (nodes/src/nodes/llm_anthropic/anthropic.py, SUPPORTS_PROMPT_CACHE_PREFIX).
 */
export const PRICES: readonly PriceRow[] = [{ model: 'claude-sonnet-5', input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10, cachesPrefix: true }];

/** Characters per estimated token. */
export const CHARS_PER_TOKEN = 4;

/** The output a request reserves when the model's configuration sets no maximum, in tokens. */
export const OUTPUT_ALLOWANCE_TOKENS = 8192;

/** How long a cached prompt start lives after the last request that wrote or read it: five minutes. */
export const CACHE_LIFE_MS = 5 * 60_000;

// =============================================================================
// THE LIMIT
// =============================================================================

/**
 * A model request the cost limit refused before it was sent: the turn's
 * estimate so far plus this request's reservation would pass the limit.
 */
export class CostLimitError extends Error {
	/**
	 * @param spentUsd - The turn's estimate before this request.
	 * @param limitUsd - The turn's limit.
	 */
	constructor(
		readonly spentUsd: number,
		readonly limitUsd: number
	) {
		super(`the next model request could pass this turn's cost limit of ${dollars(limitUsd)} (${costText(spentUsd)} so far)`);
		this.name = 'CostLimitError';
	}
}

// =============================================================================
// TEXT
// =============================================================================

/**
 * An amount in dollars, to the cent.
 *
 * @param usd - The amount.
 * @returns "$2.00".
 */
export function dollars(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

/**
 * An estimated cost as the chat shows it.
 *
 * @param usd - The estimate.
 * @returns "~$0.42 est.", or "<$0.01 est." below a cent.
 */
export function costText(usd: number): string {
	return usd < 0.005 ? '<$0.01 est.' : `~${dollars(usd)} est.`;
}

/**
 * Estimated tokens as the chat shows them.
 *
 * @param tokens - The estimate.
 * @returns "~12,345 tokens est.".
 */
export function tokensText(tokens: number): string {
	return `~${tokens.toLocaleString('en-US')} tokens est.`;
}

// =============================================================================
// THE METER
// =============================================================================

/** A request's reservation, until it ends. */
export interface Reservation {
	/** The reply came: its estimate replaces the output allowance. */
	settle(replyChars: number): void;
	/** The request failed, and what it was billed is unknown: the reservation stays. */
	keep(): void;
}

/** What a turn's model requests used so far. */
export interface UsageSnapshot {
	/** Requests sent. */
	requests: number;
	/** Estimated input tokens. */
	inputTokens: number;
	/** Estimated output tokens: each reply's, or the allowance of a request that failed or is still on its way. */
	outputTokens: number;
	/** The estimated cost in USD; unset for a model the price table does not have. */
	usd?: number;
}

/** What a meter is built with. */
export interface MeterOptions {
	/** The model the requests go to; unset or missing from the price table, the meter counts tokens and prices nothing. */
	model?: string;
	/** The turn's cost limit in USD; 0 or unset means none. A model with no price has no limit. */
	limitUsd?: number;
	/** The model's configured output maximum in tokens; unset reserves OUTPUT_ALLOWANCE_TOKENS. */
	outputMax?: number;
	/** The clock, in milliseconds (default Date.now). */
	now?: () => number;
	/** The price table (default PRICES). */
	prices?: readonly PriceRow[];
}

/** The estimated tokens in some characters. */
function tokensIn(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The characters of the start a question marks with cachePrefix: role, instructions, history. */
function prefixChars(q: QuestionSpec): number {
	return q.role.length + q.instructions.reduce((n, i) => n + i.title.length + i.text.length, 0) + q.history.reduce((n, turn) => n + turn.content.length, 0);
}

/** The characters after the start: goals, context, the question. */
function tailChars(q: QuestionSpec): number {
	return q.goals.reduce((n, goal) => n + goal.length, 0) + q.context.reduce((n, item) => n + item.length, 0) + q.question.length;
}

/** One turn's model requests: what they used, and the cost limit. */
export class UsageMeter {
	/** The model's prices, when the table has them. */
	readonly row: PriceRow | undefined;
	/** The limit in USD; 0 when there is none. */
	readonly limitUsd: number;
	/** The output each request reserves, in tokens. */
	private readonly allowance: number;
	private readonly now: () => number;
	/** When the last request that wrote or read the cached start began; unset until one got a reply. */
	private cachedAt: number | undefined;
	/** Each request sent: settled at its reply's estimate, the rest at their reservation. */
	private readonly requests: Array<{ input: number; output: number; usd: number }> = [];

	/** @param o - The model, the limit, the output maximum and the clock. */
	constructor(o: MeterOptions = {}) {
		this.row = (o.prices ?? PRICES).find((row) => row.model === o.model);
		this.limitUsd = this.row && o.limitUsd && o.limitUsd > 0 ? o.limitUsd : 0;
		this.allowance = o.outputMax && o.outputMax > 0 ? o.outputMax : OUTPUT_ALLOWANCE_TOKENS;
		this.now = o.now ?? Date.now;
	}

	/** The estimated cost of the requests so far, reservations included; 0 for a model with no price. */
	get spentUsd(): number {
		return this.requests.reduce((sum, r) => sum + r.usd, 0);
	}

	/**
	 * Reserves a request before it is sent: its input estimate, priced with
	 * the cache rates where they apply, and the output allowance.
	 *
	 * @param q - The question about to be sent.
	 * @returns The reservation, to settle or keep when the request ends.
	 * @throws CostLimitError when the estimate so far plus this reservation passes the limit; nothing is reserved.
	 */
	reserve(q: QuestionSpec): Reservation {
		const at = this.now();
		const { row } = this;
		const prefix = tokensIn(prefixChars(q));
		const tail = tokensIn(tailChars(q));
		// step: the start is priced at the cache rates only where the provider caches it and the question asks
		const cached = row?.cachesPrefix === true && q.cachePrefix;
		const writes = cached && (this.cachedAt === undefined || at - this.cachedAt > CACHE_LIFE_MS);
		const prefixRate = !row ? 0 : !cached ? row.input : writes ? row.cacheWrite : row.cacheRead;
		const inputUsd = row ? (prefix * prefixRate + tail * row.input) / 1e6 : 0;
		const outputUsd = (tokens: number): number => (row ? (tokens * row.output) / 1e6 : 0);
		const request = { input: prefix + tail, output: this.allowance, usd: inputUsd + outputUsd(this.allowance) };
		const spent = this.spentUsd;
		if (this.limitUsd > 0 && spent + request.usd > this.limitUsd) throw new CostLimitError(spent, this.limitUsd);
		this.requests.push(request);
		let open = true;
		return {
			settle: (replyChars) => {
				if (!open) return;
				open = false;
				request.output = tokensIn(replyChars);
				request.usd = inputUsd + outputUsd(request.output);
				if (cached) this.cachedAt = at;
			},
			keep: () => {
				open = false;
			},
		};
	}

	/**
	 * What the requests used so far.
	 *
	 * @returns The requests sent, the tokens, and the cost for a model with a price.
	 */
	snapshot(): UsageSnapshot {
		const sum = (pick: (r: { input: number; output: number }) => number): number => this.requests.reduce((n, r) => n + pick(r), 0);
		return { requests: this.requests.length, inputTokens: sum((r) => r.input), outputTokens: sum((r) => r.output), ...(this.row ? { usd: this.spentUsd } : {}) };
	}
}
