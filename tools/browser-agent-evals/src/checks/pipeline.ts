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
// PIPELINE CHECKS: what the engine says about the pipelines the turn left
// =============================================================================

/**
 * Task 3.1. After the turn, while the stack is still up, the trial asks the
 * engine about the pipelines in the final workspace:
 *
 * - validates: every .pipe the turn added or changed, and every one a
 *   validates check names, goes through the engine's validate (record.pipes).
 *   The engine will not validate a pipeline with several sources unless one
 *   is named, so such a pipeline is validated once per source and the
 *   errors are merged. (The agent's own validate on save names no source,
 *   so it cannot validate these pipelines at all.)
 * - output: each output check runs its pipeline on the task's sample input
 *   with runOutput.ts and tests the expectation (record.runOutput). A check
 *   marked `pending` (its input file does not exist yet) or `needs` (a server
 *   the local stack does not have) stays pending with that reason.
 *
 * Paths resolve as grade.ts resolves them, so a renamed pipeline is the one
 * validated and run.
 */

import type { RocketRideClient } from 'rocketride';

import { resolvePath } from '../resolve';
import { isSource } from '../score';
import { endOwnedRuns, runOutputCheck, type OwnedRun } from '../runOutput';
import type { Task } from '../task';
import type { RunOutputResult, ScenarioCheck, ValidateResult } from '../types';

/**
 * Validates the pipelines the grade will read.
 *
 * @param client - A connected client.
 * @param task - The task.
 * @param start - The starting workspace.
 * @param final - The final workspace.
 * @returns record.pipes: each path and the engine's verdict.
 */
export async function validatePipes(client: RocketRideClient, task: Task, start: Record<string, string>, final: Record<string, string>): Promise<Array<{ path: string; validate: ValidateResult }>> {
	const paths = new Set(Object.keys(final).filter((f) => f.endsWith('.pipe') && final[f] !== start[f]));
	for (const ck of task.checks) if (ck.type === 'validates' && typeof ck.path === 'string') paths.add(resolvePath(ck.path, start, final).path);
	const out: Array<{ path: string; validate: ValidateResult }> = [];
	for (const p of [...paths].sort()) {
		if (!(p in final)) continue;
		let validate: ValidateResult;
		try {
			const pipe = JSON.parse(final[p]) as { source?: string; components?: Array<{ id: string; provider?: string }> };
			const sources = (pipe.components ?? []).filter((c) => isSource(c.provider)).map((c) => c.id);
			const one = async (source?: string) => {
				const r = (await client.validate({ pipeline: pipe as never, ...(source ? { source } : {}) })) as { errors?: Array<string | { message?: string; id?: string }> };
				return (r.errors ?? []).map((e) => (typeof e === 'string' ? e : `${e.id ? `${e.id}: ` : ''}${e.message ?? JSON.stringify(e)}`)).map((e) => (source ? `${source}: ${e}` : e));
			};
			validate = { errors: !pipe.source && sources.length > 1 ? (await Promise.all(sources.map(one))).flat() : await one() };
		} catch (err) {
			validate = { failed: String(err instanceof Error ? err.message : err).slice(0, 300) };
		}
		out.push({ path: p, validate });
	}
	return out;
}

/**
 * Runs each output check.
 *
 * @param client - A connected client.
 * @param task - The task.
 * @param start - The starting workspace.
 * @param final - The final workspace.
 * @param engineVariables - The Variable names the engine has.
 * @returns record.runOutput: each check's result, by id.
 */
export async function runOutputs(client: RocketRideClient, task: Task, start: Record<string, string>, final: Record<string, string>, engineVariables: string[]): Promise<Record<string, RunOutputResult>> {
	const out: Record<string, RunOutputResult> = {};
	const owned: OwnedRun[] = [];
	try {
		for (const ck of task.checks.filter((c) => c.type === 'output')) {
			if (typeof ck.pending === 'string') out[ck.id] = { status: 'pending', detail: ck.pending };
			else if (typeof ck.needs === 'string') out[ck.id] = { status: 'pending', detail: `needs ${ck.needs}` };
			else {
				const path = typeof ck.path === 'string' ? resolvePath(ck.path, start, final).path : ck.path;
				out[ck.id] = await runOutputCheck(client, { ...ck, kind: 'run_output', path } as unknown as ScenarioCheck, final, engineVariables, owned);
			}
		}
	} finally {
		await endOwnedRuns(client, owned).catch(() => {});
	}
	return out;
}
