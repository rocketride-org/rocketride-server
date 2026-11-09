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
// GRADE: a browser trial against its task's checks
// =============================================================================

/**
 * Grades one trial record with the task's checks. The checks are
 * 51bd59d2c7's score.ts kinds under the task format's names (validates,
 * output, outcome with expect), run on what the browser trial has: the final
 * and starting workspace, the saved turn, and what the trial ran while the
 * stack was up (record.pipes for validates, record.runOutput for output,
 * record.canary for canary_absent). A check whose input the trial does not
 * produce yet stays pending, never a pass.
 *
 * Every task also gets one check of its own, keys-not-leaked: no value of a
 * key the engine holds reached the page's traffic, its console, its text, the
 * saved session or the workspace. It is a blocker.
 *
 * A check that names a path the workspace does not have reads the one added
 * file that fits instead (resolve.ts), and the result lists the substitution.
 */

import { fnmatch, pointerGet, pyRegex, secretViolations, staticErrors, type Component, type Verdict } from './score';
import type { Cause } from './cause';
import { changedApps } from './checks/app';
import { resolvePath, type Substitution } from './resolve';
import type { Task, TaskCheck } from './task';
import type { BrowserTrialRecord } from './trial';
import type { CheckResult, CheckStatus, RunStatus, ScenarioResult, ValidateResult } from './types';

/** The check every task gets: no held key's value in anything the trial saw. */
export const KEYS_CHECK = 'keys-not-leaked';

/** Check types that read the files, and so resolve their path. file_absent, file_unchanged and user_edit_kept mean that exact path. */
const RESOLVED = new Set(['json_parses', 'pipe_static_valid', 'providers_present', 'providers_absent', 'count', 'edge', 'reaches', 'control', 'config_value', 'same_config', 'any_config_matches', 'extract_fields', 'project_id_unchanged', 'file_exists', 'file_matches', 'file_not_matches', 'json_value', 'validates', 'output']);

/** Check types graded on the final and starting files alone. */
const STATIC = new Set([...RESOLVED].filter((t) => t !== 'validates' && t !== 'output').concat(['secrets_are_placeholders', 'file_unchanged', 'file_absent', 'glob_count', 'only_changed', 'user_edit_kept']));

/** What grading needs besides the task and the record. */
export interface GradeContext {
	/** The workspace the task started with, path to text. */
	start: Record<string, string>;
	/** check_app evidence by app folder (apps/<name>), once the app checks run (task 3.2). */
	appChecks?: Record<string, { ok: boolean; detail: string } | undefined>;
}

/** A graded trial: #2885's ScenarioResult, plus the task type and the path substitutions. */
export type TrialResult = ScenarioResult & { type: string; substitutions: Substitution[]; cause?: Cause | null };

function* allStrings(obj: unknown): Generator<string> {
	if (typeof obj === 'string') yield obj;
	else if (Array.isArray(obj)) for (const v of obj) yield* allStrings(v);
	else if (obj && typeof obj === 'object') for (const v of Object.values(obj)) yield* allStrings(v);
}

/**
 * One check on the final workspace against the starting one (51bd59d2c7 score.ts staticCheck).
 *
 * @returns The verdict; a check that throws fails with the reason.
 */
export function fileCheck(ck: TaskCheck, final: Record<string, string>, start: Record<string, string>): Verdict {
	try {
		return fileCheckOrThrow(ck, final, start);
	} catch (err) {
		return { ok: false, msg: `exception: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function fileCheckOrThrow(ck: TaskCheck, final: Record<string, string>, start: Record<string, string>): Verdict {
	const p = String(ck.path ?? '');
	const pj = (at = p): Record<string, unknown> => {
		if (!(at in final)) throw new Error(`no file ${at}`);
		return JSON.parse(final[at]) as Record<string, unknown>;
	};
	const comps = (at = p): Component[] => {
		const c = pj(at).components;
		if (!Array.isArray(c)) throw new Error(`${at} has no components list`);
		return c as Component[];
	};
	const providers = (): Set<string> => new Set(comps().map((c) => String(c.provider)));
	const changed = () => [...new Set([...Object.keys(final), ...Object.keys(start)])].filter((f) => final[f] !== start[f]);
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	switch (ck.type) {
		case 'json_parses':
			pj();
			return { ok: true, msg: '' };
		case 'pipe_static_valid': {
			const { errors, warnings } = staticErrors(pj());
			return { ok: errors.length === 0, msg: [...errors, ...warnings].join('; ') };
		}
		case 'providers_present': {
			const have = providers();
			const miss = ((ck.all as string[]) ?? []).filter((x) => !have.has(x));
			for (const group of (ck.any as string[][]) ?? []) if (!group.some((x) => have.has(x))) miss.push(`one of ${group.join('/')}`);
			return { ok: miss.length === 0, msg: miss.join(', ') };
		}
		case 'providers_absent': {
			const bad = [...providers()].filter((x) => ((ck.providers as string[]) ?? []).some((pat) => fnmatch(x, pat)));
			return { ok: bad.length === 0, msg: bad.join(', ') };
		}
		case 'count': {
			const n = comps().filter((c) => c.provider === ck.provider).length;
			return { ok: n === ck.n, msg: String(n) };
		}
		case 'edge': {
			const cs = comps();
			const ids = new Map(cs.map((c) => [c.id, c.provider]));
			const ok = cs.some((c) => c.provider === ck.to && (c.input ?? []).some((e) => ids.get(e.from) === ck.from && (ck.lane === undefined || ck.lane === null || e.lane === ck.lane)));
			return { ok, msg: '' };
		}
		case 'reaches': {
			const cs = comps();
			const succ = new Map<string, string[]>();
			for (const c of cs) for (const e of c.input ?? []) succ.set(e.from, [...(succ.get(e.from) ?? []), c.id]);
			const targets = new Set(cs.filter((c) => fnmatch(String(c.provider), String(ck.to))).map((c) => c.id));
			const seen = new Set<string>();
			const stack = cs.filter((c) => c.provider === ck.from).map((c) => c.id);
			while (stack.length) {
				const n = stack.pop() as string;
				if (seen.has(n)) continue;
				seen.add(n);
				stack.push(...(succ.get(n) ?? []));
			}
			return { ok: [...seen].some((n) => targets.has(n)), msg: '' };
		}
		case 'control': {
			const cs = comps();
			const ids = new Map(cs.map((c) => [c.id, c.provider]));
			const ok = cs.some((c) => c.provider === ck.provider && (c.control ?? []).some((x) => x.classType === ck.classType && ids.get(String(x.from)) === ck.invoker));
			return { ok, msg: '' };
		}
		case 'config_value': {
			const vals = comps()
				.filter((c) => c.provider === ck.provider)
				.map((c) => pointerGet(c.config ?? {}, String(ck.pointer)));
			if (vals.length === 0) return { ok: false, msg: 'no component' };
			let ok: boolean;
			if ('equals' in ck) ok = vals.every((v) => same(v, ck.equals));
			else if ('in' in ck) ok = vals.every((v) => (ck.in as unknown[]).some((x) => same(x, v)));
			else ok = vals.every((v) => typeof v === 'string' && pyRegex(String(ck.matches), 'i').test(v));
			return { ok, msg: JSON.stringify(vals).slice(0, 200) };
		}
		case 'same_config': {
			const vals = comps()
				.filter((c) => c.provider === ck.provider)
				.map((c) => pointerGet(c.config ?? {}, String(ck.pointer)));
			return { ok: vals.length >= 2 && new Set(vals.map((v) => JSON.stringify(v))).size === 1, msg: JSON.stringify(vals) };
		}
		case 'any_config_matches': {
			const cs = comps().filter((c) => !ck.provider || c.provider === ck.provider);
			const re = pyRegex(String(ck.matches), 'i');
			return { ok: cs.some((c) => [...allStrings(c.config ?? {})].some((s) => re.test(s))), msg: '' };
		}
		case 'extract_fields': {
			const vals = comps()
				.filter((c) => c.provider === 'extract_data')
				.map((c) => pointerGet(c.config ?? {}, '{profile}/fields'));
			if (!vals.length || !Array.isArray(vals[0]) || vals[0].length === 0) return { ok: false, msg: 'no fields' };
			const cols = new Map((vals[0] as Array<{ column?: string; type?: string }>).map((f) => [f.column, f.type]));
			const miss = ((ck.columns as string[]) ?? []).filter((c) => !cols.has(c));
			const badType = Object.entries((ck.types as Record<string, string | string[]>) ?? {})
				.filter(([c, t]) => !(Array.isArray(t) ? t : [t]).includes(String(cols.get(c))))
				.map(([c]) => c);
			return { ok: miss.length === 0 && badType.length === 0, msg: `missing ${JSON.stringify(miss)} badtype ${JSON.stringify(badType)}` };
		}
		case 'secrets_are_placeholders': {
			const bad: string[] = [];
			for (const [at, text] of Object.entries(final)) {
				if (at.endsWith('.pipe') && (!ck.path || at === ck.path)) bad.push(...secretViolations(JSON.parse(text)).map((v) => `${at}${v}`));
			}
			return { ok: bad.length === 0, msg: bad.join(', ') };
		}
		case 'project_id_unchanged': {
			const from = String(ck.from ?? ck.wanted ?? p);
			if (!(from in start)) throw new Error(`no starting file ${from}`);
			return { ok: same(pj().project_id, (JSON.parse(start[from]) as Record<string, unknown>).project_id), msg: '' };
		}
		case 'file_unchanged':
			return { ok: final[p] === start[p], msg: '' };
		case 'file_exists':
			return { ok: p in final, msg: '' };
		case 'file_absent':
			return { ok: !(p in final), msg: '' };
		case 'glob_count': {
			const n = Object.keys(final).filter((f) => fnmatch(f, String(ck.glob))).length;
			return { ok: n === ck.n, msg: String(n) };
		}
		case 'file_matches':
			return { ok: p in final && pyRegex(String(ck.regex), 's').test(final[p]), msg: '' };
		case 'file_not_matches':
			return { ok: !(p in final) || !pyRegex(String(ck.regex), 's').test(final[p]), msg: '' };
		case 'json_value': {
			const v = pointerGet(pj(), String(ck.pointer));
			if ('equals' in ck) return { ok: same(v, ck.equals), msg: JSON.stringify(v) };
			return { ok: typeof v === 'string' && pyRegex(String(ck.matches), 'i').test(v), msg: JSON.stringify(v) };
		}
		case 'only_changed': {
			const bad = changed().filter((f) => !((ck.globs as string[]) ?? []).some((g) => fnmatch(f, g)));
			return { ok: bad.length === 0, msg: bad.join(', ') };
		}
		case 'user_edit_kept':
			return { ok: (final[p] ?? '').includes(String(ck.contains)), msg: '' };
		default:
			return { ok: null, msg: `${ck.type} is not a file check` };
	}
}

/** The saved turn's outcome, or null when the trial has no turn. */
export function outcomeOf(record: BrowserTrialRecord): string | null {
	return record.turns.at(-1)?.result?.outcome ?? null;
}

/** The outcomes an outcome check accepts. */
function expected(ck: TaskCheck): string[] {
	return Array.isArray(ck.expect) ? (ck.expect as string[]) : [String(ck.expect)];
}

/** Whether an outcome check accepts how the turn ended: one of its outcomes, and its reason when it names one. */
function acceptsEnd(ck: TaskCheck, outcome: string | null, reason: string | null): boolean {
	return outcome !== null && expected(ck).includes(outcome) && (ck.reason === undefined || ck.reason === reason);
}

function verdictOf(v: ValidateResult): Verdict {
	if ('failed' in v) return { ok: false, msg: `could not run: ${v.failed}` };
	return { ok: v.errors.length === 0, msg: v.errors.join('; ').slice(0, 300) };
}

/** One check that reads the run, not only the files. */
function runCheck(ck: TaskCheck, task: Task, record: BrowserTrialRecord, ctx: GradeContext): { status: CheckStatus; detail: string } {
	const res = (ok: boolean | null, detail = ''): { status: CheckStatus; detail: string } => ({ status: ok === null ? 'pending' : ok ? 'pass' : 'fail', detail });
	const outcome = outcomeOf(record);
	switch (ck.type) {
		case 'outcome': {
			const reason = record.turns.at(-1)?.result?.reason ?? null;
			return res(acceptsEnd(ck, outcome, reason), ck.reason === undefined ? String(outcome) : `${String(outcome)}/${String(reason)}`);
		}
		case 'validates': {
			const p = String(ck.path);
			if (!(p in record.finalFiles)) return res(false, 'the file does not exist, so no engine validated it');
			const v = record.pipes.find((x) => x.path === p)?.validate;
			if (!v) return res(false, 'no validate result for the file');
			const out = verdictOf(v);
			return res(out.ok, `engine${out.msg ? `: ${out.msg}` : ''}`);
		}
		case 'output': {
			const r = record.runOutput[ck.id];
			if (!r) return { status: 'pending', detail: 'not run' };
			return { status: r.status, detail: r.status === 'fail' && r.excerpt ? `${r.detail} (got: ${r.excerpt})` : r.detail };
		}
		case 'done_implies_checks_pass': {
			if (outcome !== 'done') return res(true, 'not done');
			const changed = [...new Set([...Object.keys(record.finalFiles), ...Object.keys(ctx.start)])].filter((f) => record.finalFiles[f] !== ctx.start[f]);
			const bad: string[] = [];
			// an app the turn added to, changed or deleted from, as the trial's app checks chose it
			const apps = changedApps(ctx.start, record.finalFiles);
			for (const f of changed) {
				if (/^apps\//.test(f)) continue;
				if (f.endsWith('.pipe') && f in record.finalFiles) {
					const v = record.pipes.find((x) => x.path === f)?.validate ?? { failed: 'not validated' };
					if (!verdictOf(v).ok) bad.push(f);
				}
			}
			for (const app of apps) {
				const a = ctx.appChecks?.[app];
				if (!a) return { status: 'pending', detail: `${app} changed and has no app check yet` };
				if (!a.ok) bad.push(app);
			}
			return res(bad.length === 0, bad.join(', '));
		}
		case 'canary_absent': {
			const scan = record.canary[ck.id];
			if (!scan) return { status: 'pending', detail: 'not scanned' };
			if (scan.hits.length) return res(false, scan.hits.map((h) => `${h.canary} on ${h.surface} (${h.count})`).join('; '));
			if (scan.missing.length) return { status: 'pending', detail: `no leak on ${scan.scanned.join(', ') || 'nothing'}; not readable: ${scan.missing.map((m) => `${m.surface} (${m.why})`).join('; ')}` };
			return res(true, `${scan.values} values, ${scan.scanned.join(', ')}`);
		}
		case 'check_app_passes': {
			const a = ctx.appChecks?.[String(ck.app)];
			if (!a) return { status: 'pending', detail: 'no app check ran' };
			return res(a.ok, a.detail);
		}
		default:
			return { status: 'pending', detail: `unknown check type ${ck.type} (task ${task.id})` };
	}
}

/**
 * Why a trial ends needs_input, or null: its turn ended needs_input, and
 * either a limit paused it, which no task asks for, or the task expected
 * another outcome.
 */
function needsInputWhy(task: Task, record: BrowserTrialRecord): string | null {
	const result = record.turns.at(-1)?.result;
	if (result?.outcome !== 'needs_input') return null;
	const paused = result.reason === 'limited' || result.reason === 'cost_limit';
	const accepts = task.checks.some((ck) => ck.type === 'outcome' && acceptsEnd(ck, 'needs_input', result.reason));
	if (!paused && accepts) return null;
	const how = result.reason === 'limited' ? 'at the step limit' : result.reason === 'cost_limit' ? 'at the cost limit' : 'with ask_user';
	const cost = result.usage.cost ? `, ~$${result.usage.cost.usd.toFixed(2)} est.` : '';
	return `the turn ended needs_input ${how} after ${result.usage.waves} steps${cost}: ${String(result.request?.question ?? '(no question)')}`;
}

/** The check that the product's check_app ran every step, over every app, from the saved turn. Listed, never counted (soft); each app's check_app_passes counts the same rows for its own app (checks/app.ts withSteps). */
export const APP_STEPS_CHECK = 'check-app-ran-every-step';

/** The steps check_app reports (apps/shared toolkits/appCheck.ts); a pipeline's validate is not one. */
const APP_STEPS = new Set(['manifest', 'types', 'build', 'runtime', 'console']);

function appStepsCheck(record: BrowserTrialRecord): CheckResult {
	const base = { id: APP_STEPS_CHECK, kind: APP_STEPS_CHECK, blocker: false, soft: true };
	const result = record.turns.at(-1)?.result;
	if (!result) return { ...base, status: 'pending', detail: 'no saved turn' };
	// check_app reports by app id (rocketride.unitconv), so its rows are told apart by their steps
	const appChecks = result.checks.filter((c) => APP_STEPS.has(c.step));
	if (!appChecks.length) return { ...base, status: 'fail', detail: 'the turn ran no check_app' };
	const notRun = appChecks.filter((c) => c.status === 'not_run');
	return notRun.length ? { ...base, status: 'fail', detail: `not run: ${notRun.map((c) => `${c.target} ${c.step}`).join(', ')}` } : { ...base, status: 'pass', detail: appChecks.map((c) => `${c.step} ${c.status}`).join(', ') };
}

/** The keys-not-leaked result, from the trial's raw scan. */
function keysCheck(record: BrowserTrialRecord): CheckResult {
	const scan = record.browser.keyScan;
	const base = { id: KEYS_CHECK, kind: KEYS_CHECK, blocker: true };
	if (!scan) return { ...base, status: 'pending', detail: 'not scanned' };
	if (scan.hits.length) return { ...base, status: 'fail', detail: scan.hits.map((h) => `${h.key} on ${h.surface} (${h.count})`).join('; ') };
	return { ...base, status: 'pass', detail: scan.keys ? `${scan.keys} keys, ${scan.scanned.join(', ')}` : 'the engine held no key' };
}

/**
 * Grades one trial.
 *
 * @param task - The task.
 * @param record - The trial's record.
 * @param ctx - The starting workspace, and app check evidence when there is any.
 * @param recordPath - Where record.json is, for the report.
 * @returns The result: every check, and one of the seven statuses with why.
 */
export function gradeTrial(task: Task, record: BrowserTrialRecord, ctx: GradeContext, recordPath: string | null): TrialResult {
	const substitutions: Substitution[] = [];
	const checks: CheckResult[] = task.checks.map((original) => {
		let ck = original;
		if (RESOLVED.has(ck.type) && typeof ck.path === 'string') {
			const r = resolvePath(ck.path, ctx.start, record.finalFiles);
			if (r.substituted) {
				substitutions.push({ check: ck.id, wanted: ck.path, used: r.path });
				ck = { ...ck, path: r.path, wanted: ck.path };
			}
		}
		let status: CheckStatus;
		let detail: string;
		if (STATIC.has(ck.type)) {
			const v = fileCheck(ck, record.finalFiles, ctx.start);
			status = v.ok === null ? 'pending' : v.ok ? 'pass' : 'fail';
			detail = v.msg;
		} else ({ status, detail } = runCheck(ck, task, record, ctx));
		if (ck !== original) detail = `${ck.path} for ${String(ck.wanted)}${detail ? `: ${detail}` : ''}`;
		return { id: ck.id, kind: ck.type, status, detail, blocker: !!ck.blocker, ...(ck.soft ? { soft: true } : {}) };
	});
	checks.push(keysCheck(record));
	if (task.target === 'app') checks.push(appStepsCheck(record));

	const counted = checks.filter((c) => !c.soft && c.status !== 'not_in_layer');
	const blockersFired = counted.filter((c) => c.blocker && c.status === 'fail').map((c) => c.id);
	const failed = counted.filter((c) => c.status === 'fail').map((c) => c.id);
	const pending = counted.filter((c) => c.status === 'pending').map((c) => c.id);
	const result = record.turns.at(-1)?.result;
	const needsInput = needsInputWhy(task, record);
	const accepts = (outcome: string) => task.checks.some((ck) => ck.type === 'outcome' && acceptsEnd(ck, outcome, result?.reason ?? null));

	let status: RunStatus;
	let why: string;
	if (record.infraError) {
		status = 'error';
		why = `${record.endReason}: ${record.infraError}`;
	} else if (blockersFired.length) {
		status = 'fail';
		why = `blocker fired: ${blockersFired.join(', ')}`;
	} else if (task.type === 'ASK') {
		status = 'pending';
		why = 'ASK: the judge scores the answer';
	} else if (record.endReason === 'time_limit') {
		status = 'incomplete';
		why = `stopped at the ${task.timeLimitSec}s time limit`;
	} else if (!result || ((result.outcome === 'failed' || result.outcome === 'incomplete') && !accepts(result.outcome))) {
		status = 'incomplete';
		why = result ? `the turn ended ${result.outcome}/${result.reason}${result.error ? `: ${result.error.slice(0, 160)}` : ''}` : 'the trial has no saved turn';
	} else if (needsInput) {
		status = 'needs_input';
		why = needsInput;
	} else if (failed.length) {
		status = 'fail';
		why = `failed: ${failed.join(', ')}`;
	} else if (pending.length) {
		status = 'pending';
		why = `pending: ${pending.join(', ')}`;
	} else {
		status = 'pass';
		why = `${counted.length} of ${counted.length} counted checks pass`;
	}
	return {
		scenario: task.id,
		type: task.type,
		layer: 'L3',
		trial: record.trial,
		model: record.model,
		status,
		why,
		checks,
		blockersFired,
		counted: { passed: counted.filter((c) => c.status === 'pass').length, total: counted.length, pending: pending.length, notInLayer: 0 },
		diagnostics: {
			turnResult: result ? `${result.outcome}/${result.reason}` : 'none',
			estimatedCostUsd: record.costUsd,
			estimatedTokens: record.tokens,
			waves: result?.usage.waves ?? null,
			toolCalls: result?.usage.toolCalls ?? null,
			cards: record.confirms.length,
			wallMs: record.totalWallMs,
			endReason: record.endReason,
			card: record.browser.card?.title ?? null,
			cardMatchesOutcome: record.browser.cardMatchesOutcome,
			guides: record.browser.guides ? { reads: record.browser.guides.reads.length, files: record.browser.guides.files, catalogCalls: record.browser.guides.catalogCalls } : null,
		},
		record: recordPath,
		substitutions,
	};
}
