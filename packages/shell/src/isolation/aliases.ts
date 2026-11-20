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
// ALIASES — root-wide ids seen, and identity aliases from the grant (PR2a-2)
// =============================================================================
//
// `knownProjects` holds the FOREIGN project ids the root saw on its own
// engine-event stream: bounded at 4096, oldest evicted, cleared at logout.
// Nothing a realm sends or gets echoed back feeds it (security M1): per-realm
// sightings live in the realm's own set. The realm's own ids come from its
// ledger and stay in the scrub sets while the handle lives (criterion N1-L).
//
// Identity fields are rewritten by key (case-insensitive), never by blanket
// replacement of short values (plan section 2): user fields take the grant's
// alias (the server minted it under `RR_APP_ALIAS_KEY`; the root only copies
// it, and only in the `ru_` shape); team, run-kind, owner-kind and org fields
// are removed. Real high-entropy user, team and org ids are also replaced
// inside free text (`identityIds`, DA F1). They are learnt from the SDK's
// account info only: an engine body can carry stamps a pipeline authored
// (security N1, G4 round 2).
// =============================================================================

import type { IRealmGrant } from './types';

/** Entries a bounded set holds per session. */
export const KNOWN_LIMIT = 4096;

/** Fields whose value is a user id (lowercased): replaced by the grant's user alias (removed for an anonymous grant). */
export const USER_KEYS: ReadonlySet<string> = new Set(['userid', 'user_id', 'client_id']);
/** Team, run-kind, owner-kind and org fields (lowercased): removed from everything a realm receives. */
export const REMOVED_KEYS: ReadonlySet<string> = new Set(['teamid', 'team_id', 'devteam', 'runkind', 'run_kind', 'ownerkind', 'owner_kind', 'orgid', 'org_id']);
/** Fields whose value is a project id (lowercased, matched in any case): aliased whatever the id looks like. */
export const PROJECT_KEYS: ReadonlySet<string> = new Set(['project_id', 'projectid']);
/** A server-minted per-app user alias (`ru_`, plan section 4.9). */
const USER_ALIAS_RE = /^ru_[A-Za-z0-9_-]+$/;

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

/** Whether an id has the engine's own shape (a UUID or a minted `rrapp.` id): only those are refused inbound root-wide. */
export function isEngineShaped(id: string): boolean {
	return UUID_RE.test(id) || MINTED_PROJECT_RE.test(id);
}

/** The grant's user alias, when it has the alias shape; anything else counts as anonymous (DA F7, R2 LOW). */
export function userAliasOf(grant: IRealmGrant): string | undefined {
	const id = grant.frame?.identity?.userId;
	return typeof id === 'string' && USER_ALIAS_RE.test(id) ? id : undefined;
}

/** Whether a user, team or org id is distinctive enough to replace inside free text (never `local`). */
export function isIdentityValue(id: unknown): id is string {
	return typeof id === 'string' && id !== 'local' && (id.length >= 12 || UUID_RE.test(id));
}

/** Sets an own property, also for the key `__proto__` (plain assignment would set the prototype). */
export function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
	if (key === '__proto__') Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
	else out[key] = value;
}

/** An insertion-ordered set that evicts its oldest entry past `limit`. */
export interface IBoundedSet {
	add(value: string): void;
	has(value: string): boolean;
	values(): string[];
	clear(): void;
	size(): number;
	/** Bumped whenever membership changes (caches key on it). */
	version(): number;
}

/** Creates a bounded set (re-adding a value makes it the newest). */
export function createBoundedSet(limit = KNOWN_LIMIT): IBoundedSet {
	const set = new Set<string>();
	let version = 0;
	return {
		add(value) {
			if (set.has(value)) {
				set.delete(value);
				set.add(value);
				return;
			}
			set.add(value);
			while (set.size > limit) set.delete(set.values().next().value as string);
			version++;
		},
		has: (value) => set.has(value),
		values: () => [...set],
		clear() {
			if (set.size > 0) version++;
			set.clear();
		},
		size: () => set.size,
		version: () => version,
	};
}

/** A bounded set of project ids (root-wide foreign ids, or one realm's sightings). */
export interface IKnownProjects {
	add(projectId: string): void;
	has(projectId: string): boolean;
	/** The high-entropy ids (UUID-shaped, `rrapp.`, or at least 16 chars) held. */
	highEntropy(): string[];
	clear(): void;
	size(): number;
	/** Bumped whenever membership changes. */
	version(): number;
}

/**
 * Creates a project-id set.
 *
 * @returns The set: at most {@link KNOWN_LIMIT} ids, the oldest evicted.
 */
export function createKnownProjects(): IKnownProjects {
	const ids = createBoundedSet(KNOWN_LIMIT);
	let cache: { version: number; list: string[] } | null = null;
	return {
		add(projectId) {
			if (typeof projectId !== 'string' || projectId === '') return;
			ids.add(projectId);
		},
		has: (projectId) => ids.has(projectId),
		highEntropy() {
			if (cache?.version !== ids.version()) cache = { version: ids.version(), list: ids.values().filter(isHighEntropy) };
			return cache.list;
		},
		clear: () => ids.clear(),
		size: () => ids.size(),
		version: () => ids.version(),
	};
}

/** What a real identity id names. */
export type IdentityKind = 'user' | 'team' | 'org';

/** The root-wide real user, team and org ids (high-entropy only; bounded; cleared at logout). */
export interface IIdentityIds {
	/** Records an id when {@link isIdentityValue} accepts it. */
	add(id: unknown, kind: IdentityKind): void;
	entries(): Array<[string, IdentityKind]>;
	clear(): void;
	version(): number;
}

/** Creates the identity-id store. */
export function createIdentityIds(limit = KNOWN_LIMIT): IIdentityIds {
	// Insertion-ordered: the first entry is the oldest.
	const kinds = new Map<string, IdentityKind>();
	let version = 0;
	return {
		add(id, kind) {
			if (!isIdentityValue(id) || kinds.get(id) === kind) return;
			kinds.delete(id);
			kinds.set(id, kind);
			while (kinds.size > limit) kinds.delete(kinds.keys().next().value as string);
			version++;
		},
		entries: () => [...kinds.entries()],
		clear() {
			if (kinds.size > 0) version++;
			kinds.clear();
		},
		version: () => version,
	};
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer);

/**
 * Rewrites identity fields by key (any case) with the grant's aliases, never
 * by blanket replacement: user fields become the grant's user alias, or are
 * removed for an anonymous grant; team, run-kind, owner-kind and org fields
 * are removed.
 *
 * @param grant - The realm's grant (`frame.identity` holds the aliases).
 * @param value - The value (not modified).
 * @returns A rewritten copy.
 */
export function rewriteIdentity<T>(grant: IRealmGrant, value: T): T {
	const userAlias = userAliasOf(grant);
	const visit = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(visit);
		if (!isPlainObject(v)) return v;
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) {
			const lk = k.toLowerCase();
			if (REMOVED_KEYS.has(lk)) continue;
			if (USER_KEYS.has(lk)) {
				if (typeof userAlias === 'string') setOwn(out, k, userAlias);
				continue;
			}
			setOwn(out, k, visit(x));
		}
		return out;
	};
	return visit(value) as T;
}
