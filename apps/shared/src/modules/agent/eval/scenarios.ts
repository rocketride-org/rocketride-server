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
// SCENARIOS — load the data, and refuse what is broken before anything runs
// =============================================================================

/**
 * Loads the scenarios, fixtures, references, inputs and recordings under
 * `data/`, and validates all of them up front. A scenario is invalid when its
 * file breaks the format in data/README.md, when it names a fixture,
 * reference or input that is not there, when a check is of an unknown kind or
 * misses a field its kind needs, or when its reference solution fails one of
 * its own static checks or, for an app, its check_app_passes (the app's own
 * type-check and build, cached by content). The runner reports every invalid
 * scenario by name and runs nothing.
 *
 * Fixtures and references are stored as JSON maps of workspace path to text,
 * so the app sources in them (one of which has a type error on purpose) stay
 * out of the package's type-check, lint and format.
 */

import fs from 'node:fs';
import path from 'node:path';

import { checkApp, shellContract } from './appCheck';
import { DATA_DIR, REPO_ROOT } from './catalog';
import { RUN_KINDS, sha256, STATIC_KINDS, staticCheck } from './score';
import type { Scenario, ScenarioCheck } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

const TYPES = new Set(['BUILD', 'EDIT', 'ASK', 'STOP', 'SECRET']);
const TARGETS = new Set(['pipeline', 'app']);
const LAYERS = new Set(['L2', 'L3', 'browser']);
const EVENT_WHEN = new Set(['start', 'between_freshness_check_and_write', 'episode_end']);
const EVENT_ACTIONS = new Set(['dirty_buffer', 'save', 'save_buffer_if_dirty']);
const VARIABLE = /^ROCKETRIDE_[A-Z0-9_]+$/;

/** The fields each check kind needs besides id and kind. */
const NEEDS: Record<string, string[]> = {
	json_parses: ['path'],
	pipe_static_valid: ['path'],
	engine_validate: ['path'],
	providers_present: ['path'],
	providers_absent: ['path', 'providers'],
	count: ['path', 'provider', 'n'],
	edge: ['path', 'from', 'to'],
	reaches: ['path', 'from', 'to'],
	control: ['path', 'provider', 'classType', 'invoker'],
	config_value: ['path', 'provider', 'pointer'],
	same_config: ['path', 'provider', 'pointer'],
	any_config_matches: ['path', 'matches'],
	extract_fields: ['path', 'columns'],
	project_id_unchanged: ['path'],
	file_unchanged: ['path'],
	file_exists: ['path'],
	file_absent: ['path'],
	glob_count: ['glob', 'n'],
	file_matches: ['path', 'regex'],
	file_not_matches: ['path', 'regex'],
	json_value: ['path', 'pointer'],
	only_changed: ['globs'],
	user_edit_kept: ['path', 'contains'],
	canary_absent: ['canaries', 'surfaces'],
	run_output: ['path', 'send', 'expect'],
	check_app_passes: ['app'],
	max_identical_refusals: ['tool', 'n'],
	outcome_reached_within: ['waves'],
};

/** The surfaces canary_absent can scan. */
export const SURFACES = new Set(['model_questions', 'thinking', 'final_text', 'session_json', 'catalog', 'workspace_files']);

// =============================================================================
// LOADING
// =============================================================================

/** A workspace tree: path to text. */
export type Tree = Record<string, string>;

/**
 * Reads a packed tree: a fixture (`fixtures/<name>`) or a reference (`references/<id>`).
 *
 * @param ref - The folder as a scenario names it.
 * @returns The files, or null when there is no such pack.
 */
export function loadTree(ref: string | null | undefined): Tree | null {
	if (!ref) return null;
	const file = path.join(DATA_DIR, `${ref.replace(/\/+$/, '')}.json`);
	if (!fs.existsSync(file)) return null;
	const pack = JSON.parse(fs.readFileSync(file, 'utf8')) as { files?: Tree };
	return pack.files ?? null;
}

/**
 * The fixture's starting workspace.
 *
 * @param s - The scenario.
 * @returns The files; empty for an empty workspace.
 */
export function fixtureTree(s: Scenario): Tree {
	const ws = s.fixture.workspace;
	if (!ws) return {};
	return loadTree(ws.startsWith('fixtures/') ? ws : `fixtures/${ws}`) ?? {};
}

/**
 * The workspace a correct solution leaves: the fixture, the reference over it, minus what it deletes.
 *
 * @param s - The scenario.
 * @returns The files, or null when the scenario has no reference workspace.
 */
export function referenceTree(s: Scenario): Tree | null {
	const ref = s.reference.workspace ? loadTree(s.reference.workspace) : null;
	if (s.reference.workspace && !ref) return null;
	const final: Tree = { ...fixtureTree(s), ...(ref ?? {}) };
	for (const gone of s.reference.deleted ?? []) delete final[gone];
	return final;
}

/** Every scenario file's id, sorted. */
export function scenarioIds(): string[] {
	return fs
		.readdirSync(path.join(DATA_DIR, 'scenarios'))
		.filter((f) => f.endsWith('.json'))
		.map((f) => f.slice(0, -5))
		.sort();
}

/**
 * Reads one scenario file as it stands (validate it before use).
 *
 * @param id - The scenario id.
 * @returns The scenario.
 */
export function loadScenario(id: string): Scenario {
	return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scenarios', `${id}.json`), 'utf8')) as Scenario;
}

/** An input file the runner sends to a saved pipeline. */
export function inputPath(file: string): string {
	return path.join(DATA_DIR, file);
}

// =============================================================================
// VALIDATION
// =============================================================================

/** One scenario's problems; empty when it is valid. */
export interface Validation {
	id: string;
	problems: string[];
	/** The reference's static checks: passed of counted. */
	reference: { passed: number; counted: number } | null;
}

/** The files a check's `send` reads. */
function sendFiles(send: unknown): string[] {
	if (!send || typeof send !== 'object') return [];
	return Object.values(send as Record<string, unknown>)
		.map((v) => (v && typeof v === 'object' ? (v as { file?: unknown }).file : undefined))
		.filter((f): f is string => typeof f === 'string');
}

/**
 * Checks one scenario against the format and its own reference.
 *
 * @param id - The scenario id (its file name).
 * @returns Its problems.
 */
export function validateScenario(id: string): Validation {
	const problems: string[] = [];
	let s: Scenario;
	try {
		s = loadScenario(id);
	} catch (err) {
		return { id, problems: [`does not parse: ${err instanceof Error ? err.message : String(err)}`], reference: null };
	}
	const need = (ok: unknown, what: string) => {
		if (!ok) problems.push(what);
	};
	need(s.id === id, `id ${JSON.stringify(s.id)} does not match the file name`);
	need(TYPES.has(s.type), `type ${JSON.stringify(s.type)} is not BUILD, EDIT, ASK, STOP or SECRET`);
	need(TARGETS.has(s.target), `target ${JSON.stringify(s.target)} is not pipeline or app`);
	need(typeof s.prompt === 'string' && s.prompt.trim() !== '', 'prompt is empty');
	need(Array.isArray(s.followups), 'followups is not a list');
	for (const [i, f] of (s.followups ?? []).entries()) {
		need(f.when === 'asks' || f.when === 'after_turn', `followups[${i}].when is ${JSON.stringify(f.when)}`);
		need(typeof f.text === 'string' && f.text !== '', `followups[${i}] has no text`);
		if (f.when === 'after_turn') need(Number.isInteger(f.turn), `followups[${i}] after_turn has no turn`);
	}
	need(Array.isArray(s.layers) && s.layers.length > 0 && s.layers.every((l) => LAYERS.has(l)), `layers ${JSON.stringify(s.layers)} must be L2, L3 or browser`);

	// step: the fixture
	const fx = s.fixture;
	need(fx && typeof fx === 'object', 'fixture is missing');
	if (fx?.workspace) need(Object.keys(fixtureTree(s)).length > 0, `fixture ${fx.workspace} does not exist`);
	need(Array.isArray(fx?.variables) && fx.variables.every((v) => VARIABLE.test(v)), 'fixture.variables must be ROCKETRIDE_* names');
	for (const [name, value] of Object.entries(fx?.canaries ?? {})) need(typeof value === 'string' && value.length >= 8, `canary ${name} has no value`);
	const fixture = fixtureTree(s);
	for (const [i, e] of (fx?.user_events ?? []).entries()) {
		need(EVENT_WHEN.has(e.when), `user_events[${i}].when is ${JSON.stringify(e.when)}`);
		need(EVENT_ACTIONS.has(e.action), `user_events[${i}].action is ${JSON.stringify(e.action)}`);
		need(e.path in fixture, `user_events[${i}] names ${e.path}, which the fixture lacks`);
		for (const from of Object.keys(e.replace ?? {})) need((fixture[e.path] ?? '').includes(from), `user_events[${i}] replaces text the fixture file lacks`);
	}

	// step: the checks
	need(Array.isArray(s.checks) && s.checks.length > 0, 'checks is empty');
	const ids = new Set<string>();
	for (const ck of s.checks ?? []) {
		const label = `check ${ck.id ?? '(no id)'}`;
		need(typeof ck.id === 'string' && ck.id !== '', `a check has no id`);
		need(!ids.has(ck.id), `${label} is listed twice`);
		ids.add(ck.id);
		if (!STATIC_KINDS.has(ck.kind) && !RUN_KINDS.has(ck.kind)) {
			problems.push(`${label} has unknown kind ${JSON.stringify(ck.kind)}`);
			continue;
		}
		for (const field of NEEDS[ck.kind] ?? []) need(ck[field] !== undefined && ck[field] !== null, `${label} (${ck.kind}) needs ${field}`);
		if (ck.kind === 'outcome') need('equals' in ck || Array.isArray(ck.any_of), `${label} needs equals or any_of`);
		if (ck.kind === 'tool_called' || ck.kind === 'tool_not_called') need(ck.tool || Array.isArray(ck.tools), `${label} needs tool or tools`);
		if (ck.kind === 'answer_matches' || ck.kind === 'answer_not_matches') need(ck.regex || ck.matches, `${label} needs regex`);
		if (ck.kind === 'canary_absent') {
			for (const surface of (ck.surfaces as string[]) ?? []) need(SURFACES.has(surface), `${label} names unknown surface ${surface}`);
			for (const c of (ck.canaries as string[]) ?? []) need(c === '$VARIABLE_VALUES' || c in (fx?.canaries ?? {}) || /^[A-Za-z0-9]{8,}$/.test(c), `${label} canary ${c} is neither a Variable set, a fixture canary nor a marker`);
		}
		if (ck.kind === 'run_output' && !ck.pending) {
			for (const file of sendFiles(ck.send)) need(fs.existsSync(inputPath(file)), `${label} sends ${file}, which does not exist (mark the check pending until it does)`);
		}
		if (ck.kind === 'check_app_passes') need(/^apps\/[^/]+$/.test(String(ck.app)), `${label} app must be apps/<folder>`);
		for (const key of ['regex', 'matches']) {
			if (typeof ck[key] !== 'string') continue;
			try {
				new RegExp(String(ck[key]).replace(/^\(\?[imsx]+\)/, ''));
			} catch {
				problems.push(`${label} ${key} is not a valid regex`);
			}
		}
	}

	// step: the reference must pass its own static checks (check.py check_scenario); with no
	// reference workspace the right answer leaves the fixture as it is
	let reference: Validation['reference'] = null;
	const final = referenceTree(s);
	if (!final) problems.push(`reference ${s.reference?.workspace} does not exist`);
	else {
		const statics = (s.checks ?? []).filter((ck) => STATIC_KINDS.has(ck.kind) && ck.applies !== 'after_turn_1');
		let passed = 0;
		for (const ck of statics) {
			const v = staticCheck(ck, final, fixture);
			if (v.ok) passed++;
			else problems.push(`reference fails its check ${ck.id}${v.msg ? ` (${v.msg.slice(0, 160)})` : ''}`);
		}
		reference = { passed, counted: statics.length };
	}
	if (!s.reference?.workspace && (s.type === 'BUILD' || s.type === 'EDIT')) problems.push('a BUILD or EDIT scenario needs a reference solution');
	return { id, problems, reference };
}

/**
 * Validates every scenario.
 *
 * @returns One validation per scenario file, sorted by id.
 */
export function validateAll(): Validation[] {
	return scenarioIds().map(validateScenario);
}

/** Where app-check verdicts on reference solutions are kept, by content. */
const APP_CACHE = path.join(REPO_ROOT, '.verify/eval/cache');

/**
 * Runs check_app_passes on every app reference solution, the slow part of
 * validation. A verdict is cached under the sha256 of the app's files and the
 * shell contract, so it runs again only when either changes.
 *
 * @param ids - The scenarios to check.
 * @returns The problems, by scenario id; a scenario with none is absent.
 */
export async function validateAppReferences(ids: string[]): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	const contract = fs.readFileSync(shellContract(), 'utf8');
	fs.mkdirSync(APP_CACHE, { recursive: true });
	for (const id of ids) {
		let s: Scenario;
		try {
			s = loadScenario(id);
		} catch {
			continue;
		}
		const final = referenceTree(s);
		if (!final || !s.reference?.workspace) continue;
		for (const ck of s.checks.filter((c) => c.kind === 'check_app_passes')) {
			const app = String(ck.app);
			const files = Object.entries(final)
				.filter(([p]) => p.startsWith(`${app}/`))
				.sort(([a], [b]) => (a < b ? -1 : 1));
			const key = sha256(JSON.stringify(files) + contract);
			const cached = path.join(APP_CACHE, `app-${key}.json`);
			let verdict: { ok: boolean; detail: string };
			if (fs.existsSync(cached)) verdict = JSON.parse(fs.readFileSync(cached, 'utf8')) as { ok: boolean; detail: string };
			else {
				const r = await checkApp(final, app);
				verdict = { ok: r.ok, detail: r.detail };
				fs.writeFileSync(cached, JSON.stringify(verdict));
			}
			if (!verdict.ok) out.set(id, [...(out.get(id) ?? []), `reference fails its check ${ck.id} (${verdict.detail.split('\n')[0].slice(0, 200)})`]);
		}
	}
	return out;
}

/** A check by id, for the runner. */
export function checkOf(s: Scenario, id: string): ScenarioCheck | undefined {
	return s.checks.find((c) => c.id === id);
}
