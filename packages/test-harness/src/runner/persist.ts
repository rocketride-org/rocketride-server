/**
 * Write per-pipeline trace JSON to .harness-runs/<ISO>/traces/<slug>.json.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import type { TraceFile } from './schema';

export function isoStamp(date: Date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, '-');
}

export function ensureRunDir(runsDir: string, stamp: string): string {
	const runDir = join(runsDir, stamp);
	mkdirSync(join(runDir, 'traces'), { recursive: true });
	return runDir;
}

export function writeTrace(runDir: string, trace: TraceFile): string {
	const slug = trace.pipeline.replace(/[\\/]/g, '__');
	const outPath = join(runDir, 'traces', `${slug}.json`);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify(trace, null, 2), 'utf8');
	return outPath;
}
