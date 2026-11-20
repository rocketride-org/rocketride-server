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
// SCRUB — what the root rewrites in everything it sends to an app (PR2a-2, N1)
// =============================================================================
//
// Per string, ONE linear scan (match.ts) over matchers built once per version
// of the sets they hold (security M2):
//   - replaced: the realm's own `tk_` → its handle, `pk_` → "", task id → its
//     alias, high-entropy project id (raw and URL-encoded) → its `rp_`; real
//     high-entropy user ids → the grant's user alias, team and org ids →
//     "[redacted]" (DA F1); high-entropy project ids the realm sighted at a
//     documented engine position, and foreign ones the root saw on its own
//     event stream → this realm's `rp_` alias;
//   - hits (the backstop's exact values): every seen token and task id, every
//     realm's live ledger values, the session token, the API keys.
// Then the patterns: an engine-format credential `(?:tk|pk)_<32 hex>` or a
// minted `rrapp.` id is a hit; the broader `(?:tk|pk)_[A-Za-z0-9_-]{16,}`
// shape is redacted in place (DA F4). Both are anchored on a non-alphanumeric
// left edge, so base64url data does not trip them.
//
// By key (case-insensitive): identity fields (aliases.ts), and every
// `project_id`/`projectId` value and project-keyed map key → `rp_`.
//
// A hit inside `body.notes[*]` turns that note into "[redacted]"; inside an
// engine error text it is redacted in place; anywhere else the message is
// refused (a `credential` denial at the choke point, a dropped event).
// Only the app's own file content is exempt from by-key rewriting and the
// patterns: `fs_get_json` `value` and `fs_list_dir` entry names (DA F5).
// `__rrbin` payloads are app data and are not scanned (plan 4.4, scope).
// =============================================================================

import type { DAPMessage } from 'rocketride';
import type { IBoundedSet, IdentityKind, IIdentityIds, IKnownProjects } from './aliases';
import { isEngineShaped, isHighEntropy, KNOWN_LIMIT, MINTED_PROJECT_RE, PROJECT_KEYS, REMOVED_KEYS, setOwn, USER_KEYS, userAliasOf } from './aliases';
import { deny } from './denial';
import type { IGatedRequest } from './gate';
import type { ILedger, IRunEntry } from './ledger';
import { createMatcher, hasMatch, hashWindows, releaseWindows, replaceMatches, scan } from './match';
import type { IMatch, IMatcher, IWindows } from './match';
import { SIZES } from './rate';
import type { IRealmGrant } from './types';
import { isWireBinary } from './walk';

/** What replaces a backstop hit in a note or an error text. */
export const REDACTED = '[redacted]';

/** An engine-format credential (`generate_token`, `keyed_task_token`): a hit; also refused inbound (N1-f). */
export const ENGINE_CREDENTIAL_RE = /(?<![A-Za-z0-9])(?:tk|pk)_[0-9a-fA-F]{32}/;
const ENGINE_CREDENTIAL_G = new RegExp(ENGINE_CREDENTIAL_RE.source, 'g');
const ENGINE_CREDENTIAL_HEAD = /^(?:tk|pk)_[0-9a-fA-F]{32}/;
/** A minted project id: another app's, or one no realm holds any more. A hit. */
const MINTED_RE = /(?<![A-Za-z0-9])rrapp\.[a-z2-7]{25}\.[0-9a-f-]{36}/;
const MINTED_G = new RegExp(MINTED_RE.source, 'g');
/** The broad credential shape (Appendix L): redacted in place, never a reason to refuse (DA F4). */
const BROAD_G = /(?<![A-Za-z0-9])(?:tk|pk)_[A-Za-z0-9_-]{16,}/g;
/** A FileStore scope prefix in engine error text (`file_store.py`): it names a real user, team or org id. */
const SCOPE_PREFIX_G = /\b(?:users|teams|orgs)\/[^/\s'"]+\/files\//g;

/** Scrub budget per message, checked before any scrubbing (fail closed as `too_large`). */
export const SCRUB_BUDGET = { chars: SIZES.response, nodes: 500_000, depth: 128 } as const;

/** What a matched needle becomes. */
type Repl = { k: 'to'; to: string } | { k: 'project'; id: string } | { k: 'id'; kind: IdentityKind } | { k: 'hit' };
const HIT: Repl = { k: 'hit' };

/** Root-wide sources the scrubber reads (the app root supplies them). */
export interface IScrubSources {
	/** Foreign project ids from the root's own engine-event stream only. */
	known: IKnownProjects;
	/** Every token and real task id the root saw. */
	seen: IBoundedSet;
	/** Real high-entropy user, team and org ids. */
	identities: IIdentityIds;
	sessionToken(): string;
	/** The shell API keys (cached, plus the client's live key). */
	apiKeys(): string[];
	/** Every attached realm's live ledger values: tokens, `pk_`s, task ids, high-entropy project ids (N1-L). */
	liveValues(): string[];
	/** The account's own ids from the SDK's account info, read live. */
	accountIds(): Array<[unknown, IdentityKind]>;
}

/** The root's matchers, each rebuilt only when its sets change. */
export interface IScrubRoot {
	readonly sources: IScrubSources;
	knownMatcher(): IMatcher<Repl>;
	identityMatcher(): IMatcher<Repl>;
	needleMatcher(): IMatcher<Repl>;
	/** N1-f: a checker for one inbound value (seen and live values, session token, API keys, engine-shaped foreign ids, engine-format credentials). */
	inbound(): (s: string) => boolean;
}

/** Projects a high-entropy id in raw and URL-encoded form. */
function* projectForms(ids: Iterable<string>, repl: (id: string) => Repl): Iterable<readonly [string, Repl]> {
	for (const id of ids) {
		const r = repl(id);
		yield [id, r];
		const encoded = encodeURIComponent(id);
		if (encoded !== id) yield [encoded, r];
	}
}

/** One cache slot: the value for the last key. */
function cached<T>(build: () => T): (key: string) => T {
	let key: string | undefined;
	let value!: T;
	return (k) => {
		if (k !== key) {
			value = build();
			key = k;
		}
		return value;
	};
}

/**
 * Creates the root's scrub state.
 *
 * @param sources - The root-wide sets and accessors.
 * @returns Matchers cached per set version.
 */
export function createScrubRoot(sources: IScrubSources): IScrubRoot {
	const known = cached(() => createMatcher(projectForms(sources.known.highEntropy(), (id) => ({ k: 'project', id }))));
	const knownInbound = cached(() =>
		createMatcher(
			sources.known
				.highEntropy()
				.filter(isEngineShaped)
				.map((id) => [id, HIT] as const)
		)
	);
	const identity = cached(() => createMatcher(sources.identities.entries().map(([id, kind]) => [id, { k: 'id', kind }] as const)));
	let needleParts: string[] = [];
	const needles = cached(() => createMatcher(needleParts.map((n) => [n, HIT] as const)));
	const root: IScrubRoot = {
		sources,
		knownMatcher: () => known(String(sources.known.version())),
		identityMatcher() {
			for (const [id, kind] of sources.accountIds()) sources.identities.add(id, kind);
			return identity(String(sources.identities.version()));
		},
		needleMatcher() {
			const live = sources.liveValues();
			const keys = sources.apiKeys();
			const session = sources.sessionToken();
			needleParts = [...sources.seen.values(), ...live, ...keys, session];
			return needles(`${sources.seen.version()}\u0001${session}\u0001${keys.join('\u0002')}\u0001${live.join('\u0002')}`);
		},
		inbound() {
			const matchers = [root.needleMatcher(), knownInbound(String(sources.known.version()))];
			return (s) => ENGINE_CREDENTIAL_RE.test(s) || hasMatch(s, matchers);
		},
	};
	return root;
}

/** What the scrubber needs for one realm. */
export interface IScrubContext {
	root: IScrubRoot;
	/** The realm's ledger: its own runs are replaced, never denied. */
	ledger: ILedger;
	/** The realm's grant (`frame.identity` holds its user alias). */
	grant: IRealmGrant;
	/** This realm's aliases of project ids it does not own: real id → `rp_` (bounded, oldest evicted). */
	aliases: Map<string, string>;
	/** Project ids this realm's replies named at a documented engine position (never shared with other realms). */
	sighted: IKnownProjects;
	/** A fresh `rp_` alias. */
	mintAlias(): string;
	/** Whether any realm's ledger holds this project id as its own (such an id is never "foreign"). */
	ownedByAnyRealm(projectId: string): boolean;
	/** Per-realm matcher caches (internal). */
	cache?: { own?: { key: string; m: IMatcher<Repl> }; sighted?: { version: number; m: IMatcher<Repl> } };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Opaque to the scrubber: typed arrays, buffers and exact wire binary members. */
const isOpaque = (v: unknown): boolean => ArrayBuffer.isView(v) || v instanceof ArrayBuffer || isWireBinary(v);

/**
 * The scrub budget (DA F3, security L4): string characters (values and keys),
 * nodes and depth, walked once before any scrubbing.
 *
 * @throws A `too_large` denial when the value is over budget.
 */
export function checkBudget(value: unknown, op: string): void {
	let chars = 0;
	let nodes = 0;
	const stack: Array<[unknown, number]> = [[value, 0]];
	while (stack.length > 0) {
		const [v, depth] = stack.pop()!;
		if (++nodes > SCRUB_BUDGET.nodes || depth > SCRUB_BUDGET.depth) throw deny('too_large', op);
		if (typeof v === 'string') chars += v.length;
		else if (typeof v === 'object' && v !== null && !isOpaque(v)) {
			if (Array.isArray(v)) for (const x of v) stack.push([x, depth + 1]);
			else
				for (const [k, x] of Object.entries(v)) {
					chars += k.length;
					stack.push([x, depth + 1]);
				}
		}
		if (chars > SCRUB_BUDGET.chars) throw deny('too_large', op);
	}
}

/** How a string is treated: refused on a hit, redacted in place (error text), or app file content (no patterns). */
type Mode = 'deny' | 'inline' | 'file';

/** One scrub of one message for one realm. */
interface IPass {
	/** What is replaced (own values, identity ids, sightings, foreign ids), in priority order. */
	replace: ReadonlyArray<IMatcher<Repl>>;
	/** The backstop's exact values. */
	deny: IMatcher<Repl>;
	/** Whether a needle is one the pass replaces (an own value is never a hit). */
	replaces(needle: string): boolean;
	userAlias: string | undefined;
	projectAlias(id: string): string;
	isProjectKey(key: string): boolean;
	/** Set by a hit in 'deny' or 'file' mode. */
	hit: boolean;
}

/** Prepares one scrub for a realm. `extraRuns`: runs to scrub besides the live ones (a run the answer just ended). */
function prepare(ctx: IScrubContext, extraRuns: readonly IRunEntry[]): IPass {
	const runs = [...ctx.ledger.runs()];
	for (const r of extraRuns) if (!runs.includes(r)) runs.push(r);
	const ownProject = new Map(runs.map((r) => [r.projectId, r] as const));
	const cache = (ctx.cache ??= {});

	// The realm's own values, cached per set of runs.
	const ownKey = runs.map((r) => `${r.handle}\u0002${r.token}\u0002${r.publicToken}\u0002${r.taskId}\u0002${r.projectId}`).join('\u0001');
	if (cache.own?.key !== ownKey) {
		const entries: Array<readonly [string, Repl]> = [];
		for (const r of runs) {
			entries.push([r.token, { k: 'to', to: r.handle }], [r.publicToken, { k: 'to', to: '' }], [r.taskId, { k: 'to', to: r.taskIdAlias }]);
			if (isHighEntropy(r.projectId)) entries.push(...projectForms([r.projectId], () => ({ k: 'to', to: r.projectAlias })));
		}
		cache.own = { key: ownKey, m: createMatcher(entries) };
	}
	// This realm's sightings, cached per version.
	if (cache.sighted?.version !== ctx.sighted.version()) {
		cache.sighted = { version: ctx.sighted.version(), m: createMatcher(projectForms(ctx.sighted.highEntropy(), (id) => ({ k: 'project', id }))) };
	}

	let aliasValues: Set<string> | null = null;
	const isRealmAlias = (id: string): boolean => {
		aliasValues ??= new Set([...runs.map((r) => r.projectAlias), ...ctx.aliases.values()]);
		return aliasValues.has(id);
	};
	const projectAlias = (id: string): string => {
		const own = ownProject.get(id);
		if (own) return own.projectAlias;
		if (isRealmAlias(id)) return id;
		let alias = ctx.aliases.get(id);
		if (alias === undefined) {
			alias = ctx.mintAlias();
			ctx.aliases.set(id, alias);
			while (ctx.aliases.size > KNOWN_LIMIT) ctx.aliases.delete(ctx.aliases.keys().next().value as string);
			aliasValues = null;
		}
		return alias;
	};
	const known = ctx.root.sources.known;
	// Priority on equal length: own values, identity ids, sightings, foreign ids.
	const replace = [cache.own.m, ctx.root.identityMatcher(), cache.sighted.m, ctx.root.knownMatcher()];
	return {
		replace,
		deny: ctx.root.needleMatcher(),
		replaces: (needle) => replace.some((m) => m.has(needle)),
		userAlias: userAliasOf(ctx.grant),
		projectAlias,
		// Short ids are map keys only when this realm sighted them; root-wide membership counts for high-entropy ids only (security M1).
		isProjectKey: (key) => ownProject.has(key) || MINTED_PROJECT_RE.test(key) || ctx.sighted.has(key) || (isHighEntropy(key) && known.has(key)),
		hit: false,
	};
}

/** Merges overlapping or touching ranges (sorted by start). */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
	const sorted = ranges.map((r) => [r[0], r[1]] as [number, number]).sort((a, b) => a[0] - b[0]);
	const out: Array<[number, number]> = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else out.push(r);
	}
	return out;
}

/**
 * Grows the redaction ranges until no replacement partly overlaps one (the deny wins).
 *
 * One sweep: `ranges` are merged and sorted, `reps` come from a non-overlapping scan so they are
 * sorted and disjoint too. A range absorbs the following ranges it touches and every replacement
 * that sticks out of it; a replacement that has only ever been inside, or outside, is left alone.
 * Work is linear in ranges plus replacements, not their product.
 */
export function growRanges(ranges: Array<[number, number]>, reps: ReadonlyArray<{ index: number; needle: string }>): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let from = 0;
	for (let g = 0; g < ranges.length; g++) {
		let lo = ranges[g][0];
		let hi = ranges[g][1];
		for (let grew = true; grew; ) {
			grew = false;
			while (g + 1 < ranges.length && ranges[g + 1][0] <= hi) hi = Math.max(hi, ranges[++g][1]);
			while (from < reps.length && reps[from].index + reps[from].needle.length <= lo) from++;
			for (let k = from; k < reps.length && reps[k].index < hi; k++) {
				const a = reps[k].index;
				const b = a + reps[k].needle.length;
				if (b > lo && (a < lo || b > hi)) {
					lo = Math.min(lo, a);
					hi = Math.max(hi, b);
					grew = true;
				}
			}
		}
		const last = out[out.length - 1];
		if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
		else out.push([lo, hi]);
	}
	return out;
}

/** The replacements that do not overlap any (sorted, disjoint) range: one pass, no replacement-by-range product. */
export function repsOutside<T extends { index: number; needle: string }>(reps: ReadonlyArray<T>, ranges: ReadonlyArray<[number, number]>): T[] {
	const out: T[] = [];
	let g = 0;
	for (const r of reps) {
		const a = r.index;
		const b = a + r.needle.length;
		while (g < ranges.length && ranges[g][1] <= a) g++;
		if (g < ranges.length && ranges[g][0] < b) continue;
		out.push(r);
	}
	return out;
}

/**
 * Error text with must-deny values: each is redacted, and so is any
 * replacement that overlaps one (the deny wins, DA R2 LOW); the other
 * replacements apply.
 */
function redactWithin(s: string, deny: Array<[number, number]>, pass: IPass, replacement: (m: IMatch<Repl>) => string, windows: IWindows): string {
	const reps: Array<IMatch<Repl>> = [];
	scan(
		s,
		pass.replace,
		(m) => {
			reps.push(m);
		},
		false,
		windows
	);
	const ranges = growRanges(mergeRanges(deny), reps);
	const kept = repsOutside(reps, ranges);
	const items = [...ranges.map((g) => ({ a: g[0], b: g[1], text: REDACTED })), ...kept.map((r) => ({ a: r.index, b: r.index + r.needle.length, text: replacement(r) }))].sort((x, y) => x.a - y.a);
	let out = '';
	let pos = 0;
	for (const it of items) {
		out += s.slice(pos, it.a) + it.text;
		pos = it.b;
	}
	return out + s.slice(pos);
}

/**
 * Scrubs one string. The backstop's exact values are looked for first, at
 * every position of the original string (so a replacement that starts
 * earlier cannot consume part of one); an own value is never a hit.
 */
function scrubString(pass: IPass, s: string, mode: Mode): string {
	// One string, two scans (backstop, then replacements): its window hashes are computed once.
	const windows = hashWindows(s);
	try {
		return scrubStringWith(pass, s, mode, windows);
	} finally {
		releaseWindows(windows);
	}
}

function scrubStringWith(pass: IPass, s: string, mode: Mode, windows: IWindows): string {
	let hit = false;
	const deny: Array<[number, number]> = [];
	scan(
		s,
		[pass.deny],
		(m) => {
			if (pass.replaces(m.needle)) return true;
			if (mode === 'inline') {
				deny.push([m.index, m.index + m.needle.length]);
				return true;
			}
			hit = true;
			return false;
		},
		true,
		windows,
		true // every must-deny needle at an offset, not only the longest: an exempt own value must not hide a shorter deny hit
	);
	const replacement = (m: IMatch<Repl>): string => {
		const r = m.value;
		switch (r.k) {
			case 'to':
				return r.to;
			case 'project':
				return pass.projectAlias(r.id);
			case 'id':
				return r.kind === 'user' && typeof pass.userAlias === 'string' ? pass.userAlias : REDACTED;
			default:
				return m.needle;
		}
	};
	let out = deny.length > 0 ? redactWithin(s, deny, pass, replacement, windows) : replaceMatches(s, pass.replace, replacement, windows);
	if (mode !== 'file' && (out.includes('k_') || out.includes('rrapp.'))) {
		out = out.replace(BROAD_G, (x) => (ENGINE_CREDENTIAL_HEAD.test(x) ? x : REDACTED));
		if (mode === 'inline') out = out.replace(ENGINE_CREDENTIAL_G, REDACTED).replace(MINTED_G, REDACTED);
		else if (ENGINE_CREDENTIAL_RE.test(out) || MINTED_RE.test(out)) hit = true;
	}
	if (hit) pass.hit = true;
	return out;
}

/** Per-key handling of one object: `undefined` falls through to the generic copy. */
type Special = (key: string, value: unknown) => { value: unknown } | undefined;

/** Scrubs a copy of `v`: by key (identity, project fields, project-keyed map keys) when `byKey`, strings always. */
function visit(pass: IPass, v: unknown, mode: Mode, byKey: boolean, depth: number, special?: Special): unknown {
	if (depth > SCRUB_BUDGET.depth) throw deny('too_large', 'outbound');
	if (typeof v === 'string') return scrubString(pass, v, mode);
	if (typeof v !== 'object' || v === null || isOpaque(v)) return v;
	if (Array.isArray(v)) return v.map((x) => visit(pass, x, mode, byKey, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) {
		const custom = special?.(k, x);
		if (custom) {
			setOwn(out, k, custom.value);
			continue;
		}
		if (byKey) {
			const lk = k.toLowerCase();
			if (REMOVED_KEYS.has(lk)) continue;
			if (USER_KEYS.has(lk)) {
				if (typeof pass.userAlias === 'string') setOwn(out, k, pass.userAlias);
				continue;
			}
			if (PROJECT_KEYS.has(lk) && typeof x === 'string') {
				setOwn(out, k, pass.projectAlias(x));
				continue;
			}
		}
		const key = byKey && pass.isProjectKey(k) ? pass.projectAlias(k) : scrubString(pass, k, mode === 'inline' ? 'deny' : mode);
		setOwn(out, key, visit(pass, x, mode, byKey, depth + 1));
	}
	return out;
}

/** A note with a hit becomes "[redacted]". */
function scrubNote(pass: IPass, note: unknown): unknown {
	const before = pass.hit;
	pass.hit = false;
	const out = visit(pass, note, 'deny', true, 2);
	const hit = pass.hit;
	pass.hit = before;
	return hit ? REDACTED : out;
}

/** Engine error text: scope prefixes stripped, then every hit redacted in place. */
function scrubText(pass: IPass, text: string): string {
	return scrubString(pass, text.replace(SCOPE_PREFIX_G, ''), 'inline');
}

/**
 * Records the documented engine positions of a body (DA F2) as this realm's
 * own sightings. Nothing of a reply or an event feeds a root-wide set:
 * identity ids come from the SDK's account info only (security N1, round 2).
 */
function learnFrom(ctx: IScrubContext, body: Record<string, unknown>): void {
	const pipeline = isPlainObject(body.pipeline) ? body.pipeline : undefined;
	for (const id of [body.project_id, body.projectId, pipeline?.project_id]) {
		if (typeof id !== 'string' || id === '' || ctx.ownedByAnyRealm(id)) continue;
		if (ctx.ledger.runs().some((r) => r.projectAlias === id) || [...ctx.aliases.values()].includes(id)) continue;
		ctx.sighted.add(id);
	}
}

/** The scrub of a DAP message (a response or an event): the scrubbed copy, and whether a hit is left outside notes and error text. */
function scrubMessage(ctx: IScrubContext, message: DAPMessage, opts: { extraRuns: readonly IRunEntry[]; op: string; store?: string }): { message: DAPMessage; hit: boolean } {
	checkBudget(message, opts.op);
	const msg = message as unknown as Record<string, unknown>;
	if (isPlainObject(msg.body)) learnFrom(ctx, msg.body);
	const pass = prepare(ctx, opts.extraRuns);
	// The app's own file content (DA F5): fs_get_json `value`, fs_list_dir entry names.
	const fileName: Special = (k, x) => (k === 'name' && typeof x === 'string' ? { value: scrubString(pass, x, 'file') } : undefined);
	const bodySpecial: Special = (k, x) => {
		if (k === 'notes' && Array.isArray(x)) return { value: x.map((note) => scrubNote(pass, note)) };
		if (opts.store === 'fs_get_json' && k === 'value') return { value: visit(pass, x, 'file', false, 2) };
		if (opts.store === 'fs_list_dir' && k === 'entries' && Array.isArray(x)) return { value: x.map((e) => (isPlainObject(e) ? visit(pass, e, 'deny', true, 3, fileName) : visit(pass, e, 'deny', true, 3))) };
		return undefined;
	};
	const out = visit(pass, msg, 'deny', true, 0, (k, x) => {
		if (k === 'body' && isPlainObject(x)) return { value: visit(pass, x, 'deny', true, 1, bodySpecial) };
		if (k === 'message' && msg.success === false && typeof x === 'string') return { value: scrubText(pass, x) };
		return undefined;
	});
	return { message: out as DAPMessage, hit: pass.hit };
}

/**
 * Scrubs any value on its way to the realm (the router's choke point) that
 * the root has not scrubbed already: the realm's own and the known values
 * are replaced inside strings, then the backstop runs. No by-key rewriting:
 * this also carries app-to-app traffic, whose fields are the apps' own.
 *
 * @param ctx - The realm's scrub context.
 * @param value - The value.
 * @returns A scrubbed copy; throws a `credential` (or `too_large`) denial.
 */
export function scrubOutbound<T>(ctx: IScrubContext, value: T): T {
	checkBudget(value, 'outbound');
	const pass = prepare(ctx, []);
	const out = visit(pass, value, 'deny', false, 0);
	if (pass.hit) throw deny('credential', 'outbound');
	return out as T;
}

/**
 * Scrubs one `client.request` response (after the ledger recorded it).
 *
 * @param ctx - The realm's scrub context.
 * @param req - The gated request it answers (its run is scrubbed even when the answer ended it).
 * @param response - The engine response.
 * @returns The scrubbed response, and whether a hit is left outside notes
 *   and error text (the root then refuses it at the choke point, N1-e).
 *   Throws a `too_large` denial when the response is over the scrub budget.
 */
export function scrubResponse(ctx: IScrubContext, req: IGatedRequest, response: DAPMessage): { message: DAPMessage; hit: boolean } {
	return scrubMessage(ctx, response, { extraRuns: req.run ? [req.run] : [], op: 'client.request', ...(req.command === 'rrext_store' && req.subcommand !== undefined ? { store: req.subcommand } : {}) });
}

/**
 * Scrubs one engine event on its way to the realm that owns its run.
 *
 * @param ctx - The realm's scrub context.
 * @param event - The engine event.
 * @returns The scrubbed event, or null when it must be dropped (a hit, or over budget).
 */
export function scrubEvent(ctx: IScrubContext, event: DAPMessage): DAPMessage | null {
	try {
		const { message, hit } = scrubMessage(ctx, event, { extraRuns: [], op: 'client.event' });
		return hit ? null : message;
	} catch {
		return null;
	}
}

/**
 * Scrubs the text of a thrown engine error: scope prefixes stripped,
 * replacements, then every backstop hit redacted in place.
 *
 * @param ctx - The realm's scrub context.
 * @param text - The error message.
 * @param run - The run the request named, if any.
 * @returns The text to send.
 */
export function scrubErrorText(ctx: IScrubContext, text: string, run?: IRunEntry): string {
	return scrubText(prepare(ctx, run ? [run] : []), text);
}
