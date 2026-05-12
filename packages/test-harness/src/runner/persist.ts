/**
 * Write per-pipeline trace JSON to .harness-runs/<ISO>/traces/<slug>.json.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
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
