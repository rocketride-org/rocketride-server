import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadExclusions, validateExclusions, writeStarterExclusions, type ExclusionsFile } from '../../src/coverage/exclusions';

describe('exclusions', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'harness-exclusions-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('loads an empty file when none exists', () => {
		const result = loadExclusions(join(tmpDir, 'missing.json'));
		expect(result.exclusions).toEqual([]);
		expect(result.version).toBe(1);
	});

	it('rejects unsupported versions', () => {
		const filePath = join(tmpDir, 'bad-version.json');
		writeFileSync(filePath, JSON.stringify({ version: 2, exclusions: [] }));
		expect(() => loadExclusions(filePath)).toThrow(/Unsupported exclusions version/);
	});

	it('rejects a non-array exclusions field', () => {
		const filePath = join(tmpDir, 'bad-shape.json');
		writeFileSync(filePath, JSON.stringify({ version: 1, exclusions: 'not an array' }));
		expect(() => loadExclusions(filePath)).toThrow(/exclusions field must be an array/);
	});
});

describe('validateExclusions', () => {
	const knownNodes = new Set(['llm_openai', 'qdrant', 'db_mysql']);

	it('accepts valid entries with adequate reasons', () => {
		const file: ExclusionsFile = {
			version: 1,
			exclusions: [
				{ node: 'qdrant', reason: 'requires running qdrant instance', owner: 'joshua', added: '2026-05-01' },
			],
		};

		const result = validateExclusions(file, knownNodes);

		expect(result.excluded.size).toBe(1);
		expect(result.stale).toEqual([]);
		expect(result.thinReason).toEqual([]);
		expect(result.staleWarnings).toEqual([]);
	});

	it('flags entries whose node is not in /services as stale', () => {
		const file: ExclusionsFile = {
			version: 1,
			exclusions: [
				{ node: 'no_such_node', reason: 'long enough reason here', owner: 'a', added: '2026-05-01' },
			],
		};

		const result = validateExclusions(file, knownNodes);

		expect(result.stale).toEqual(['no_such_node']);
		expect(result.excluded.size).toBe(0);
	});

	it('flags entries with thin reasons (< 3 words)', () => {
		const file: ExclusionsFile = {
			version: 1,
			exclusions: [
				{ node: 'qdrant', reason: 'TODO', owner: 'a', added: '2026-05-01' },
				{ node: 'db_mysql', reason: 'two words', owner: 'a', added: '2026-05-01' },
			],
		};

		const result = validateExclusions(file, knownNodes);

		expect(result.thinReason).toEqual(['qdrant', 'db_mysql']);
		expect(result.excluded.size).toBe(0);
	});

	it('warns on entries older than 90 days', () => {
		const file: ExclusionsFile = {
			version: 1,
			exclusions: [
				{ node: 'qdrant', reason: 'requires running qdrant instance', owner: 'a', added: '2025-01-01' },
			],
		};

		const now = new Date('2026-05-01T00:00:00Z');
		const result = validateExclusions(file, knownNodes, now);

		expect(result.excluded.size).toBe(1);
		expect(result.staleWarnings).toHaveLength(1);
		expect(result.staleWarnings[0].node).toBe('qdrant');
	});
});

describe('writeStarterExclusions', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'harness-scaffold-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('writes one entry per known node with placeholder reasons', () => {
		const filePath = join(tmpDir, 'coverage-exclusions.json');
		writeStarterExclusions(filePath, new Set(['parse', 'llm_openai']), 'harness-owner');

		const parsed = loadExclusions(filePath);
		expect(parsed.exclusions).toHaveLength(2);
		expect(parsed.exclusions.map((e) => e.node).sort()).toEqual(['llm_openai', 'parse']);
		for (const entry of parsed.exclusions) {
			expect(entry.owner).toBe('harness-owner');
			expect(entry.reason.toLowerCase()).toContain('todo');
		}
	});
});
