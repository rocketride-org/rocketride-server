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
// USAGE — what a turn's model requests cost, and the cost limit
// =============================================================================

/**
 * A native turn's answer carries the provider's real token counts, and the meter prices those.
 * A text answer carries none, so its request is estimated at 4 characters a token, input and
 * output apart; that estimate leaves out thinking, which the provider bills as output the browser
 * never sees, so it is a lower bound. Prices come from one dated table. Before each request the
 * meter reserves its input estimate plus an output allowance, and refuses a request that would
 * pass the limit (CostLimitError). Real tokens replace the whole reservation; a text reply
 * replaces only the allowance. A failed request keeps its whole reservation, since what the
 * provider billed is unknown, unless it cannot have been billed at all. The cacheable start gets
 * cache rates only when its row says the provider caches it: the first request writes it, later
 * ones read it until 5 idle minutes. The limit applies to every model: one the table does not
 * list is counted at ASSUMED_PRICE, for the limit only, so no dollar figure is ever shown from it.
 */

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
	{ model: 'gpt-6-luna', input: 0.1, cacheWrite: 0.1, cacheRead: 0.1, output: 0.5, cachesPrefix: false },
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
	 * @param spentUsd - The turn's cost before this request; unset for a model with no known price, whose cost is not shown.
	 * @param estimated - Whether any of that cost comes from character counts rather than the provider.
	 */
	constructor(
		readonly spentUsd: number | undefined,
		readonly limitUsd: number,
		estimated = true
	) {
		super(`the next model request could pass this turn's cost limit of ${dollars(limitUsd)}${spentUsd === undefined ? '' : ` (${costText(spentUsd, estimated)} so far)`}`);
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
 * A cost as the chat shows it.
 *
 * @param estimated - Whether any of it comes from character counts rather than the provider.
 * @returns "~$0.42 est." or "<$0.01 est." when estimated, else "$0.42" or "<$0.01".
 */
export function costText(usd: number, estimated: boolean): string {
	const text = usd < 0.005 ? '<$0.01' : estimated ? `~${dollars(usd)}` : dollars(usd);
	return estimated ? `${text} est.` : text;
}

/**
 * Tokens as the chat shows them.
 *
 * @param estimated - Whether any of them come from character counts rather than the provider.
 * @returns "~12,345 tokens est." when estimated, else "12,345 tokens".
 */
export function tokensText(tokens: number, estimated: boolean): string {
	const count = `${tokens.toLocaleString('en-US')} tokens`;
	return estimated ? `~${count} est.` : count;
}

// =============================================================================
// TOKENS — what the provider reports for a native turn
// =============================================================================

/**
 * A request's real token counts. The four are disjoint: `input` is fresh input only, since the
 * engine subtracts what the cache read or wrote (llm_adapter.py `_split_input_cache`).
 */
export interface Tokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/**
 * Reads the engine's `tokens` dict (`input`, `output`, `cache_read`, `cache_creation`).
 *
 * @returns The counts, or undefined when the dict is missing or counts nothing, so the request is estimated instead.
 */
export function readTokens(raw: unknown): Tokens | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const dict = raw as Record<string, unknown>;
	const count = (key: string): number => {
		const value = dict[key];
		return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
	};
	const tokens: Tokens = { input: count('input'), output: count('output'), cacheRead: count('cache_read'), cacheWrite: count('cache_creation') };
	return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0 ? tokens : undefined;
}

/** The USD of real tokens at a row's rates. */
export function priceOf(rates: Pick<PriceRow, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>, t: Tokens): number {
	return (t.input * rates.input + t.output * rates.output + t.cacheRead * rates.cacheRead + t.cacheWrite * rates.cacheWrite) / 1e6;
}

// =============================================================================
// THE METER
// =============================================================================

/**
 * What a request will send, in characters, as its adapter sizes it. `cachedChars` is the start the
 * provider can cache when `cacheable`; the rest is `freshChars`.
 */
export interface RequestSize {
	readonly cachedChars: number;
	readonly freshChars: number;
	readonly cacheable: boolean;
}

/** What a request used: the provider's tokens, or the reply's length when there are none. */
export type Used = { readonly tokens: Tokens } | { readonly replyChars: number };

/** A request's reservation, until it ends. */
export interface Reservation {
	/** The reply came. Real tokens replace the whole reservation; a reply's length replaces only the output allowance. */
	settle(used: Used): void;
	/** The request failed, and what it was billed is unknown: the reservation stays. */
	keep(): void;
	/** The request cannot have been billed (no key, a refused key, a task that never started): it counts for nothing. */
	release(): void;
}

/** The meter as a model session sees it: one reservation before each send. */
export interface Meter {
	/** @throws CostLimitError when the turn so far plus this reservation passes the limit; nothing is reserved. */
	reserve(size: RequestSize): Reservation;
}

/** What a turn's model requests used so far. */
export interface UsageSnapshot {
	requests: number;
	/** Input tokens, cached ones included. */
	inputTokens: number;
	/** Output tokens: each reply's, or the allowance of a request that failed or is still on its way. */
	outputTokens: number;
	/** The cost in USD; unset for a model the price table does not list. */
	usd?: number;
	/** Whether any request counts at an estimate: a text reply, a failed request kept at its reservation, or one still on its way. */
	estimated: boolean;
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

/** One request as the meter counts it: settled at the provider's tokens, at its reply's estimate, or still at its reservation. */
interface Counted {
	input: number;
	output: number;
	usd: number;
	estimated: boolean;
}

/** One turn's model requests: what they used, and the cost limit. */
export class UsageMeter implements Meter {
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
	/** Each request sent, as it counts now. */
	private readonly requests: Counted[] = [];

	constructor(o: MeterOptions = {}) {
		this.row = (o.prices ?? PRICES).find((row) => row.model === o.model);
		this.rates = this.row ?? ASSUMED_PRICE;
		this.limitUsd = o.limitUsd && o.limitUsd > 0 ? o.limitUsd : 0;
		this.allowance = o.outputMax && o.outputMax > 0 ? o.outputMax : OUTPUT_ALLOWANCE_TOKENS;
		this.now = o.now ?? Date.now;
	}

	/** The cost of the requests so far, reservations included, for the limit; a model with no known price counts at ASSUMED_PRICE. */
	get spentUsd(): number {
		return this.requests.reduce((sum, r) => sum + r.usd, 0);
	}

	/**
	 * Reserves a request before it is sent: its input estimate, priced with
	 * the cache rates where they apply, and the output allowance.
	 *
	 * @returns The reservation, to settle or keep when the request ends.
	 * @throws CostLimitError when the cost so far plus this reservation passes the limit; nothing is reserved.
	 */
	reserve(size: RequestSize): Reservation {
		const at = this.now();
		const { rates } = this;
		const start = tokensIn(size.cachedChars);
		const rest = tokensIn(size.freshChars);
		// step: the start is priced at the cache rates only where the provider caches it and the request can be cached
		const cached = rates.cachesPrefix && size.cacheable;
		const writes = cached && (this.cachedAt === undefined || at - this.cachedAt > CACHE_LIFE_MS);
		const startRate = !cached ? rates.input : writes ? rates.cacheWrite : rates.cacheRead;
		const inputUsd = (start * startRate + rest * rates.input) / 1e6;
		const outputUsd = (tokens: number): number => (tokens * rates.output) / 1e6;
		const request: Counted = { input: start + rest, output: this.allowance, usd: inputUsd + outputUsd(this.allowance), estimated: true };
		const spent = this.spentUsd;
		if (this.limitUsd > 0 && spent + request.usd > this.limitUsd)
			throw new CostLimitError(
				this.row ? spent : undefined,
				this.limitUsd,
				this.requests.some((r) => r.estimated)
			);
		this.requests.push(request);
		let open = true;
		return {
			settle: (used) => {
				if (!open) return;
				open = false;
				if ('tokens' in used) {
					const { tokens } = used;
					Object.assign(request, { input: tokens.input + tokens.cacheRead + tokens.cacheWrite, output: tokens.output, usd: priceOf(rates, tokens), estimated: false });
				} else {
					request.output = tokensIn(used.replyChars);
					request.usd = inputUsd + outputUsd(request.output);
				}
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
		const sum = (pick: (r: Counted) => number): number => this.requests.reduce((n, r) => n + pick(r), 0);
		return { requests: this.requests.length, inputTokens: sum((r) => r.input), outputTokens: sum((r) => r.output), ...(this.row ? { usd: this.spentUsd } : {}), estimated: this.requests.some((r) => r.estimated) };
	}
}
