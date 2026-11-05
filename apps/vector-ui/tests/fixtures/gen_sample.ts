// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// VECTOR-UI TEST FIXTURES — synthetic `sample` answers (seeded, reproducible)
// =============================================================================
//
// Writes the provisional `sample` wire fixtures the map is built against before
// a live node can answer:
//
//   provisional/sample_demo_1000.json       detailed, 1,000 of 1,318 chunks, 42 documents, k = 15
//   provisional/sample_light_5000.json      light, 5,000 of 12,000 chunks, 300 documents, k = 10, 2-dp
//   provisional/sample_biased_refilled.json detailed, 180 of 200 requested, refilled ('random', biased)
//   provisional/sample_native_knn.json      detailed, 300 points, neighbour graph computed by the backend
//   provisional/sample_demo_1000_clusters.json  sample_demo_1000 asked with `cluster` (contract section
//                                           4.4-C): `clusters`, `points.table` and `listing`
//   provisional/sample_listing_truncated.json   detailed, 300 points of a 600-document collection whose
//                                           sampler listed only the first 500 (caveat listing_truncated)
//
// The points come from seeded synthetic clusters in a 48-dimensional space:
// topics (folders) -> documents -> chunks drifting along a per-document
// direction, plus two near-duplicate pairs, one boilerplate chunk shared by six
// documents and one document of noise (the outliers). The kNN graph is exact
// (cosine) in that space and the coordinates are its PCA, as the node computes
// them, so a layout built from the kNN graph has real structure to recover.
// The vectors themselves are never written.
//
// Clusters are computed as the contract describes them: mutual kNN edges at
// or above the given percentile of all edge similarities (60 first, raised by
// 10 while one group holds half the points and the percentile is below 95),
// connected groups by union-find, numbered by size, groups of 2 or more kept
// up to 200, and the 5 top TF-IDF terms of the largest groups of 5 or more.
//
// Usage (repository root):
//   npx tsx apps/vector-ui/tests/fixtures/gen_sample.ts          # write the files
//   npx tsx apps/vector-ui/tests/fixtures/gen_sample.ts --check  # exit 1 when a file differs
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IDuplicatePair, ISampleClusters, ISampleDoc, ISampleListing, ISampleResult, KnnSource, SampleMode, SampleStrategy } from '../../src/contract/types';

const OUT_DIR = join(__dirname, 'provisional');
// The app's programs declare a narrower global `process` (env only); this script runs under Node.
const nodeProcess = process as unknown as NodeJS.Process;
const DIM = 48;

// =============================================================================
// SEEDED RANDOMNESS
// =============================================================================

/**
 * Mulberry32: a small, fast, seedable PRNG (uniform in [0, 1)).
 *
 * @param seed - The seed.
 * @returns The generator.
 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Standard normal draws from a uniform generator (Box-Muller). */
function gaussian(rand: () => number): () => number {
	return () => {
		const u = Math.max(rand(), 1e-12);
		const v = rand();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	};
}

/** A random unit vector. */
function randomUnit(normal: () => number): Float64Array {
	const out = new Float64Array(DIM);
	for (let i = 0; i < DIM; i += 1) out[i] = normal();
	return normalise(out);
}

/** Scale a vector to unit length (in place) and return it. */
function normalise(v: Float64Array): Float64Array {
	let norm = 0;
	for (let i = 0; i < v.length; i += 1) norm += (v[i] as number) * (v[i] as number);
	norm = Math.sqrt(norm) || 1;
	for (let i = 0; i < v.length; i += 1) v[i] = (v[i] as number) / norm;
	return v;
}

/** a + s * b as a new vector. */
function axpy(a: Float64Array, s: number, b: Float64Array): Float64Array {
	const out = new Float64Array(a.length);
	for (let i = 0; i < a.length; i += 1) out[i] = (a[i] as number) + s * (b[i] as number);
	return out;
}

/** Dot product. */
function dot(a: Float64Array, b: Float64Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i += 1) s += (a[i] as number) * (b[i] as number);
	return s;
}

/** A deterministic 32-hex-digit id shaped like a uuid. */
function hexId(rand: () => number): string {
	let hex = '';
	for (let i = 0; i < 32; i += 1) hex += Math.floor(rand() * 16).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** FNV-1a over a string, as 8 hex digits (stands in for the node's sha1 prefix). */
function fnv8(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/** Round to `dp` decimals. */
function round(value: number, dp: number): number {
	const f = 10 ** dp;
	return Math.round(value * f) / f;
}

// =============================================================================
// SYNTHETIC CORPUS
// =============================================================================

/** One synthetic document. */
interface IDocSpec {
	objectId: string;
	path: string;
	chunks: number;
	/** Chunk vectors (unit), chunk id = index. */
	vectors: Float64Array[];
	/** Chunk lengths in characters. */
	lengths: number[];
	/** Snippet text per chunk. */
	snippets: string[];
}

/** What one fixture's corpus looks like. */
interface ICorpusSpec {
	seed: number;
	folders: readonly string[];
	documents: number;
	totalChunks: number;
	/** Spread of documents around their topic and chunks around their document. */
	docSpread: number;
	chunkSpread: number;
	/** Add the planted near-duplicates, boilerplate and noise document. */
	plant: boolean;
}

const WORDS = [
	'water', 'station', 'kestrel', 'greenhouse', 'orchid', 'falcon', 'budget', 'contract', 'sensor', 'protocol',
	'pressure', 'valve', 'season', 'harvest', 'invoice', 'clause', 'survey', 'nesting', 'humidity', 'spring',
	'maintenance', 'schedule', 'filter', 'report', 'ledger', 'audit', 'sample', 'trial', 'ticket', 'rotation',
];

/** A snippet of at most 120 characters, cut at a word boundary with an ellipsis. */
function snippet(rand: () => number, folder: string, file: string, chunkId: number): string {
	const words = [file.replace(/\.[a-z]+$/, '').replace(/_/g, ' '), `part ${chunkId + 1}:`];
	while (words.join(' ').length < 140) words.push(WORDS[Math.floor(rand() * WORDS.length)] as string);
	const text = `${folder} ${words.join(' ')}`;
	const cut = text.slice(0, 118);
	return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** Split `total` chunks over `count` documents, each at least 1, seeded. */
function chunkCounts(rand: () => number, count: number, total: number): number[] {
	const weights = Array.from({ length: count }, () => 0.2 + rand() * rand() * 3);
	const sum = weights.reduce((a, b) => a + b, 0);
	const counts = weights.map((w) => Math.max(1, Math.floor((w / sum) * total)));
	let diff = total - counts.reduce((a, b) => a + b, 0);
	for (let i = 0; diff !== 0; i = (i + 1) % count) {
		if (diff > 0) {
			counts[i] = (counts[i] as number) + 1;
			diff -= 1;
		} else if ((counts[i] as number) > 1) {
			counts[i] = (counts[i] as number) - 1;
			diff += 1;
		}
	}
	return counts;
}

/**
 * Build a corpus of documents with chunk vectors.
 *
 * @param spec - The corpus spec.
 * @returns The documents, in path order.
 */
function buildCorpus(spec: ICorpusSpec): IDocSpec[] {
	const rand = mulberry32(spec.seed);
	const normal = gaussian(rand);
	const topics = spec.folders.map(() => randomUnit(normal));
	const counts = chunkCounts(rand, spec.documents, spec.totalChunks);
	const docs: IDocSpec[] = [];
	for (let d = 0; d < spec.documents; d += 1) {
		const t = d % spec.folders.length;
		const folder = spec.folders[t] as string;
		const noiseDoc = spec.plant && d === spec.documents - 1;
		const file = noiseDoc ? 'ocr_scan_junk.txt' : `${folder}_${String(d).padStart(3, '0')}.${['md', 'pdf', 'docx', 'txt'][d % 4]}`;
		const centre = normalise(axpy(topics[t] as Float64Array, spec.docSpread, randomUnit(normal)));
		const drift = randomUnit(normal);
		const vectors: Float64Array[] = [];
		const lengths: number[] = [];
		const snippets: string[] = [];
		const n = counts[d] as number;
		for (let c = 0; c < n; c += 1) {
			const v = noiseDoc
				? randomUnit(normal)
				: normalise(axpy(axpy(centre, spec.chunkSpread, randomUnit(normal)), (0.6 * c) / Math.max(1, n), drift));
			vectors.push(v);
			lengths.push(noiseDoc ? 40 + Math.floor(rand() * 120) : 380 + Math.floor(rand() * 820));
			snippets.push(snippet(rand, folder, file, c));
		}
		docs.push({ objectId: hexId(rand), path: `C:/demo/${folder}/${file}`, chunks: n, vectors, lengths, snippets });
	}
	if (spec.plant && docs.length >= 8) {
		// Two near-duplicate pairs: the same file stored under two paths.
		for (const [a, b] of [[0, 1], [2, 3]] as const) {
			const source = docs[a] as IDocSpec;
			const copy = docs[b] as IDocSpec;
			copy.vectors[0] = normalise(axpy(source.vectors[0] as Float64Array, 0.02, randomUnit(normal)));
			copy.snippets[0] = source.snippets[0] as string;
		}
		// One boilerplate paragraph repeated as the last chunk of six documents.
		const boiler = randomUnit(normal);
		for (let d = 4; d < 10 && d < docs.length - 1; d += 1) {
			const doc = docs[d] as IDocSpec;
			const last = doc.chunks - 1;
			doc.vectors[last] = normalise(axpy(boiler, 0.03, randomUnit(normal)));
			doc.snippets[last] = 'Confidential. This document is the property of the Falcon Station operators; do not distribute without…';
		}
	}
	docs.sort((x, y) => x.path.localeCompare(y.path) || x.objectId.localeCompare(y.objectId));
	return docs;
}

// =============================================================================
// SAMPLING, kNN, PCA (what the node computes)
// =============================================================================

/** A sampled point. */
interface IPoint {
	doc: number;
	chunk: number;
	vector: Float64Array;
	len: number;
	snip: string;
	pinned: number;
}

/**
 * Stratified pick: the first chunk of every document, then random chunks until `n`.
 *
 * @param docs - The corpus.
 * @param n - Points wanted.
 * @param seed - The sampling seed.
 * @param pinnedDoc - Index of a document whose chunk 1 is pinned (include_keys), or -1.
 * @returns The points, ordered by document then chunk.
 */
function stratifiedSample(docs: IDocSpec[], n: number, seed: number, pinnedDoc: number): IPoint[] {
	const rand = mulberry32(seed * 7919 + 13);
	const chosen = new Set<string>();
	const order: Array<[number, number]> = [];
	const take = (d: number, c: number): void => {
		const key = `${d}#${c}`;
		if (chosen.has(key) || order.length >= n) return;
		chosen.add(key);
		order.push([d, c]);
	};
	if (pinnedDoc >= 0 && (docs[pinnedDoc] as IDocSpec).chunks > 1) take(pinnedDoc, 1);
	docs.forEach((_doc, d) => take(d, 0));
	const all: Array<[number, number]> = [];
	docs.forEach((doc, d) => {
		for (let c = 1; c < doc.chunks; c += 1) all.push([d, c]);
	});
	for (let i = all.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rand() * (i + 1));
		const tmp = all[i] as [number, number];
		all[i] = all[j] as [number, number];
		all[j] = tmp;
	}
	for (const [d, c] of all) take(d, c);
	order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	return order.map(([d, c]) => {
		const doc = docs[d] as IDocSpec;
		return {
			doc: d,
			chunk: c,
			vector: doc.vectors[c] as Float64Array,
			len: doc.lengths[c] as number,
			snip: doc.snippets[c] as string,
			pinned: d === pinnedDoc && c === 1 ? 1 : 0,
		};
	});
}

/**
 * Exact cosine kNN (vectors are unit length), in Qdrant's offsets layout.
 *
 * @param points - The points.
 * @param k - Neighbours per point.
 * @returns offsets_row, cols and sims.
 */
function knn(points: IPoint[], k: number): { offsets: number[]; cols: number[]; sims: number[] } {
	const offsets: number[] = [0];
	const cols: number[] = [];
	const sims: number[] = [];
	for (let i = 0; i < points.length; i += 1) {
		const row: Array<[number, number]> = [];
		const vi = (points[i] as IPoint).vector;
		for (let j = 0; j < points.length; j += 1) {
			if (j !== i) row.push([dot(vi, (points[j] as IPoint).vector), j]);
		}
		row.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
		for (const [sim, j] of row.slice(0, k)) {
			cols.push(j);
			sims.push(sim);
		}
		offsets.push(cols.length);
	}
	return { offsets, cols, sims };
}

/**
 * PCA by power iteration with deflation on the covariance matrix (dimension is small).
 * Sign convention: each component's largest absolute loading is positive.
 *
 * @param points - The points.
 * @param components - Components wanted (2 or 3).
 * @returns Coordinates per component and the explained variance ratios.
 */
function pca(points: IPoint[], components: number): { coords: number[][]; explained: number[] } {
	const n = points.length;
	const mean = new Float64Array(DIM);
	for (const p of points) for (let i = 0; i < DIM; i += 1) mean[i] = (mean[i] as number) + (p.vector[i] as number) / n;
	const centred = points.map((p) => {
		const out = new Float64Array(DIM);
		for (let i = 0; i < DIM; i += 1) out[i] = (p.vector[i] as number) - (mean[i] as number);
		return out;
	});
	const cov: Float64Array[] = Array.from({ length: DIM }, () => new Float64Array(DIM));
	for (const x of centred) {
		for (let i = 0; i < DIM; i += 1) {
			const xi = x[i] as number;
			const row = cov[i] as Float64Array;
			for (let j = 0; j < DIM; j += 1) row[j] = (row[j] as number) + (xi * (x[j] as number)) / n;
		}
	}
	let total = 0;
	for (let i = 0; i < DIM; i += 1) total += (cov[i] as Float64Array)[i] as number;
	const basis: Float64Array[] = [];
	const explained: number[] = [];
	for (let c = 0; c < components; c += 1) {
		let v: Float64Array = new Float64Array(DIM).fill(1 / Math.sqrt(DIM));
		let lambda = 0;
		for (let iter = 0; iter < 500; iter += 1) {
			const next = new Float64Array(DIM);
			for (let i = 0; i < DIM; i += 1) next[i] = dot(cov[i] as Float64Array, v);
			lambda = Math.sqrt(dot(next, next));
			v = normalise(next);
		}
		let big = 0;
		for (let i = 0; i < DIM; i += 1) if (Math.abs(v[i] as number) > Math.abs(v[big] as number)) big = i;
		if ((v[big] as number) < 0) for (let i = 0; i < DIM; i += 1) v[i] = -(v[i] as number);
		basis.push(v);
		explained.push(lambda / total);
		for (let i = 0; i < DIM; i += 1) {
			const row = cov[i] as Float64Array;
			for (let j = 0; j < DIM; j += 1) row[j] = (row[j] as number) - lambda * (v[i] as number) * (v[j] as number);
		}
	}
	const coords = basis.map((b) => centred.map((x) => dot(x, b)));
	return { coords, explained };
}

/**
 * kNN overlap of a 2D layout with the graph: the mean share of each point's k
 * graph neighbours that are among its k nearest points in the layout. (The
 * map's layout-quality metric; printed so the fixture records PCA's baseline.)
 */
function knnOverlap(x: number[], y: number[], offsets: number[], cols: number[], k: number): number {
	let total = 0;
	for (let i = 0; i < x.length; i += 1) {
		const near: Array<[number, number]> = [];
		for (let j = 0; j < x.length; j += 1) {
			if (j !== i) near.push([((x[j] as number) - (x[i] as number)) ** 2 + ((y[j] as number) - (y[i] as number)) ** 2, j]);
		}
		near.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		const layout = new Set(near.slice(0, k).map(([, j]) => j));
		const graph = cols.slice(offsets[i] as number, (offsets[i] as number) + k);
		total += graph.filter((j) => layout.has(j)).length / Math.max(1, graph.length);
	}
	return total / Math.max(1, x.length);
}

// =============================================================================
// CLUSTERS (what a node that computes clusters answers)
// =============================================================================

/** Words never used as a label (a short English stop list; the node's is longer). */
const STOP_WORDS = new Set(
	('the and for are but not you all any can had her was one our out has his how its may new now old see two way who did get let put say she too use part this that with from have they will your what when were been into than them then some more also only over such each most other which their there these those about after before under while where would could should').split(' ')
);

/** At most this many chunk texts are read per labelled group. */
const LABELLED_FROM = 50;

/** At most this many groups are labelled (the largest with at least 5 points). */
const LABELLED_MAX = 50;

/** Groups kept (limits.max_components). */
const MAX_COMPONENTS = 200;

/**
 * The p-th percentile of values (linear interpolation, as numpy's default).
 *
 * @param sorted - Values, ascending.
 * @param p - Percentile, 0 to 100.
 * @returns The percentile.
 */
function percentileOf(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const at = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
	const lo = Math.floor(at);
	const hi = Math.min(sorted.length - 1, lo + 1);
	return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (at - lo);
}

/**
 * Connected groups of the mutual kNN edges at or above a threshold (union-find with path halving).
 *
 * @param n - Points.
 * @param graph - The kNN graph.
 * @param threshold - The similarity an edge needs.
 * @returns The root of every point.
 */
function components(n: number, graph: { offsets: number[]; cols: number[]; sims: number[] }, threshold: number): number[] {
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (x: number): number => {
		let r = x;
		while (parent[r] !== r) {
			parent[r] = parent[parent[r] as number] as number;
			r = parent[r] as number;
		}
		return r;
	};
	const neighbours = (i: number): number[] => graph.cols.slice(graph.offsets[i] as number, graph.offsets[i + 1] as number);
	for (let i = 0; i < n; i += 1) {
		for (let e = graph.offsets[i] as number; e < (graph.offsets[i + 1] as number); e += 1) {
			const j = graph.cols[e] as number;
			if (j <= i || (graph.sims[e] as number) < threshold || !neighbours(j).includes(i)) continue;
			const a = find(i);
			const b = find(j);
			if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
		}
	}
	return Array.from({ length: n }, (_, i) => find(i));
}

/**
 * The `clusters` block of a sample answer.
 *
 * @param points - The sampled points.
 * @param graph - Their kNN graph.
 * @returns The clusters, numbered by size (largest first), with labels for the largest.
 */
function clustersOf(points: IPoint[], graph: { offsets: number[]; cols: number[]; sims: number[] }): ISampleClusters {
	const n = points.length;
	const sorted = [...graph.sims].sort((a, b) => a - b);
	let percentile = 60;
	let threshold = percentileOf(sorted, percentile);
	let roots = components(n, graph, threshold);
	const largest = (rs: number[]): number => Math.max(0, ...[...rs.reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), new Map<number, number>()).values()]);
	while (largest(roots) >= n / 2 && percentile < 95) {
		percentile += 10;
		threshold = percentileOf(sorted, percentile);
		roots = components(n, graph, threshold);
	}
	const members = new Map<number, number[]>();
	roots.forEach((r, i) => members.set(r, [...(members.get(r) ?? []), i]));
	const groups = [...members.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length || (a[0] as number) - (b[0] as number)).slice(0, MAX_COMPONENTS);
	const labels = new Array<number>(n).fill(-1);
	groups.forEach((g, id) => g.forEach((i) => (labels[i] = id)));
	// Labels: the top 5 TF-IDF terms of the largest groups of 5 or more, over their first 50 chunk texts.
	const labelled = groups.filter((g) => g.length >= 5).slice(0, LABELLED_MAX);
	const terms = labelled.map((g) => {
		const counts = new Map<string, number>();
		for (const i of g.slice(0, LABELLED_FROM)) {
			for (const token of (points[i] as IPoint).snip.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []) {
				if (token.length < 3 || STOP_WORDS.has(token)) continue;
				counts.set(token, (counts.get(token) ?? 0) + 1);
			}
		}
		return counts;
	});
	const df = new Map<string, number>();
	for (const counts of terms) for (const token of counts.keys()) df.set(token, (df.get(token) ?? 0) + 1);
	const keywords = groups.map((_g, id) => {
		const counts = id < terms.length ? (terms[id] as Map<string, number>) : null;
		if (counts === null) return [];
		return [...counts.entries()]
			.map(([token, tf]) => ({ token, tf, score: tf * Math.log(1 + terms.length / (df.get(token) as number)) }))
			.sort((a, b) => b.score - a.score || b.tf - a.tf || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
			.slice(0, 5)
			.map((t) => t.token);
	});
	return {
		method: 'knn-components',
		edge_threshold: round(threshold, 4),
		percentile,
		count: groups.length,
		noise: labels.filter((l) => l < 0).length,
		labels,
		sizes: groups.map((g) => g.length),
		keywords,
		labelled: labelled.length,
		label_source: 'text',
		labelled_from: LABELLED_FROM,
		took_ms: { clusters: 41, labels: 120 },
	};
}

// =============================================================================
// ANSWER
// =============================================================================

/** One fixture's parameters. */
interface IFixtureSpec {
	file: string;
	corpus: ICorpusSpec;
	n: number;
	nRequested: number;
	seed: number;
	mode: SampleMode;
	k: number;
	strategyUsed: SampleStrategy;
	biased: boolean;
	knnSource: KnnSource;
	tookMs: number;
	caveats: string[];
	pinnedDoc: number;
	/** Sample only from the first this many documents by path (the sampler's listing stopped there). */
	listed?: number;
	/** The answer's `listing` (contract section 4.4-B). */
	listing?: ISampleListing;
	/** Add `clusters` (the call sent `cluster`). */
	clusters?: boolean;
	/** Add `points.table`: the folder whose chunks every fifth of are tables. */
	tableFolder?: string;
}

/**
 * Build one `sample` answer.
 *
 * @param spec - The fixture spec.
 * @returns The answer and PCA's kNN overlap.
 */
function buildAnswer(spec: IFixtureSpec): { answer: ISampleResult; pcaOverlap: number } {
	const corpus = buildCorpus(spec.corpus);
	const docs = spec.listed === undefined ? corpus : corpus.slice(0, spec.listed);
	const points = stratifiedSample(docs, spec.n, spec.seed, spec.pinnedDoc);
	const graph = knn(points, spec.k);
	const { coords, explained } = pca(points, 3);
	const light = spec.mode === 'light';
	const bulk = light ? 2 : 4;
	const density = points.map((_p, i) => {
		const sims = graph.sims.slice(graph.offsets[i] as number, graph.offsets[i + 1] as number);
		return sims.reduce((a, b) => a + b, 0) / Math.max(1, sims.length);
	});
	const ranked = density.map((d, i) => [d, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const outliers = ranked.slice(0, Math.max(1, Math.round(points.length * 0.01))).map(([, i]) => i);
	const duplicates: IDuplicatePair[] = [];
	for (let i = 0; i < points.length; i += 1) {
		for (let e = graph.offsets[i] as number; e < (graph.offsets[i + 1] as number); e += 1) {
			const j = graph.cols[e] as number;
			const sim = graph.sims[e] as number;
			if (i < j && sim >= 0.97) duplicates.push({ a: i, b: j, sim: round(sim, 4) });
		}
	}
	const inSample = new Map<number, number>();
	for (const p of points) inSample.set(p.doc, (inSample.get(p.doc) ?? 0) + 1);
	const docIndex = new Map<number, number>();
	const sampleDocs: ISampleDoc[] = [];
	for (const p of points) {
		if (docIndex.has(p.doc)) continue;
		const doc = docs[p.doc] as IDocSpec;
		docIndex.set(p.doc, sampleDocs.length);
		sampleDocs.push({ i: sampleDocs.length, objectId: doc.objectId, path: doc.path, chunks: doc.chunks, in_sample: inSample.get(p.doc) as number });
	}
	const keys = points.map((p) => `${(docs[p.doc] as IDocSpec).objectId}#${p.chunk}`).join('|');
	const x = (coords[0] as number[]).map((v) => round(v, bulk));
	const y = (coords[1] as number[]).map((v) => round(v, bulk));
	const answer: ISampleResult = {
		success: true,
		sample_id: `s-${spec.seed}-${fnv8(keys)}`,
		expires_in_s: 600,
		n: points.length,
		n_requested: spec.nRequested,
		mode: spec.mode,
		of: { chunks: spec.corpus.totalChunks, documents: spec.corpus.documents },
		strategy_used: spec.strategyUsed,
		biased: spec.biased,
		knn_source: spec.knnSource,
		metric: 'cosine',
		dimension: 384,
		docs: sampleDocs,
		points: {
			doc: points.map((p) => docIndex.get(p.doc) as number),
			chunk: points.map((p) => p.chunk),
			x,
			y,
			z: (coords[2] as number[]).map((v) => round(v, bulk)),
			len: points.map((p) => p.len),
			...(light ? {} : { snip: points.map((p) => p.snip) }),
			pinned: points.map((p) => p.pinned),
			...(spec.tableFolder === undefined ? {} : { table: points.map((p) => ((docs[p.doc] as IDocSpec).path.includes(`/${spec.tableFolder}/`) && p.chunk % 5 === 4 ? 1 : 0)) }),
		},
		knn: { k: spec.k, offsets_row: graph.offsets, cols: graph.cols, sims: graph.sims.map((s) => round(s, bulk)) },
		density: density.map((d) => round(d, bulk)),
		outliers,
		duplicates,
		pca: { explained: explained.map((e) => round(e, 5)) },
		took_ms: spec.tookMs,
		...(spec.caveats.length > 0 ? { caveats: spec.caveats } : {}),
		...(spec.clusters ? { clusters: clustersOf(points, graph) } : {}),
		...(spec.listing === undefined ? {} : { listing: spec.listing }),
	};
	return { answer, pcaOverlap: knnOverlap(x, y, graph.offsets, graph.cols, Math.min(spec.k, 15)) };
}

const DEMO_FOLDERS = ['field', 'finance', 'greenhouse', 'handbooks', 'legal', 'ops', 'research', 'support'] as const;
const LIGHT_FOLDERS = [...DEMO_FOLDERS, 'archive', 'hr', 'marketing', 'sales'] as const;

const FIXTURES: IFixtureSpec[] = [
	{
		file: 'sample_demo_1000.json',
		corpus: { seed: 7, folders: DEMO_FOLDERS, documents: 42, totalChunks: 1318, docSpread: 0.9, chunkSpread: 0.75, plant: true },
		n: 1000, nRequested: 1000, seed: 7, mode: 'detailed', k: 15,
		strategyUsed: 'stratified', biased: false, knnSource: 'node', tookMs: 420, caveats: [], pinnedDoc: 5,
	},
	{
		file: 'sample_light_5000.json',
		corpus: { seed: 11, folders: LIGHT_FOLDERS, documents: 300, totalChunks: 12000, docSpread: 0.9, chunkSpread: 0.75, plant: true },
		n: 5000, nRequested: 5000, seed: 11, mode: 'light', k: 10,
		strategyUsed: 'stratified', biased: false, knnSource: 'node', tookMs: 2310, caveats: [], pinnedDoc: -1,
	},
	{
		file: 'sample_biased_refilled.json',
		corpus: { seed: 23, folders: DEMO_FOLDERS, documents: 12, totalChunks: 180, docSpread: 0.9, chunkSpread: 0.75, plant: false },
		n: 180, nRequested: 200, seed: 23, mode: 'detailed', k: 15,
		strategyUsed: 'random', biased: true, knnSource: 'node', tookMs: 95, caveats: ['biased_sample'], pinnedDoc: -1,
	},
	{
		file: 'sample_native_knn.json',
		corpus: { seed: 31, folders: DEMO_FOLDERS, documents: 20, totalChunks: 300, docSpread: 0.9, chunkSpread: 0.75, plant: true },
		n: 300, nRequested: 300, seed: 31, mode: 'detailed', k: 15,
		strategyUsed: 'random', biased: false, knnSource: 'native', tookMs: 160, caveats: [], pinnedDoc: -1,
	},
	{
		file: 'sample_demo_1000_clusters.json',
		corpus: { seed: 7, folders: DEMO_FOLDERS, documents: 42, totalChunks: 1318, docSpread: 0.9, chunkSpread: 0.75, plant: true },
		n: 1000, nRequested: 1000, seed: 7, mode: 'detailed', k: 15,
		strategyUsed: 'stratified', biased: false, knnSource: 'node', tookMs: 581, caveats: [], pinnedDoc: 5,
		clusters: true, tableFolder: 'finance', listing: { documents: 42, truncated: false, reason: 'complete' },
	},
	{
		file: 'sample_listing_truncated.json',
		corpus: { seed: 41, folders: DEMO_FOLDERS, documents: 600, totalChunks: 1800, docSpread: 0.9, chunkSpread: 0.75, plant: false },
		n: 300, nRequested: 300, seed: 41, mode: 'detailed', k: 15, listed: 500,
		strategyUsed: 'stratified', biased: false, knnSource: 'native', tookMs: 240, caveats: ['listing_truncated'], pinnedDoc: -1,
		listing: { documents: 500, truncated: true, reason: 'cap' },
	},
];

/**
 * Write (or with --check compare) every fixture.
 *
 * @returns The process exit code.
 */
function main(): number {
	const check = nodeProcess.argv.includes('--check');
	let drift = 0;
	for (const spec of FIXTURES) {
		const { answer, pcaOverlap } = buildAnswer(spec);
		// Large answers are written compact (as the node sends them); small ones indented for review.
		const text = (answer.n >= 500 ? JSON.stringify(answer) : JSON.stringify(answer, null, '\t')) + '\n';
		const path = join(OUT_DIR, spec.file);
		if (check) {
			let current = '';
			try {
				current = readFileSync(path, 'utf8');
			} catch {
				current = '';
			}
			if (current !== text) {
				drift += 1;
				console.log(`${spec.file}: differs from a fresh generation`);
			}
		} else {
			writeFileSync(path, text);
		}
		const clusters = answer.clusters ? ` clusters=${answer.clusters.count} noise=${answer.clusters.noise} percentile=${answer.clusters.percentile} labelled=${answer.clusters.labelled}` : '';
		console.log(`${spec.file}: n=${answer.n} k=${answer.knn.k} duplicates=${answer.duplicates.length} outliers=${answer.outliers.length}${clusters} bytes=${text.length} pca_knn_overlap=${pcaOverlap.toFixed(3)}`);
	}
	return drift === 0 ? 0 : 1;
}

nodeProcess.exitCode = main();
