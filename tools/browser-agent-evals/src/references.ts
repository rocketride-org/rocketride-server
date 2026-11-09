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
// REFERENCES: the hand-written solutions, and grading a workspace without the agent
// =============================================================================

/**
 * A task set's references/<task id>/ folders hold 51bd59d2c7's hand-written
 * solutions: the files a correct turn adds or changes. references/deleted.json
 * lists the files a solution deletes. The workspace a correct solution leaves
 * is the task's starting files, the reference over them, minus what it
 * deletes (51bd59d2c7 scenarios.ts referenceTree).
 *
 * `check` grades such a workspace, or any folder, against the engine with no
 * agent and no browser: the pipelines are validated and run as after a real
 * turn, and the grade reads them as if the turn had ended done.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { RocketRideClient } from 'rocketride';

import { changedApps, checkApps } from './checks/app';
import { TrialScans } from './checks/common';
import { runOutputs, validatePipes } from './checks/pipeline';
import type { HeldKey } from './evidence';
import { gradeTrial, type TrialResult } from './grade';
import type { Task } from './task';
import type { BrowserTrialRecord } from './trial';

/** Every file under a folder, by path relative to it, with / separators. */
export function readTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
		const f = path.join(dir, rel);
		if (fs.statSync(f).isFile()) out[rel.split(path.sep).join('/')] = fs.readFileSync(f, 'utf8');
	}
	return out;
}

/** The task's starting workspace. */
export function startFiles(task: Task, tasksDir: string): Record<string, string> {
	return Object.fromEntries(task.files.map((f) => [f.path, fs.readFileSync(path.join(tasksDir, f.from), 'utf8')]));
}

/**
 * The workspace the task's reference solution leaves, or null when it has none.
 * An ASK reference is the state after a follow-up answer, which a one-turn
 * trial never reaches, so ASK tasks have none here.
 */
export function referenceWorkspace(task: Task, tasksDir: string): Record<string, string> | null {
	const dir = path.join(tasksDir, 'references', task.id);
	if (task.type === 'ASK' || !fs.existsSync(dir)) return null;
	const deletedFile = path.join(tasksDir, 'references', 'deleted.json');
	const deleted = fs.existsSync(deletedFile) ? ((JSON.parse(fs.readFileSync(deletedFile, 'utf8')) as Record<string, string[]>)[task.id] ?? []) : [];
	const final: Record<string, string> = { ...startFiles(task, tasksDir), ...readTree(dir) };
	for (const gone of deleted) delete final[gone];
	return final;
}

/**
 * A record of a turn that ended as the task expects (its outcome check's
 * first outcome and its reason, else done) with these final files: what
 * grade.ts reads, and nothing the browser would add.
 */
export function handMadeRecord(task: Task, final: Record<string, string>, model: string): BrowserTrialRecord {
	const ck = task.checks.find((c) => c.type === 'outcome');
	const outcome = String((Array.isArray(ck?.expect) ? ck.expect[0] : ck?.expect) ?? 'done');
	const result = { outcome, reason: typeof ck?.reason === 'string' ? ck.reason : outcome, files: [], checks: [], usage: { waves: 0, modelRequests: 0, toolCalls: 0 }, runsStarted: 0 };
	return {
		harness: 'browser-agent-evals check',
		layer: 'L3',
		scenario: task.id,
		prompt: task.prompt,
		trial: 1,
		startedAt: new Date().toISOString(),
		model,
		settings: {},
		engine: null,
		engineVariables: [],
		variablesMissing: [],
		scope: null,
		maxFollowups: 0,
		turns: [{ turn: 1, request: task.prompt, waves: 0, endedOnItsOwn: true, harnessStop: null, runError: null, wallMs: 0, modelCalls: [], modelErrors: [], calls: [], refusals: [], thinking: [], finalText: '', repeats: [], toolErrors: 0, gateStateWriteFailures: 0, changed: true, asked: null, finishedAfter: false, reply: null, followupKind: null, result: result as never, replies: [] }],
		approvalTurns: 0,
		retryTurns: 0,
		finished: true,
		endReason: 'turn_ended',
		totalWallMs: 0,
		totalModelMs: 0,
		tokens: null,
		costUsd: null,
		confirms: [],
		shellMissing: [],
		pipes: [],
		finalFiles: final,
		canary: {},
		runOutput: {},
		session: { saved: false, messages: 0 },
		infraError: null,
		replay: null,
		browser: { card: null, banner: null, cardMatchesOutcome: null, modelShown: null, modelKey: null, approvalMode: null, stoppedAtLimit: false, cards: [], leaks: [], keyScan: null, guides: null, appChecks: {}, appLoads: {}, previewsOpened: [], userEvents: [] },
	};
}

/**
 * Grades a workspace for a task against the engine: validates and output
 * checks run for real, the leak scans read the files (a hand-made workspace
 * has no conversation, so the other surfaces are empty).
 *
 * @param client - A connected client.
 * @param task - The task.
 * @param tasksDir - The task set folder.
 * @param final - The workspace to grade.
 * @param keys - The keys the engine holds.
 * @param engineVariables - The Variable names the engine has.
 * @param workDir - Where app checks lay apps out; removed after each.
 */
export async function checkWorkspace(client: RocketRideClient, task: Task, tasksDir: string, final: Record<string, string>, keys: HeldKey[], engineVariables: string[], workDir: string): Promise<TrialResult> {
	const start = startFiles(task, tasksDir);
	const record = handMadeRecord(task, final, 'none (hand-made workspace)');
	record.engineVariables = engineVariables;
	record.pipes = await validatePipes(client, task, start, final);
	record.runOutput = await runOutputs(client, task, start, final, engineVariables);
	const scans = new TrialScans(task, keys);
	for (const s of ['model_questions', 'thinking', 'final_text', 'session_json', 'catalog']) scans.empty(s);
	for (const text of Object.values(final)) scans.feed('workspace_files', text);
	record.canary = scans.canaryScans();
	record.browser.keyScan = scans.keyScan();
	const apps = new Set([...changedApps(start, final), ...task.checks.filter((c) => c.type === 'check_app_passes').map((c) => String(c.app))]);
	if (apps.size) record.browser.appChecks = await checkApps([...apps].sort(), final, workDir);
	return gradeTrial(task, record, { start, appChecks: record.browser.appChecks }, null);
}
