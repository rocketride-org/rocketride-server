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
// MAP - CLUSTERS (pure: the node's groups, folded by the minimum size here)
// =============================================================================
//
// A node that computes clusters answers `sample` with `clusters` (contract
// section 4.4-C): the connected groups of the sample's mutual kNN edges above a
// similarity threshold, numbered by size, every group of 2 or more points kept
// and up to 5 terms for the largest ones. The minimum size the person picks
// (2, 5 or 10) is applied HERE: groups below it are folded into noise and the
// rest renumbered, so changing it never calls the store (a control over data
// the browser already holds never re-samples).
//
// From the folded view come the Clusters tab's rows (largest first, sized by
// the points still shown), each group's medoid (the member nearest the
// group's centre, where its label is drawn) and the legend's sentence.
// =============================================================================

import type { ClusterMinSize, ISampleClusters, ISampleResult } from '../contract/types';
import { num } from './wording';

/** The minimum sizes offered. */
export const CLUSTER_MIN_SIZES: readonly ClusterMinSize[] = [2, 5, 10];

/** The minimum size the map starts with. */
export const DEFAULT_MIN_CLUSTER_SIZE: ClusterMinSize = 5;

/** The percentile the node starts from (it raises it while one group holds half the points). */
export const START_PERCENTILE = 60;

/** The folded groups. */
export interface IClusterFold {
	/** Per point: its group (0 = largest kept) or -1 (noise). */
	labels: Int32Array;
	/** Groups kept. */
	count: number;
	/** Points in no kept group. */
	noise: number;
	/** Points per kept group (as the node counted them). */
	sizes: number[];
	/** Kept group -> the node's group number. */
	source: number[];
}

/** The folded groups with their terms. */
export interface IClusterView extends IClusterFold {
	/** Kept group -> up to 5 terms ([] when the node sent none). */
	keywords: string[][];
	/** The minimum size applied. */
	minSize: number;
}

/** One row of the Clusters tab. */
export interface IClusterRow {
	/** The folded group number. */
	cluster: number;
	/** Its words: the terms joined by " · ", or "group N". */
	label: string;
	keywords: string[];
	/** Points shown (hidden ones left out). */
	size: number;
	/** objectIds of its documents, in first-seen order. */
	documents: string[];
	/** Its points. */
	indices: number[];
}

/** The noise row. */
export interface INoiseRow {
	size: number;
	documents: string[];
	indices: number[];
}

/**
 * Fold the node's groups by a minimum size: smaller groups become noise; the
 * rest are ranked by size (largest first, ties by the node's number) and
 * renumbered from 0.
 *
 * @param labels - The node's group per point (-1 = noise).
 * @param sizes - Points per node group.
 * @param minSize - The smallest group kept.
 * @returns The folded labels, count, noise and sizes.
 */
export function fold(labels: ArrayLike<number>, sizes: readonly number[], minSize: number): IClusterFold {
	const kept = sizes
		.map((size, g) => ({ size, g }))
		.filter((row) => row.size >= minSize && row.size > 0)
		.sort((x, y) => y.size - x.size || x.g - y.g);
	const remap = new Int32Array(sizes.length).fill(-1);
	kept.forEach((row, rank) => (remap[row.g] = rank));
	const out = new Int32Array(labels.length);
	let noise = 0;
	for (let i = 0; i < labels.length; i += 1) {
		const g = labels[i] as number;
		const folded = Number.isInteger(g) && g >= 0 && g < remap.length ? (remap[g] as number) : -1;
		out[i] = folded;
		if (folded < 0) noise += 1;
	}
	return { labels: out, count: kept.length, noise, sizes: kept.map((row) => row.size), source: kept.map((row) => row.g) };
}

/**
 * The node's clusters folded by a minimum size, with their terms.
 *
 * @param clusters - `sample.clusters`.
 * @param minSize - The smallest group kept.
 * @returns The view.
 */
export function clusterView(clusters: ISampleClusters, minSize: number): IClusterView {
	const folded = fold(clusters.labels, clusters.sizes, minSize);
	return { ...folded, keywords: folded.source.map((g) => (clusters.keywords[g] ?? []).slice(0, 5)), minSize };
}

/**
 * A point's group.
 *
 * @param view - The folded view.
 * @param i - Point index.
 * @returns Its group, or -1 for noise.
 */
export function clusterOf(view: Pick<IClusterFold, 'labels'>, i: number): number {
	const g = view.labels[i];
	return g === undefined ? -1 : g;
}

/**
 * A group's words.
 *
 * @param view - The folded view.
 * @param g - The group.
 * @returns Its terms joined by " · ", or "group N" (1-based) when the node sent none.
 */
export function clusterLabel(view: Pick<IClusterView, 'keywords'>, g: number): string {
	const words = view.keywords[g] ?? [];
	return words.length > 0 ? words.join(' · ') : `group ${g + 1}`;
}

/**
 * The rows of the Clusters tab and the noise row.
 *
 * @param sample - The `sample` answer.
 * @param view - The folded view.
 * @param hidden - Points not shown (removed documents, isolation).
 * @returns Rows by size (largest first, ties by group), and the noise.
 */
export function clusterRows(sample: ISampleResult, view: IClusterView, hidden?: ArrayLike<number> | null): { rows: IClusterRow[]; noise: INoiseRow } {
	const indices: number[][] = Array.from({ length: view.count }, () => []);
	const noise: number[] = [];
	for (let i = 0; i < sample.n; i += 1) {
		if (hidden != null && (hidden[i] as number) !== 0) continue;
		const g = clusterOf(view, i);
		if (g >= 0 && g < view.count) (indices[g] as number[]).push(i);
		else noise.push(i);
	}
	const documentsOf = (list: number[]): string[] => {
		const seen = new Set<string>();
		for (const i of list) {
			const objectId = sample.docs[sample.points.doc[i] as number]?.objectId;
			if (objectId !== undefined) seen.add(objectId);
		}
		return Array.from(seen);
	};
	const rows = indices
		.map((list, g): IClusterRow => ({ cluster: g, label: clusterLabel(view, g), keywords: view.keywords[g] ?? [], size: list.length, documents: documentsOf(list), indices: list }))
		.filter((row) => row.size > 0)
		.sort((x, y) => y.size - x.size || x.cluster - y.cluster);
	return { rows, noise: { size: noise.length, documents: documentsOf(noise), indices: noise } };
}

/**
 * Where each group's label is drawn: the visible member nearest the group's
 * centre (on the layout shown).
 *
 * @param positions - Layout coordinates, `dims` per point.
 * @param dims - 2 or 3.
 * @param view - The folded view.
 * @param hidden - Points not shown.
 * @returns Per group, a point index (-1 when no member is shown).
 */
export function medoids(positions: ArrayLike<number>, dims: 2 | 3, view: Pick<IClusterFold, 'labels' | 'count'>, hidden?: ArrayLike<number> | null): Int32Array {
	const n = Math.min(view.labels.length, Math.floor(positions.length / dims));
	const sum = new Float64Array(view.count * 3);
	const count = new Int32Array(view.count);
	const shown = (i: number): boolean => !(hidden != null && (hidden[i] as number) !== 0);
	for (let i = 0; i < n; i += 1) {
		const g = view.labels[i] as number;
		if (g < 0 || g >= view.count || !shown(i)) continue;
		for (let d = 0; d < dims; d += 1) sum[g * 3 + d] = (sum[g * 3 + d] as number) + (positions[i * dims + d] as number);
		count[g] = (count[g] as number) + 1;
	}
	const best = new Int32Array(view.count).fill(-1);
	const bestD = new Float64Array(view.count).fill(Infinity);
	for (let i = 0; i < n; i += 1) {
		const g = view.labels[i] as number;
		if (g < 0 || g >= view.count || !shown(i)) continue;
		let d2 = 0;
		for (let d = 0; d < dims; d += 1) {
			const delta = (positions[i * dims + d] as number) - (sum[g * 3 + d] as number) / (count[g] as number);
			d2 += delta * delta;
		}
		if (d2 < (bestD[g] as number)) {
			bestD[g] = d2;
			best[g] = i;
		}
	}
	return best;
}

/**
 * The legend's sentence on what a cluster is.
 *
 * @param clusters - `sample.clusters`.
 * @param minSize - The minimum size applied in the browser.
 * @returns The sentence.
 */
export function clusterSentence(clusters: Pick<ISampleClusters, 'edge_threshold' | 'percentile' | 'label_source' | 'labelled_from'>, minSize: number): string {
	const threshold = clusters.edge_threshold.toFixed(2);
	const how = clusters.percentile > START_PERCENTILE ? `raised from the ${ordinal(START_PERCENTILE)} to the ${ordinal(clusters.percentile)} percentile because the graph was one connected group` : `the ${ordinal(clusters.percentile)} percentile of its edges, computed by the store node`;
	const labels = clusters.label_source === 'text' ? `labels are the most frequent terms of up to ${num(clusters.labelled_from)} of their chunks.` : clusters.label_source === 'paths' ? 'Labels from file names (this store returned no text).' : 'the groups are not labelled (this store returned neither text nor file names).';
	return `Clusters: connected groups of the sample's neighbour graph above similarity ${threshold} (${how}), groups of at least ${num(minSize)} points; ${labels}`;
}

/**
 * 60 -> "60th", 81 -> "81st".
 *
 * @param n - A whole number.
 * @returns Its ordinal.
 */
function ordinal(n: number): string {
	const v = Math.round(n);
	const tens = v % 100;
	if (tens >= 11 && tens <= 13) return `${v}th`;
	const ones = v % 10;
	return `${v}${ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th'}`;
}
