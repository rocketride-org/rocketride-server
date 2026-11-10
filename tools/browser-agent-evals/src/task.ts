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
// TASKS: the task format, and refusing a broken task before anything runs
// =============================================================================

/**
 * A task is one JSON file in a task set folder (tasks/breadth/, tasks/golden/,
 * or another folder). Its starting files are copied from that folder, so the
 * agent's workspace never holds the task or its checks. README.md documents
 * the format. Every task is validated before a trial starts; an invalid task
 * is named with each of its problems, and nothing runs.
 *
 * This file began as #2885's scenarios.ts. SURFACES is as it
 * was; the loader reads the task format instead of #2885's scenarios.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './catalog';
import { expectProblems } from './expect';
import { pyRegex } from './score';

// =============================================================================
// TYPES
// =============================================================================

/** What a task asks for, for filtering and the report. ANSWER: the agent should answer and change nothing; it is graded like BUILD and EDIT, by its checks, while an ASK trial waits for the judge. */
export type TaskType = 'BUILD' | 'EDIT' | 'ANSWER' | 'ASK' | 'STOP' | 'SECRET';

/** What the task works on. */
export type TaskTarget = 'pipeline' | 'app';

/** An answer to a "Needs your OK" card. */
export type CardAnswer = 'approve' | 'deny';

/** An answer to the unsaved-changes prompt (apps/shared/src/modules/agent/choice.tsx). */
export type DirtyFileAnswer = 'save_mine_first' | 'discard_mine' | 'keep_mine';

/** How the runner answers cards: one answer for every card, or a default plus the answer to the unsaved-changes prompt. */
export type CardPolicy = CardAnswer | { default: CardAnswer; dirty_file_prompt?: DirtyFileAnswer };

/** Something the user does in the workspace during a trial. */
export interface UserEvent {
	when: 'start' | 'between_freshness_check_and_write' | 'episode_end';
	path: string;
	action: 'dirty_buffer' | 'save' | 'save_buffer_if_dirty';
	description?: string;
	replace?: Record<string, string>;
	set_pointer?: Record<string, unknown>;
}

/**
 * How the runner uses an app after the turn, for a check_app_passes check
 * (checks/appRun.ts): it types `fill` into the app's first text box, presses
 * the button whose name contains `click`, waits up to `timeoutSec` (default
 * 120) for `answer` (a regex) on the page, and reads the engine's tasks of
 * the app's own pipeline, the files `pipeline` globs under the app folder.
 */
export interface AppUse {
	fill: string;
	click: string;
	pipeline: string;
	answer?: string;
	timeoutSec?: number;
}

/** The fields an AppUse may have. */
const USE_FIELDS = new Set(['fill', 'click', 'pipeline', 'answer', 'timeoutSec']);

/** One check. Its other fields depend on its type (CHECK_FIELDS). */
export interface TaskCheck {
	id: string;
	type: string;
	path?: string;
	/** A blocker that fails fails the trial, however the turn ended. */
	blocker?: boolean;
	/** What the report calls a fired blocker. */
	blocker_name?: string;
	/** Recorded, never counted toward pass or fail. */
	soft?: boolean;
	[field: string]: unknown;
}

/** One judge question, kept as written for the judge (Phase 4). */
export interface JudgeLine {
	id: string;
	question: string;
	options: string[];
	pass_on: string;
	[field: string]: unknown;
}

/** One eval task. */
export interface Task {
	id: string;
	type: TaskType;
	target: TaskTarget;
	title?: string;
	/** The one message the runner sends. It never sends another. */
	prompt: string;
	/** The starting workspace: each file's workspace path, and where its text is, relative to the task set folder. */
	files: Array<{ path: string; from: string }>;
	cards: CardPolicy;
	/** When the turn has run this long, the runner stops it and grades what is there. */
	timeLimitSec: number;
	/** The sample input an output check with no `send` sends. */
	input?: string;
	/** The Variable names the engine must have. Values never appear in a task. */
	variables: string[];
	/** Synthetic secret values, by name, that the task plants for canary_absent. Never real keys. */
	canaries?: Record<string, string>;
	user_events?: UserEvent[];
	checks: TaskCheck[];
	/** Questions for the judge, which is advisory. */
	judge: JudgeLine[];
	/** What makes the task hard, which its checks are built around. */
	hard_because?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const FIELDS = new Set(['id', 'type', 'target', 'title', 'prompt', 'files', 'cards', 'timeLimitSec', 'input', 'variables', 'canaries', 'user_events', 'checks', 'judge', 'hard_because']);
const TYPES = new Set(['BUILD', 'EDIT', 'ANSWER', 'ASK', 'STOP', 'SECRET']);
const TARGETS = new Set(['pipeline', 'app']);
const CARD_ANSWERS = new Set(['approve', 'deny']);
const DIRTY_FILE_ANSWERS = new Set(['save_mine_first', 'discard_mine', 'keep_mine']);
const EVENT_WHEN = new Set(['start', 'between_freshness_check_and_write', 'episode_end']);
const EVENT_ACTIONS = new Set(['dirty_buffer', 'save', 'save_buffer_if_dirty']);
const VARIABLE = /^ROCKETRIDE_[A-Z0-9_]+$/;

/** How a turn can end (turn.ts TurnOutcome), for an outcome check's `expect`. */
const OUTCOMES = new Set(['done', 'needs_input', 'stopped', 'failed', 'incomplete']);

/** The canary_absent entry that stands for every Variable value the engine has. */
const VARIABLE_VALUES = '$VARIABLE_VALUES';

/** A canary_absent entry that is a marker: a fragment of a planted value, found even when only part of the value leaks. */
const MARKER = /^[A-Za-z0-9]{8,}$/;

/** Each check type, and the fields it needs besides id and type. `output` is checked on its own (validateOutput). */
export const CHECK_FIELDS = new Map<string, string[]>([
	// how the turn ended
	['outcome', ['expect']],
	['done_implies_checks_pass', []],
	// the engine, after the turn
	['validates', ['path']],
	['output', []],
	// the final files, against the starting files
	['json_parses', ['path']],
	['pipe_static_valid', ['path']],
	['providers_present', ['path']],
	['providers_absent', ['path', 'providers']],
	['count', ['path', 'provider', 'n']],
	['edge', ['path', 'from', 'to']],
	['reaches', ['path', 'from', 'to']],
	['control', ['path', 'provider', 'classType', 'invoker']],
	['config_value', ['path', 'provider', 'pointer']],
	['same_config', ['path', 'provider', 'pointer']],
	['any_config_matches', ['path', 'matches']],
	['extract_fields', ['path', 'columns']],
	['secrets_are_placeholders', []],
	['project_id_unchanged', ['path']],
	['file_unchanged', ['path']],
	['file_exists', ['path']],
	['file_absent', ['path']],
	['glob_count', ['glob', 'n']],
	['file_matches', ['path', 'regex']],
	['file_not_matches', ['path', 'regex']],
	['json_value', ['path', 'pointer']],
	['only_changed', ['globs']],
	['user_edit_kept', ['path', 'contains']],
	// what the trial saw
	['canary_absent', ['canaries', 'surfaces']],
	// app is optional: without it the check grades the one app folder the turn added (checks/app.ts appOf)
	['check_app_passes', []],
]);

/** Check types from #2885 and 51bd59d2c7 that a browser trial cannot grade from the end state, and why. */
export const NOT_SUPPORTED = new Map<string, string>([
	['no_change_tools', "reads the agent's tool calls"],
	['tool_called', "reads the agent's tool calls"],
	['tool_not_called', "reads the agent's tool calls"],
	['max_identical_refusals', "reads the agent's tool calls"],
	['outcome_reached_within', "reads the agent's step count"],
	['answer_matches', "reads the agent's answer, which only the judge grades"],
	['answer_not_matches', "reads the agent's answer, which only the judge grades"],
]);

/** The surfaces canary_absent can scan. */
export const SURFACES = new Set(['model_questions', 'thinking', 'final_text', 'session_json', 'catalog', 'workspace_files']);

// =============================================================================
// LOADING
// =============================================================================

/**
 * Every task file's id in a task set folder, sorted. Subfolders (fixtures,
 * inputs) are not read.
 *
 * @param dir - The task set folder.
 * @returns The ids.
 */
export function taskIds(dir: string = DATA_DIR): string[] {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith('.json'))
		.map((e) => e.name.slice(0, -5))
		.sort();
}

/**
 * Reads one task file as it stands (validate it before use).
 *
 * @param id - The task id.
 * @param dir - The task set folder.
 * @returns The task.
 */
export function loadTask(id: string, dir: string = DATA_DIR): Task {
	return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as Task;
}

// =============================================================================
// VALIDATION
// =============================================================================

/** One task's problems; empty when it is valid. */
export interface Validation {
	id: string;
	problems: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isText(v: unknown): v is string {
	return typeof v === 'string' && v.trim() !== '';
}

/** A relative path that stays inside its folder: no leading slash, no backslash, no `..` or empty part. */
function isInside(p: unknown): p is string {
	return typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validCards(c: unknown): boolean {
	if (typeof c === 'string') return CARD_ANSWERS.has(c);
	if (!isObject(c) || !CARD_ANSWERS.has(String(c.default))) return false;
	return Object.keys(c).every((k) => k === 'default' || (k === 'dirty_file_prompt' && DIRTY_FILE_ANSWERS.has(String(c.dirty_file_prompt))));
}

/** The problems with an output check: `send` with `path` and `expect` (51bd59d2c7's run_output), or the spec's `key` with `contains` or `absent`, which sends the task's `input`. */
function validateOutput(ck: Record<string, unknown>, label: string, task: Record<string, unknown>, dir: string): string[] {
	const problems: string[] = [];
	if (ck.send !== undefined) {
		if (!isText(ck.path)) problems.push(`${label} (output) needs path`);
		if (!isObject(ck.send)) problems.push(`${label} (output) send must be an object of source to what to send`);
		if (!isObject(ck.expect)) problems.push(`${label} (output) needs expect`);
		else problems.push(...expectProblems(ck.expect).map((p) => `${label} (output) ${p}`));
		if (ck.pending === undefined && isObject(ck.send)) {
			for (const what of Object.values(ck.send)) {
				const file = isObject(what) ? what.file : undefined;
				if (typeof file === 'string' && !(isInside(file) && fs.existsSync(path.join(dir, file)))) problems.push(`${label} sends ${file}, which is not in the task set folder`);
			}
		}
		return problems;
	}
	if (!isText(ck.key)) problems.push(`${label} (output) needs send, or key with contains or absent`);
	if ((typeof ck.contains === 'string') === (ck.absent === true)) problems.push(`${label} (output) needs exactly one of contains (text) or absent (true)`);
	if (!isText(task.input)) problems.push(`${label} (output) sends the task's input, and the task has none`);
	return problems;
}

/**
 * Checks one task against the format.
 *
 * @param id - The task id (its file name).
 * @param dir - The task set folder.
 * @returns Its problems.
 */
export function validateTask(id: string, dir: string = DATA_DIR): Validation {
	let raw: unknown;
	try {
		raw = loadTask(id, dir);
	} catch (err) {
		return { id, problems: [`does not parse: ${err instanceof Error ? err.message : String(err)}`] };
	}
	if (!isObject(raw)) return { id, problems: ['is not a JSON object'] };
	const t = raw;
	const problems: string[] = [];
	const need = (ok: unknown, what: string) => {
		if (!ok) problems.push(what);
	};

	for (const key of Object.keys(t)) need(FIELDS.has(key), `unknown field ${key}`);
	need(t.id === id, `id ${JSON.stringify(t.id)} does not match the file name`);
	need(TYPES.has(String(t.type)), `type ${JSON.stringify(t.type)} is not BUILD, EDIT, ANSWER, ASK, STOP or SECRET`);
	need(TARGETS.has(String(t.target)), `target ${JSON.stringify(t.target)} is not pipeline or app`);
	need(t.title === undefined || typeof t.title === 'string', 'title must be text');
	need(isText(t.prompt), 'prompt is empty');
	need(validCards(t.cards), 'cards must be "approve", "deny", or { "default": "approve" or "deny", "dirty_file_prompt": "save_mine_first", "discard_mine" or "keep_mine" }');
	need(Number.isInteger(t.timeLimitSec) && Number(t.timeLimitSec) > 0, 'timeLimitSec must be a whole number of seconds above 0');
	need(t.input === undefined || typeof t.input === 'string', 'input must be text');
	need(Array.isArray(t.variables) && t.variables.every((v) => typeof v === 'string' && VARIABLE.test(v)), 'variables must be a list of ROCKETRIDE_* names');
	need(t.canaries === undefined || (isObject(t.canaries) && Object.values(t.canaries).every((v) => typeof v === 'string' && v.length >= 8)), 'canaries must map names to values of 8 characters or more');
	need(t.hard_because === undefined || typeof t.hard_because === 'string', 'hard_because must be text');
	need(Array.isArray(t.judge) && t.judge.every((j) => isObject(j) && isText(j.id) && isText(j.question)), 'judge must be a list of { id, question, options, pass_on }');

	// step: the starting files
	if (!Array.isArray(t.files)) problems.push('files must be a list of { path, from }');
	else {
		const paths = new Set<string>();
		for (const f of t.files) {
			if (!isObject(f) || !isInside(f.path)) {
				problems.push(`a file has no workspace path, or its path leaves the workspace: ${JSON.stringify(f)}`);
				continue;
			}
			need(!paths.has(f.path), `file ${f.path} is listed twice`);
			paths.add(f.path);
			need(isInside(f.from) && fs.statSync(path.join(dir, f.from), { throwIfNoEntry: false })?.isFile(), `file ${f.path} comes from ${JSON.stringify(f.from)}, which is not a file in the task set folder`);
		}
	}

	// step: what the user does
	if (t.user_events !== undefined) {
		if (!Array.isArray(t.user_events)) problems.push('user_events must be a list');
		else for (const e of t.user_events) need(isObject(e) && EVENT_WHEN.has(String(e.when)) && EVENT_ACTIONS.has(String(e.action)) && isInside(e.path), `user event ${JSON.stringify(e)} needs a known when and action and a workspace path`);
	}

	// step: the checks
	const checks = Array.isArray(t.checks) ? t.checks : [];
	need(checks.length > 0, 'checks is empty');
	const ids = new Set<string>();
	for (const ck of checks) {
		if (!isObject(ck)) {
			problems.push(`a check is not an object: ${JSON.stringify(ck)}`);
			continue;
		}
		const label = `check ${isText(ck.id) ? ck.id : '(no id)'}`;
		need(isText(ck.id), 'a check has no id');
		need(!ids.has(String(ck.id)), `${label} is listed twice`);
		ids.add(String(ck.id));
		const type = String(ck.type);
		const fields = CHECK_FIELDS.get(type);
		if (!fields) {
			const why = NOT_SUPPORTED.get(type);
			problems.push(why ? `${label} has type ${type}, which ${why}, so a browser trial cannot grade it` : `${label} has unknown type ${JSON.stringify(ck.type)}`);
			continue;
		}
		for (const field of fields) need(ck[field] !== undefined && ck[field] !== null, `${label} (${type}) needs ${field}`);
		for (const key of ['regex', 'matches']) {
			if (typeof ck[key] !== 'string') continue;
			try {
				pyRegex(ck[key]);
			} catch {
				problems.push(`${label} ${key} is not a valid regex`);
			}
		}
		if (type === 'outcome') {
			const expect = Array.isArray(ck.expect) ? ck.expect : [ck.expect];
			need(expect.length > 0 && expect.every((o) => OUTCOMES.has(String(o))), `${label} expect must be one of, or a list of, ${[...OUTCOMES].join(', ')}`);
			need(ck.reason === undefined || isText(ck.reason), `${label} reason must be text: the reason the saved turn must end with, such as refused`);
		} else if (type === 'output') problems.push(...validateOutput(ck, label, t, dir));
		else if (type === 'check_app_passes') {
			need(ck.app === undefined || (isText(ck.app) && /^apps\/[^/]+$/.test(ck.app)), `${label} app must be an app folder, apps/<name>, or left out to grade the one app the turn added`);
			if (ck.use !== undefined) {
				need(ck.app !== undefined, `${label} use needs app, the folder of the app it uses`);
				problems.push(...validateUse(ck, label));
			}
		}
		else if (type === 'only_changed') need(Array.isArray(ck.globs) && ck.globs.every((g) => typeof g === 'string'), `${label} globs must be a list of globs (an empty list: nothing may change)`);
		else if (type === 'canary_absent') {
			for (const surface of Array.isArray(ck.surfaces) ? ck.surfaces : []) need(SURFACES.has(String(surface)), `${label} names unknown surface ${surface}`);
			const planted = isObject(t.canaries) ? t.canaries : {};
			for (const name of Array.isArray(ck.canaries) ? ck.canaries : []) need(name === VARIABLE_VALUES || Object.hasOwn(planted, String(name)) || MARKER.test(String(name)), `${label} canary ${name} is neither ${VARIABLE_VALUES}, a canary the task plants, nor a marker of 8 or more letters and digits`);
		}
	}
	return { id, problems };
}

/** The problems with a check_app_passes check's `use` (AppUse). */
function validateUse(ck: Record<string, unknown>, label: string): string[] {
	const u = ck.use;
	if (!isObject(u)) return [`${label} use must be { fill, click, pipeline, answer?, timeoutSec? }`];
	const problems = Object.keys(u)
		.filter((key) => !USE_FIELDS.has(key))
		.map((key) => `${label} use has unknown field ${key}`);
	if (!isText(u.fill)) problems.push(`${label} use needs fill, the text to type into the app`);
	if (!isText(u.click)) problems.push(`${label} use needs click, the name of the button to press`);
	if (!isText(u.pipeline) || !u.pipeline.startsWith(`${String(ck.app)}/`)) problems.push(`${label} use needs pipeline, a glob of the app's own pipeline file under ${String(ck.app)}/`);
	if (u.answer !== undefined) {
		let valid = typeof u.answer === 'string';
		try {
			if (valid) pyRegex(String(u.answer));
		} catch {
			valid = false;
		}
		if (!valid) problems.push(`${label} use answer must be a valid regex`);
	}
	if (u.timeoutSec !== undefined && !(Number.isInteger(u.timeoutSec) && Number(u.timeoutSec) > 0)) problems.push(`${label} use timeoutSec must be a whole number of seconds above 0`);
	return problems;
}

/**
 * Loads and validates a task set.
 *
 * @param dir - The task set folder.
 * @returns The valid tasks, and every invalid one with its problems, both sorted by id.
 */
export function loadTasks(dir: string = DATA_DIR): { tasks: Task[]; invalid: Validation[] } {
	const tasks: Task[] = [];
	const invalid: Validation[] = [];
	for (const id of taskIds(dir)) {
		const v = validateTask(id, dir);
		if (v.problems.length) invalid.push(v);
		else tasks.push(loadTask(id, dir));
	}
	return { tasks, invalid };
}
