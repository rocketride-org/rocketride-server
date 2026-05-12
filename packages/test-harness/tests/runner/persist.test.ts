import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureRunDir, isoStamp, loadTraces, pipelineSlugToFile, pruneRuns, writeTrace } from '../../src/runner/persist';
import type { TraceFile } from '../../src/runner/schema';

function makeTrace(slug: string): TraceFile {
	return {
		pipeline: slug,
		run_started: '2026-05-12T20:00:00.000Z',
		run_ended: '2026-05-12T20:00:01.000Z',
		token: 'tk_test',
		prompt: 'hello',
		sse_events: [],
		runtime_events: [],
		other_events: [],
		result: 'pass',
		exercised_nodes: ['parse'],
		exercised_components: ['parse_1'],
	};
}

describe('pipelineSlugToFile', () => {
	it('replaces forward and back slashes with double-underscore', () => {
		expect(pipelineSlugToFile('smoke/llm_openai')).toBe('smoke__llm_openai.json');
		expect(pipelineSlugToFile('integration\\multi_llm_chain')).toBe('integration__multi_llm_chain.json');
	});
});

describe('isoStamp', () => {
	it('replaces colons and dots so the result is filesystem-safe', () => {
		const stamp = isoStamp(new Date('2026-05-12T20:30:45.123Z'));
		expect(stamp).toBe('2026-05-12T20-30-45-123Z');
		expect(stamp).not.toMatch(/[:.]/);
	});
});

describe('writeTrace + loadTraces', () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), 'harness-persist-'));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it('writes a trace file under <runDir>/traces/<slug>.json', () => {
		const runDir = ensureRunDir(tmpRoot, '2026-05-12T20-00-00-000Z');
		const tracePath = writeTrace(runDir, makeTrace('smoke/llm_openai'));
		expect(existsSync(tracePath)).toBe(true);
		expect(tracePath).toMatch(/smoke__llm_openai\.json$/);

		const parsed = JSON.parse(readFileSync(tracePath, 'utf8'));
		expect(parsed.pipeline).toBe('smoke/llm_openai');
	});

	it('loadTraces reads every trace JSON back', () => {
		const runDir = ensureRunDir(tmpRoot, '2026-05-12T20-00-00-000Z');
		writeTrace(runDir, makeTrace('smoke/a'));
		writeTrace(runDir, makeTrace('smoke/b'));

		const traces = loadTraces(runDir);
		expect(traces.map((t) => t.pipeline).sort()).toEqual(['smoke/a', 'smoke/b']);
	});
});

describe('pruneRuns', () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), 'harness-prune-'));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function seed(names: string[]): void {
		for (const name of names) {
			mkdirSync(join(tmpRoot, name), { recursive: true });
			writeFileSync(join(tmpRoot, name, 'sentinel.txt'), 'data');
		}
	}

	it('keeps the N newest dirs and removes the rest', () => {
		seed([
			'2026-05-10T10-00-00-000Z',
			'2026-05-11T10-00-00-000Z',
			'2026-05-12T10-00-00-000Z',
			'2026-05-13T10-00-00-000Z',
		]);

		const removed = pruneRuns(tmpRoot, 2);

		expect(removed).toHaveLength(2);
		expect(existsSync(join(tmpRoot, '2026-05-10T10-00-00-000Z'))).toBe(false);
		expect(existsSync(join(tmpRoot, '2026-05-11T10-00-00-000Z'))).toBe(false);
		expect(existsSync(join(tmpRoot, '2026-05-12T10-00-00-000Z'))).toBe(true);
		expect(existsSync(join(tmpRoot, '2026-05-13T10-00-00-000Z'))).toBe(true);
	});

	it('is a no-op when there are fewer dirs than keep', () => {
		seed(['2026-05-12T10-00-00-000Z']);
		const removed = pruneRuns(tmpRoot, 5);
		expect(removed).toEqual([]);
		expect(existsSync(join(tmpRoot, '2026-05-12T10-00-00-000Z'))).toBe(true);
	});

	it('is a no-op when keep <= 0', () => {
		seed(['2026-05-12T10-00-00-000Z']);
		expect(pruneRuns(tmpRoot, 0)).toEqual([]);
		expect(pruneRuns(tmpRoot, -1)).toEqual([]);
		expect(existsSync(join(tmpRoot, '2026-05-12T10-00-00-000Z'))).toBe(true);
	});

	it('is a no-op when the runsDir does not exist', () => {
		expect(pruneRuns(join(tmpRoot, 'missing'), 5)).toEqual([]);
	});

	it('ignores non-directory entries at the runsDir root', () => {
		seed(['2026-05-10T10-00-00-000Z', '2026-05-11T10-00-00-000Z', '2026-05-12T10-00-00-000Z']);
		writeFileSync(join(tmpRoot, 'README.txt'), 'do not delete');

		const removed = pruneRuns(tmpRoot, 1);

		expect(removed).toHaveLength(2);
		expect(existsSync(join(tmpRoot, 'README.txt'))).toBe(true);
	});
});
