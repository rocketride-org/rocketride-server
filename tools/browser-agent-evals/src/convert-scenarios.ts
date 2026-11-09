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
// CONVERT SCENARIOS: the 30 drafted scenarios into the task format, once
// =============================================================================

/**
 * Converts the scenarios at 51bd59d2c7 (apps/shared/src/modules/agent/eval/
 * data) into tasks/breadth/: one task file each, their fixtures unpacked into
 * fixtures/<name>/, the hand-written reference solutions into
 * references/<task id>/ (the files they add or change; references/deleted.json
 * lists the files a solution deletes), and the input files into inputs/. It reads the commit with
 * git, so the commit only has to exist in this clone.
 *
 *   node --import tsx src/convert-scenarios.ts [commit]
 *
 * What changes on the way, since a browser trial is one turn that nobody
 * answers (README.md lists each dropped check):
 *
 * - followups are dropped: the runner sends the prompt and nothing else.
 * - An ASK scenario keeps its first turn only. Its checks marked
 *   `after_turn_1` stay, along with the guards that hold for the whole
 *   trial (scope, leak, done-means-checked); the checks on the state after
 *   the follow-up answer go.
 * - no_change_tools becomes only_changed with no globs: no file in the
 *   workspace may change, which the end state shows.
 * - Other checks that read tool calls, the step count or the agent's answer
 *   (NOT_SUPPORTED in task.ts) are dropped.
 * - engine_validate becomes validates, run_output becomes output, and an
 *   outcome check's equals or any_of becomes expect. `layers` and `applies`
 *   go, since there is one layer and one turn.
 * - fixture.confirm becomes cards. The old runner answered every card deny
 *   unless confirm.default was set, and so do these tasks.
 * - expect, reference, layers, smoke and baseline are dropped: every
 *   scenario's expected outcome is already one of its outcome checks.
 * - timeLimitSec is 300, and 600 for the four app builds.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, REPO_ROOT } from './catalog';
import { NOT_SUPPORTED, type CardPolicy, type Task, type TaskCheck } from './task';

// =============================================================================
// THE OLD FORMAT (51bd59d2c7's eval/types.ts)
// =============================================================================

interface OldCheck {
	id: string;
	kind: string;
	applies?: string;
	layers?: string[];
	equals?: unknown;
	any_of?: unknown[];
	[field: string]: unknown;
}

interface OldScenario {
	id: string;
	type: Task['type'];
	target: Task['target'];
	title: string;
	prompt: string;
	reference?: { workspace?: string | null; deleted?: string[] };
	fixture: {
		workspace: string | null;
		variables: string[];
		user_events?: Task['user_events'];
		confirm?: { default?: boolean; dirty_file_prompt?: string } | null;
		canaries?: Record<string, string>;
	};
	checks: OldCheck[];
	judge?: Task['judge'];
	hard_because: string;
}

// =============================================================================
// CONVERSION
// =============================================================================

/** Where the scenario data is in the commit. */
const OLD_DATA = 'apps/shared/src/modules/agent/eval/data';

/** Kinds that take a new name. */
const RENAMED: Record<string, string> = { engine_validate: 'validates', run_output: 'output' };

/** Checks an ASK task keeps besides its first-turn checks: they hold for the whole trial. */
const WHOLE_TRIAL = new Set(['only_changed', 'canary_absent', 'done_implies_checks_pass']);

/** A check as the task format writes it: id and type first, without the fields one turn and one layer make moot. */
function convertCheck(ck: OldCheck): TaskCheck {
	const { id, kind, applies: _applies, layers: _layers, ...rest } = ck;
	if (kind === 'outcome') {
		const { equals, any_of, ...others } = rest;
		return { id, type: 'outcome', expect: any_of ?? equals, ...others };
	}
	return { id, type: RENAMED[kind] ?? kind, ...rest };
}

/**
 * The checks a scenario keeps, and the ids it drops.
 *
 * @param s - The scenario.
 * @returns The task's checks and the dropped check ids.
 */
export function convertChecks(s: OldScenario): { checks: TaskCheck[]; dropped: string[] } {
	const firstTurnOnly = s.type === 'ASK';
	const checks: TaskCheck[] = [];
	const dropped: string[] = [];
	for (const ck of s.checks) {
		if (ck.applies !== undefined && (!firstTurnOnly || ck.applies !== 'after_turn_1')) throw new Error(`${s.id}: check ${ck.id} applies ${ck.applies}, which the conversion does not know`);
		if (firstTurnOnly && ck.applies === undefined && !WHOLE_TRIAL.has(ck.kind)) dropped.push(`${ck.id} (after the follow-up)`);
		else if (ck.kind === 'no_change_tools') checks.push({ id: ck.id, type: 'only_changed', globs: [], note: 'was no_change_tools: the turn changes no file' });
		else if (NOT_SUPPORTED.has(ck.kind)) dropped.push(`${ck.id} (${ck.kind})`);
		else checks.push(convertCheck(ck));
	}
	const outcomes = checks.filter((c) => c.type === 'outcome').length;
	if (outcomes !== 1) throw new Error(`${s.id}: ${outcomes} outcome checks after conversion, wanted 1`);
	return { checks, dropped };
}

function cardsFor(confirm: OldScenario['fixture']['confirm']): CardPolicy {
	const answer = confirm?.default ? 'approve' : 'deny';
	if (!confirm?.dirty_file_prompt) return answer;
	return { default: answer, dirty_file_prompt: confirm.dirty_file_prompt as 'save_mine_first' };
}

/**
 * One scenario as a task.
 *
 * @param s - The scenario.
 * @param fixtureFiles - Its fixture's workspace paths, sorted; empty when it starts from an empty workspace.
 * @returns The task, and the ids of the checks it dropped.
 */
export function convertScenario(s: OldScenario, fixtureFiles: string[]): { task: Task; dropped: string[] } {
	const { checks, dropped } = convertChecks(s);
	const fixture = s.fixture.workspace;
	const task: Task = {
		id: s.id,
		type: s.type,
		target: s.target,
		title: s.title,
		prompt: s.prompt,
		files: fixture ? fixtureFiles.map((p) => ({ path: p, from: `${fixture}/${p}` })) : [],
		cards: cardsFor(s.fixture.confirm),
		timeLimitSec: s.type === 'BUILD' && s.target === 'app' ? 600 : 300,
		variables: s.fixture.variables,
		...(s.fixture.canaries ? { canaries: s.fixture.canaries } : {}),
		...(s.fixture.user_events ? { user_events: s.fixture.user_events } : {}),
		checks,
		judge: s.judge ?? [],
		hard_because: s.hard_because,
	};
	return { task, dropped };
}

// =============================================================================
// MAIN
// =============================================================================

function git(...args: string[]): string {
	return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

function main(): void {
	const commit = process.argv[2] ?? '51bd59d2c7';
	const listed = git('ls-tree', '-r', '--name-only', commit, `${OLD_DATA}/`).split('\n').filter(Boolean);
	const files = (sub: string) => listed.filter((f) => f.startsWith(`${OLD_DATA}/${sub}/`));
	const out = DATA_DIR;

	// step: start clean, so a rerun writes exactly what the commit holds
	for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f.endsWith('.json')) fs.rmSync(path.join(out, f));
	fs.rmSync(path.join(out, 'fixtures'), { recursive: true, force: true });
	fs.rmSync(path.join(out, 'inputs'), { recursive: true, force: true });
	fs.rmSync(path.join(out, 'references'), { recursive: true, force: true });

	const fixtures = new Map<string, string[]>();
	for (const f of files('fixtures')) {
		const name = `fixtures/${path.basename(f, '.json')}`;
		const tree = (JSON.parse(git('show', `${commit}:${f}`)) as { files: Record<string, string> }).files;
		for (const [p, text] of Object.entries(tree)) write(path.join(out, name, p), text);
		fixtures.set(name, Object.keys(tree).sort());
	}
	for (const f of files('inputs')) write(path.join(out, 'inputs', path.basename(f)), git('show', `${commit}:${f}`));
	for (const f of files('references')) {
		const tree = (JSON.parse(git('show', `${commit}:${f}`)) as { files: Record<string, string> }).files;
		for (const [p, text] of Object.entries(tree)) write(path.join(out, 'references', path.basename(f, '.json'), p), text);
	}

	const deleted: Record<string, string[]> = {};
	for (const f of files('scenarios')) {
		const s = JSON.parse(git('show', `${commit}:${f}`)) as OldScenario;
		if (s.reference?.deleted?.length) deleted[s.id] = s.reference.deleted;
		const workspace = s.fixture.workspace;
		if (workspace && !fixtures.has(workspace)) throw new Error(`${s.id}: no fixture ${workspace}`);
		const { task, dropped } = convertScenario(s, workspace ? (fixtures.get(workspace) ?? []) : []);
		write(path.join(out, `${task.id}.json`), `${JSON.stringify(task, null, '\t')}\n`);
		console.log(`${task.id}: ${task.checks.length} checks${dropped.length ? `, dropped ${dropped.join(', ')}` : ''}`);
	}
	write(path.join(out, 'references', 'deleted.json'), `${JSON.stringify(deleted, null, '\t')}\n`);
}

if (require.main === module) main();
