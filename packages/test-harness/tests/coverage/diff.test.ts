import { describe, expect, it } from 'vitest';

import { diffCoverage } from '../../src/coverage/diff';
import type { ExclusionEntry } from '../../src/coverage/exclusions';

function exclusionMap(entries: ExclusionEntry[]): Map<string, ExclusionEntry> {
	return new Map(entries.map((e) => [e.node, e]));
}

describe('diffCoverage', () => {
	it('classifies each known node into covered, excluded, or gap', () => {
		const result = diffCoverage({
			knownNodes: new Set(['llm_openai', 'parse', 'qdrant', 'db_mysql']),
			exercisedNodes: new Set(['llm_openai', 'parse']),
			excluded: exclusionMap([
				{ node: 'qdrant', reason: 'requires a running qdrant instance', owner: 'a', added: '2026-01-01' },
			]),
		});

		expect(result.knownCount).toBe(4);
		expect(result.covered).toEqual(['llm_openai', 'parse']);
		expect(result.excluded).toEqual([{ node: 'qdrant', reason: 'requires a running qdrant instance' }]);
		expect(result.gaps).toEqual(['db_mysql']);
	});

	it('ignores exercised nodes that are not in the known set', () => {
		const result = diffCoverage({
			knownNodes: new Set(['parse']),
			exercisedNodes: new Set(['parse', 'response']), // response not in /services
			excluded: new Map(),
		});

		expect(result.covered).toEqual(['parse']);
		expect(result.gaps).toEqual([]);
	});

	it('does not put excluded nodes in gaps even when not exercised', () => {
		const result = diffCoverage({
			knownNodes: new Set(['db_mysql']),
			exercisedNodes: new Set(),
			excluded: exclusionMap([
				{ node: 'db_mysql', reason: 'needs running MySQL instance', owner: 'a', added: '2026-01-01' },
			]),
		});

		expect(result.covered).toEqual([]);
		expect(result.gaps).toEqual([]);
		expect(result.excluded).toHaveLength(1);
	});

	it('returns covered + gaps in sorted order for deterministic reports', () => {
		const result = diffCoverage({
			knownNodes: new Set(['zeta', 'alpha', 'beta']),
			exercisedNodes: new Set(['zeta', 'alpha']),
			excluded: new Map(),
		});

		expect(result.covered).toEqual(['alpha', 'zeta']);
		expect(result.gaps).toEqual(['beta']);
	});
});
