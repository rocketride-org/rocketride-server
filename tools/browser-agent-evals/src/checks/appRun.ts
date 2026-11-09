// =============================================================================
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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// APP RUN: use the app in its Design preview and see its pipeline run on the engine
// =============================================================================

/**
 * Task 3.2's run half. After the load check, for a check_app_passes check
 * with `use`, the runner types into the app's first text box and presses
 * its button (Driver.useApp), then asks the engine which tasks run the
 * app's own pipeline (the files `use.pipeline` globs, by their project_id)
 * and what each one's status says. The engine's stdout logs connections,
 * not pipeline runs, so its task status is the run log read here.
 *
 * Seen live on the local engine: each chat question adds one to the task's
 * completed count, even when the model call fails. A failed model call is
 * not an error in the status: it lands in its warnings ("Warning*Error 401:
 * ..."), and the app shows "**LLM error** ...". So the run fails on either.
 */

import { fnmatch } from '../score';
import type { AppCheckResult } from './app';

/** One running task of an app's pipeline, as the engine reports it. */
export interface RunSeen {
	token: string;
	name: string;
	projectId: string;
	completed: number;
	failed: number;
	/** The status's error and warning histories, as the engine keeps them. */
	errors: string[];
	warnings: string[];
}

/** What the runner did in the app's page (Driver.useApp). */
export interface AppUsed {
	/** It typed into the text box and pressed the button. */
	done: boolean;
	/** The page showed `use.answer` within the wait; null when the task names no answer, or the app could not be used. */
	answered: boolean | null;
	detail: string;
	/** The end of the page's text after the wait. */
	excerpt: string;
}

/** The run half of an app check. */
export interface AppRun {
	/** null when the engine could not be read. */
	ok: boolean | null;
	detail: string;
	used: AppUsed;
	/** The app's pipeline files the glob matched, with their project_id. */
	pipelines: Array<{ path: string; projectId: string }>;
	/** Each of their tasks after the use, with what changed since before it (the task's token is left out). */
	runs: RunChange[];
}

/** One task of the app's pipeline after the use, and what the use changed in its status. */
export interface RunChange {
	name: string;
	projectId: string;
	isNew: boolean;
	completed: number;
	completedAdded: number;
	failedAdded: number;
	newErrors: string[];
	/** New warnings that report a failure, such as a model call's. */
	newFailures: string[];
}

/** A status warning that reports a failure; the engine writes a failed model call as one. */
const FAILURE_WARNING = /\b(error|failed|exception)\b/i;

/** The model's error, as the app shows the answer it got (cause.ts PROVIDER_ERROR has the same marker). */
const LLM_ERROR = /\*\*LLM error\*\*/;

/** A status line without the engine's "Warning*" prefix and "*file:line" suffix, cut short. */
function statusText(line: string): string {
	const parts = line.split('*');
	return (parts.length >= 3 ? parts.slice(1, -1).join('*') : line).slice(0, 300);
}

/** The engine calls the run check makes (RocketRideClient's). */
export interface TaskReader {
	getTasks(): Promise<Array<Record<string, unknown>>>;
	getTaskStatus(token: string): Promise<{ completedCount?: number; failedCount?: number; errors?: string[]; warnings?: string[] }>;
}

/**
 * The app's own pipelines: each file the glob matches whose JSON has a
 * project_id. A file that is not JSON, or has none, is not one.
 *
 * @param files - The workspace files.
 * @param glob - check_app_passes `use.pipeline`.
 */
export function appPipelines(files: Record<string, string>, glob: string): Array<{ path: string; projectId: string }> {
	const out: Array<{ path: string; projectId: string }> = [];
	for (const [p, text] of Object.entries(files)) {
		if (!fnmatch(p, glob)) continue;
		try {
			const id = (JSON.parse(text) as { project_id?: unknown }).project_id;
			if (typeof id === 'string' && id) out.push({ path: p, projectId: id });
		} catch {
			/* not a pipeline */
		}
	}
	return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * The engine's running tasks of the given pipelines, by token, with their status.
 *
 * @param client - The engine client.
 * @param projectIds - The pipelines, by project_id.
 */
export async function pipelineRuns(client: TaskReader, projectIds: Set<string>): Promise<Map<string, RunSeen>> {
	const out = new Map<string, RunSeen>();
	for (const t of await client.getTasks()) {
		const projectId = (t.pipeline as { project_id?: unknown } | undefined)?.project_id;
		if (typeof projectId !== 'string' || !projectIds.has(projectId)) continue;
		const token = String(t.token);
		const s = await client.getTaskStatus(token);
		out.set(token, { token, name: String(t.name ?? ''), projectId, completed: s.completedCount ?? 0, failed: s.failedCount ?? 0, errors: s.errors ?? [], warnings: s.warnings ?? [] });
	}
	return out;
}

/**
 * What the use did on the engine. The app passes when a task of one of its
 * pipelines completed more after the use than before, no such task
 * reported a new error, failed object or failure warning, the page did not
 * show the model's error, and it showed the answer the task names.
 *
 * @param used - What the runner did in the page.
 * @param pipelines - The app's pipelines (appPipelines).
 * @param before - Their tasks before the use.
 * @param after - Their tasks after it.
 * @param glob - The glob, for the detail.
 */
export function runVerdict(used: AppUsed, pipelines: Array<{ path: string; projectId: string }>, before: Map<string, RunSeen>, after: Map<string, RunSeen>, glob: string): AppRun {
	const runs: RunChange[] = [...after.values()].map((r) => {
		const was = before.get(r.token);
		const newErrors = r.errors.slice(was?.errors.length ?? 0).map(statusText);
		const newFailures = r.warnings
			.slice(was?.warnings.length ?? 0)
			.filter((w) => FAILURE_WARNING.test(w))
			.map(statusText);
		return { name: r.name, projectId: r.projectId, isNew: !was, completed: r.completed, completedAdded: r.completed - (was?.completed ?? 0), failedAdded: r.failed - (was?.failed ?? 0), newErrors, newFailures };
	});
	const base = { used, pipelines, runs };
	if (!pipelines.length) return { ...base, ok: false, detail: `run: no pipeline file in the app matches ${glob}` };
	if (!used.done) return { ...base, ok: false, detail: `run: could not use the app: ${used.detail}` };
	const names = pipelines.map((p) => p.path).join(', ');
	if (!runs.length) return { ...base, ok: false, detail: `run: the engine has no running task of ${names} after the app was used` };
	const bad = runs.filter((r) => r.newErrors.length || r.failedAdded > 0 || r.newFailures.length);
	if (bad.length) {
		const first = bad[0];
		const said = [...first.newErrors, ...first.newFailures][0];
		return { ...base, ok: false, detail: `run: ${first.name || names} reported ${first.newErrors.length} error(s), ${Math.max(first.failedAdded, 0)} failed object(s) and ${first.newFailures.length} failure warning(s)${said ? `: ${said.slice(0, 200)}` : ''}` };
	}
	if (LLM_ERROR.test(used.excerpt)) return { ...base, ok: false, detail: `run: the app showed the model's error: ${used.excerpt.slice(used.excerpt.search(LLM_ERROR), used.excerpt.search(LLM_ERROR) + 200)}` };
	const processed = runs.filter((r) => r.completedAdded > 0);
	if (!processed.length) return { ...base, ok: false, detail: `run: no task of ${names} processed anything after the app was used` };
	if (used.answered === false) return { ...base, ok: false, detail: `run: ${names} ran, but the page did not show the expected answer (${used.detail})` };
	const how = processed.map((r) => `${r.name || r.projectId}: ${r.isNew ? 'new task, ' : ''}${r.completedAdded} completed`).join('; ');
	return { ...base, ok: true, detail: `runs: ${names} (${how})${used.answered ? ', answer shown' : ''}` };
}

/**
 * Adds each app's run to its check: a failed run fails the check, one the
 * engine could not report is noted and does not count.
 *
 * @param checks - The app checks, by app folder; changed in place.
 * @param runs - The runs, by app folder.
 */
export function withRuns(checks: Record<string, AppCheckResult>, runs: Record<string, AppRun>): void {
	for (const [app, r] of Object.entries(checks)) {
		const run = runs[app];
		if (!run) continue;
		r.run = run;
		if (run.ok === null) r.detail = `${r.detail}; run not checked (${run.detail})`;
		else r.detail = run.ok || !r.ok ? `${r.detail}; ${run.detail}` : run.detail;
		r.ok = r.ok && run.ok !== false;
	}
}
