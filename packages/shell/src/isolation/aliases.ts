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
// `knownProjects` holds the FOREIGN project ids the root saw on its own
// connection (engine events, responses): bounded at 4096, oldest evicted,
// cleared at logout. The realm's own ids never live here: they come from its
// ledger and stay in the scrub sets while the handle lives (criterion N1-L).
//
// Identity fields are rewritten by key, never by blanket string replacement
// (plan section 2): user fields take the grant's alias (the server minted it
// under `RR_APP_ALIAS_KEY`; the root only copies it), team, run-kind,
// owner-kind and org fields are removed.
// =============================================================================

import type { IRealmGrant } from './types';

/** Entries a bounded set holds per session. */
export const KNOWN_LIMIT = 4096;

/** Fields whose value is a user id: replaced by the grant's user alias (removed for an anonymous grant). */
export const USER_KEYS: ReadonlySet<string> = new Set(['userId', 'user_id', 'client_id']);
/** Team, run-kind, owner-kind and org fields: removed from everything a realm receives. */
export const REMOVED_KEYS: ReadonlySet<string> = new Set(['teamId', 'team_id', 'devTeam', 'runKind', 'run_kind', 'ownerKind', 'owner_kind', 'orgId', 'org_id']);
/** Fields whose value is a project id: aliased whatever the id looks like. */
export const PROJECT_KEYS: ReadonlySet<string> = new Set(['project_id', 'projectId']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A project id the root minted for an app (`rrapp.<appKey>.<uuid4>`). */
export const MINTED_PROJECT_RE = /^rrapp\.[a-z2-7]{25}\.[0-9a-f-]{36}$/;

/**
 * Whether an id is matched inside strings (and in the backstop) as well as by
 * key: UUID-shaped, `rrapp.`, or at least 16 characters. Short ids such as
 * `rag-example` are aliased by key only, so app text is never rewritten.
 */
export function isHighEntropy(id: string): boolean {
	return id.length >= 16 || id.startsWith('rrapp.') || UUID_RE.test(id);
}

/** An insertion-ordered set that evicts its oldest entry past `limit`. */
export interface IBoundedSet {
	add(value: string): void;
	has(value: string): boolean;
	values(): string[];
	clear(): void;
	size(): number;
}

/** Creates a bounded set (re-adding a value makes it the newest). */
export function createBoundedSet(limit = KNOWN_LIMIT): IBoundedSet {
	const set = new Set<string>();
	return {
		add(value) {
			if (set.has(value)) set.delete(value);
			set.add(value);
			while (set.size > limit) set.delete(set.values().next().value as string);
		},
		has: (value) => set.has(value),
		values: () => [...set],
		clear: () => set.clear(),
		size: () => set.size,
	};
}

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
 * @returns The set: at most {@link KNOWN_LIMIT} ids, the oldest evicted.
 */
export function createKnownProjects(): IKnownProjects {
	const ids = createBoundedSet(KNOWN_LIMIT);
	let cache: string[] | null = null;
	return {
		add(projectId) {
			if (typeof projectId !== 'string' || projectId === '') return;
			ids.add(projectId);
			cache = null;
		},
		has: (projectId) => ids.has(projectId),
		highEntropy() {
			cache ??= ids.values().filter(isHighEntropy);
			return cache;
		},
		clear() {
			ids.clear();
			cache = null;
		},
		size: () => ids.size(),
	};
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer);

/**
 * Rewrites identity fields by key with the grant's aliases (never by blanket
 * replacement): user fields become the grant's user alias, or are removed for
 * an anonymous grant; team, run-kind, owner-kind and org fields are removed.
 *
 * @param grant - The realm's grant (`frame.identity` holds the aliases).
 * @param value - The value (not modified).
 * @returns A rewritten copy.
 */
export function rewriteIdentity<T>(grant: IRealmGrant, value: T): T {
	const userAlias = grant.frame?.identity?.userId;
	const visit = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(visit);
		if (!isPlainObject(v)) return v;
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) {
			if (REMOVED_KEYS.has(k)) continue;
			if (USER_KEYS.has(k)) {
				if (typeof userAlias === 'string') out[k] = userAlias;
				continue;
			}
			out[k] = visit(x);
		}
		return out;
	};
	return visit(value) as T;
}
