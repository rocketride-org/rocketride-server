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
// IDENTITY SCOPE — a change of account closes the previous account's tabs
// =============================================================================
//
// When the signed-in user, organization or team changes without a reload,
// the engine core forgets every connection, token and saved record (the
// endpoint store and the saved list follow the identity tracker). Open
// workbench, query, table, designer, diagram and connection-editor tabs, and
// the schema snapshots, belonged to the previous account and must go with it,
// so its results are never shown to the next one.
//
// The rule is R9's, the same one each dev-tool frame follows through the
// dev-tool library's frame identity guard (sqlFrame.ts):
//
//   first fingerprint   binds; nothing is forgotten;
//   a DIFFERENT one     another account: close the tabs, forget the schemas;
//   null                nobody can be vouched for (signed out, connection
//                       dropped): forget the schemas, keep the tabs (each one
//                       says "Not connected" and resolves again);
//   the same one again  (a reconnect, a token refresh): nothing.
//
// Fingerprints are compared, never epochs. The full app follows its engine
// core's tracker (SqlApp.tsx); it lives at module level like the stores it
// clears.
//
// Port of 98277843b (identityScope.ts), re-implemented on the R9 rule.
// =============================================================================

import type { ConnectionDocsHost } from './docs';
import { closeConnectionDocuments, getDocs } from './docs';
import { clearSchemas } from './schema/schemaStore';

/** What a scope does when the account changes, or cannot be vouched for. */
export interface IdentityScopeActions {
	/** Another account: close the previous account's tabs and forget its caches. */
	forget(): void;
	/** Nobody can be vouched for: forget the caches, keep the tabs. */
	unknown(): void;
}

/** Tracks the signed-in account. */
export interface IdentityScope {
	/**
	 * Record the identity fingerprint now in force (null: unknown).
	 *
	 * @param fingerprint - The fingerprint, or null.
	 * @returns What it did: 'bound', 'forgot', 'unknown' or 'kept'.
	 */
	apply(fingerprint: string | null): 'bound' | 'forgot' | 'unknown' | 'kept';
}

/**
 * Create an identity scope.
 *
 * @param actions - What to do on a change and on unknown.
 * @returns The scope, bound to no account yet.
 */
export function createIdentityScope(actions: IdentityScopeActions): IdentityScope {
	let first: string | null = null;
	let current: string | null = null;
	return {
		apply(fingerprint) {
			if (fingerprint === null) {
				const was = current;
				current = null;
				if (was === null) return 'kept';
				actions.unknown();
				return 'unknown';
			}
			current = fingerprint;
			if (first === null) {
				first = fingerprint;
				return 'bound';
			}
			if (fingerprint === first) return 'kept';
			first = fingerprint;
			actions.forget();
			return 'forgot';
		},
	};
}

/**
 * Drop everything that belongs to the previous account's connections: close
 * every connection-scoped tab and forget the schema snapshots and reads in
 * flight.
 *
 * @param docs - The app's Documents instance, or null when none is mounted.
 */
export function forgetConnectionScope(docs: ConnectionDocsHost | null): void {
	if (docs !== null) closeConnectionDocuments(docs);
	clearSchemas();
}

/** SQL Explorer's identity scope (the full app), over the app's own Documents instance. */
export const sqlIdentityScope: IdentityScope = createIdentityScope({
	forget: () => forgetConnectionScope(getDocs()),
	unknown: () => clearSchemas(),
});
