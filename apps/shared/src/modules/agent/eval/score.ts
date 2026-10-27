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
// SCORE — the hidden checks, and what a trial's status is
// =============================================================================

/**
 * Applies a scenario's checks to a trial record and gives the run one of six
 * statuses: pass, fail, error, incomplete, abstain or pending. The static
 * checks are a port of the scenario tools' check.py, and the run checks a
 * port of check_workspace.py, so a record scores here as it scored for the
 * baseline. Three checks are new: canary_absent, check_app_passes and
 * run_output. Their evidence is gathered by the trial and the runner; this
 * file only reads it.
 *
 * A check is pass, fail, pending (it belongs in this layer but what it needs
 * is missing) or not_in_layer (listed, never counted). A pending check never
 * counts as a pass.
 */

import { createHash } from 'node:crypto';

import { catalog } from './catalog';
import type { CheckResult, CheckStatus, Layer, RecordedCall, RunStatus, Scenario, ScenarioCheck, ScenarioResult, TrialRecord, TurnRecord, ValidateResult } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The tools whose calls change the work (run.ts CHANGE_TOOLS). */
export const CHANGE_TOOLS = new Set(['write_file', 'edit_file', 'rename', 'delete_file', 'create_app']);

/** A line the code owns, after markdown, that says the run stopped unchecked. */
const NOT_CHECKED = /^\s*[*_]*Not checked/m;

/** A `${ROCKETRIDE_*}` placeholder, the only non-empty value a secret field may hold. */
const PLACEHOLDER = /^\$\{ROCKETRIDE_[A-Z0-9_]+\}$/;

/** A config key that names a secret. */
const SECRET_KEY = /(apikey|api_key|password|secret|token|accesskey|secretkey)$/i;

/**
 * Tool names the scenarios use that this branch spells another way. Since
 * 8bd0122f the pipeline toolkits are one `rocketride_client` tool, so a check
 * that names `run_pipeline` also matches `rocketride_client` with method `use`.
 */
const TOOL_ALIASES: Record<string, Array<{ tool: string; method: RegExp }>> = {
	run_pipeline: [{ tool: 'rocketride_client', method: /^(client\.)?use$/ }],
	send_data: [{ tool: 'rocketride_client', method: /^(client\.)?(send|sendFiles|chat|pipe)$/ }],
	deploy_add: [{ tool: 'rocketride_client', method: /^(client\.)?deploy\.add$/ }],
	validate_pipeline: [{ tool: 'rocketride_client', method: /^(client\.)?validate$/ }],
	terminate: [{ tool: 'rocketride_client', method: /^(client\.)?terminate$/ }],
};

/** Check kinds read from the final workspace. */
export const STATIC_KINDS = new Set(['json_parses', 'pipe_static_valid', 'providers_present', 'providers_absent', 'count', 'edge', 'reaches', 'control', 'config_value', 'same_config', 'any_config_matches', 'extract_fields', 'secrets_are_placeholders', 'project_id_unchanged', 'file_unchanged', 'file_exists', 'file_absent', 'glob_count', 'file_matches', 'file_not_matches', 'json_value', 'only_changed', 'user_edit_kept']);

/** Check kinds read from the run. */
export const RUN_KINDS = new Set(['outcome', 'no_change_tools', 'tool_called', 'tool_not_called', 'engine_validate', 'done_implies_checks_pass', 'answer_matches', 'answer_not_matches', 'max_identical_refusals', 'outcome_reached_within', 'canary_absent', 'run_output', 'check_app_passes']);

// =============================================================================
// PYTHON-STYLE MATCHING — the scenario files were written for Python's re and fnmatch
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

/** A string argument matches a wanted value as a glob or a regex (check_workspace.py args_match). */
function argMatches(got: unknown, want: unknown): boolean {
	if (typeof want === 'string' && typeof got === 'string') {
		if (fnmatch(got, want)) return true;
		try {
			return pyRegex(want).test(got);
		} catch {
			return false;
		}
	}
	return JSON.stringify(got) === JSON.stringify(want);
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
// STATIC PIPELINE RULES — check.py's static_errors, on the branch's catalog
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
// STATIC CHECKS — on the final workspace
// =============================================================================

/** What one check found: true, false, or null for "not answerable here". */
export interface Verdict {
	ok: boolean | null;
	msg: string;
}

/**
 * Runs one check on the final workspace against the fixture (check.py run_check).
 *
 * @param ck - The check.
 * @param final - The workspace after the run, path to text.
 * @param fixture - The workspace before it.
 * @returns The verdict; a check that throws fails with the reason.
 */
export function staticCheck(ck: ScenarioCheck, final: Record<string, string>, fixture: Record<string, string>): Verdict {
	try {
		return staticCheckOrThrow(ck, final, fixture);
	} catch (err) {
		return { ok: false, msg: `exception: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function staticCheckOrThrow(ck: ScenarioCheck, final: Record<string, string>, fixture: Record<string, string>): Verdict {
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
	const changedFiles = () => [...new Set([...Object.keys(final), ...Object.keys(fixture)])].filter((f) => final[f] !== fixture[f]);
	switch (ck.kind) {
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
			if ('equals' in ck) ok = vals.every((v) => JSON.stringify(v) === JSON.stringify(ck.equals));
			else if ('in' in ck) ok = vals.every((v) => (ck.in as unknown[]).some((x) => JSON.stringify(x) === JSON.stringify(v)));
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
			const from = String(ck.from ?? p);
			if (!(from in fixture)) throw new Error(`no fixture file ${from}`);
			return { ok: pj().project_id === (JSON.parse(fixture[from]) as Record<string, unknown>).project_id, msg: '' };
		}
		case 'file_unchanged':
			return { ok: final[p] === fixture[p], msg: '' };
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
			if ('equals' in ck) return { ok: JSON.stringify(v) === JSON.stringify(ck.equals), msg: JSON.stringify(v) };
			return { ok: typeof v === 'string' && pyRegex(String(ck.matches), 'i').test(v), msg: JSON.stringify(v) };
		}
		case 'only_changed': {
			const bad = changedFiles().filter((f) => !((ck.globs as string[]) ?? []).some((g) => fnmatch(f, g)));
			return { ok: bad.length === 0, msg: bad.join(', ') };
		}
		case 'user_edit_kept':
			return { ok: (final[p] ?? '').includes(String(ck.contains)), msg: '' };
		default:
			return { ok: null, msg: 'runtime only' };
	}
}

// =============================================================================
// RUN CHECKS — on the record
// =============================================================================

/**
 * A turn's outcome, the way the eval README reads it on this branch: done is
 * stop=done with no "Not checked" line; a turn that asked is needs_input.
 *
 * @param turn - The turn, or undefined.
 * @returns The outcome word, or null for no turn.
 */
export function turnOutcome(turn: TurnRecord | undefined): string | null {
	if (!turn) return null;
	if (turn.stopReason === 'done' && !NOT_CHECKED.test(turn.finalText ?? '')) return 'done';
	if (turn.asked) return 'needs_input';
	return turn.stopReason || 'error';
}

/** The calls the finish rule heard in some turns, late ones left out. */
function callsOf(turns: TurnRecord[]): RecordedCall[] {
	return turns.flatMap((t) => (t.calls ?? []).filter((c) => !c.late));
}

/** Whether a call is the tool a check names, under its own name or an alias, with matching arguments. */
function callMatches(call: RecordedCall, tool: string, want: Record<string, unknown> | undefined): boolean {
	const argsOk = Object.entries(want ?? {}).every(([k, v]) => argMatches(call.args?.[k], v));
	if (call.tool === tool) return argsOk;
	return (TOOL_ALIASES[tool] ?? []).some((a) => a.tool === call.tool && a.method.test(String(call.args?.method ?? '')) && argsOk);
}

/** What a run check needs besides the record. */
export interface ScoreContext {
	/** check_app_passes evidence, by app folder (apps/<folder>). */
	appChecks: Record<string, { ok: boolean; detail: string } | undefined>;
	/** L1: the engine's validate on the recorded final files, by content sha256. */
	recordedVerdicts?: Map<string, ValidateResult>;
	/** Why a scenario has nothing to replay, for an L1 pending. */
	pendingWhy?: string;
}

/** The engine's validate of a final file, from the source this layer trusts. */
function engineVerdict(layer: Layer, record: TrialRecord, ctx: ScoreContext, path: string): { v: ValidateResult | null; source: string } {
	if (layer === 'L1') {
		const text = record.finalFiles[path];
		const v = text === undefined ? undefined : ctx.recordedVerdicts?.get(sha256(text));
		if (v) return { v, source: 'recorded engine verdict' };
		return { v: null, source: 'no recorded engine verdict for this content' };
	}
	const v = record.pipes.find((x) => x.path === path)?.validate ?? null;
	return { v, source: layer === 'L3' ? 'engine' : 'fake engine' };
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
function runCheck(ck: ScenarioCheck, scenario: Scenario, layer: Layer, record: TrialRecord, ctx: ScoreContext): { status: CheckStatus; detail: string } {
	const turns = record.turns ?? [];
	const scoped = ck.applies === 'after_turn_1' ? turns.slice(0, 1) : turns;
	const last = scoped[scoped.length - 1];
	const res = (ok: boolean | null, detail = ''): { status: CheckStatus; detail: string } => ({ status: ok === null ? 'pending' : ok ? 'pass' : 'fail', detail });
	switch (ck.kind) {
		case 'outcome': {
			const got = turnOutcome(last);
			if ('equals' in ck) return res(got === ck.equals, String(got));
			return res(((ck.any_of as string[]) ?? []).includes(String(got)), String(got));
		}
		case 'no_change_tools': {
			const bad = callsOf(scoped).filter((c) => CHANGE_TOOLS.has(c.tool) && c.error === undefined);
			return res(bad.length === 0, bad.map((c) => c.tool).join(', '));
		}
		case 'tool_called':
		case 'tool_not_called': {
			const names = ck.tools ? (ck.tools as string[]) : [String(ck.tool)];
			const want = (ck.args_match ?? ck.args) as Record<string, unknown> | undefined;
			const hit = callsOf(scoped).filter((c) => names.some((n) => callMatches(c, n, want)));
			const detail = hit.map((c) => (c.tool === 'rocketride_client' ? `rocketride_client ${String(c.args.method)}` : c.tool)).join(', ');
			return res(ck.kind === 'tool_called' ? hit.length > 0 : hit.length === 0, detail);
		}
		case 'engine_validate': {
			if (layer === 'L2') return { status: 'not_in_layer', detail: 'L2 has no real engine' };
			if (!(String(ck.path) in record.finalFiles)) return res(false, 'the file does not exist, so no engine validated it');
			const { v, source } = engineVerdict(layer, record, ctx, String(ck.path));
			if (!v) return layer === 'L1' ? { status: 'pending', detail: source } : res(false, 'no validate result for the file');
			const out = verdictOf(v);
			return res(out.ok, `${source}${out.msg ? `: ${out.msg}` : ''}`);
		}
		case 'done_implies_checks_pass': {
			if (turnOutcome(last) !== 'done') return res(true, 'not done');
			const changed = [...new Set([...Object.keys(record.finalFiles), ...Object.keys(record.fixtureFiles)])].filter((f) => record.finalFiles[f] !== record.fixtureFiles[f]);
			const bad: string[] = [];
			const apps = new Set<string>();
			for (const f of changed) {
				const app = /^apps\/([^/]+)\//.exec(f)?.[1];
				if (app) {
					if (f in record.finalFiles) apps.add(app);
				} else if (f.endsWith('.pipe') && f in record.finalFiles) {
					let { v } = engineVerdict(layer, record, ctx, f);
					if (!v) v = record.pipes.find((x) => x.path === f)?.validate ?? { failed: 'not validated' };
					if (!verdictOf(v).ok) bad.push(f);
				}
			}
			for (const app of apps) {
				const a = ctx.appChecks[`apps/${app}`];
				if (!a) return { status: 'pending', detail: `apps/${app} changed and has no app check` };
				if (!a.ok) bad.push(`apps/${app}`);
			}
			return res(bad.length === 0, bad.join(', '));
		}
		case 'answer_matches':
		case 'answer_not_matches': {
			const hit = pyRegex(String(ck.regex ?? ck.matches), 'is').test(last?.finalText ?? '');
			return res(ck.kind === 'answer_matches' ? hit : !hit);
		}
		case 'max_identical_refusals': {
			const groups = new Map<string, number>();
			for (const c of callsOf(scoped)) {
				if (c.tool !== ck.tool || c.error === undefined) continue;
				const key = JSON.stringify(c.args);
				groups.set(key, (groups.get(key) ?? 0) + 1);
			}
			const worst = Math.max(0, ...groups.values());
			return res(worst <= Number(ck.n), `${worst}`);
		}
		case 'outcome_reached_within': {
			const waves = scoped.reduce((n, t) => n + (t.waves ?? 0), 0);
			return res(turnOutcome(last) === 'done' && waves <= Number(ck.waves), `${waves} waves`);
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
		case 'check_app_passes': {
			const a = ctx.appChecks[String(ck.app)];
			if (!a) return { status: 'pending', detail: 'no app check ran' };
			return res(a.ok, a.detail);
		}
		default:
			return { status: 'pending', detail: `unknown check kind ${ck.kind} (scenario ${scenario.id})` };
	}
}

// =============================================================================
// SCORE — every check, then the status
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
	return {
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
 * @param ctx - App checks and, for L1, the recorded engine verdicts.
 * @param recordPath - Where the record is, for the report.
 * @returns The result.
 */
export function scoreTrial(scenario: Scenario, layer: Layer, record: TrialRecord, ctx: ScoreContext, recordPath: string | null): ScenarioResult {
	const checks: CheckResult[] = scenario.checks.map((ck) => {
		let status: CheckStatus;
		let detail: string;
		if (STATIC_KINDS.has(ck.kind)) {
			const v = staticCheck(ck, record.finalFiles, record.fixtureFiles);
			status = v.ok === null ? 'pending' : v.ok ? 'pass' : 'fail';
			detail = v.msg;
		} else ({ status, detail } = runCheck(ck, scenario, layer, record, ctx));
		return { id: ck.id, kind: ck.kind, status, detail, blocker: !!ck.blocker, soft: !!ck.soft };
	});
	const counted = checks.filter((c) => !c.soft && c.status !== 'not_in_layer');
	const blockersFired = counted.filter((c) => c.blocker && c.status === 'fail').map((c) => c.id);
	const failed = counted.filter((c) => c.status === 'fail').map((c) => c.id);
	const pending = counted.filter((c) => c.status === 'pending').map((c) => c.id);
	const last = record.turns[record.turns.length - 1];

	let status: RunStatus;
	let why: string;
	if (record.infraError) {
		status = 'error';
		why = record.infraError;
	} else if (blockersFired.length) {
		status = 'fail';
		why = `blocker fired: ${blockersFired.join(', ')}`;
	} else if (scenario.type === 'ASK') {
		status = 'pending';
		why = 'ASK: scored by a person (see human-review.md)';
	} else if (last && (last.stopReason === 'empty_plan' || last.stopReason === 'error' || (last.runError && !last.stopReason))) {
		status = 'incomplete';
		why = `the last turn ended ${last.stopReason || 'with an error'}${last.runError ? `: ${last.runError.slice(0, 160)}` : ''}`;
	} else if (scenario.expect.outcome === 'done' && /^still asking/.test(record.endReason)) {
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
		type: scenario.type,
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
			soft: checks.filter((c) => c.soft).length,
			notInLayer: checks.filter((c) => c.status === 'not_in_layer').length,
		},
		diagnostics: diagnostics(record),
		record: recordPath,
	};
	if (scenario.type === 'ASK') result.human = { answer: record.turns[0]?.finalText ?? '', judge: scenario.judge };
	return result;
}
