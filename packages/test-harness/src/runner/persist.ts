/**
 * Write per-pipeline trace JSON to .harness-runs/<ISO>/traces/<slug>.json.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import type { TraceFile } from './schema';

export function pipelineSlugToFile(slug: string): string {
	return `${slug.replace(/[\\/]/g, '__')}.json`;
}

export function isoStamp(date: Date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, '-');
}

export function ensureRunDir(runsDir: string, stamp: string): string {
	const runDir = join(runsDir, stamp);
	mkdirSync(join(runDir, 'traces'), { recursive: true });
	return runDir;
}

export function writeTrace(runDir: string, trace: TraceFile): string {
	const outPath = join(runDir, 'traces', pipelineSlugToFile(trace.pipeline));
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify(trace, null, 2), 'utf8');
	return outPath;
}

export function loadTraces(runDir: string): TraceFile[] {
	const tracesDir = join(runDir, 'traces');
	const files = readdirSync(tracesDir).filter((f) => f.endsWith('.json'));
	return files.map((f) => JSON.parse(readFileSync(join(tracesDir, f), 'utf8')) as TraceFile);
}

/**
 * Prune .harness-runs/ to the newest `keep` run directories.
 *
 * ISO timestamps sort lexicographically, so directory names alone suffice
 * for ordering. Only top-level entries that are directories are considered;
 * unexpected files at the runsDir root are left alone.
 */
export function pruneRuns(runsDir: string, keep: number): string[] {
	if (keep <= 0 || !existsSync(runsDir)) return [];

	const entries = readdirSync(runsDir).filter((name) => {
		try {
			return statSync(join(runsDir, name)).isDirectory();
		} catch {
			return false;
		}
	});

	const sorted = entries.sort(); // ISO stamps sort chronologically
	const toRemove = sorted.slice(0, Math.max(0, sorted.length - keep));
	const removed: string[] = [];

	for (const name of toRemove) {
		const fullPath = join(runsDir, name);
		try {
			rmSync(fullPath, { recursive: true, force: true });
			removed.push(fullPath);
		} catch {
			// Best-effort: a locked or in-progress run dir should not break the run.
		}
	}

	return removed;
}
