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
// VECTOR - SUPPORT LEVELS AND STORE NAMES (pure)
// =============================================================================
//
// `postgres`, `rocketride_vector`, `qdrant` and `chroma` are supported once
// their live suites pass on new and legacy collections; the others are
// experimental (checked against stand-ins only). The node's own `dialect`
// answer is the authority; this table is the fallback before it answered.
// =============================================================================

import type { IDialectResult, SupportLevel } from '../contract/types';
import { CAVEAT_SENTENCES } from './wording';

/** Display names of the store providers. */
export const PROVIDER_TITLES: Readonly<Record<string, string>> = {
	postgres: 'PostgreSQL (pgvector)',
	rocketride_vector: 'RocketRide Vector',
	qdrant: 'Qdrant',
	chroma: 'Chroma',
	milvus: 'Milvus',
	weaviate: 'Weaviate',
	pinecone: 'Pinecone',
	astra_db: 'Astra DB',
	'mongodb+srv': 'MongoDB Atlas',
};

/** The providers this build supports (the rest are experimental). */
export const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(['postgres', 'rocketride_vector', 'qdrant', 'chroma']);

/**
 * A provider's display name.
 *
 * @param provider - The component provider.
 * @returns Its name, or the provider id itself for one this build does not know.
 */
export function providerTitle(provider: string): string {
	return PROVIDER_TITLES[provider] ?? provider;
}

/**
 * A store's support level: what its node says, else this build's table.
 *
 * @param provider - The component provider.
 * @param dialect - The node's dialect, or null.
 * @returns 'supported' or 'experimental'.
 */
export function supportOf(provider: string, dialect: IDialectResult | null): SupportLevel {
	if (dialect) return dialect.support;
	return SUPPORTED_PROVIDERS.has(provider) ? 'supported' : 'experimental';
}

/** The badge an experimental store wears everywhere it is shown. */
export const EXPERIMENTAL_BADGE = { label: 'Experimental', tooltip: CAVEAT_SENTENCES.experimental } as const;
