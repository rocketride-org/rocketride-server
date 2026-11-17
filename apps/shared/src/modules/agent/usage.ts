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
 * Every answer carries the provider's real token counts (a native turn in its answer, a text answer
 * in the response node's `tokens` key), and the meter prices those, input, output, cache reads and
 * cache writes apart. Prices come from one dated table. Before each request the meter reserves its
 * input, sized at CHARS_PER_TOKEN, plus an output allowance, and refuses a request that would pass
 * the limit (CostLimitError). That reservation is the only number made from characters, and it never
 * shows: real counts replace it; a request that ends with no counts (an older engine, an uncounted
 * stream, a timeout, a thrown chat, a stop) keeps it whole, for the limit only, and counts as
 * uncounted. A request that cannot have been billed is released. The cacheable start gets cache
 * rates only when its row says the provider caches it: the first request writes it, later ones read
 * it until 5 idle minutes. The limit applies to every model: one the table does not list is counted
 * at ASSUMED_PRICE, for the limit only, so no dollar figure is ever shown from it.
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

/** Characters per token, for sizing a reservation before the request is sent. Nothing shown or reported comes from it. */
export const CHARS_PER_TOKEN = 4;

/** The output a request reserves when the model's configuration sets no maximum, in tokens. */
export const OUTPUT_ALLOWANCE_TOKENS = 8192;

/** How long a cached prompt start lives after the last request that wrote or read it: five minutes. */
export const CACHE_LIFE_MS = 5 * 60_000;

// =============================================================================
// THE LIMIT
// =============================================================================

/**
 * A model request the cost limit refused before it was sent: the turn's requests so far, those
 * without counts held at their reservation, plus this request's reservation would pass the limit.
 */
export class CostLimitError extends Error {
	/**
	 * @param spentUsd - The turn's cost from real counts before this request; unset for a model with no known price, whose cost is not shown.
	 * @param uncounted - Requests so far with no counts, which the limit held at their reservation.
	 */
	constructor(
		readonly spentUsd: number | undefined,
		readonly limitUsd: number,
		readonly uncounted = 0
	) {
		const so = [...(spentUsd === undefined ? [] : [`${costText(spentUsd)} so far`]), ...(uncounted ? [uncountedText(uncounted)] : [])];
		super(`the next model request could pass this turn's cost limit of ${dollars(limitUsd)}${so.length ? ` (${so.join(', ')})` : ''}`);
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
 * @param estimated - Only for a turn saved before real counts, whose cost came from characters.
 * @returns "~$0.42 est." or "<$0.01 est." when estimated, else "$0.42" or "<$0.01".
 */
export function costText(usd: number, estimated = false): string {
	const text = usd < 0.005 ? '<$0.01' : estimated ? `~${dollars(usd)}` : dollars(usd);
	return estimated ? `${text} est.` : text;
}

/**
 * Tokens as the chat shows them.
 *
 * @param estimated - Only for a turn saved before real counts, whose tokens came from characters.
 * @returns "~12,345 tokens est." when estimated, else "12,345 tokens".
 */
export function tokensText(tokens: number, estimated: boolean): string {
	const count = `${tokens.toLocaleString('en-US')} tokens`;
	return estimated ? `~${count} est.` : count;
}

/**
 * Requests that came back without the provider's counts, as the chat shows them.
 *
 * @returns "1 request not counted" or "2 requests not counted".
 */
export function uncountedText(requests: number): string {
	return `${requests} ${requests === 1 ? 'request' : 'requests'} not counted`;
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
 * @returns The counts, or undefined when the dict is missing or counts nothing, so the request counts as uncounted.
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

/** A request's reservation, until it ends. Exactly one of the three ends it; a second does nothing. */
export interface Reservation {
	/**
	 * The provider's counts came, with an answer or with a failure it billed: they replace the whole reservation.
	 *
	 * @returns What the request cost at the model's price; undefined for a model the table does not list.
	 */
	settle(tokens: Tokens): number | undefined;
	/** It ended with no counts and may have been billed: the reservation stays whole, for the limit, and the request counts as uncounted. */
	keep(): void;
	/** It cannot have been billed (no key, a refused key, a task that never started, a refusal of tools): it counts for nothing. */
	release(): void;
}

/** The meter as a model session sees it: one reservation before each send. */
export interface Meter {
	/** @throws CostLimitError when the turn so far plus this reservation passes the limit; nothing is reserved. */
	reserve(size: RequestSize): Reservation;
}

/** What a turn's model requests used so far. */
export interface UsageSnapshot {
	/** Requests that count: every one reserved but those released. */
	requests: number;
	/** The provider's counts, summed over the requests that had them; all zero when none had. */
	tokens: Tokens;
	/** Their cost at the model's price; unset for a model the table does not list. A reservation never shows here. */
	usd?: number;
	/** Requests with no counts: kept, or still on their way. The limit holds each at its reservation. */
	uncounted: number;
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

/** One request as the meter counts it: its reservation, until real counts replace it. */
interface Counted {
	/** What the limit counts it at: its price at real counts once settled, else its reservation. */
	usd: number;
	/** The provider's counts, apart; unset while it is reserved, or once it was kept. */
	tokens?: Tokens;
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
	/** When the last request that wrote or read the cached start began; unset until one settled with counts. */
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

	/** The cost of the requests so far for the limit: real counts where they came, reservations elsewhere; a model with no known price counts at ASSUMED_PRICE. */
	get spentUsd(): number {
		return this.requests.reduce((sum, r) => sum + r.usd, 0);
	}

	/**
	 * Reserves a request before it is sent: its input sized at CHARS_PER_TOKEN, priced with
	 * the cache rates where they apply, and the output allowance.
	 *
	 * @returns The reservation, to settle, keep or release when the request ends.
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
		const request: Counted = { usd: inputUsd + (this.allowance * rates.output) / 1e6 };
		if (this.limitUsd > 0 && this.spentUsd + request.usd > this.limitUsd) {
			const used = this.snapshot();
			throw new CostLimitError(used.usd, this.limitUsd, used.uncounted);
		}
		this.requests.push(request);
		let open = true;
		return {
			settle: (tokens) => {
				if (!open) return undefined;
				open = false;
				Object.assign(request, { tokens, usd: priceOf(rates, tokens) });
				if (cached) this.cachedAt = at;
				// rates is the row when there is one, so this is the request's price
				return this.row ? request.usd : undefined;
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

	/** What the requests used so far: real counts only, and how many had none. */
	snapshot(): UsageSnapshot {
		const counted = this.requests.filter((r): r is Counted & { tokens: Tokens } => r.tokens !== undefined);
		const sum = (pick: (t: Tokens) => number): number => counted.reduce((n, r) => n + pick(r.tokens), 0);
		const tokens: Tokens = { input: sum((t) => t.input), output: sum((t) => t.output), cacheRead: sum((t) => t.cacheRead), cacheWrite: sum((t) => t.cacheWrite) };
		return { requests: this.requests.length, tokens, ...(this.row ? { usd: counted.reduce((n, r) => n + r.usd, 0) } : {}), uncounted: this.requests.length - counted.length };
	}
}
