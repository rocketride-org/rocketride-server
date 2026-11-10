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
// SCORE: the hidden checks, and what a trial's status is
// =============================================================================

/**
 * Applies a scenario's checks to a trial record and gives the run one of seven
 * statuses: pass, fail, error, incomplete, needs_input, abstain or pending. The static
 * checks read the final workspace and the run checks read the record.
 * canary_absent and run_output read evidence the trial gathers.
 *
 * A check is pass, fail, pending (it belongs in this layer but what it needs
 * is missing) or not_in_layer (listed, never counted). A pending check never
 * counts as a pass.
 */

import { createHash } from 'node:crypto';

import { catalog } from './catalog';
import type { CheckResult, CheckStatus, Layer, RunStatus, Scenario, ScenarioCheck, ScenarioResult, TrialRecord, TurnRecord, ValidateResult } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The tools whose calls change the work (run.ts CHANGE_TOOLS). */
export const CHANGE_TOOLS = new Set(['write_file', 'edit_file', 'rename', 'delete_file', 'create_app']);

/** A `${ROCKETRIDE_*}` placeholder, the only non-empty value a secret field may hold. */
const PLACEHOLDER = /^\$\{ROCKETRIDE_[A-Z0-9_]+\}$/;

/** A config key that names a secret. */
const SECRET_KEY = /(apikey|api_key|password|secret|token|accesskey|secretkey)$/i;

/** Check kinds read from the final workspace. */
export const STATIC_KINDS = new Set(['pipe_static_valid', 'providers_present', 'providers_absent', 'reaches', 'control', 'config_value', 'any_config_matches', 'extract_fields', 'secrets_are_placeholders', 'only_changed']);

/** Check kinds read from the run. */
export const RUN_KINDS = new Set(['outcome', 'engine_validate', 'canary_absent', 'run_output']);

// =============================================================================
// PYTHON-STYLE MATCHING: the scenario files were written for Python's re and fnmatch
// =============================================================================

/**
 * A Python regex as a JavaScript one. Leading inline flags such as `(?i)`
 * become flags; the rest of the syntax the scenarios use is the same.
 *
 * @param pattern - The pattern as the scenario writes it.
 * @param flags - Flags to add (`i`, `s`).
 * @returns The regex.
 */
export function pyRegex(pattern: string, flags = ''): RegExp {
	let body = pattern;
	const set = new Set(flags.split(''));
	for (let m = /^\(\?([imsx]+)\)/.exec(body); m; m = /^\(\?([imsx]+)\)/.exec(body)) {
		for (const f of m[1]) if (f !== 'x') set.add(f);
		body = body.slice(m[0].length);
	}
	return new RegExp(body, [...set].join(''));
}

/**
 * Python's fnmatch on POSIX: `*` matches anything, `/` included.
 *
 * @param name - The text to test.
 * @param pattern - The glob.
 * @returns Whether it matches the whole text.
 */
export function fnmatch(name: string, pattern: string): boolean {
	let re = '';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === '*') re += '.*';
		else if (c === '?') re += '.';
		else if (c === '[') {
			const end = pattern.indexOf(']', i + 2);
			if (end < 0) re += '\\[';
			else {
				let set = pattern.slice(i + 1, end).replace(/\\/g, '\\\\');
				if (set.startsWith('!')) set = `^${set.slice(1)}`;
				re += `[${set}]`;
				i = end;
			}
		} else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
	}
	return new RegExp(`^${re}$`, 's').test(name);
}

/**
 * Reads a slash pointer, with `{profile}` standing for the object's own profile.
 *
 * @param obj - Where to start.
 * @param ptr - The pointer, such as `{profile}/apikey`.
 * @returns The value, or null when the path does not exist.
 */
export function pointerGet(obj: unknown, ptr: string): unknown {
	let cur = obj;
	let pointer = ptr;
	if (isObject(cur) && pointer.includes('{profile}')) pointer = pointer.replace('{profile}', String(cur.profile));
	for (const part of pointer.split('/').filter(Boolean)) {
		if (Array.isArray(cur)) cur = cur[Number(part)];
		else if (isObject(cur)) {
			if (!(part in cur)) return null;
			cur = cur[part];
		} else return null;
	}
	return cur === undefined ? null : cur;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The sha256 of a text, as hex. */
export function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

// =============================================================================
// STATIC PIPELINE RULES: on the branch's catalog
// =============================================================================

interface Component {
	id: string;
	provider?: string;
	config?: Record<string, unknown>;
	input?: Array<{ lane: string; from: string }>;
	control?: Array<{ classType?: string; from?: string }>;
}

function isSource(provider: string | undefined): boolean {
	return (catalog().get(provider ?? '')?.classType ?? []).includes('source');
}

function outputLanes(provider: string): Set<string> {
	const lanes = catalog().get(provider)?.lanes ?? {};
	if ('_source' in lanes) return new Set(lanes._source);
	if ('source' in lanes) return new Set(lanes.source);
	return new Set(Object.values(lanes).flat());
}

function inputLanes(provider: string): Set<string> {
	return new Set(Object.keys(catalog().get(provider)?.lanes ?? {}).filter((k) => !k.startsWith('_') && k !== 'source'));
}

/**
 * The design-time rules: providers exist, lanes connect, control points at an
 * invoker of that class, invoke limits hold, there is a source, no cycle and
 * no orphan. More than one source with no top-level `source` is a warning.
 *
 * @param pipe - The parsed .pipe file.
 * @returns The errors and warnings.
 */
export function staticErrors(pipe: unknown): { errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	const comps = isObject(pipe) && Array.isArray(pipe.components) ? (pipe.components as Component[]) : null;
	if (!comps || comps.length === 0) return { errors: ['no components'], warnings };
	const cat = catalog();
	const byId = new Map<string, Component>();
	for (const c of comps) {
		if (!isObject(c) || typeof c.id !== 'string') {
			errors.push('a component has no id');
			continue;
		}
		if (byId.has(c.id)) errors.push(`duplicate id ${c.id}`);
		byId.set(c.id, c);
	}
	const valid = comps.filter((c) => isObject(c) && typeof c.id === 'string');
	for (const c of valid) {
		const p = c.provider ?? '';
		const spec = cat.get(p);
		if (!spec) {
			errors.push(`${c.id}: unknown provider ${p}`);
			continue;
		}
		if (isSource(p) && c.input && c.input.length) errors.push(`${c.id}: source with input`);
		for (const e of c.input ?? []) {
			const src = byId.get(e.from);
			if (!src) {
				errors.push(`${c.id}: input from missing ${e.from}`);
				continue;
			}
			if (src.provider && cat.has(src.provider) && !outputLanes(src.provider).has(e.lane)) errors.push(`${c.id}: ${src.id} has no output lane ${e.lane}`);
			if (!inputLanes(p).has(e.lane)) errors.push(`${c.id}: no input lane ${e.lane}`);
		}
		for (const k of c.control ?? []) {
			const inv = byId.get(String(k.from));
			if (!inv) {
				errors.push(`${c.id}: control from missing ${k.from}`);
				continue;
			}
			if (!spec.classType.includes(String(k.classType))) errors.push(`${c.id}: classType ${k.classType} not in ${JSON.stringify(spec.classType)}`);
			const invoke = cat.get(inv.provider ?? '')?.invoke ?? {};
			if (!(String(k.classType) in invoke)) errors.push(`${c.id}: invoker ${inv.id} does not invoke ${k.classType}`);
		}
	}
	for (const c of valid) {
		for (const [cls, lim] of Object.entries(cat.get(c.provider ?? '')?.invoke ?? {})) {
			const n = valid.filter((d) => (d.control ?? []).some((k) => k.from === c.id && k.classType === cls)).length;
			if (lim.min !== undefined && n < lim.min) errors.push(`${c.id}: needs at least ${lim.min} ${cls}, has ${n}`);
			if (lim.max !== undefined && n > lim.max) errors.push(`${c.id}: allows at most ${lim.max} ${cls}, has ${n}`);
		}
	}
	const sources = valid.filter((c) => isSource(c.provider));
	if (sources.length === 0) errors.push('no source component');
	const top = isObject(pipe) ? pipe.source : undefined;
	if (sources.length > 1 && !sources.some((s) => s.id === top)) warnings.push(`${sources.length} sources and no top-level source: a run must name one`);
	const succ = new Map<string, string[]>(valid.map((c) => [c.id, []]));
	for (const c of valid) for (const e of c.input ?? []) succ.get(e.from)?.push(c.id);
	const state = new Map<string, number>();
	const cyclic = (n: string): boolean => {
		state.set(n, 1);
		for (const m of succ.get(n) ?? []) {
			if (state.get(m) === 1) return true;
			if (!state.get(m) && cyclic(m)) return true;
		}
		state.set(n, 2);
		return false;
	};
	for (const n of succ.keys()) {
		if (!state.get(n) && cyclic(n)) {
			errors.push('cycle');
			break;
		}
	}
	const reach = new Set<string>();
	const stack = sources.map((s) => s.id);
	while (stack.length) {
		const n = stack.pop() as string;
		if (reach.has(n)) continue;
		reach.add(n);
		stack.push(...(succ.get(n) ?? []));
	}
	for (let grew = true; grew; ) {
		grew = false;
		for (const c of valid) {
			if (!reach.has(c.id) && (c.control ?? []).some((k) => reach.has(String(k.from)))) {
				reach.add(c.id);
				grew = true;
			}
		}
	}
	for (const c of valid) if (!reach.has(c.id)) errors.push(`${c.id}: orphan`);
	return { errors, warnings };
}

/** Every secret-named key holding a value that is neither empty nor a placeholder, as a pointer. */
function secretViolations(obj: unknown, at = ''): string[] {
	const out: string[] = [];
	if (isObject(obj)) {
		for (const [k, v] of Object.entries(obj)) {
			if (typeof v === 'string' && SECRET_KEY.test(k) && v !== '' && !PLACEHOLDER.test(v)) out.push(`${at}/${k}`);
			out.push(...secretViolations(v, `${at}/${k}`));
		}
	} else if (Array.isArray(obj)) obj.forEach((v, i) => out.push(...secretViolations(v, `${at}/${i}`)));
	return out;
}

function* allStrings(obj: unknown): Generator<string> {
	if (typeof obj === 'string') yield obj;
	else if (Array.isArray(obj)) for (const v of obj) yield* allStrings(v);
	else if (isObject(obj)) for (const v of Object.values(obj)) yield* allStrings(v);
}

// =============================================================================
// STATIC CHECKS: on the final workspace
// =============================================================================

/** What one check found: true, false, or null for "not answerable here". */
export interface Verdict {
	ok: boolean | null;
	msg: string;
}

/**
 * Runs one check on the final workspace. Every scenario starts from an empty one.
 *
 * @param ck - The check.
 * @param final - The workspace after the run, path to text.
 * @returns The verdict; a check that throws fails with the reason.
 */
export function staticCheck(ck: ScenarioCheck, final: Record<string, string>): Verdict {
	try {
		return staticCheckOrThrow(ck, final);
	} catch (err) {
		return { ok: false, msg: `exception: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function staticCheckOrThrow(ck: ScenarioCheck, final: Record<string, string>): Verdict {
	const p = ck.path ?? '';
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
	switch (ck.kind) {
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
			if ('equals' in ck) ok = vals.every((v) => JSON.stringify(v) === JSON.stringify(ck.equals));
			else if ('in' in ck) ok = vals.every((v) => (ck.in as unknown[]).some((x) => JSON.stringify(x) === JSON.stringify(v)));
			else ok = vals.every((v) => typeof v === 'string' && pyRegex(String(ck.matches), 'i').test(v));
			return { ok, msg: JSON.stringify(vals).slice(0, 200) };
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
		case 'only_changed': {
			const bad = Object.keys(final).filter((f) => !((ck.globs as string[]) ?? []).some((g) => fnmatch(f, g)));
			return { ok: bad.length === 0, msg: bad.join(', ') };
		}
		default:
			return { ok: null, msg: 'runtime only' };
	}
}

// =============================================================================
// RUN CHECKS: on the record
// =============================================================================

/**
 * A turn's outcome, from the TurnResult the product gave it: done when it
 * says done; needs_input when it says needs_input (ask_user, or a limit's
 * pause) or when the answer asks the user; otherwise its reason, or `none`
 * for a turn that left no result.
 *
 * @param turn - The turn, or undefined.
 * @returns The outcome word, or null for no turn.
 */
export function turnOutcome(turn: TurnRecord | undefined): string | null {
	if (!turn) return null;
	if (turn.result?.outcome === 'done') return 'done';
	if (turn.asked || turn.result?.outcome === 'needs_input') return 'needs_input';
	return turn.result?.reason ?? 'none';
}

/**
 * Why a trial ends with the needs_input status, or null when it does not: its
 * last turn's TurnResult is needs_input, from ask_user or a limit's pause. No
 * scenario expects either.
 *
 * @param last - The trial's last turn.
 * @returns The why line, or null.
 */
function needsInputWhy(last: TurnRecord | undefined): string | null {
	const result = last?.result;
	if (result?.outcome !== 'needs_input') return null;
	const how = result.reason === 'limited' ? 'at the step limit' : result.reason === 'cost_limit' ? 'at the cost limit' : 'with ask_user';
	const cost = result.usage.cost ? `, ~$${result.usage.cost.usd.toFixed(2)} est.` : '';
	return `the last turn ended needs_input ${how} after ${result.usage.waves} steps${cost}: ${result.request?.question ?? '(no question)'}`;
}

/** The validate the trial ran on a final file: the fake engine's static rules in L1 and L2, the engine's in L3. */
function savedVerdict(record: TrialRecord, path: string): ValidateResult | null {
	return record.pipes.find((x) => x.path === path)?.validate ?? null;
}

function verdictOf(v: ValidateResult): Verdict {
	if ('failed' in v) return { ok: false, msg: `could not run: ${v.failed}` };
	return { ok: v.errors.length === 0, msg: v.errors.join('; ').slice(0, 300) };
}

/**
 * Runs one check that reads the run.
 *
 * @returns The status and why.
 */
function runCheck(ck: ScenarioCheck, scenario: Scenario, layer: Layer, record: TrialRecord): { status: CheckStatus; detail: string } {
	const turns = record.turns ?? [];
	const last = turns[turns.length - 1];
	const res = (ok: boolean | null, detail = ''): { status: CheckStatus; detail: string } => ({ status: ok === null ? 'pending' : ok ? 'pass' : 'fail', detail });
	switch (ck.kind) {
		case 'outcome': {
			const got = turnOutcome(last);
			return res(got === ck.equals, String(got));
		}
		case 'engine_validate': {
			if (layer !== 'L3') return { status: 'not_in_layer', detail: 'needs the real engine (L3)' };
			if (!(String(ck.path) in record.finalFiles)) return res(false, 'the file does not exist, so no engine validated it');
			const v = savedVerdict(record, String(ck.path));
			if (!v) return res(false, 'no validate result for the file');
			const out = verdictOf(v);
			return res(out.ok, `engine${out.msg ? `: ${out.msg}` : ''}`);
		}
		case 'canary_absent': {
			const scan = record.canary?.[ck.id];
			if (!scan) return { status: 'pending', detail: 'not scanned' };
			if (scan.hits.length) return res(false, scan.hits.map((h) => `${h.canary} on ${h.surface} (${h.count})`).join('; '));
			if (scan.missing.length) return { status: 'pending', detail: `no leak on ${scan.scanned.join(', ') || 'nothing'}; not readable: ${scan.missing.map((m) => `${m.surface} (${m.why})`).join('; ')}` };
			return res(true, `${scan.values} values, ${scan.scanned.join(', ')}`);
		}
		case 'run_output': {
			if (layer !== 'L3') return { status: 'not_in_layer', detail: 'needs the real engine (L3)' };
			const r = record.runOutput?.[ck.id];
			if (!r) return { status: 'pending', detail: 'not run' };
			return { status: r.status, detail: r.detail };
		}
		default:
			return { status: 'pending', detail: `unknown check kind ${ck.kind} (scenario ${scenario.id})` };
	}
}

// =============================================================================
// SCORE: every check, then the status
// =============================================================================

/** A repeated identical call: same tool and arguments in one turn. Returns the count and the longest run back to back. */
function repeats(turns: TurnRecord[]): { repeated: number; longestRun: number } {
	let repeated = 0;
	let longest = 0;
	for (const t of turns) {
		const seen = new Map<string, number>();
		let run = 0;
		let prev = '';
		for (const c of (t.calls ?? []).filter((x) => !x.late)) {
			const key = `${c.tool}\u0000${JSON.stringify(c.args)}`;
			seen.set(key, (seen.get(key) ?? 0) + 1);
			run = key === prev ? run + 1 : 1;
			prev = key;
			longest = Math.max(longest, run);
		}
		for (const n of seen.values()) if (n > 1) repeated += n - 1;
	}
	return { repeated, longestRun: longest };
}

/**
 * Diagnostics: recorded next to the result, never deciding it.
 *
 * @param record - The trial record.
 * @returns The diagnostics.
 */
export function diagnostics(record: TrialRecord): Record<string, unknown> {
	const turns = record.turns ?? [];
	// the product's own account of each turn: how it ended, and its estimated usage
	const results = turns.map((t) => t.result ?? null);
	const costs = results.map((r) => r?.usage.cost?.usd);
	return {
		turnResults: results.map((r) => (r ? `${r.outcome}/${r.reason}` : 'none')),
		estimatedCostUsd: costs.some((c) => c !== undefined) ? costs.reduce<number>((n, c) => n + (c ?? 0), 0) : null,
		estimatedTokens: results.some((r) => r?.usage.tokens) ? results.reduce((n, r) => ({ input: n.input + (r?.usage.tokens?.input ?? 0), output: n.output + (r?.usage.tokens?.output ?? 0) }), { input: 0, output: 0 }) : null,
		turns: turns.length,
		wavesPerTurn: turns.map((t) => t.waves),
		toolCalls: turns.reduce((n, t) => n + (t.calls?.length ?? 0), 0),
		modelCalls: turns.reduce((n, t) => n + (t.modelCalls?.length ?? 0), 0),
		...repeats(turns),
		toolErrors: turns.reduce((n, t) => n + (t.toolErrors ?? 0), 0),
		gateStateWriteFailures: turns.reduce((n, t) => n + (t.gateStateWriteFailures ?? 0), 0),
		doneRefusals: turns.reduce((n, t) => n + (t.refusals?.length ?? 0), 0),
		approvalTurns: record.approvalTurns,
		retryTurns: record.retryTurns,
		confirms: record.confirms?.length ?? 0,
		tokens: record.tokens,
		costUsd: record.costUsd,
		wallMs: record.totalWallMs,
		modelMs: record.totalModelMs,
		endReason: record.endReason,
	};
}

/**
 * Scores one trial.
 *
 * @param scenario - The scenario.
 * @param layer - The layer it ran in.
 * @param record - The trial record.
 * @param recordPath - Where the record is, for the report.
 * @returns The result.
 */
export function scoreTrial(scenario: Scenario, layer: Layer, record: TrialRecord, recordPath: string | null): ScenarioResult {
	const checks: CheckResult[] = scenario.checks.map((ck) => {
		let status: CheckStatus;
		let detail: string;
		if (STATIC_KINDS.has(ck.kind)) {
			const v = staticCheck(ck, record.finalFiles);
			status = v.ok === null ? 'pending' : v.ok ? 'pass' : 'fail';
			detail = v.msg;
		} else ({ status, detail } = runCheck(ck, scenario, layer, record));
		return { id: ck.id, kind: ck.kind, status, detail, blocker: !!ck.blocker };
	});
	const counted = checks.filter((c) => c.status !== 'not_in_layer');
	const blockersFired = counted.filter((c) => c.blocker && c.status === 'fail').map((c) => c.id);
	const failed = counted.filter((c) => c.status === 'fail').map((c) => c.id);
	const pending = counted.filter((c) => c.status === 'pending').map((c) => c.id);
	const last = record.turns[record.turns.length - 1];
	const needsInput = needsInputWhy(last);
	const ended = last?.result;

	let status: RunStatus;
	let why: string;
	if (record.infraError) {
		status = 'error';
		why = record.infraError;
	} else if (blockersFired.length) {
		status = 'fail';
		why = `blocker fired: ${blockersFired.join(', ')}`;
	} else if (last && (ended ? ended.outcome === 'failed' || ended.outcome === 'incomplete' : last.runError)) {
		status = 'incomplete';
		why = `the last turn ended ${ended ? `${ended.outcome}/${ended.reason}` : 'with an error'}${last.runError ? `: ${last.runError.slice(0, 160)}` : ''}`;
	} else if (needsInput) {
		status = 'needs_input';
		why = needsInput;
	} else if (/^still asking/.test(record.endReason)) {
		status = 'abstain';
		why = record.endReason;
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
	const result: ScenarioResult = {
		scenario: scenario.id,
		layer,
		trial: record.trial,
		model: record.model,
		status,
		why,
		checks,
		blockersFired,
		counted: {
			passed: counted.filter((c) => c.status === 'pass').length,
			total: counted.length,
			pending: pending.length,
			notInLayer: checks.filter((c) => c.status === 'not_in_layer').length,
		},
		diagnostics: diagnostics(record),
		record: recordPath,
	};
	return result;
}
