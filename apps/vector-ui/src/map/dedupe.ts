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
// MAP - NEAR-DUPLICATE GROUPS AND THE DUPLICATES QUEUE (pure)
// =============================================================================
//
// The duplicates queue is computed in the browser from what the sample
// already holds: the node's `sample.duplicates` and every kNN pair of
// `sample.knn` at or above the threshold, so moving the threshold re-groups
// at once and sends nothing to the store. Pairs are joined into point groups
// by union-find; the queue then shows one group per SET OF DOCUMENTS (a
// copied file pairs up chunk by chunk, and those point groups are one
// decision), and lists a group whose points all sit in one document apart
// ("repeated text inside one document"), never offering to remove it.
//
// A keep policy (oldest ingest, shortest path, most chunks) or a hand-picked
// keep chooses one document per group. A policy queues another document of
// the group only when the sample shows the kept one holds it: at least four
// in five of its stored chunks. That is decided per document, never per group,
// so a revision that added chapters is never queued behind its original.
//
// The sample is evidence in two ways. What it holds is certain: a sampled
// chunk that pairs with the kept document is known to be in it, so a document
// with four in five of its stored chunks matched is held. Beyond that, the
// sampler draws each document's chunks on its own (chunk 0 first in a
// stratified sample, the rest a uniform subset per document), so a sampled
// chunk of a copy pairs only when its twin was drawn too: the share of
// matches is about the partner's coverage, not 1. Each matched drawn chunk is
// therefore weighted by the rate at which the partner's chunks were drawn,
// and a document counts as held only when that estimate is at least nine in
// ten and the sample holds enough of both to rule out seven in ten (one-sided,
// 1%). That weight assumes one twin per chunk: when a sampled chunk pairs with
// two of the partner's (the partner prints that text more than once, so a
// chunk pairs with one of its twins more often than the partner's draw rate)
// there is no estimate and the sample cannot tell yet. It holds text of its own only when its matches are too few for a
// document held whole (under 0.1% chance; with the partner in the sample
// whole, any unmatched sampled chunk). Otherwise the group says the sample
// cannot tell yet, or holds too few chunks, or that the store did not report
// the chunk counts, or that the sample was not drawn evenly. Chunks pinned on
// purpose (include_keys) are certain points: they count once, never weighted
// up, since a search for a shared section pins exactly the chunks that match.
//
// A hand-picked keep queues the others as the user chose, and the line under
// a document the sample does not show to be held says so. A document kept by
// hand in any group, reviewed or not, is never queued by another; a policy's
// keep protects its document when its group queues something. Removal itself
// is the console's: the panel hands the queued objectIds to `requestRemove`,
// which confirms (nothing to type) and moves them to the trash (`soft_delete`) in batches.
//
// The reviewed documents of a connection live in the registry's 'reviewed
// documents' cache (adapters/connections.ts), cleared on a change of
// identity; the helpers below take that map so they stay pure.
//
// `pairsAt`, `groups` and `groupOf` keep the signatures frozen on day 0 (the
// Points table numbers its rows through them).
// =============================================================================

import type { IDocumentItem, IDuplicatePair, ISampleResult } from '../contract/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Lowest similarity the queue's slider offers. */
export const THRESHOLD_MIN = 0.9;

/** Highest similarity the queue's slider offers. */
export const THRESHOLD_MAX = 0.995;

/** The slider's step. */
export const THRESHOLD_STEP = 0.005;

/** The queue's starting threshold (the node's own duplicate threshold). */
export const THRESHOLD_DEFAULT = 0.97;

/** Most groups the panel draws (the largest first). */
export const GROUPS_SHOWN_MAX = 200;

/** Most pairs listed under one group. */
export const PAIRS_SHOWN_MAX = 10;

/** Most documents listed under one group (its kept one always among them); Show group selects the rest on the map. */
export const DOCS_SHOWN_MAX = 20;

/** How a group's kept document is chosen. */
export type KeepPolicy = 'oldest' | 'shortest-path' | 'most-chunks' | 'manual';

/** The policies, in the picker's order. */
export const KEEP_POLICIES: readonly KeepPolicy[] = ['oldest', 'shortest-path', 'most-chunks', 'manual'];

// =============================================================================
// PAIRS AND POINT GROUPS (frozen signatures)
// =============================================================================

/** A connected group of near-duplicate points, numbered by size (largest first). */
export interface IDuplicateGroup {
	/** The group's number. */
	id: number;
	/** Point indices, ascending. */
	points: readonly number[];
	/** The lowest and highest similarity of the pairs inside the group. */
	simMin: number;
	simMax: number;
}

/**
 * The near-duplicate pairs of a sample at a threshold: the node's
 * `sample.duplicates` and every kNN edge at or above it, each pair once
 * (a < b) with its highest similarity, most similar first, then by index.
 *
 * @param sample - The `sample` answer.
 * @param threshold - The similarity a pair needs (0.90 to 0.995 in the queue).
 * @returns The pairs.
 */
export function pairsAt(sample: ISampleResult, threshold: number): IDuplicatePair[] {
	const best = new Map<number, IDuplicatePair>();
	const n = sample.n;
	const add = (i: number, j: number, sim: number): void => {
		if (i === j || !(sim >= threshold) || i < 0 || j < 0 || i >= n || j >= n) return;
		const a = Math.min(i, j);
		const b = Math.max(i, j);
		const id = a * n + b;
		const known = best.get(id);
		if (known === undefined || sim > known.sim) best.set(id, { a, b, sim });
	};
	for (const pair of sample.duplicates) add(pair.a, pair.b, pair.sim);
	const { offsets_row: offsets, cols, sims } = sample.knn;
	for (let i = 0; i < offsets.length - 1 && i < n; i += 1) {
		const end = offsets[i + 1] as number;
		for (let e = offsets[i] as number; e < end; e += 1) add(i, cols[e] as number, sims[e] as number);
	}
	return [...best.values()].sort((x, y) => y.sim - x.sim || x.a - y.a || x.b - y.b);
}

/**
 * Find a point's root, halving the path on the way (union-find).
 *
 * @param parent - The parent array.
 * @param i - A point.
 * @returns Its root.
 */
function find(parent: Map<number, number>, i: number): number {
	let x = i;
	for (;;) {
		const p = parent.get(x) ?? x;
		if (p === x) return x;
		const grand = parent.get(p) ?? p;
		parent.set(x, grand);
		x = grand;
	}
}

/**
 * The connected groups of pairs (union-find over the pairs, path halving):
 * numbered by size, largest first, ties by their first point.
 *
 * @param pairs - The pairs.
 * @returns The groups.
 */
export function groups(pairs: readonly IDuplicatePair[]): IDuplicateGroup[] {
	const parent = new Map<number, number>();
	for (const { a, b } of pairs) {
		if (!parent.has(a)) parent.set(a, a);
		if (!parent.has(b)) parent.set(b, b);
		const ra = find(parent, a);
		const rb = find(parent, b);
		if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
	}
	const members = new Map<number, number[]>();
	for (const point of parent.keys()) {
		const root = find(parent, point);
		const list = members.get(root);
		if (list) list.push(point);
		else members.set(root, [point]);
	}
	const range = new Map<number, { min: number; max: number }>();
	for (const { a, sim } of pairs) {
		const root = find(parent, a);
		const r = range.get(root);
		if (r) {
			r.min = Math.min(r.min, sim);
			r.max = Math.max(r.max, sim);
		} else range.set(root, { min: sim, max: sim });
	}
	const found = [...members.entries()].map(([root, points]) => ({ root, points: points.sort((x, y) => x - y) }));
	found.sort((x, y) => y.points.length - x.points.length || (x.points[0] as number) - (y.points[0] as number));
	return found.map((g, id) => ({ id, points: g.points, simMin: range.get(g.root)?.min ?? 1, simMax: range.get(g.root)?.max ?? 1 }));
}

/**
 * Every point's group number, or -1 when it is in none.
 *
 * @param found - The groups.
 * @param n - The sample's point count.
 * @returns One group number per point.
 */
export function groupOf(found: readonly IDuplicateGroup[], n: number): Int32Array {
	const out = new Int32Array(Math.max(0, n)).fill(-1);
	for (const group of found) for (const i of group.points) if (i >= 0 && i < out.length) out[i] = group.id;
	return out;
}

// =============================================================================
// QUEUE GROUPS (one per set of documents)
// =============================================================================

/** A queue group: the point groups over one set of documents. */
export interface IDocumentGroup extends IDuplicateGroup {
	/** The documents' objectIds joined (stable across thresholds; the keep choices are stored under it). */
	key: string;
	/** The documents, by objectId. */
	objectIds: readonly string[];
	/** True when every point is in one document (repeated text; never removed from here). */
	sameDocument: boolean;
	/** How many point groups were merged into this one. */
	chunkGroups: number;
	/** Points of each document inside the group. */
	shared: Readonly<Record<string, number>>;
	/** Of those, the points the sampler drew (not pinned by include_keys). */
	drawn: Readonly<Record<string, number>>;
	/** The pairs inside the group, most similar first. */
	pairs: readonly IDuplicatePair[];
	/** What the whole sample shows at this threshold (one object shared by every group of a view). */
	evidence: ICopyEvidence;
}

/** What one point knows of another document it pairs with. */
export interface IPartnerLink {
	/** True when one of the partner's points it pairs with is certain to be in the sample. */
	certain: boolean;
	/** How many of the partner's points it pairs with: two or more when the partner holds that text more than once. */
	count: number;
}

/**
 * What the sample shows about which documents hold which, at one threshold:
 * how each point was drawn and which documents it pairs with. Shared by every
 * group of a view, so a document's evidence counts its pairs in every group
 * (three copies drawn unevenly split into several groups).
 */
export interface ICopyEvidence {
	/** True when the sampler drew evenly within each document ('stratified' or 'random', no refill). */
	uniform: boolean;
	/** Per point: 1 when it is certain to be in the sample (pinned by include_keys, or chunk 0, which a stratified sample takes first). */
	census: Uint8Array;
	/** Per point: 1 when every one of its kNN neighbours is at or above the threshold (a twin may lie beyond the row). */
	crowded: Uint8Array;
	/** Per point: the other documents it pairs with, and how. */
	partners: ReadonlyArray<ReadonlyMap<string, IPartnerLink> | undefined>;
	/** Per document: its points. */
	pointsOf: ReadonlyMap<string, readonly number[]>;
	/** What is already worked out, per documents map. */
	memo: WeakMap<ReadonlyMap<string, IDocInfo>, IWorkedOut>;
}

/** How the sampler drew a document: the rate at which a chunk of its pool (its chunks that are not certain points) was drawn. */
interface IDraw {
	/** 1 when the sample holds its whole pool. */
	rate: number;
	/** Its pool. */
	pool: number;
}

/** What one documents map makes of a view's evidence, kept as it is worked out. */
interface IWorkedOut {
	/** Containment answers by document and partners. */
	answers: Map<string, IContainment>;
	/** Each document's draw, or null when the store did not report its chunk count. */
	draws: Map<string, IDraw | null>;
}

/** What the duplicates queue shows at one threshold. */
export interface IDedupeView {
	threshold: number;
	/** Every pair at the threshold between documents still stored. */
	pairs: IDuplicatePair[];
	/** Groups across documents, numbered from 0 (most documents first, then most points). */
	groups: IDocumentGroup[];
	/** Groups inside one document, numbered after `groups`. */
	repeated: IDocumentGroup[];
}

/**
 * The evidence of a view: how each point was drawn, whether its kNN row is
 * crowded with near-duplicates, and the documents each point pairs with.
 *
 * @param sample - The `sample` answer.
 * @param threshold - The similarity a pair needs.
 * @param pairs - The view's pairs (documents removed already left out).
 * @param objectOf - A point's objectId.
 * @param gone - objectIds removed since the sample was drawn.
 * @returns The evidence.
 */
function copyEvidence(sample: ISampleResult, threshold: number, pairs: readonly IDuplicatePair[], objectOf: (i: number) => string, gone: ReadonlySet<string>): ICopyEvidence {
	const n = sample.n;
	const strategy = sample.strategy_used ?? 'stratified';
	const census = new Uint8Array(Math.max(0, n));
	const crowded = new Uint8Array(Math.max(0, n));
	const pointsOf = new Map<string, number[]>();
	for (let i = 0; i < n; i += 1) {
		const id = objectOf(i);
		if (gone.has(id)) continue;
		if (sample.points.pinned[i] || (strategy === 'stratified' && sample.points.chunk[i] === 0)) census[i] = 1;
		const list = pointsOf.get(id);
		if (list) list.push(i);
		else pointsOf.set(id, [i]);
	}
	const { k, offsets_row: offsets, sims } = sample.knn;
	for (let i = 0; i < offsets.length - 1 && i < n; i += 1) {
		const start = offsets[i] as number;
		const end = offsets[i + 1] as number;
		if (k <= 0 || end - start < k) continue;
		let full = true;
		for (let e = start; e < end && full; e += 1) full = (sims[e] as number) >= threshold;
		if (full) crowded[i] = 1;
	}
	const partners: Array<Map<string, IPartnerLink> | undefined> = new Array(Math.max(0, n));
	const link = (i: number, j: number): void => {
		const other = objectOf(j);
		if (other === objectOf(i)) return;
		const map = partners[i] ?? new Map<string, IPartnerLink>();
		partners[i] = map;
		const known = map.get(other);
		if (known) {
			known.count += 1;
			known.certain = known.certain || census[j] === 1;
		} else map.set(other, { certain: census[j] === 1, count: 1 });
	};
	for (const { a, b } of pairs) {
		link(a, b);
		link(b, a);
	}
	return { uniform: strategy !== 'first' && !sample.biased, census, crowded, partners, pointsOf, memo: new WeakMap() };
}

/**
 * The duplicates queue's groups at a threshold. Pairs touching a removed
 * document are dropped first, so a removal shrinks or resolves its groups.
 *
 * @param sample - The `sample` answer.
 * @param threshold - The similarity a pair needs.
 * @param removed - objectIds removed since the sample was drawn.
 * @returns The pairs, the groups across documents and the groups inside one.
 */
export function dedupeView(sample: ISampleResult, threshold: number, removed: readonly string[] = []): IDedupeView {
	const gone = new Set(removed);
	const objectOf = (i: number): string => sample.docs[sample.points.doc[i] as number]?.objectId ?? '';
	const pairs = pairsAt(sample, threshold).filter((p) => !gone.has(objectOf(p.a)) && !gone.has(objectOf(p.b)));
	const pointGroups = groups(pairs);
	const groupOfPoint = groupOf(pointGroups, sample.n);
	const merged = new Map<string, { objectIds: string[]; points: number[]; chunkGroups: number; simMin: number; simMax: number; pairs: IDuplicatePair[] }>();
	const keyOfGroup: string[] = [];
	for (const group of pointGroups) {
		const objectIds = [...new Set(group.points.map(objectOf))].sort();
		const key = objectIds.join('\n');
		keyOfGroup[group.id] = key;
		const into = merged.get(key);
		if (into) {
			into.points.push(...group.points);
			into.chunkGroups += 1;
			into.simMin = Math.min(into.simMin, group.simMin);
			into.simMax = Math.max(into.simMax, group.simMax);
		} else merged.set(key, { objectIds, points: [...group.points], chunkGroups: 1, simMin: group.simMin, simMax: group.simMax, pairs: [] });
	}
	for (const pair of pairs) merged.get(keyOfGroup[groupOfPoint[pair.a] as number] as string)?.pairs.push(pair);
	const evidence = copyEvidence(sample, threshold, pairs, objectOf, gone);
	const all = [...merged.entries()].map(([key, g]) => {
		const points = g.points.sort((x, y) => x - y);
		const shared: Record<string, number> = {};
		const drawn: Record<string, number> = {};
		for (const i of points) {
			const id = objectOf(i);
			shared[id] = (shared[id] ?? 0) + 1;
			if (!sample.points.pinned[i]) drawn[id] = (drawn[id] ?? 0) + 1;
		}
		return { key, objectIds: g.objectIds, points, chunkGroups: g.chunkGroups, simMin: g.simMin, simMax: g.simMax, pairs: g.pairs, shared, drawn, evidence, sameDocument: g.objectIds.length === 1 };
	});
	const order = (x: (typeof all)[number], y: (typeof all)[number]): number => y.objectIds.length - x.objectIds.length || y.points.length - x.points.length || (x.points[0] as number) - (y.points[0] as number);
	const across = all.filter((g) => !g.sameDocument).sort(order);
	const inside = all.filter((g) => g.sameDocument).sort(order);
	return {
		threshold,
		pairs,
		groups: across.map((g, id) => ({ ...g, id })),
		repeated: inside.map((g, i) => ({ ...g, id: across.length + i })),
	};
}

/**
 * Every point's queue group number (the Points table's notes), or -1.
 *
 * @param sample - The `sample` answer.
 * @param threshold - The queue's threshold.
 * @param removed - objectIds removed since the sample was drawn.
 * @returns One group number per point.
 */
export function duplicateGroupOf(sample: ISampleResult, threshold: number = THRESHOLD_DEFAULT, removed: readonly string[] = []): Int32Array {
	const view = dedupeView(sample, threshold, removed);
	return groupOf([...view.groups, ...view.repeated], sample.n);
}

// =============================================================================
// DOCUMENTS AND KEEP POLICIES
// =============================================================================

/** What the queue knows about a document. */
export interface IDocInfo {
	objectId: string;
	path: string;
	/** Chunks the store reported for it, or null. */
	chunks: number | null;
	/** UTC ISO-8601, or null when the store does not keep it or the row is not loaded. */
	ingestedAt: string | null;
	/** Bytes, or null. */
	size: number | null;
	/** Its points in the sample. */
	inSample: number;
	/** Of those, the points the sampler drew (not pinned by include_keys). */
	drawn: number;
}

/**
 * The documents of a sample, joined with the console's loaded directory rows
 * (a row's path, chunk count, ingest time and size win; the sample fills in).
 *
 * @param sample - The `sample` answer.
 * @param rows - The directory rows loaded so far, or null.
 * @returns The documents by objectId.
 */
export function docInfo(sample: ISampleResult, rows: readonly IDocumentItem[] | null | undefined): Map<string, IDocInfo> {
	const byId = new Map<string, IDocumentItem>();
	for (const r of rows ?? []) byId.set(r.objectId, r);
	const pinned = new Map<number, number>();
	sample.points.doc.forEach((d, i) => {
		if (sample.points.pinned[i]) pinned.set(d, (pinned.get(d) ?? 0) + 1);
	});
	const out = new Map<string, IDocInfo>();
	sample.docs.forEach((doc, d) => {
		const r = byId.get(doc.objectId);
		const drawn = Math.max(0, doc.in_sample - (pinned.get(d) ?? 0));
		out.set(doc.objectId, { objectId: doc.objectId, path: r?.path || doc.path, chunks: r?.chunks ?? doc.chunks, ingestedAt: r?.ingestedAt ?? null, size: r?.size ?? null, inSample: doc.in_sample, drawn });
	});
	return out;
}

/**
 * The value a policy ranks documents by, smaller first; null when unknown.
 *
 * @param doc - The document.
 * @param policy - The policy.
 * @returns The rank value.
 */
function rankValue(doc: IDocInfo | undefined, policy: KeepPolicy): number | null {
	if (!doc) return null;
	if (policy === 'oldest') {
		const t = doc.ingestedAt ? Date.parse(doc.ingestedAt) : NaN;
		return Number.isFinite(t) ? t : null;
	}
	if (policy === 'shortest-path') return doc.path ? doc.path.length : null;
	if (policy === 'most-chunks') return doc.chunks === null ? null : -doc.chunks;
	return null;
}

/**
 * The document a policy keeps in a group: the oldest ingest, the shortest
 * path or the most chunks; ties by objectId, unknown values last. Null when
 * the policy is "choose manually" or no document of the group has the value.
 *
 * @param group - The group's documents.
 * @param policy - The policy.
 * @param info - The documents (docInfo).
 * @returns The kept objectId, or null.
 */
export function applyPolicy(group: Pick<IDocumentGroup, 'objectIds'>, policy: KeepPolicy, info: ReadonlyMap<string, IDocInfo>): string | null {
	if (policy === 'manual') return null;
	let kept: string | null = null;
	let keptValue = Infinity;
	for (const objectId of [...group.objectIds].sort()) {
		const value = rankValue(info.get(objectId), policy);
		if (value !== null && value < keptValue) {
			kept = objectId;
			keptValue = value;
		}
	}
	return kept;
}

/**
 * Whether a policy can choose in any group: the ingest time or the chunk
 * count of at least one document is known.
 *
 * @param found - The groups.
 * @param policy - The policy.
 * @param info - The documents.
 * @returns True when the policy picks somewhere.
 */
export function policyChooses(found: readonly IDocumentGroup[], policy: KeepPolicy, info: ReadonlyMap<string, IDocInfo>): boolean {
	if (policy === 'manual') return true;
	return found.some((g) => applyPolicy(g, policy, info) !== null);
}

// =============================================================================
// THE QUEUE (a reducer; nothing here reaches the store)
// =============================================================================

/** The queue's choices. */
export interface IQueueState {
	threshold: number;
	policy: KeepPolicy;
	/** Hand-picked keeps by group key. */
	overrides: Readonly<Record<string, string>>;
}

/** What the queue's controls do. */
export type QueueAction = { type: 'threshold'; value: number } | { type: 'policy'; value: KeepPolicy } | { type: 'keep'; group: string; objectId: string };

/**
 * The queue's starting choices: the node's threshold, nothing kept yet.
 *
 * @returns The state.
 */
export function queueInit(): IQueueState {
	return { threshold: THRESHOLD_DEFAULT, policy: 'manual', overrides: {} };
}

/**
 * Clamp a threshold to the slider's range, on its step.
 *
 * @param value - Any number.
 * @returns The threshold.
 */
export function clampThreshold(value: number): number {
	if (!Number.isFinite(value)) return THRESHOLD_DEFAULT;
	const stepped = Math.round(value / THRESHOLD_STEP) * THRESHOLD_STEP;
	return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, Number(stepped.toFixed(3))));
}

/**
 * Apply one control.
 *
 * @param state - The choices.
 * @param action - What changed.
 * @returns The new choices (a new policy replaces the hand-picked keeps).
 */
export function queueReducer(state: IQueueState, action: QueueAction): IQueueState {
	switch (action.type) {
		case 'threshold':
			return { ...state, threshold: clampThreshold(action.value) };
		case 'policy':
			return { ...state, policy: action.value, overrides: {} };
		case 'keep':
			return { ...state, overrides: { ...state.overrides, [action.group]: action.objectId } };
		default:
			return state;
	}
}

// =============================================================================
// WHAT THE SAMPLE SHOWS: IS ONE DOCUMENT HELD BY OTHERS?
// =============================================================================

/**
 * Share of a document's stored chunks another must hold for the document to
 * count as held (a copy, or a part, of it).
 */
export const HELD_SHARE = 0.8;

/**
 * Where the sample holds only part of the documents, the estimated share a
 * document must reach to count as held (a margin over HELD_SHARE for the
 * estimate's noise).
 */
export const HELD_ESTIMATE = 0.9;

/** The share the sample must rule out (one-sided) before an estimate counts as held. */
export const HELD_RULED_OUT = 0.7;

/** z for "held": the sample rules out HELD_RULED_OUT at 1%. */
const Z_HELD = 2.33;

/** Chance below which the sample's few matches show text of its own (were the document held whole). */
const OWN_TEXT_CHANCE = 0.001;

/** Fewest matched chunks before the sample's estimate counts, and fewest expected before the sample can tell. */
export const COPY_EVIDENCE_MIN = 3;

/**
 * What the sample shows about one document and others:
 * - 'in': they hold it (at least HELD_SHARE of its stored chunks);
 * - 'out': it holds text they do not (more than 1 - HELD_SHARE of it);
 * - 'unsure': the sample holds enough of them but cannot tell yet;
 * - 'few': the sample holds too few of their chunks to tell;
 * - 'unsized': the store did not report a chunk count it needs;
 * - 'uneven': the sample was not drawn evenly within documents ('first', or a refill), and what it holds does not decide.
 */
export type ContainmentVerdict = 'in' | 'out' | 'unsure' | 'few' | 'unsized' | 'uneven';

/** The answer for one document and others. */
export interface IContainment {
	verdict: ContainmentVerdict;
	/** Its sampled chunks that pair with one of the others (each one known to be in them). */
	matched: number;
	/** Its chunks in the sample. */
	sampled: number;
	/** The estimated share of its stored chunks the others hold (0 to 1), or null when there is no estimate. */
	share: number | null;
}

/**
 * P(Binomial(n, p) <= k).
 *
 * @param n - Trials.
 * @param p - Chance of each.
 * @param k - At most this many.
 * @returns The chance.
 */
function binomialAtMost(n: number, p: number, k: number): number {
	if (k >= n || p <= 0) return 1;
	if (k < 0) return 0;
	if (p >= 1) return 0;
	// Terms from 0 up, in logs (n is at most the sample size).
	const lq = Math.log(1 - p);
	const lp = Math.log(p);
	let logTerm = n * lq;
	let sum = Math.exp(logTerm);
	for (let i = 1; i <= k; i += 1) {
		logTerm += Math.log((n - i + 1) / i) + lp - lq;
		sum += Math.exp(logTerm);
	}
	return Math.min(1, sum);
}

/**
 * A document's stored chunk count as the queue knows it (never below what the
 * sample holds of it), or null.
 *
 * @param info - The documents.
 * @param objectId - The document.
 * @returns The count.
 */
function storedChunks(info: ReadonlyMap<string, IDocInfo>, objectId: string): number | null {
	const doc = info.get(objectId);
	if (!doc || doc.chunks === null) return null;
	return Math.max(doc.chunks, doc.inSample);
}

/**
 * Whether others hold a document, from the sample.
 *
 * Certain first: every sampled chunk that pairs with one of them is in them,
 * so `matched >= HELD_SHARE x stored` is held.
 *
 * Text of its own: if the others held the whole document, each of its
 * sampled chunks would pair with them at least at the partners' draw rate q
 * (the lowest of theirs: a twin is certain when it is one of their certain
 * points, else drawn at their rate), so the matches would be at least
 * Binomial(sampled, q); the document holds text of its own when the matches
 * are so few that this has under 0.1% chance. When the others are in the
 * sample whole (q = 1) that is any sampled chunk that pairs with none of
 * them, and that is the only case a sample not drawn evenly decides. A point
 * whose kNN row is all near-duplicates may have its twin beyond the row, so
 * an unmatched one of those counts as matched here.
 *
 * Held, where the sample holds only part of the documents and was drawn
 * evenly within each, and no sampled chunk of the document pairs with two of
 * theirs: an estimate. (A chunk whose text the others hold n times pairs with
 * one of its twins at 1 - (1 - q)^n, not q, so weighting its match by 1 / q
 * would count text of its own as held: a kept handbook that prints a section
 * twice would make a document holding that section once look held whole.
 * When the sample shows a repeated twin the answer is 'unsure'; the certain
 * rule and the test for text of its own stay sound.) A point is certain (pinned, or chunk 0 of
 * a stratified sample) or drawn: the drawn ones are a uniform subset of the
 * document's other chunks (r of the pool), and each matched drawn chunk
 * stands for 1 / q drawn chunks held, so
 *     g = (matched via a certain partner + matched via a drawn one / q) / r
 *     share = (certain chunks matched + g x pool) / stored
 * with variance, at a share g0 of the pool held,
 *     (1 - r / pool) g0 (1 - g0) / r + g0 (1 - q) / (q r) x (poolQ - g0 r) / (poolQ - 1)
 * (drawing r of the pool, then each twin at rate q from the partner's poolQ).
 * Held: share >= HELD_ESTIMATE, at least COPY_EVIDENCE_MIN matched, and g
 * rules out HELD_RULED_OUT (z = 2.33, one-sided 1%).
 *
 * @param group - A group of the view (for its shared evidence).
 * @param info - The documents (their stored chunk counts).
 * @param objectId - The document.
 * @param others - The documents that would hold it.
 * @returns The answer.
 */
export function containment(group: Pick<IDocumentGroup, 'evidence'>, info: ReadonlyMap<string, IDocInfo>, objectId: string, others: readonly string[]): IContainment {
	const ev = group.evidence;
	const work = workedOut(ev, info);
	const memoKey = others.length === 1 ? `${objectId}\u0000${others[0]}` : `${objectId}\u0000${[...others].sort().join('\u0001')}`;
	const known = work.answers.get(memoKey);
	if (known) return known;
	const set = others.length === 1 ? null : new Set(others);
	const answer = workOutContainment(ev, info, objectId, set === null ? (others[0] as string) : (id) => set.has(id), () => lowestDraw(ev, info, others));
	work.answers.set(memoKey, answer);
	return answer;
}

/**
 * The view's worked-out answers for a documents map.
 *
 * @param ev - The view's evidence.
 * @param info - The documents.
 * @returns Its memo.
 */
function workedOut(ev: ICopyEvidence, info: ReadonlyMap<string, IDocInfo>): IWorkedOut {
	let work = ev.memo.get(info);
	if (!work) {
		work = { answers: new Map(), draws: new Map() };
		ev.memo.set(info, work);
	}
	return work;
}

/**
 * How the sampler drew a document (its certain points apart).
 *
 * @param ev - The view's evidence.
 * @param info - The documents.
 * @param objectId - The document.
 * @returns Its draw, or null when the store did not report its chunk count.
 */
function drawOf(ev: ICopyEvidence, info: ReadonlyMap<string, IDocInfo>, objectId: string): IDraw | null {
	const work = workedOut(ev, info);
	const known = work.draws.get(objectId);
	if (known !== undefined) return known;
	const total = storedChunks(info, objectId);
	let draw: IDraw | null = null;
	if (total !== null) {
		const theirs = ev.pointsOf.get(objectId) ?? [];
		let theirCertain = 0;
		for (const j of theirs) if (ev.census[j] === 1) theirCertain += 1;
		const theirDrawn = theirs.length - theirCertain;
		const pool = Math.max(theirDrawn, total - theirCertain);
		draw = { rate: pool === 0 || theirDrawn >= pool ? 1 : theirDrawn / pool, pool };
	}
	work.draws.set(objectId, draw);
	return draw;
}

/** The partners' draw: the lowest rate at which a twin in their pool was drawn (q), and that partner's pool. */
interface IPartnersDraw {
	q: number;
	poolQ: number;
}

/**
 * The lowest draw among documents (the first of them on a tie).
 *
 * @param ev - The view's evidence.
 * @param info - The documents.
 * @param others - The documents.
 * @returns Their draw, or null when one has no chunk count.
 */
function lowestDraw(ev: ICopyEvidence, info: ReadonlyMap<string, IDocInfo>, others: readonly string[]): IPartnersDraw | null {
	let q = 1;
	let poolQ = 0;
	for (const other of others) {
		const draw = drawOf(ev, info, other);
		if (draw === null) return null;
		if (draw.rate < q) {
			q = draw.rate;
			poolQ = draw.pool;
		}
	}
	return { q, poolQ };
}

/**
 * See containment.
 *
 * @param ev - The view's evidence.
 * @param info - The documents.
 * @param objectId - The document.
 * @param isOther - The one document that would hold it, or whether a document is one of those.
 * @param partnersDraw - Their draw (asked only when the certain rule does not decide), or null when one has no chunk count.
 * @returns The answer.
 */
function workOutContainment(ev: ICopyEvidence, info: ReadonlyMap<string, IDocInfo>, objectId: string, isOther: string | ((id: string) => boolean), partnersDraw: () => IPartnersDraw | null): IContainment {
	const points = ev.pointsOf.get(objectId) ?? [];
	let certain = 0;
	let drawn = 0;
	let certainMatched = 0;
	let viaCertain = 0;
	let viaDrawn = 0;
	let crowdedMisses = 0;
	let repeated = false;
	for (const i of points) {
		const isCertain = ev.census[i] === 1;
		if (isCertain) certain += 1;
		else drawn += 1;
		const map = ev.partners[i];
		// true: pairs with a certain point of theirs; false: with drawn ones only; undefined: with none.
		let hit: boolean | undefined;
		let twins = 0;
		if (map && typeof isOther === 'string') {
			const link = map.get(isOther);
			if (link) {
				twins = link.count;
				hit = link.certain;
			}
		} else if (map && typeof isOther === 'function') {
			for (const [other, link] of map) {
				if (!isOther(other)) continue;
				twins += link.count;
				if (link.certain) hit = true;
				else if (hit === undefined) hit = false;
			}
		}
		if (twins >= 2) repeated = true;
		if (hit === undefined) {
			if (ev.crowded[i]) crowdedMisses += 1;
			continue;
		}
		if (isCertain) certainMatched += 1;
		else if (hit) viaCertain += 1;
		else viaDrawn += 1;
	}
	const matched = certainMatched + viaCertain + viaDrawn;
	const sampled = points.length;
	const stored = storedChunks(info, objectId);
	const out = (verdict: ContainmentVerdict, share: number | null): IContainment => ({ verdict, matched, sampled, share });
	if (stored === null) return out('unsized', null);
	if (matched >= HELD_SHARE * stored) return out('in', Math.min(1, matched / stored));
	const theirs = partnersDraw();
	if (theirs === null) return out('unsized', null);
	const { q, poolQ } = theirs;
	const whole = q >= 1;
	// A sample not drawn evenly says nothing about the chunks it did not draw: only partners whole in it count.
	if ((whole || ev.uniform) && binomialAtMost(sampled, q, matched + crowdedMisses) < OWN_TEXT_CHANCE) return out('out', matched / stored);
	if (!ev.uniform) return out('uneven', null);
	const pool = Math.max(drawn, stored - certain);
	const expected = sampled * q;
	if (drawn === 0 || q <= 0 || pool === 0 || repeated) return out(expected < COPY_EVIDENCE_MIN ? 'few' : 'unsure', null);
	const g = Math.min(1, (viaCertain + (whole ? viaDrawn : viaDrawn / q)) / drawn);
	const share = Math.min(1, (certainMatched + g * pool) / stored);
	const sd = (g0: number): number => {
		const sampling = drawn >= pool ? 0 : (((1 - drawn / pool) * g0 * (1 - g0)) / drawn) * (pool / Math.max(1, pool - 1));
		const twinsVar = whole ? 0 : ((g0 * (1 - q)) / (q * drawn)) * (Math.max(0, poolQ - g0 * drawn) / Math.max(1, poolQ - 1));
		return Math.sqrt(Math.max(0, sampling + twinsVar));
	};
	if (share >= HELD_ESTIMATE && matched >= COPY_EVIDENCE_MIN && g - HELD_RULED_OUT >= Z_HELD * sd(HELD_RULED_OUT)) return out('in', share);
	return out(expected < COPY_EVIDENCE_MIN ? 'few' : 'unsure', share);
}

/** What the sample shows about a group's documents (the note under a group that is not copies). */
export type CopyVerdict = 'copies' | 'passages' | 'mixed' | 'partial' | 'sparse' | 'unsized' | 'uneven';

/**
 * The draws of a group's documents, worked out once: for every document, the
 * lowest draw among the others (the lowest of the group unless it is that
 * document's own, then the next lowest) and whether one of them has no chunk count.
 *
 * @param group - The group.
 * @param info - The documents.
 * @returns The others' draw of a document, or null when one of them has no chunk count.
 */
function othersDraw(group: Pick<IDocumentGroup, 'objectIds' | 'evidence'>, info: ReadonlyMap<string, IDocInfo>): (objectId: string) => IPartnersDraw | null {
	let unsized = 0;
	let lowest: { id: string; draw: IDraw } | null = null;
	let next: { id: string; draw: IDraw } | null = null;
	for (const id of group.objectIds) {
		const draw = drawOf(group.evidence, info, id);
		if (draw === null) {
			unsized += 1;
			continue;
		}
		if (lowest === null || draw.rate < lowest.draw.rate) {
			next = lowest;
			lowest = { id, draw };
		} else if (next === null || draw.rate < next.draw.rate) next = { id, draw };
	}
	return (objectId) => {
		const own = drawOf(group.evidence, info, objectId);
		if (unsized - (own === null ? 1 : 0) > 0) return null;
		const theirs = lowest !== null && lowest.id === objectId ? next : lowest;
		return theirs === null || theirs.draw.rate >= 1 ? { q: 1, poolQ: 0 } : { q: theirs.draw.rate, poolQ: theirs.draw.pool };
	};
}

/**
 * The documents of a group a document's sampled chunks pair with (its points
 * may pair with documents of other groups too: those never hold it here), and
 * how many of its sampled chunks pair with each.
 *
 * @param ev - The view's evidence.
 * @param objectId - The document.
 * @param members - The group's documents.
 * @returns Its partners in the group, in the order they first appear.
 */
function partnersOf(ev: ICopyEvidence, objectId: string, members: ReadonlySet<string>): Map<string, number> {
	const found = new Map<string, number>();
	for (const i of ev.pointsOf.get(objectId) ?? []) for (const other of ev.partners[i]?.keys() ?? []) if (members.has(other)) found.set(other, (found.get(other) ?? 0) + 1);
	return found;
}

/**
 * What the sample shows about one document of a group: 'whole' when another
 * document of the group holds it; 'own' when it holds text the others
 * together do not; otherwise why the sample cannot tell.
 *
 * Only the documents its sampled chunks pair with can hold it (one none of
 * its chunks pairs with matches nothing of it), so it is compared with those
 * one by one, and a partner too few of its chunks pair with to hold it by
 * either rule (fewer than HELD_SHARE of its stored chunks and fewer than
 * COPY_EVIDENCE_MIN) counts only for its missing chunk count. "The others
 * together" are every other document of the group, their lowest draw worked
 * out once for the group.
 *
 * @param group - The group.
 * @param info - The documents.
 * @param objectId - The document.
 * @param members - The group's documents.
 * @param others - The others' draw (othersDraw).
 * @returns The verdict for the document.
 */
function docVerdict(group: Pick<IDocumentGroup, 'objectIds' | 'evidence'>, info: ReadonlyMap<string, IDocInfo>, objectId: string, members: ReadonlySet<string>, others: (objectId: string) => IPartnersDraw | null): 'whole' | 'own' | 'few' | 'partial' | 'unsized' | 'uneven' {
	if (!group.objectIds.some((id) => id !== objectId)) return 'few';
	const ev = group.evidence;
	const stored = storedChunks(info, objectId);
	// Without its chunk count every comparison of it says 'unsized'.
	if (stored === null) return 'unsized';
	const each: IContainment[] = [];
	let partnerUnsized = false;
	for (const [other, matched] of partnersOf(ev, objectId, members)) {
		if (ev.uniform && matched < HELD_SHARE * stored && matched < COPY_EVIDENCE_MIN) {
			// Never 'in', and in a sample drawn evenly never 'uneven': only its chunk count can count.
			if (drawOf(ev, info, other) === null) partnerUnsized = true;
			continue;
		}
		const c = containment(group, info, objectId, [other]);
		if (c.verdict === 'in') return 'whole';
		each.push(c);
	}
	const isOther = (id: string): boolean => id !== objectId && members.has(id);
	const theirDraw = (): IPartnersDraw | null => others(objectId);
	const together = group.objectIds.length === 2 && each.length === 1 ? (each[0] as IContainment) : workOutContainment(ev, info, objectId, isOther, theirDraw);
	if (together.verdict === 'out') return 'own';
	const reasons = [together, ...each].map((c) => c.verdict);
	if (partnerUnsized || reasons.includes('unsized')) return 'unsized';
	if (reasons.includes('uneven')) return 'uneven';
	return together.verdict === 'few' ? 'few' : 'partial';
}

/** Verdicts already worked out, per group and documents map. */
const VERDICTS = new WeakMap<object, WeakMap<ReadonlyMap<string, IDocInfo>, CopyVerdict>>();

/**
 * What a group is: 'copies' when another document of the group holds each
 * one; 'passages' when each holds text the others do not (shared text);
 * 'mixed' when some do; otherwise why the sample cannot tell: 'unsized' (the
 * store did not report a chunk count), 'uneven' (the sample was not drawn
 * evenly within documents), 'sparse' (too few chunks of a document sampled to
 * tell, such as a boilerplate paragraph at the end of long files, sampled once
 * each) or 'partial' (enough sampled, not enough to tell yet). Worked out once
 * per group and documents map, in time linear in the group's pairs.
 *
 * @param group - The group.
 * @param info - The documents.
 * @returns The verdict.
 */
export function copyVerdict(group: Pick<IDocumentGroup, 'objectIds' | 'evidence'>, info: ReadonlyMap<string, IDocInfo>): CopyVerdict {
	let byInfo = VERDICTS.get(group);
	const known = byInfo?.get(info);
	if (known !== undefined) return known;
	const others = othersDraw(group, info);
	const members = new Set(group.objectIds);
	const each = group.objectIds.map((id) => docVerdict(group, info, id, members, others));
	let verdict: CopyVerdict;
	if (each.length > 0 && each.every((v) => v === 'whole')) verdict = 'copies';
	else if (each.length > 0 && each.every((v) => v === 'own')) verdict = 'passages';
	else if (each.includes('own')) verdict = 'mixed';
	else if (each.includes('unsized')) verdict = 'unsized';
	else if (each.includes('uneven')) verdict = 'uneven';
	else verdict = each.includes('few') || each.length === 0 ? 'sparse' : 'partial';
	if (!byInfo) {
		byInfo = new WeakMap();
		VERDICTS.set(group, byInfo);
	}
	byInfo.set(info, verdict);
	return verdict;
}

/**
 * Whether a group's documents are copies of each other (see copyVerdict).
 *
 * @param group - The group.
 * @param info - The documents.
 * @returns True for copies.
 */
export function isCopyGroup(group: Pick<IDocumentGroup, 'objectIds' | 'evidence'>, info: ReadonlyMap<string, IDocInfo>): boolean {
	return copyVerdict(group, info) === 'copies';
}

/**
 * Whether every document of a group holds text the others do not.
 *
 * @param group - The group.
 * @param info - The documents.
 * @returns True when the group holds shared passages only.
 */
export function isPassagesOnly(group: Pick<IDocumentGroup, 'objectIds' | 'evidence'>, info: ReadonlyMap<string, IDocInfo>): boolean {
	return copyVerdict(group, info) === 'passages';
}

/**
 * The document a group keeps: the hand-picked one, else the policy's. Which
 * of the others are queued is decided per document (queued).
 *
 * @param group - The group.
 * @param state - The choices.
 * @param info - The documents.
 * @returns The kept objectId, or null when none is chosen.
 */
export function keepOf(group: Pick<IDocumentGroup, 'key' | 'objectIds'>, state: IQueueState, info: ReadonlyMap<string, IDocInfo>): string | null {
	const picked = pickedKeep(group, state);
	return picked ?? applyPolicy(group, state.policy, info);
}

/**
 * The keep picked by hand in a group, or null.
 *
 * @param group - The group.
 * @param state - The choices.
 * @returns The objectId.
 */
export function pickedKeep(group: Pick<IDocumentGroup, 'key' | 'objectIds'>, state: IQueueState): string | null {
	const picked = state.overrides[group.key];
	return picked !== undefined && group.objectIds.includes(picked) ? picked : null;
}

/**
 * Whether every document of a group was marked reviewed.
 *
 * @param group - The group.
 * @param reviewed - The connection's reviewed documents.
 * @returns True when the group is out of the queue.
 */
export function isReviewed(group: Pick<IDocumentGroup, 'objectIds'>, reviewed: ReadonlySet<string>): boolean {
	return group.objectIds.length > 0 && group.objectIds.every((id) => reviewed.has(id));
}

/** The queue's content. */
export interface IQueued {
	/** Documents to remove, in group order, each once. */
	objectIds: string[];
	/** The documents each group queues, by group key. */
	byGroup: Map<string, string[]>;
	/** Documents a group would queue but another group keeps (not queued). */
	conflicts: string[];
	/** By group key: the documents a policy leaves in place because the sample does not show the kept one holds them, and why. */
	held: Map<string, Map<string, ContainmentVerdict>>;
	/** By group key: the documents a hand-picked keep queues that the sample does not show the kept one holds, and why. */
	unshown: Map<string, Map<string, ContainmentVerdict>>;
}

/**
 * The documents queued for removal. In every group across documents that is
 * not reviewed and has a kept document: a policy queues a document the sample
 * shows the kept one holds; a hand-picked keep queues every other document
 * (the ones not shown to be held are listed in `unshown`). A document kept by
 * hand in any group (reviewed ones included), or kept by a policy in a group
 * that queues something, is never queued; a group inside one document never
 * queues.
 *
 * @param found - The groups.
 * @param state - The choices.
 * @param info - The documents.
 * @param reviewed - The connection's reviewed documents.
 * @returns The queue.
 */
export function queued(found: readonly IDocumentGroup[], state: IQueueState, info: ReadonlyMap<string, IDocInfo>, reviewed: ReadonlySet<string>): IQueued {
	const across = found.filter((g) => !g.sameDocument);
	const kept = new Set<string>();
	for (const g of across) {
		const picked = pickedKeep(g, state);
		if (picked !== null) kept.add(picked);
	}
	const held = new Map<string, Map<string, ContainmentVerdict>>();
	const unshown = new Map<string, Map<string, ContainmentVerdict>>();
	const candidates = new Map<string, string[]>();
	for (const g of across) {
		if (isReviewed(g, reviewed)) continue;
		const keep = keepOf(g, state, info);
		if (keep === null) continue;
		const byHand = pickedKeep(g, state) !== null;
		const mine: string[] = [];
		for (const id of g.objectIds) {
			if (id === keep) continue;
			const c = containment(g, info, id, [keep]);
			if (c.verdict === 'in') mine.push(id);
			else if (byHand) {
				mine.push(id);
				const notes = unshown.get(g.key) ?? new Map<string, ContainmentVerdict>();
				notes.set(id, c.verdict);
				unshown.set(g.key, notes);
			} else {
				const notes = held.get(g.key) ?? new Map<string, ContainmentVerdict>();
				notes.set(id, c.verdict);
				held.set(g.key, notes);
			}
		}
		if (mine.length > 0) kept.add(keep);
		candidates.set(g.key, mine);
	}
	const objectIds: string[] = [];
	const seen = new Set<string>();
	const conflicts = new Set<string>();
	const byGroup = new Map<string, string[]>();
	for (const [key, mine] of candidates) {
		const queuedHere: string[] = [];
		for (const id of mine) {
			if (kept.has(id)) {
				conflicts.add(id);
				continue;
			}
			queuedHere.push(id);
			if (!seen.has(id)) {
				seen.add(id);
				objectIds.push(id);
			}
		}
		byGroup.set(key, queuedHere);
	}
	return { objectIds, byGroup, conflicts: [...conflicts].sort(), held, unshown };
}

// =============================================================================
// REVIEWED DOCUMENTS (the registry's 'reviewed documents' map, per connection)
// =============================================================================

/** The registry map of reviewed documents (adapters/connections.ts `reviewedDocuments`). */
export type ReviewedCache = Map<string, ReadonlySet<string>>;

/** One empty set for every connection without reviewed documents (stable, so memoised views do not recompute). */
const NONE_REVIEWED: ReadonlySet<string> = new Set<string>();

/**
 * A connection's reviewed documents.
 *
 * @param cache - The registry map.
 * @param connectionKey - The connection.
 * @returns The set (the same empty set when none).
 */
export function reviewedOf(cache: ReviewedCache, connectionKey: string): ReadonlySet<string> {
	return cache.get(connectionKey) ?? NONE_REVIEWED;
}

/**
 * Mark documents reviewed for a connection.
 *
 * @param cache - The registry map.
 * @param connectionKey - The connection.
 * @param objectIds - The documents.
 * @returns The connection's new set.
 */
export function markReviewed(cache: ReviewedCache, connectionKey: string, objectIds: readonly string[]): ReadonlySet<string> {
	const next = new Set(reviewedOf(cache, connectionKey));
	for (const id of objectIds) next.add(id);
	cache.set(connectionKey, next);
	return next;
}

/**
 * Take documents out of a connection's reviewed set ("Review again").
 *
 * @param cache - The registry map.
 * @param connectionKey - The connection.
 * @param objectIds - The documents.
 * @returns The connection's new set.
 */
export function unmarkReviewed(cache: ReviewedCache, connectionKey: string, objectIds: readonly string[]): ReadonlySet<string> {
	const next = new Set(reviewedOf(cache, connectionKey));
	for (const id of objectIds) next.delete(id);
	if (next.size === 0) cache.delete(connectionKey);
	else cache.set(connectionKey, next);
	return next;
}
