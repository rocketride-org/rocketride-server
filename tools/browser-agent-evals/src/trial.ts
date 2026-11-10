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
// TRIAL: one task, once, in the browser
// =============================================================================

/**
 * The six steps: reset the store and write the task's files, open the Agent
 * tab and pick the model, send the prompt, answer cards by the task's
 * policy, wait for the turn's result up to the time limit, then save the
 * traffic and the final files and write the TrialRecord.
 *
 * The outcome comes from the turn the chat saved in its session file, and
 * the page's "Turn result" card is kept beside it; record.json says whether
 * they agree. A missing model key ends the trial as an environment failure
 * (endReason "environment"), not an agent failure.
 *
 * Trial folder:
 *   record.json     the TrialRecord, plus `browser` (what the page showed)
 *   trace.jsonl     WebSocket frames both ways and a line per HTTP request
 *   console.log     the page's console
 *   steps.log       what the runner did, step by step
 *   transcript.txt  the page's text at the end
 *   session.json    the saved conversation, as the chat wrote it
 *   final/          the workspace's files at the end
 *   NN-<step>.png and .aria.txt, a screenshot and accessibility tree per step
 *
 * Every file is scrubbed of the held keys, and the trial ends by scanning its
 * folder for them.
 */

import fs from 'node:fs';
import path from 'node:path';

import { appsToCheck, checkApps, withLoads, withSteps, type AppCheckResult } from './checks/app';
import { appPipelines, pipelineRuns, runVerdict, withRuns, type AppRun, type RunSeen } from './checks/appRun';
import { TrialScans, type KeyScan } from './checks/common';
import { runOutputs, validatePipes } from './checks/pipeline';
import { Driver, modelTitles, outcomeOfCard, type AppLoad, type ModelPick, type TurnRun } from './driver';
import { findLeaks, type HeldKey, type Scrubber } from './evidence';
import { gradeTrial, type TrialResult } from './grade';
import { guideReads, type GuideReads } from './guides';
import type { Stack } from './stack';
import { Store, storePath, type AgentLimits, type SavedSession, type SavedTurn } from './store';
import { pyRegex } from './score';
import type { AppUse, Task, UserEvent } from './task';
import type { TrialRecord, TurnRecord, TurnResultRecord } from './types';

/** Why the trial ended, beyond the turn's own outcome. */
export type EndReason = 'turn_ended' | 'time_limit' | 'environment' | 'runner_error' | 'not_supported';

/** What the page showed, which the TrialRecord has no field for. */
export interface BrowserTrial {
	/** The last "Turn result" card: title and text. */
	card: { title: string; text: string } | null;
	/** The error banner the turn ended on when it got no card (a turn that threw, such as a refused pasted key). */
	banner: string | null;
	/** Whether the card's title stands for the saved turn's outcome (turn.ts turnCard), or null when either is missing. */
	cardMatchesOutcome: boolean | null;
	/** The model the picker showed after the pick. */
	modelShown: string | null;
	/** The picker's key state for the provider. */
	modelKey: 'set' | 'missing' | null;
	/** The agent's approval mode during the turn, as its switch shows it. */
	approvalMode: string | null;
	stoppedAtLimit: boolean;
	/** The cards answered, in order, with their detail. */
	cards: TurnRun['cards'];
	/** Files under the trial folder where a held key turned up (names only). Empty, or the trial's evidence is unsafe. */
	leaks: Array<{ file: string; key: string }>;
	/** keys-not-leaked: where the raw scan for the engine's keys looked, and what it found (grade.ts). */
	keyScan: KeyScan | null;
	/** The guides the agent read, from the saved session's thinking rows (guides.ts). */
	guides: GuideReads | null;
	/** The Design previews the runner opened, as a user watching would: each starting app's before the session, each new app's during the turn. */
	previewsOpened: PreviewOpened[];
	/** The runner's own type-check and build of each app the grade reads (checks/app.ts), by app folder. */
	appChecks: Record<string, AppCheckResult>;
	/** Each app with an open preview, loaded from the final files after the turn (Driver.appLoad), by app folder. */
	appLoads: Record<string, AppLoad>;
	/** Each app a check_app_passes check uses, after its load: what the runner did in it and what the engine ran (checks/appRun.ts), by app folder. */
	appRuns: Record<string, AppRun>;
	/** What the runner did as the user, from the task's user_events, in order. */
	userEvents: Array<{ when: UserEvent['when']; action: UserEvent['action']; path: string; done: boolean; detail: string }>;
	/** Rocket Builder's workspace file after the turn (Store.agentSettings): its settings, and whether the page saved it, which shows the page loaded the limits the record's `settings` hold. Null when there was no file. */
	agentSettingsAfter: { settings: Record<string, unknown>; savedByPage: boolean } | null;
}

export type BrowserTrialRecord = TrialRecord & { endReason: EndReason; browser: BrowserTrial };

/** One Design preview the runner opened, or tried to. */
export interface PreviewOpened {
	/** The app folder's name (apps/<name>). */
	app: string;
	when: 'before the session' | 'during the turn';
	/** When it was ready, in seconds after the prompt was sent; null before the session or when it failed. */
	atSec: number | null;
	/** Why it did not open; absent when it did. */
	error?: string;
}

export interface TrialOptions {
	task: Task;
	/** The task set folder, which task.files[].from is relative to. */
	tasksDir: string;
	trial: number;
	model: ModelPick;
	stack: Stack;
	/** The trial's folder. */
	dir: string;
	headed: boolean;
	/** Keep each app's Design preview open, as a user watching would: each app the task starts with before the session, and each app the agent creates as soon as its package.json names it. Off (--no-preview), check_app cannot build (task 1.2). */
	previews: boolean;
	/** The agent's limits to set before the page opens, or null to leave the product's defaults. */
	limits: AgentLimits | null;
	/** Every key the runner holds: what the evidence must not contain (the engine's keys and the account's API key). */
	keys: HeldKey[];
	/** The keys the engine holds: keys-not-leaked looks for these. The account's API key is not one; the page sends it to sign in. */
	engineKeys: HeldKey[];
	scrubber: Scrubber;
}

/**
 * Runs one trial, grades it, and writes its folder.
 *
 * @returns The record, as written to record.json, and its grade, as written to result.json.
 */
export async function runTrial(opts: TrialOptions): Promise<{ record: BrowserTrialRecord; result: TrialResult }> {
	const { task, dir } = opts;
	fs.mkdirSync(dir, { recursive: true });
	const scrubber = opts.scrubber.keeping(Object.values(task.canaries ?? {}));
	const t0 = Date.now();
	const record = emptyRecord(opts);
	const browser = record.browser;
	const steps = (action: string, result: string) => fs.appendFileSync(path.join(dir, 'steps.log'), `${new Date().toISOString()}  ${action}  ->  ${scrubber.scrub(result)}\n`);
	const start: Record<string, string> = Object.fromEntries(task.files.map((f) => [f.path, fs.readFileSync(path.join(opts.tasksDir, f.from), 'utf8')]));
	// the leak scans read the raw text; values never leave this process
	const scans = new TrialScans(task, opts.engineKeys);
	let store: Store | null = null;
	let driver: Driver | null = null;
	let rawFinal: Record<string, string> | null = null;

	try {
		const unsupported = (task.user_events ?? []).filter((e) => !supportedEvent(e));
		if (unsupported.length) {
			record.endReason = 'not_supported';
			record.infraError = `the task scripts what the user does during the turn (user_events: ${unsupported.map((e) => `${e.action} at ${e.when}`).join(', ')}), which the browser driver does not do yet`;
		} else {
			// step 1: an empty store, then the task's files
			store = await Store.connect(opts.stack.engineUri, opts.stack.apiKey);
			record.scope = { kind: store.prefix ? 'team' : 'user', prefix: store.prefix };
			record.engineVariables = await store.variableNames();
			record.variablesMissing = task.variables.filter((v) => !record.engineVariables.includes(v));
			await store.reset();
			await store.seed(Object.entries(start).map(([p, text]) => ({ path: p, text })));
			steps('reset the store and write the task files', `${task.files.length} files: ${task.files.map((f) => f.path).join(', ') || 'none'}`);
			// step: the agent's limits, in Rocket Builder's settings before the page loads them
			if (opts.limits) {
				record.settings = await store.setAgentLimits(opts.limits);
				steps('set the agent limits', JSON.stringify(record.settings));
			}
			const variable = modelTitles(opts.model).variable;
			if (!record.engineVariables.includes(variable)) steps('engine variables', `no ${variable}: the picker will say the key is missing`);

			// step 2: the Agent tab, a new session, the model
			// step: a save timed between the agent's freshness check and its write holds that write (edit-05)
			const midWrite = (task.user_events ?? []).find((e) => e.when === 'between_freshness_check_and_write');
			const live = store;
			const holdWrite = midWrite ? { storePath: storePath(live.prefix, midWrite.path), during: () => userSave(live, midWrite) } : undefined;
			driver = await Driver.open({ shellUrl: opts.stack.shellUrl, devRemote: opts.stack.devRemote, apiKey: opts.stack.apiKey, headed: opts.headed, dir, scrubber, observe: (surface, text) => scans.feed(surface, text), holdWrite });
			await driver.openApp();
			// the app folders with a preview open, or one that failed to open; neither is tried again
			const previewed = new Set<string>();
			if (opts.previews) {
				for (const p of Object.keys(start).filter((f) => /^apps\/[^/]+\/package\.json$/.test(f))) {
					const app = p.split('/')[1] ?? p;
					previewed.add(path.dirname(p));
					try {
						const name = (JSON.parse(start[p]) as { appManifest?: { name?: string } }).appManifest?.name;
						if (!name) throw new Error(`${p} has no appManifest.name to find the app by`);
						await driver.openDesignPreview(name);
						browser.previewsOpened.push({ app, when: 'before the session', atSec: null });
					} catch (err) {
						// step: the turn still runs; check_app will say the preview is closed
						const error = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
						browser.previewsOpened.push({ app, when: 'before the session', atSec: null, error });
						steps(`open the ${app} Design preview`, `failed: ${error}`);
						await driver.shot('preview-failed');
					}
				}
			}
			// step: what the user has done before asking (an unsaved edit), then a new chat in front of it
			for (const e of (task.user_events ?? []).filter((x) => x.when === 'start')) {
				await driver.openFile(e.path);
				await driver.replaceUnsaved(e.path, e.replace ?? {});
				browser.userEvents.push({ when: e.when, action: e.action, path: e.path, done: true, detail: `${Object.keys(e.replace ?? {}).length} replacement(s), left unsaved` });
			}
			await driver.newSession();
			browser.approvalMode = await driver.askFirst();
			const picked = await driver.pickModel(opts.model);
			browser.modelShown = picked.shown;
			browser.modelKey = picked.key;
			if (picked.key === 'missing') {
				record.endReason = 'environment';
				record.infraError = `the model picker says the ${opts.model.provider} key is missing (${variable} is not among the engine's variables), so no turn ran`;
			} else {
				// steps 3 to 5: the prompt, the cards, the turn's end
				await driver.send(task.prompt);
				const during = opts.previews ? newAppPreviews(store, driver, previewed, browser.previewsOpened, steps) : undefined;
				const run = await driver.runTurn(task.cards, task.timeLimitSec * 1000, during);
				if (midWrite) browser.userEvents.push({ when: midWrite.when, action: midWrite.action, path: midWrite.path, done: driver.heldWrite !== null && !driver.heldWrite.detail.startsWith('failed'), detail: driver.heldWrite ? `held the agent's write ${driver.heldWrite.ms} ms: ${driver.heldWrite.detail}` : 'the agent never wrote the file, so there was no write to hold' });
				// step: what the user does when the turn is over (save a buffer that is still unsaved)
				for (const e of (task.user_events ?? []).filter((x) => x.when === 'episode_end')) {
					const saved = await driver.saveIfUnsaved(e.path);
					browser.userEvents.push({ when: e.when, action: e.action, path: e.path, done: saved, detail: saved ? 'it was unsaved; saved it' : 'nothing unsaved to save' });
				}
				// step: each app whose preview is open, loaded from the final files (task 3.2's load check)
				const folders = await store.appFolders();
				for (const p of browser.previewsOpened.filter((x) => !x.error && folders.includes(`apps/${x.app}`))) {
					const folder = `apps/${p.app}`;
					if (browser.appLoads[folder]) continue;
					const name = (await store.appName(folder)) ?? p.app;
					browser.appLoads[folder] = await driver.appLoad(name).catch((err: unknown): AppLoad => {
						const detail = `not read: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`;
						steps(`load ${name} in its Design preview`, detail);
						return { ok: null, detail, errors: [], crashed: false };
					});
				}
				// step: each app a check uses, after its load: type, press, and read the engine's tasks of its own pipeline (task 3.2's run check)
				const uses = task.checks.filter((c) => c.type === 'check_app_passes' && c.use !== undefined);
				const files = uses.length ? await store.readWorkspace() : {};
				for (const ck of uses) {
					const folder = String(ck.app);
					if (browser.appRuns[folder]) continue;
					browser.appRuns[folder] = await useApp(store, driver, folder, ck.use as AppUse, files, browser.appLoads[folder], steps);
				}
				browser.card = run.card;
				browser.banner = run.banner ?? null;
				browser.stoppedAtLimit = run.stoppedAtLimit;
				browser.cards = run.cards;
				record.confirms = run.cards.map((c) => ({ title: c.title, answer: c.answer }));
				record.endReason = run.stoppedAtLimit ? 'time_limit' : 'turn_ended';

				// step 6: the saved turn, the final files, and what the engine says about them
				const saved = await store.newestSession(1);
				if (saved) fs.writeFileSync(path.join(dir, 'session.json'), scrubber.scrub(saved.text));
				record.session = { saved: saved !== null, messages: saved?.session.messages.length ?? 0, ...(saved ? {} : { error: 'no session file was saved' }) };
				const turn = saved?.session.turns?.at(-1) ?? null;
				record.turns = [turnRecord(task, run, turn, saved?.session ?? null)];
				const outcome = turn?.outcome ?? null;
				browser.cardMatchesOutcome = outcome && run.card ? cardMatches(run.card.title, outcome) : null;
				record.finished = run.ended && !run.stoppedAtLimit;
				record.tokens = turn?.usage.tokens ? { input: turn.usage.tokens.input, output: turn.usage.tokens.output, cacheRead: 0, cacheWrite: 0 } : null;
				record.costUsd = turn?.usage.cost?.usd ?? null;
				if (saved?.session.model && (saved.session.model.provider !== opts.model.provider || saved.session.model.model !== opts.model.model)) {
					record.infraError = `the saved session's model is ${saved.session.model.provider}/${saved.session.model.model}, not the ${opts.model.provider}/${opts.model.model} the runner picked`;
				}

				// the surfaces the canary checks read, raw
				scans.empty('model_questions');
				if (saved) {
					scans.feed('session_json', saved.text);
					const thinking = saved.session.messages.filter((m) => m.sseType === 'thinking').map((m) => m.text);
					scans.feed('thinking', thinking.join('\n'));
					browser.guides = guideReads(thinking);
					scans.feed('final_text', turn?.finalText ?? '');
				} else for (const s of ['session_json', 'thinking', 'final_text']) scans.unreadable(s, 'no session file was saved');
				const catalog = await store.catalogText();
				if (catalog === null) scans.unreadable('catalog', 'no catalog file');
				else scans.feed('catalog', catalog);
				scans.feed('page_text', await driver.pageText());

				browser.agentSettingsAfter = await store.agentSettings();
				rawFinal = await store.readWorkspace();
				record.pipes = await validatePipes(store.client, task, start, rawFinal);
				record.runOutput = await runOutputs(store.client, task, start, rawFinal, record.engineVariables);
				steps('engine checks', `validated ${record.pipes.length} pipeline(s), ran ${Object.keys(record.runOutput).length} output check(s)`);
			}
		}
	} catch (err) {
		record.endReason = 'runner_error';
		record.infraError = scrubber.scrub(err instanceof Error ? (err.message.split('\n')[0] ?? String(err)) : String(err));
		steps('runner error', record.infraError);
		await driver?.shot('error');
	} finally {
		if (driver) {
			fs.writeFileSync(path.join(dir, 'transcript.txt'), `${await driver.transcript()}\n`);
			await driver.close();
		}
		if (store) {
			try {
				rawFinal ??= await store.readWorkspace();
			} catch (err) {
				record.infraError ??= `could not read the final files: ${err instanceof Error ? err.message : String(err)}`;
			}
			await store.close().catch(() => {});
		}
	}

	// the final files: scanned raw, saved and kept in the record scrubbed
	const final = rawFinal ?? {};
	if (Object.keys(final).length) for (const text of Object.values(final)) scans.feed('workspace_files', text);
	else scans.empty('workspace_files');
	for (const [p, text] of Object.entries(final)) {
		const file = path.join(dir, 'final', p);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, scrubber.scrub(text));
	}
	record.finalFiles = Object.fromEntries(Object.entries(final).map(([p, text]) => [p, scrubber.scrub(text)]));
	record.canary = scans.canaryScans();
	browser.keyScan = scans.keyScan();
	// the apps the grade reads: every app folder the turn changed, and every one a check grades (the one it names, or the one the turn added)
	const apps = appsToCheck(task.checks, start, final);
	if (apps.length) {
		browser.appChecks = await checkApps(apps, final, path.join(dir, 'app-check'));
		withLoads(browser.appChecks, browser.appLoads);
		withSteps(browser.appChecks, record.turns.at(-1)?.result?.checks ?? null, final);
		withRuns(browser.appChecks, browser.appRuns);
		steps(
			'app checks',
			Object.entries(browser.appChecks)
				.map(([app, r]) => `${app}: ${r.ok ? 'pass' : `FAIL ${r.detail.slice(0, 120)}`}`)
				.join('; ')
		);
	}
	record.totalWallMs = Date.now() - t0;
	writeRecord(dir, record, scrubber);

	// step: the folder must not hold a key; if it does, say where, by name
	browser.leaks = findLeaks(dir, opts.keys);
	if (browser.leaks.length) {
		record.infraError = `a held key is in the trial folder: ${browser.leaks.map((l) => `${l.key} in ${l.file}`).join(', ')}`;
		writeRecord(dir, record, scrubber);
	}
	const result = gradeTrial(task, record, { start, appChecks: browser.appChecks }, path.join(dir, 'record.json'));
	fs.writeFileSync(path.join(dir, 'result.json'), `${scrubber.scrub(JSON.stringify(result, null, '\t'))}\n`);
	return { record, result };
}

/** How often the store is read for a new app during the turn. */
const APP_POLL_MS = 1000;

/**
 * Uses one app for its check_app_passes check and reads what the engine ran
 * (checks/appRun.ts). An app whose preview was not loaded is not used: its
 * run is not read (null) when the preview was never open, and not tried when
 * the load failed, since that already fails the check. A use or engine read
 * that throws fails the run, keeping a failure already seen.
 */
async function useApp(store: Store, driver: Driver, folder: string, use: AppUse, files: Record<string, string>, load: AppLoad | undefined, steps: (action: string, result: string) => void): Promise<AppRun> {
	const pipelines = appPipelines(files, use.pipeline);
	const notUsed = (why: string): AppRun => ({ ok: null, detail: `run not read: ${why}`, used: { done: false, answered: null, detail: why, excerpt: '' }, pipelines, runs: [] });
	if (!load) return notUsed("the app's Design preview was not open");
	if (load.ok === false) return notUsed('the app did not load');
	const ids = new Set(pipelines.map((p) => p.projectId));
	const engine = (): Promise<Map<string, RunSeen>> => pipelineRuns(store.client, ids);
	let verdict: AppRun | null = null;
	try {
		const before = await engine();
		const name = (await store.appName(folder)) ?? folder.slice('apps/'.length);
		const used = await driver.useApp(name, use, use.answer ? pyRegex(use.answer) : null, (use.timeoutSec ?? 120) * 1000);
		// step: the engine's status can trail the page by a moment, so read it until it says the use ran, for up to 10 s
		verdict = runVerdict(used, pipelines, before, await engine(), use.pipeline);
		for (let i = 0; i < 10 && used.done && verdict.ok === false && pipelines.length > 0; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			verdict = runVerdict(used, pipelines, before, await engine(), use.pipeline);
		}
	} catch (err) {
		const why = `the app could not be used, or the engine's tasks could not be read: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`;
		verdict = verdict ? { ...verdict, detail: `${verdict.detail}; then ${why}` } : { ...notUsed(why), ok: false, detail: `run: ${why}` };
	}
	steps(`use ${folder} and read its pipeline's tasks`, verdict.detail);
	return verdict;
}

/**
 * The during-turn step that opens a new app's Design preview as soon as the
 * agent has written the app's package.json, as a user watching would, then
 * goes back to the Agent view. The agent's check_app builds only while a
 * preview is open (task 1.1). A preview that fails to open is recorded and
 * not tried again; the turn goes on.
 *
 * @param previewed - The app folders already open or tried; added to.
 * @param opened - The record's list; each attempt is added.
 */
function newAppPreviews(store: Store, driver: Driver, previewed: Set<string>, opened: PreviewOpened[], steps: (action: string, result: string) => void): (deadline: number) => Promise<boolean> {
	const sent = Date.now();
	let next = 0;
	return async (deadline) => {
		if (Date.now() < next) return false;
		next = Date.now() + APP_POLL_MS;
		for (const folder of await store.appFolders()) {
			if (previewed.has(folder)) continue;
			const name = await store.appName(folder);
			if (!name) continue;
			previewed.add(folder);
			const app = folder.split('/')[1] ?? folder;
			try {
				await driver.openDesignPreview(name, Math.max(1, deadline - Date.now()));
				opened.push({ app, when: 'during the turn', atSec: Math.round((Date.now() - sent) / 1000) });
			} catch (err) {
				const error = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
				opened.push({ app, when: 'during the turn', atSec: null, error });
				steps(`open the ${name} Design preview`, `failed: ${error}`);
				if (Date.now() < deadline) await driver.shot('preview-failed', deadline - Date.now());
			}
			// step: back to the chat even past the deadline: its Stop button is how the runner ends the turn
			await driver.showAgent();
			await driver.showChat();
			return true;
		}
		return false;
	};
}

/** Whether a "Turn result" card title stands for an outcome (turn.ts turnCard). */
export function cardMatches(title: string, outcome: string): boolean {
	const shown = outcomeOfCard(title);
	return shown === 'failed_or_incomplete' ? outcome === 'failed' || outcome === 'incomplete' : shown === outcome;
}

function writeRecord(dir: string, record: BrowserTrialRecord, scrubber: Scrubber): void {
	fs.writeFileSync(path.join(dir, 'record.json'), `${scrubber.scrub(JSON.stringify(record, null, '\t'))}\n`);
}

function emptyRecord(opts: TrialOptions): BrowserTrialRecord {
	return {
		harness: 'browser-agent-evals',
		layer: 'L3',
		scenario: opts.task.id,
		prompt: opts.task.prompt,
		trial: opts.trial,
		startedAt: new Date().toISOString(),
		model: `${opts.model.provider}/${opts.model.model}`,
		settings: {},
		engine: opts.stack.engine,
		engineVariables: [],
		variablesMissing: [],
		scope: null,
		maxFollowups: 0,
		turns: [],
		approvalTurns: 0,
		retryTurns: 0,
		finished: false,
		endReason: 'runner_error',
		totalWallMs: 0,
		totalModelMs: 0,
		tokens: null,
		costUsd: null,
		confirms: [],
		shellMissing: [],
		pipes: [],
		finalFiles: {},
		canary: {},
		runOutput: {},
		session: { saved: false, messages: 0 },
		infraError: null,
		replay: null,
		browser: { card: null, banner: null, cardMatchesOutcome: null, modelShown: null, modelKey: null, approvalMode: null, stoppedAtLimit: false, cards: [], leaks: [], keyScan: null, guides: null, appChecks: {}, appLoads: {}, appRuns: {}, previewsOpened: [], userEvents: [], agentSettingsAfter: null },
	};
}

/**
 * Whether the browser driver can do a task's user event: an unsaved edit
 * before the prompt, and saving a still-unsaved buffer when the turn is over.
 * A save timed between the agent's freshness check and its write is not
 * supported yet.
 */
export function supportedEvent(e: UserEvent): boolean {
	return (e.when === 'start' && e.action === 'dirty_buffer' && Object.keys(e.replace ?? {}).length > 0) || (e.when === 'episode_end' && e.action === 'save_buffer_if_dirty') || (e.when === 'between_freshness_check_and_write' && e.action === 'save' && Object.keys(e.set_pointer ?? {}).length > 0);
}

/**
 * The user's save of a pipeline, written to the store the moment the
 * agent's write is held: the file as it is now, with each set_pointer value
 * set. A browser run approximates the race this way. The user saves through
 * the runner's own client, not through the canvas.
 */
async function userSave(store: Store, e: UserEvent): Promise<string> {
	const at = storePath(store.prefix, e.path);
	const doc = JSON.parse(await store.client.fsReadString(at)) as unknown;
	for (const [pointer, value] of Object.entries(e.set_pointer ?? {})) setPointer(doc, pointer, value);
	await store.client.fsWriteString(at, `${JSON.stringify(doc, null, '\t')}\n`);
	return `saved the user's change to ${e.path} (${Object.keys(e.set_pointer ?? {}).join(', ')})`;
}

/** Sets the value at a JSON pointer (RFC 6901, without the leading slash, as tasks write it); every step but the last must exist. */
export function setPointer(doc: unknown, pointer: string, value: unknown): void {
	const parts = pointer
		.replace(/^\//, '')
		.split('/')
		.map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
	const last = parts.pop();
	let at = doc as Record<string, unknown>;
	for (const part of parts) {
		const next = at?.[part];
		if (next === null || typeof next !== 'object') throw new Error(`no ${part} on the way to ${pointer}`);
		at = next as Record<string, unknown>;
	}
	if (last === undefined || at === null || typeof at !== 'object') throw new Error(`cannot set ${pointer}`);
	at[last] = value;
}

/**
 * The one turn, as #2885's TurnRecord has it. The browser sees no tool
 * calls, model calls or thinking, so those stay empty; the result is the
 * turn the chat saved.
 */
function turnRecord(task: Task, run: TurnRun, turn: SavedTurn | null, session: SavedSession | null): TurnRecord {
	const row = turn ? session?.messages.find((m) => m.id === turn.messageId) : undefined;
	let result: TurnResultRecord | null = null;
	if (turn) {
		const { turnId: _turnId, messageId: _messageId, finalText: _finalText, runsStarted, ...rest } = turn;
		result = { ...(rest as unknown as Omit<TurnResultRecord, 'runsStarted'>), runsStarted: runsStarted?.length ?? 0 };
	}
	return {
		turn: 1,
		request: task.prompt,
		waves: turn?.usage.waves ?? 0,
		endedOnItsOwn: run.ended && !run.stoppedAtLimit,
		harnessStop: run.stoppedAtLimit ? 'time' : null,
		runError: turn?.error ?? null,
		wallMs: run.ms,
		modelCalls: [],
		modelErrors: [],
		calls: [],
		refusals: [],
		thinking: [],
		finalText: turn?.finalText ?? row?.text ?? '',
		repeats: [],
		toolErrors: 0,
		gateStateWriteFailures: 0,
		changed: (turn?.files.length ?? 0) > 0,
		asked: turn?.outcome === 'needs_input' ? { rule: turn.reason, options: Array.isArray(turn.request?.choices) } : null,
		finishedAfter: false,
		reply: null,
		followupKind: null,
		result,
		replies: [],
	};
}
