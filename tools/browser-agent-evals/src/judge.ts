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
// JUDGE: one trial's app, served from its saved workspace and judged live
// =============================================================================

/**
 * The judge command. It starts the stack as `run` does (its own store, the
 * env file's keys), loads a trial's final workspace into the store, and
 * serves the app the way a user gets it: deployed as the App Builder's
 * Deploy button does (deploy.addApp, then the engine's own build),
 * published to the signed-in user (@me), and opened at <shell>/?appid=<id>.
 * The Design preview is no use here: its frame is a blob: URL that no other
 * browser can open. After one signed-in look at the page, judgeApp uses the
 * app against the checklist, and the stack stops.
 */

import fs from 'node:fs';
import path from 'node:path';
// registers the packer that deploy.addApp loads
import 'rocketride/app-pack';

import { judgeApp, parseChecklist, type JudgeResult } from '../judge/judge.mjs';
import { REPO_ROOT } from './catalog';
import { Driver } from './driver';
import { findLeaks, heldKeys, MODEL_KEYS, Scrubber, type HeldKey } from './evidence';
import { readTree } from './references';
import { LOCAL_APIKEY, openStack, type Stack } from './stack';
import { Store } from './store';

/** The key the shell keeps its sign-in token under, which the judge's browser starts with. */
const LS_TOKEN = 'rr:user_token';

/** What the shell shows instead of an app it cannot load (packages/shell ShellLayout.tsx). */
const SHELL_LOAD_ERRORS = ['App not found', 'Could not load', 'Home app unavailable'];

/** The judge command's arguments, as given. */
export interface JudgeArgs {
	workspace: string | null;
	app: string | null;
	checklist: string | null;
	out: string;
	/** Judge sessions; null keeps judgeApp's default. */
	runs: number | null;
	/** Keep the stack's store when the judge is done (--keep-store). */
	keepStore?: boolean;
	/** A folder of files the judge may upload into the app (--inputs). */
	inputs?: string | null;
}

/** What one judge command does, checked. */
export interface JudgePlan {
	/** The trial's final workspace, absolute. */
	workspace: string;
	/** The app folder, relative to the workspace (apps/<name>). */
	app: string;
	/** The app's id, from its package.json appManifest.id. */
	appId: string;
	checklistFile: string;
	checklist: string[];
	out: string;
	runs: number | null;
	keepStore: boolean;
	/** The folder the judge may upload from, absolute; null blocks uploads. */
	inputs: string | null;
}

/**
 * Removes the stack's store under `out`, keeping the stack's logs beside it.
 * The store is the engine's working copy, about 250 MB a run, and the judge's
 * result never reads it.
 *
 * @param out - The judge's output folder.
 * @param keep - Leave the store in place (--keep-store).
 */
export function clearStore(out: string, keep: boolean): void {
	if (!keep) fs.rmSync(path.join(out, 'stack', 'store'), { recursive: true, force: true });
}

/**
 * Checks the judge command's arguments and reads what they name.
 *
 * @param args - The arguments: --workspace, --app (relative to the workspace, or inside it), --checklist, --out, --runs.
 * @returns The plan: the app's id from its package.json, and the checklist's lines.
 * @throws When an argument is missing, the app folder is outside the workspace or has no appManifest.id, or the checklist has no lines.
 */
export function judgePlan(args: JudgeArgs): JudgePlan {
	const missing = (['workspace', 'app', 'checklist'] as const).filter((k) => !args[k]).map((k) => `--${k}`);
	if (missing.length) throw new Error(`judge needs ${missing.join(', ')}`);
	const workspace = path.resolve(args.workspace as string);
	if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--workspace ${workspace} is not a folder`);
	const app = path.relative(workspace, path.resolve(workspace, args.app as string));
	if (!app || app.startsWith('..') || path.isAbsolute(app)) throw new Error(`--app ${args.app} is not a folder inside the workspace ${workspace}`);
	let appId: unknown;
	try {
		appId = (JSON.parse(fs.readFileSync(path.join(workspace, app, 'package.json'), 'utf8')) as { appManifest?: { id?: unknown } }).appManifest?.id;
	} catch (err) {
		throw new Error(`--app ${app}: no readable package.json (${err instanceof Error ? err.message : String(err)})`);
	}
	if (typeof appId !== 'string' || !appId) throw new Error(`--app ${app}: its package.json has no appManifest.id`);
	const checklistFile = path.resolve(args.checklist as string);
	const checklist = parseChecklist(fs.readFileSync(checklistFile, 'utf8'));
	if (!checklist.length) throw new Error(`--checklist ${checklistFile} has no lines`);
	const inputs = args.inputs ? path.resolve(args.inputs) : null;
	if (inputs && !fs.statSync(inputs, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--inputs ${inputs} is not a folder`);
	return { workspace, app: app.split(path.sep).join('/'), appId, checklistFile, checklist, out: path.resolve(args.out), runs: args.runs, keepStore: args.keepStore ?? false, inputs };
}

/**
 * The Anthropic key the judge's sessions run on: EVAL_ANTHROPIC_KEY from the
 * env file, which readModelKeys holds under the engine's name.
 */
export function judgeKey(modelKeys: HeldKey[]): string {
	const name = MODEL_KEYS.find((k) => k.source === 'EVAL_ANTHROPIC_KEY')?.variable;
	const key = modelKeys.find((k) => k.name === name)?.value;
	if (!key) throw new Error('no EVAL_ANTHROPIC_KEY among the model keys');
	return key;
}

/** Where the app was served from, for summary.md and result.json. */
export interface Served {
	workspace: string;
	app: string;
	appId: string;
	version: number;
	url: string;
}

const cell = (text: string) => text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

/**
 * The evidence for a line's verdict, on one line: what the judge saw in the
 * first run that decided it (a failing run, else a run that did not test the
 * line or was invalid, else the first run).
 */
function evidence(result: JudgeResult, index: number): string {
	const decided = (verdict: string) => result.runs.find((run) => run.lines[index]?.verdict === verdict);
	const line = result.lines[index];
	const run = line?.verdict === 'fail' ? decided('fail') : line?.verdict === 'inconclusive' ? (decided('not_tested') ?? result.runs.find((r) => r.invalidReason)) : result.runs[0];
	if (!run) return '';
	if (run.invalidReason) return `run ${run.run} invalid: ${cell(run.invalidReason)}`;
	return `run ${run.run}: ${cell(run.lines[index]?.saw ?? '')}`;
}

/**
 * summary.md: the verdict, where the app was served from, each run, and each
 * checklist line with its verdict and the judge's evidence.
 */
export function judgeSummary(result: JudgeResult, served: Served): string {
	const minutes = (ms: number) => `${Math.round(ms / 6000) / 10} min`;
	const out = [
		`# Judge: ${served.app}`,
		'',
		`Verdict: **${result.verdict}** over ${result.runs.length} run(s), $${result.costUsd.toFixed(2)}, ${minutes(result.runs.reduce((t, r) => t + r.durationMs, 0))}. A line fails when any run fails it. The verdict is advisory: a pass means the judge found nothing wrong.`,
		'',
		`- Workspace: \`${path.relative(REPO_ROOT, served.workspace)}\``,
		`- App: \`${served.app}\` (\`${served.appId}\`), version ${served.version}, published to @me`,
		`- URL: ${served.url}`,
		'',
		'| Run | Verdict | Cost | Time | Invalid because |',
		'| --- | --- | --- | --- | --- |',
		...result.runs.map((r) => `| ${r.run} | ${r.verdict} | ${r.costUsd === null ? '?' : `$${r.costUsd.toFixed(2)}`} | ${minutes(r.durationMs)} | ${cell(r.invalidReason ?? '')} |`),
		'',
		'| # | Line | Verdict | Runs | Evidence |',
		'| --- | --- | --- | --- | --- |',
		...result.lines.map((l, i) => `| ${l.line} | ${cell(l.text)} | ${l.verdict} | ${l.runs.map((v) => v ?? 'invalid').join(' ')} | ${evidence(result, i)} |`),
	];
	return `${out.join('\n')}\n`;
}

/**
 * Opens the URL in the runner's browser, signed in as the judge's will be,
 * and keeps a screenshot. The judge is not started on a page where the shell
 * says it could not load the app.
 *
 * @returns The shell's load error, or null when it showed none.
 */
async function lookAtApp(url: string, stack: Stack, dir: string, scrubber: Scrubber): Promise<string | null> {
	const driver = await Driver.open({ shellUrl: stack.shellUrl, devRemote: stack.devRemote, apiKey: stack.apiKey, headed: false, dir, scrubber });
	try {
		await driver.page.goto(url, { waitUntil: 'domcontentloaded' });
		await driver.page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => {});
		await driver.shot('app');
		const text = await driver.pageText();
		return SHELL_LOAD_ERRORS.find((e) => text.includes(e)) ?? null;
	} finally {
		await driver.close();
	}
}

/**
 * Runs the judge command: starts the stack, serves the app, judges it, and
 * writes result.json and summary.md to plan.out. The stack always stops.
 *
 * @returns 0 for pass, 1 for fail, 2 for inconclusive or when the app could not be served.
 */
export async function judgeCommand(plan: JudgePlan, modelKeys: HeldKey[]): Promise<number> {
	const keys = heldKeys(modelKeys);
	const scrubber = new Scrubber(keys);
	const log = (line: string) => console.log(`[eval] ${scrubber.scrub(line)}`);
	const apiKey = judgeKey(modelKeys);
	log(`judge ${plan.app} (${plan.appId}) from ${plan.workspace}, ${plan.checklist.length} checklist lines, output in ${plan.out}`);

	let stack: Stack;
	try {
		stack = await openStack({ apiKey: LOCAL_APIKEY, modelKeys, dir: path.join(plan.out, 'stack'), scrubber, log });
	} catch (err) {
		console.error(`could not start the stack: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	let code = 2;
	try {
		// step: the trial's workspace into the store, as a trial leaves it
		const store = await Store.connect(stack.engineUri, stack.apiKey);
		let served: Served;
		try {
			await store.reset();
			await store.seed(Object.entries(readTree(plan.workspace)).map(([p, text]) => ({ path: p, text })));
			// step: deploy as the Deploy button does; the engine builds it
			const added = await store.client.deploy.addApp(path.join(plan.workspace, plan.app), { workspaceRoot: plan.workspace, comment: 'browser-agent-evals judge' });
			const version = Number((added.artifact as { registryVersion?: number } | undefined)?.registryVersion);
			if (!Number.isInteger(version)) throw new Error(`deploy.add gave no registry version: ${JSON.stringify(added).slice(0, 300)}`);
			log(`deployed ${plan.appId} version ${version}; waiting for the engine's build`);
			try {
				await store.client.waitForAppBuild(plan.appId, version, { timeoutMs: 600_000 });
			} catch (err) {
				const { log: buildLog } = await store.client.buildLog(plan.appId, version).catch(() => ({ log: '' }));
				fs.writeFileSync(path.join(plan.out, 'build.log'), scrubber.scrub(buildLog));
				throw new Error(`${err instanceof Error ? err.message : String(err)}; the build log is in ${path.join(plan.out, 'build.log')}`);
			}
			// step: publish to the signed-in user, so /?appid=<id> serves it
			await store.client.publishApp(plan.appId, version, '@me');
			served = { workspace: plan.workspace, app: plan.app, appId: plan.appId, version, url: `${stack.shellUrl}/?appid=${encodeURIComponent(plan.appId)}` };
			log(`built and published to @me: ${served.url}`);
		} finally {
			await store.close();
		}

		const loadError = await lookAtApp(served.url, stack, path.join(plan.out, 'served'), scrubber);
		if (loadError) throw new Error(`the shell shows "${loadError}" at ${served.url}, so the judge did not start (screenshot in ${path.join(plan.out, 'served')})`);

		const result = await judgeApp({ url: served.url, checklist: plan.checklist, ...(plan.runs === null ? {} : { runs: plan.runs }), outDir: plan.out, localStorage: { [LS_TOKEN]: stack.apiKey }, apiKey, ...(plan.inputs ? { uploadDir: plan.inputs } : {}) });
		fs.writeFileSync(path.join(plan.out, 'result.json'), `${scrubber.scrub(JSON.stringify({ served, checklistFile: plan.checklistFile, ...result }, null, '\t'))}\n`);
		fs.writeFileSync(path.join(plan.out, 'summary.md'), scrubber.scrub(judgeSummary(result, served)));
		for (const r of result.runs) log(`run ${r.run}: ${r.verdict}, $${r.costUsd?.toFixed(3) ?? '?'}, ${Math.round(r.durationMs / 1000)}s${r.invalidReason ? `, invalid: ${r.invalidReason}` : ''}`);
		for (const l of result.lines) log(`line ${l.line}: ${l.verdict} (${l.runs.map((v) => v ?? 'invalid').join(' ')})`);
		log(`verdict: ${result.verdict}, $${result.costUsd.toFixed(3)} over ${result.runs.length} run(s); ${path.join(plan.out, 'summary.md')}`);
		code = { pass: 0, fail: 1, inconclusive: 2 }[result.verdict];
	} catch (err) {
		console.error(`judge: ${scrubber.scrub(err instanceof Error ? err.message : String(err))}`);
	} finally {
		await stack.stop();
		clearStore(plan.out, plan.keepStore);
	}
	const leaks = findLeaks(plan.out, keys);
	if (leaks.length) {
		log(`a held key is in the output: ${leaks.map((l) => `${l.key} in ${l.file}`).join(', ')}`);
		return 2;
	}
	return code;
}
