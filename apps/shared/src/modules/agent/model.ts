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
// MODEL — which model a conversation uses, and the seam a model call goes through
// =============================================================================

/**
 * What the run's retry and meter policy knows about a model. Nothing here knows tokens, pipelines,
 * nodes or how Variables are stored: that is modelEngine.ts, and the only part client.process()
 * replaces. This file has no runtime imports, so settings code in any realm can read its defaults.
 */

import type { QuestionSpec } from './wave/plan';

// =============================================================================
// THE CHOICE
// =============================================================================

/** The providers the picker offers. The engine's table is keyed by these, so a new id does not compile until it has a row. */
export const PROVIDER_IDS = ['anthropic', 'openai'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Which model a conversation uses. Saved with the session and read when a turn starts; a turn
 * holds its copy to the end. The ids are the `company` values of client.process()'s mockups.
 */
export interface ModelChoice {
	readonly provider: ProviderId;
	/** The model as its provider's catalog and the price table name it. */
	readonly model: string;
}

/** A new conversation's model when the user has picked nothing yet, as the setting holds it. */
export const DEFAULT_MODEL_SETTING = 'anthropic/claude-sonnet-5-5';
export const DEFAULT_MODEL: ModelChoice = { provider: 'anthropic', model: 'claude-sonnet-5-5' };

/**
 * Reads a stored choice, from a session file or the setting's `provider/model` text.
 *
 * @returns The choice, or undefined for anything else, a provider the table no longer has included.
 */
export function parseModelChoice(raw: unknown): ModelChoice | undefined {
	let provider: unknown;
	let model: unknown;
	if (typeof raw === 'string') {
		const text = raw.trim();
		const slash = text.indexOf('/');
		provider = text.slice(0, Math.max(slash, 0));
		model = text.slice(slash + 1);
	} else if (raw && typeof raw === 'object') {
		({ provider, model } = raw as { provider?: unknown; model?: unknown });
	}
	if (!PROVIDER_IDS.includes(provider as ProviderId) || typeof model !== 'string' || model === '') return undefined;
	return { provider: provider as ProviderId, model };
}

/** A choice as the setting holds it. */
export function modelSetting(choice: ModelChoice): string {
	return `${choice.provider}/${choice.model}`;
}

// =============================================================================
// THE SEAM
// =============================================================================

/** The user has to do something about a key before this model can answer. */
export interface KeyTrouble {
	readonly state: 'missing' | 'rejected';
	/** The provider, as the user knows it ("Anthropic"). */
	readonly provider: string;
	/** Where the user fixes it. */
	readonly variable: string;
}

/**
 * Why a model did not answer. It tells the policy in createChatModel what it may do, not what
 * happened: the message is for the user, and the causes stay with the implementation.
 */
export class ModelFailure extends Error {
	/** One fresh try may fix it. */
	readonly retryable: boolean;
	/** The provider may have charged for it, so the meter keeps the reservation. */
	readonly billed: boolean;
	readonly key?: KeyTrouble;

	constructor(message: string, o: { retryable: boolean; billed: boolean; key?: KeyTrouble }) {
		super(message);
		this.name = 'ModelFailure';
		this.retryable = o.retryable;
		this.billed = o.billed;
		if (o.key) this.key = o.key;
	}
}

/**
 * Asks one question and resolves with the model's text, or rejects with a ModelFailure.
 * Any ModelCall fits this type, so test fakes need no adapter.
 *
 * @param o.fresh - Do not reuse whatever served the last ask. Passed only when retrying a retryable failure.
 */
export type ModelAsk = (q: QuestionSpec, o?: { fresh?: boolean }) => Promise<string>;

/** One turn's model. createChatModel knows nothing else about what is behind it. */
export interface ChatModel {
	/** As the price table and the turn's record name it, so the price can never describe another model than the one asked. */
	readonly name: string;
	readonly ask: ModelAsk;
}

// =============================================================================
// THE OFFERS
// =============================================================================

/** What the picker shows. One read gives it everything, so it coordinates no calls. */
export interface ProviderOffer {
	readonly provider: ProviderId;
	readonly title: string;
	/** 'unknown': the names could not be read, and the turn finds out. */
	readonly key: 'set' | 'missing' | 'unknown';
	readonly models: readonly ModelOffer[];
}

export interface ModelOffer {
	readonly model: string;
	readonly title: string;
}
