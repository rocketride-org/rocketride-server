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
// GRAPH-UI - ONE LIVE REGION PER REALM
// =============================================================================
//
// Every Graph Explorer mount announces through the adapter's one announcer, and
// in rocket-ui several of them share a realm (the full app and every open
// dev-tool document). A live region per mount would speak each sentence once
// per mount. So every mount CLAIMS the realm's region and only the first claim
// renders it; when that mount goes, the next claim takes over.
// =============================================================================

/** The realm's claims on its one live region. */
export interface IRegionClaims {
	/** Claim (idempotent per token). */
	claim(token: object): void;
	/** Give a claim up. */
	release(token: object): void;
	/** The token whose mount renders the region, or null. */
	owner(): object | null;
	/** Be told when the owner may have changed; returns unsubscribe. */
	subscribe(listener: () => void): () => void;
}

/**
 * Create a set of claims (one per realm in the app; tests make their own).
 *
 * @returns The claims.
 */
export function createRegionClaims(): IRegionClaims {
	const tokens: object[] = [];
	const listeners = new Set<() => void>();
	const notify = (): void => listeners.forEach((listener) => listener());
	return {
		claim(token) {
			if (tokens.includes(token)) return;
			tokens.push(token);
			notify();
		},
		release(token) {
			const at = tokens.indexOf(token);
			if (at < 0) return;
			tokens.splice(at, 1);
			notify();
		},
		owner: () => tokens[0] ?? null,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** This realm's claims. */
export const REALM_REGION = createRegionClaims();
