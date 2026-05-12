/**
 * Coverage diff: /services list vs exercised nodes vs excluded list.
 *
 * Buckets every known node into covered / excluded / gap. A non-empty gap
 * is the run-level coverage failure signal.
 */

import type { ExclusionEntry } from './exclusions';

export type CoverageDiff = {
	knownCount: number;
	covered: string[];
	excluded: Array<{ node: string; reason: string }>;
	gaps: string[];
};

export function diffCoverage(args: {
	knownNodes: Set<string>;
	exercisedNodes: Set<string>;
	excluded: Map<string, ExclusionEntry>;
}): CoverageDiff {
	const covered: string[] = [];
	const gaps: string[] = [];

	for (const node of Array.from(args.knownNodes).sort()) {
		if (args.excluded.has(node)) continue;
		if (args.exercisedNodes.has(node)) {
			covered.push(node);
		} else {
			gaps.push(node);
		}
	}

	const excludedList = Array.from(args.excluded.values())
		.map((e) => ({ node: e.node, reason: e.reason }))
		.sort((a, b) => a.node.localeCompare(b.node));

	return {
		knownCount: args.knownNodes.size,
		covered,
		excluded: excludedList,
		gaps,
	};
}
