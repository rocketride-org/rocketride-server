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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// ALIASES — root-wide project ids seen, and identity aliases from the grant (PR2a-2)
// =============================================================================
//
// COMMIT A STUBS: they keep PR2a-1's behaviour (nothing is recorded, nothing
// is rewritten). The implementation (plan sections 2 and 4.4) replaces them.
// =============================================================================

import type { IRealmGrant } from './types';

/** The root-wide set of foreign project ids (bounded at 4096, cleared at logout). */
export interface IKnownProjects {
	add(projectId: string): void;
	has(projectId: string): boolean;
	/** The high-entropy ids (UUID-shaped, `rrapp.`, or at least 16 chars) held. */
	highEntropy(): string[];
	clear(): void;
	size(): number;
}

/**
 * Creates the root's foreign-project set.
 *
 * @returns The set (a no-op in commit A).
 */
export function createKnownProjects(): IKnownProjects {
	return {
		add() {},
		has: () => false,
		highEntropy: () => [],
		clear() {},
		size: () => 0,
	};
}

/**
 * Rewrites identity fields by key with the grant's aliases (never by blanket replacement).
 *
 * @param _grant - The realm's grant (`frame.identity` holds the aliases).
 * @param value - The value.
 * @returns The value (identity in commit A).
 */
export function rewriteIdentity<T>(_grant: IRealmGrant, value: T): T {
	return value;
}
