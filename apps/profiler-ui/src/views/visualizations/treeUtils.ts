// MIT License
//
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
// TREE UTILS — shared profile-tree shaping for the visualisations
// =============================================================================
//
// One implementation of the cutoff prune and depth limit used by both the
// flame graph and the sunburst chart, so their shaping never drifts apart.
// =============================================================================

import type { ProfileTreeNode } from './types';

/**
 * Apply cutoff pruning to a tree node.
 * Returns a new node with children filtered by the cutoff threshold.
 * A child is removed when nothing in its subtree reaches cutoff * the
 * parent's weight, where a node's weight is the largest cumtime in its
 * subtree. Its own cumtime is not enough: frames still running when
 * profiling stopped read ~0, and a coroutine is booked its whole lifetime
 * while the loop step that resumes it is not. Apply before limitDepth, so
 * weights see the whole subtree.
 */
export function pruneTree(node: ProfileTreeNode, cutoff: number): ProfileTreeNode {
	if (cutoff <= 0 || !node.children.length) return node;

	const weights = new Map<ProfileTreeNode, number>();
	const weightOf = (n: ProfileTreeNode): number => {
		let weight = weights.get(n);
		if (weight === undefined) {
			weight = n.children.reduce((max, c) => Math.max(max, weightOf(c)), n.cumtime);
			weights.set(n, weight);
		}
		return weight;
	};

	const prune = (n: ProfileTreeNode): ProfileTreeNode => {
		const threshold = cutoff * weightOf(n);
		return { ...n, children: n.children.filter((c) => weightOf(c) >= threshold).map(prune) };
	};
	return prune(node);
}

/**
 * Limit tree depth to maxDepth levels.
 * Returns a new tree with children beyond maxDepth removed.
 */
export function limitDepth(node: ProfileTreeNode, maxDepth: number, depth: number = 0): ProfileTreeNode {
	if (depth >= maxDepth) return { ...node, children: [] };
	return {
		...node,
		children: node.children.map((c) => limitDepth(c, maxDepth, depth + 1)),
	};
}
