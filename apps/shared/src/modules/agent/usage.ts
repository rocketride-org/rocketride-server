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
 * The browser never sees token counts (the model pipeline answers with text
 * only), so a turn's usage is estimated at 4 characters a token, input and
 * output apart, and priced from one dated table. The chat's "~$0.42 est." and
 * the cost limit use the same estimate. It leaves out thinking, which the
 * provider bills as output the browser never sees, so it is a lower bound.
 * Before each request the meter reserves its input estimate plus an output
 * allowance, and refuses a request that would pass the limit (CostLimitError).
 * A reply replaces the allowance with its own estimate; a failed request keeps
 * its whole reservation, since what the provider billed is unknown, unless it
 * cannot have been billed at all. The
 * cachePrefix start gets cache rates only when its row says the provider caches
 * it: the first request writes it, later ones read it until 5 idle minutes.
 * The limit applies to every model: one the table does not list is counted at
 * ASSUMED_PRICE, for the limit only, so no dollar figure is ever shown from it.
 */

import type { QuestionSpec } from './wave/plan';

// =============================================================================
// PRICES
// =============================================================================

/** One model's prices, in USD per million tokens. */
export interface PriceRow {
	/** The model, as its model node's profile names it. */
	model: string;
	input: number;
	/** Input tokens written to the prompt cache (5-minute entries). */
	cacheWrite: number;
	cacheRead: number;
	output: number;
	/** Whether the provider's model node caches the prompt start a question marks with cachePrefix. */
	cachesPrefix: boolean;
}

/** Where the prices come from, and the day they were read there. */
export const PRICES_SOURCES = [
	{ url: 'https://platform.claude.com/docs/en/about-claude/pricing', read: '2026-11-04' },
	{ url: 'https://developers.openai.com/api/docs/pricing', read: '2026-11-04' },
] as const;

/**
 * The prices the meter knows: every model the picker offers (modelEngine.ts). OpenAI's are its standard
 * short-context rates, and Haiku 5.5's are for prompts up to 100,000 tokens. Anthropic's model node marks
 * the cached start (nodes/src/nodes/llm_anthropic/anthropic.py, SUPPORTS_PROMPT_CACHE_PREFIX). OpenAI's
 * does not, so its cache rates are never read and repeat the input rate.
 */
export const PRICES: readonly PriceRow[] = [
	{ model: 'claude-fable-5-1', input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50, cachesPrefix: true },
	{ model: 'claude-opus-5-5', input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20, cachesPrefix: true },
	{ model: 'claude-opus-5', input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25, cachesPrefix: true },
	{ model: 'claude-sonnet-5-5', input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10, cachesPrefix: true },
	{ model: 'claude-haiku-5-5', input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5, cachesPrefix: true },
	{ model: 'gpt-6-astra', input: 10, cacheWrite: 10, cacheRead: 10, output: 50, cachesPrefix: false },
	{ model: 'gpt-6-1-sol', input: 2, cacheWrite: 2, cacheRead: 2, output: 10, cachesPrefix: false },
	{ model: 'gpt-6-sol', input: 2, cacheWrite: 2, cacheRead: 2, output: 10, cachesPrefix: false },
	{ model: 'openai-5-4', input: 2.5, cacheWrite: 2.5, cacheRead: 2.5, output: 15, cachesPrefix: false },
	{ model: 'openai-5-4-mini', input: 0.75, cacheWrite: 0.75, cacheRead: 0.75, output: 4.5, cachesPrefix: false },
];

/**
 * What the limit counts a model the table does not list at, per million tokens. Not a real price and
 * not an upper bound, so it never reaches the user as a dollar figure.
 */
export const ASSUMED_PRICE: Omit<PriceRow, 'model'> = { input: 5, cacheWrite: 5, cacheRead: 5, output: 25, cachesPrefix: false };

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
	 * @param spentUsd - The turn's estimate before this request; unset for a model with no known price, whose estimate is not shown.
	 */
	constructor(
		readonly spentUsd: number | undefined,
		readonly limitUsd: number
	) {
		super(`the next model request could pass this turn's cost limit of ${dollars(limitUsd)}${spentUsd === undefined ? '' : ` (${costText(spentUsd)} so far)`}`);
		this.name = 'CostLimitError';
	}
}

// =============================================================================
// TEXT
// =============================================================================

/**
 * An amount in dollars, to the cent.
 *
 * @returns "$2.00".
 */
export function dollars(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

/**
 * An estimated cost as the chat shows it.
 *
 * @returns "~$0.42 est.", or "<$0.01 est." below a cent.
 */
export function costText(usd: number): string {
	return usd < 0.005 ? '<$0.01 est.' : `~${dollars(usd)} est.`;
}

/**
 * Estimated tokens as the chat shows them.
 *
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
	/** The request cannot have been billed (no key, a refused key, a task that never started): it counts for nothing. */
	release(): void;
}

/** What a turn's model requests used so far. */
export interface UsageSnapshot {
	requests: number;
	/** Estimated input tokens. */
	inputTokens: number;
	/** Estimated output tokens: each reply's, or the allowance of a request that failed or is still on its way. */
	outputTokens: number;
	/** The estimated cost in USD; unset for a model the price table does not list. */
	usd?: number;
}

/** What a meter is built with. */
export interface MeterOptions {
	/** The model the requests go to; unset or missing from the price table, the meter shows tokens and no dollars. */
	model?: string;
	/** The turn's cost limit in USD; 0 or unset means none. */
	limitUsd?: number;
	/** The model's configured output maximum in tokens; unset reserves OUTPUT_ALLOWANCE_TOKENS. */
	outputMax?: number;
	/** The clock, in milliseconds (default Date.now). */
	now?: () => number;
	/** The price table (default PRICES). */
	prices?: readonly PriceRow[];
}

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
	/** The model's prices, when the table has them. Only these ever show as dollars. */
	readonly row: PriceRow | undefined;
	/** What the limit counts it at. */
	private readonly rates: Omit<PriceRow, 'model'>;
	/** The limit in USD; 0 when there is none. */
	readonly limitUsd: number;
	/** The output each request reserves, in tokens. */
	private readonly allowance: number;
	private readonly now: () => number;
	/** When the last request that wrote or read the cached start began; unset until one got a reply. */
	private cachedAt: number | undefined;
	/** Each request sent: settled at its reply's estimate, the rest at their reservation. */
	private readonly requests: Array<{ input: number; output: number; usd: number }> = [];

	constructor(o: MeterOptions = {}) {
		this.row = (o.prices ?? PRICES).find((row) => row.model === o.model);
		this.rates = this.row ?? ASSUMED_PRICE;
		this.limitUsd = o.limitUsd && o.limitUsd > 0 ? o.limitUsd : 0;
		this.allowance = o.outputMax && o.outputMax > 0 ? o.outputMax : OUTPUT_ALLOWANCE_TOKENS;
		this.now = o.now ?? Date.now;
	}

	/** The estimated cost of the requests so far, reservations included, for the limit; a model with no known price counts at ASSUMED_PRICE. */
	get spentUsd(): number {
		return this.requests.reduce((sum, r) => sum + r.usd, 0);
	}

	/**
	 * Reserves a request before it is sent: its input estimate, priced with
	 * the cache rates where they apply, and the output allowance.
	 *
	 * @returns The reservation, to settle or keep when the request ends.
	 * @throws CostLimitError when the estimate so far plus this reservation passes the limit; nothing is reserved.
	 */
	reserve(q: QuestionSpec): Reservation {
		const at = this.now();
		const { rates } = this;
		const prefix = tokensIn(prefixChars(q));
		const tail = tokensIn(tailChars(q));
		// step: the start is priced at the cache rates only where the provider caches it and the question asks
		const cached = rates.cachesPrefix && q.cachePrefix;
		const writes = cached && (this.cachedAt === undefined || at - this.cachedAt > CACHE_LIFE_MS);
		const prefixRate = !cached ? rates.input : writes ? rates.cacheWrite : rates.cacheRead;
		const inputUsd = (prefix * prefixRate + tail * rates.input) / 1e6;
		const outputUsd = (tokens: number): number => (tokens * rates.output) / 1e6;
		const request = { input: prefix + tail, output: this.allowance, usd: inputUsd + outputUsd(this.allowance) };
		const spent = this.spentUsd;
		if (this.limitUsd > 0 && spent + request.usd > this.limitUsd) throw new CostLimitError(this.row ? spent : undefined, this.limitUsd);
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
			release: () => {
				if (!open) return;
				open = false;
				this.requests.splice(this.requests.indexOf(request), 1);
			},
		};
	}

	/**
	 * What the requests used so far.
	 */
	snapshot(): UsageSnapshot {
		const sum = (pick: (r: { input: number; output: number }) => number): number => this.requests.reduce((n, r) => n + pick(r), 0);
		return { requests: this.requests.length, inputTokens: sum((r) => r.input), outputTokens: sum((r) => r.output), ...(this.row ? { usd: this.spentUsd } : {}) };
	}
}
