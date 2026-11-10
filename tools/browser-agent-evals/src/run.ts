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
// RUN: the browser-agent:eval command line
// =============================================================================

/**
 * `./builder browser-agent:eval` runs this file with the arguments in
 * EVAL_ARGS: `validate` checks a task set, `run` runs its tasks in a browser
 * against the local dev stack (stack.ts) or a running one (--url).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, REPO_ROOT } from './catalog';
import { modelTitles, parseModel, type ModelPick } from './driver';
import { findLeaks, heldKeys, readModelKeys, Scrubber, type HeldKey } from './evidence';
import { erroredTrial, type TrialResult } from './grade';
import { freeGb, stopReason, type Guards } from './guards';
import { LOCAL_APIKEY, MAX_SLOTS, openStack, slotPlan, type Stack, type StackOptions } from './stack';
import { agentSettingsFile, Store, type AgentLimits } from './store';
import { loadTasks, type Task } from './task';
import { writeRunReport } from './report';
import { findResults, mergeResults } from './merge';
import { buildResults, spentUsd, writeResults, type ResultsFile, type Schedule } from './results';
import { checkWorkspace, readTree, referenceWorkspace } from './references';
import { judgeCommand, judgePlan } from './judge';
import { causeOf } from './cause';
import { roundOrder, runSchedule, runTrials, type Job } from './schedule';
import { SMOKE_MODELS, smokeModels, smokeTable } from './smoke-models';
import { runTrial } from './trial';

const DEFAULT_MODEL = 'anthropic/claude-haiku-5-5';

/** The env file the model keys come from: .env.local two folders above the checkout, beside the worktrees folder. */
const DEFAULT_ENV_FILE = path.resolve(REPO_ROOT, '..', '..', '.env.local');

/** No trial starts with less free disk than this, in GB. */
const DEFAULT_MIN_FREE_GB = 3;

const USAGE = `Usage: EVAL_ARGS="<command> [options]" ./builder browser-agent:eval
   or: node --import tsx src/run.ts <command> [options]   (from tools/browser-agent-evals)

Commands:
  validate        Load every task in the task set and report each problem.
                  Exits 1 when any task is invalid. Prints a table of the
                  valid tasks with --table.
  run             Run the tasks in Rocket Builder's Agent tab in a browser:
                  one prompt, cards answered by the task's policy, the turn
                  stopped at its time limit. Starts the engine (dist/server)
                  and the two dev servers unless --url names a running stack.
                  The model keys come from the env file (--env-file) and go
                  to the engine only.
  check           Grade a hand-made workspace for each picked task with no
                  agent: the engine (started alone) validates and runs its
                  pipelines, and every check reads it as if the turn had
                  ended done. --workspace <dir> grades that folder; by
                  default each task's reference solution.
  stack           Start the local stack (engine, rocket-ui dev remote, shell
                  dev server) and keep it up until Ctrl-C; run --url
                  <its shell URL> --allow-wipe uses it. With --slots n,
                  starts n stacks side by side and prints each shell URL.
  judge           Serve one trial's app from its saved workspace and judge
                  it live (judge/README.md): start the stack, load
                  --workspace into its store, deploy and build --app as
                  the Deploy button does, publish it to the signed-in
                  user, open <shell>/?appid=<id>, and run judgeApp on
                  --checklist. Writes result.json, summary.md and each
                  judge session's transcript to --out, then stops the
                  stack. The judge's claude sessions run on
                  EVAL_ANTHROPIC_KEY alone. Exits 0 pass, 1 fail,
                  2 inconclusive or not served.
  smoke           Ask each model one question the way the Agent tab does
                  (task 0.2), on the engine alone. Prints a table: model,
                  answered, seconds, whether the engine lists the key name.
  merge           Write one results.json and report.md for a batch that ran
                  as many small runs (one task per fresh stack): every
                  results.json under --out, each task's trials renumbered in
                  the order they started and scored as one --trials run.
                  Needs --out <batch folder> and --trials <n>. Lists the
                  trial folders no results.json names.

Options:
  --env-file <file>
                  run, check, judge, stack, smoke: where the model keys are
                  read from (default: ${DEFAULT_ENV_FILE}). Only
                  EVAL_ANTHROPIC_KEY and EVAL_OPENAI_KEY are read, and both
                  must be set; they become the engine's
                  ROCKETRIDE_ANTHROPIC_KEY and ROCKETRIDE_OPENAI_KEY, and
                  judge's sessions get EVAL_ANTHROPIC_KEY as
                  ANTHROPIC_API_KEY. No process gets a model key from the
                  shell's environment.
  --tasks <dir>   The task set folder (default: tasks/breadth).
  --task <ids>    Only tasks whose id contains one of these, comma-separated.
                  ./builder's --pattern=<id> sets it.
  --table         validate: print the tasks as a Markdown table.
  --model <p/m>   run: provider/model to pick (default: ${DEFAULT_MODEL}).
  --url <url>     run: use the shell at this URL instead of starting a stack.
                  Needs --allow-wipe.
  --apikey-env <name>
                  run: the environment variable holding the API key the page
                  signs in with (default: RR_EVAL_APIKEY with --url when it is
                  set, else the local engine's ${LOCAL_APIKEY}).
  --allow-wipe    run: allow --url. Every trial empties the workspace, the
                  agent sessions and the saved layouts of the API key's
                  account on that stack, local or not. A stack the stack
                  command started is safe to empty; a dev stack holds your
                  own work.
  --out <dir>     run: where trial folders go (default: .verify/browser-agent/<time>).
  --reruns <n>    run: how many times to rerun a task whose first run failed
                  (default: 2). Flaky: a rerun passed. Failing: every run failed.
  --step-limit <n>
                  run: the agent's step limit per turn, set in Rocket
                  Builder's settings before every trial (0: no limit).
                  Without it the product's default applies.
  --cost-limit <usd>
                  run: the agent's estimated cost limit per turn, in US
                  dollars, set the same way (0: no limit).
  --trials <n>    run: every task exactly n times, pass or fail, in rounds
                  (every task once, then every task again), with no reruns
                  of failures. Within a round: real-* tasks, then app tasks,
                  then the rest. A trial that ends error is retried once as
                  a new trial (retryOf), added to the end of the queue when
                  it ends. The report shows k of n per task. Without it,
                  --reruns applies.
  --slots <n>     run, stack: n whole stacks side by side (1 to ${MAX_SLOTS},
                  default 1), each with its own ports, engine clone, store,
                  dev configs and browser. They take trials from one queue,
                  in the --trials order; an error's retry joins the queue
                  when the error ends. A slot whose stack fails to start or
                  dies takes no more trials, and its running trial ends as
                  an error and is retried. Needs --trials, and no --url.
                  Slot 0 keeps 5565, 3010 and 3000; slot k uses 5600+10k
                  (engine), 3100+10k (shell) and 3101+10k (rocket-ui).
  --max-spend <usd>
                  run: before each trial starts, stop starting trials once
                  the finished trials' estimated cost is at or over this.
                  Running trials finish; results.json and report.md say
                  the batch stopped at the spend cap. Default: no cap.
  --min-free-disk <GB>
                  run: the same, once the output folder's disk has less
                  than this free (default: ${DEFAULT_MIN_FREE_GB}).
  --headed        run: show the browser.
  --no-preview    run: leave every Design preview closed. By default the
                  runner opens each app's preview as a user watching would:
                  each app the task starts with before the session, and each
                  app the agent creates as soon as it is written.
  --workspace <dir>
                  check: the workspace folder to grade (one task).
                  judge: the trial's final workspace (its final/ folder).
  --app <dir>     judge: the app folder, relative to --workspace
                  (apps/<name>).
  --checklist <file>
                  judge: the checklist, one expectation per line.
  --runs <n>      judge: judge sessions, one after another (default 3).
  --keep-store    judge: keep the stack's store (about 250 MB) when done; it is cleared by default.
  --models <p/m,...>
                  smoke: the models to ask (default: ${SMOKE_MODELS.join(', ')}).
  --help          This text.`;

interface Args {
	command: string | null;
	tasks: string;
	only: string[];
	table: boolean;
	model: string;
	url: string | null;
	apikeyEnv: string | null;
	out: string | null;
	reruns: number;
	/** Every task this many times in rounds, with no reruns (null: reruns mode). */
	trials: number | null;
	/** How many stacks run trials side by side. */
	slots: number;
	headed: boolean;
	models: string[];
	workspace: string | null;
	/** judge: the app folder, relative to the workspace. */
	app: string | null;
	/** judge: the checklist file. */
	checklist: string | null;
	/** judge: judge sessions (null: the judge's default). */
	runs: number | null;
	/** judge: keep the stack's store when done. */
	keepStore: boolean;
	allowWipe: boolean;
	noPreview: boolean;
	envFile: string;
	limits: AgentLimits;
	guards: Guards;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { command: null, tasks: DATA_DIR, only: [], table: false, model: DEFAULT_MODEL, url: null, apikeyEnv: null, out: null, reruns: 2, trials: null, slots: 1, headed: false, models: [], workspace: null, app: null, checklist: null, runs: null, keepStore: false, allowWipe: false, noPreview: false, envFile: DEFAULT_ENV_FILE, limits: {}, guards: { maxSpendUsd: null, minFreeGb: DEFAULT_MIN_FREE_GB }, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
			return v;
		};
		if (a === '--help' || a === '-h') args.help = true;
		else if (a === '--tasks') args.tasks = path.resolve(value());
		else if (a === '--task') args.only.push(...value().split(',').filter(Boolean));
		else if (a === '--table') args.table = true;
		else if (a === '--model') args.model = value();
		else if (a === '--url') args.url = value();
		else if (a === '--apikey-env') args.apikeyEnv = value();
		else if (a === '--out') args.out = path.resolve(value());
		else if (a === '--reruns') {
			args.reruns = Number(value());
			if (!Number.isInteger(args.reruns) || args.reruns < 0) throw new Error('--reruns needs a whole number of 0 or more');
		} else if (a === '--trials') {
			args.trials = Number(value());
			if (!Number.isInteger(args.trials) || args.trials < 1) throw new Error('--trials needs a whole number of 1 or more');
		} else if (a === '--slots') {
			args.slots = Number(value());
			if (!Number.isInteger(args.slots) || args.slots < 1 || args.slots > MAX_SLOTS) throw new Error(`--slots needs a whole number from 1 to ${MAX_SLOTS}`);
		} else if (a === '--max-spend') {
			args.guards.maxSpendUsd = Number(value());
			if (!Number.isFinite(args.guards.maxSpendUsd) || args.guards.maxSpendUsd <= 0) throw new Error('--max-spend needs a number of US dollars above 0');
		} else if (a === '--min-free-disk') {
			args.guards.minFreeGb = Number(value());
			if (!Number.isFinite(args.guards.minFreeGb) || args.guards.minFreeGb < 0) throw new Error('--min-free-disk needs a number of GB, 0 or more');
		} else if (a === '--headed') args.headed = true;
		else if (a === '--workspace') args.workspace = path.resolve(value());
		else if (a === '--app') args.app = value();
		else if (a === '--checklist') args.checklist = path.resolve(value());
		else if (a === '--runs') {
			args.runs = Number(value());
			if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error('--runs needs a whole number of 1 or more');
		}
		else if (a === '--keep-store') args.keepStore = true;
		else if (a === '--allow-wipe') args.allowWipe = true;
		else if (a === '--no-preview') args.noPreview = true;
		else if (a === '--env-file') args.envFile = path.resolve(value());
		else if (a === '--step-limit') {
			args.limits.steps = Number(value());
			if (!Number.isInteger(args.limits.steps) || args.limits.steps < 0) throw new Error('--step-limit needs a whole number of 0 or more (0: no limit)');
		} else if (a === '--cost-limit') {
			args.limits.costUsd = Number(value());
			if (!Number.isFinite(args.limits.costUsd) || args.limits.costUsd < 0) throw new Error('--cost-limit needs a number of US dollars, 0 or more (0: no limit)');
		}
		else if (a === '--models') args.models.push(...value().split(',').filter(Boolean));
		else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
		else if (args.command === null) args.command = a;
		else throw new Error(`unexpected argument ${a}`);
	}
	if (args.trials !== null && argv.includes('--reruns')) throw new Error('--trials runs every task a fixed number of times with no reruns; leave out --reruns');
	if (args.slots > 1 && args.url) throw new Error('--slots starts local stacks; leave out --url');
	if (args.slots > 1 && args.trials === null && args.command === 'run') throw new Error('--slots runs the fixed-trials schedule, where an error is retried on another slot; pass --trials');
	return args;
}

/** The tasks as the README's Markdown table. */
function table(tasks: Task[]): string {
	const rows = ['| Task | Type | Target | Time limit (s) | Checks |', '| --- | --- | --- | --- | --- |'];
	for (const t of tasks) rows.push(`| ${t.id} | ${t.type} | ${t.target} | ${t.timeLimitSec} | ${t.checks.length} |`);
	return rows.join('\n');
}

/** The picked tasks: valid ones, and the problems of invalid ones. */
function pick(args: Args): { valid: Task[]; bad: ReturnType<typeof loadTasks>['invalid'] } {
	const picked = (id: string) => args.only.length === 0 || args.only.some((p) => id.includes(p));
	const { tasks, invalid } = loadTasks(args.tasks);
	return { valid: tasks.filter((t) => picked(t.id)), bad: invalid.filter((v) => picked(v.id)) };
}

function validate(args: Args): number {
	const { valid, bad } = pick(args);
	for (const v of bad) console.log(`INVALID ${v.id}\n${v.problems.map((p) => `  - ${p}`).join('\n')}`);
	console.log(`${valid.length} valid, ${bad.length} invalid, in ${args.tasks}`);
	if (args.table) console.log(`\n${table(valid)}`);
	return bad.length ? 1 : 0;
}

/** The trial folders under a batch folder that hold a result.json. */
function trialFolders(dir: string): string[] {
	const found: string[] = [];
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (!e.isDirectory() || /^(final|stack.*|pages|node_modules)$/.test(e.name)) continue;
			const p = path.join(d, e.name);
			if (/^trial-\d+/.test(e.name)) {
				if (fs.existsSync(path.join(p, 'result.json'))) found.push(p);
			} else walk(p);
		}
	};
	walk(dir);
	return found;
}

function merge(args: Args): number {
	if (!args.out || args.trials === null) {
		console.error(`merge needs --out <batch folder> and --trials <n>\n\n${USAGE}`);
		return 2;
	}
	const out = path.resolve(args.out);
	try {
		const runs = findResults(out).map((f) => ({ dir: path.dirname(f), results: JSON.parse(fs.readFileSync(f, 'utf8')) as ResultsFile }));
		const results = mergeResults(runs, out, args.trials);
		console.log(`${runs.length} runs, ${results.tasks.length} tasks: ${writeResults(out, results)} and ${writeRunReport(out, results)}`);
		for (const r of runs.filter((x) => x.results.stopped)) console.log(`${path.relative(out, r.dir)} stopped early, ${r.results.stopped}`);
		// step: a run stopped before it wrote results.json leaves trials no results.json names; list them, never count them
		const named = new Set(results.tasks.flatMap((t) => t.trials.map((x) => path.dirname(path.resolve(out, x.result)))));
		const unnamed = trialFolders(out).filter((d) => !named.has(d));
		if (unnamed.length) console.log(`${unnamed.length} trial folder(s) no results.json names, left out:\n${unnamed.map((d) => `  ${path.relative(out, d)}`).join('\n')}`);
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

async function run(args: Args, modelKeys: HeldKey[]): Promise<number> {
	const { valid, bad } = pick(args);
	if (bad.length) {
		for (const v of bad) console.log(`INVALID ${v.id}\n${v.problems.map((p) => `  - ${p}`).join('\n')}`);
		console.error('fix the invalid tasks first (validate lists them)');
		return 2;
	}
	if (!valid.length) {
		console.error(`no task in ${args.tasks} matches ${args.only.join(', ')}`);
		return 2;
	}
	let model: ModelPick;
	try {
		model = parseModel(args.model);
		modelTitles(model);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
	if (args.url && !args.allowWipe) {
		console.error(`every trial empties the workspace (.projects), the agent sessions and the saved layouts of the account the API key signs in to on ${new URL(args.url).host}. On your dev stack that is your own work. Pass --allow-wipe only when nothing there needs keeping, such as a stack the stack command started, which keeps its store in its own run folder.`);
		return 2;
	}
	let apiKey: string;
	try {
		apiKey = apiKeyOf(args);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
	const keys = keysFor(args, apiKey, modelKeys);
	const scrubber = new Scrubber(keys);
	const out = args.out ?? path.join(REPO_ROOT, '.verify', 'browser-agent', new Date().toISOString().replace(/[:.]/g, '-'));
	// every line is scrubbed: card titles and the agent's questions can quote anything
	const log = (line: string) => console.log(`[eval] ${scrubber.scrub(line)}`);
	// the engine's keys, for keys-not-leaked: never the account's API key, which the page sends to sign in
	const accountKeyEnv = apiKeyEnvOf(args);
	const engineKeys = heldKeys(modelKeys).filter((k) => k.name !== accountKeyEnv && k.value !== apiKey);
	const schedule: Schedule = args.trials === null ? { mode: 'reruns', reruns: args.reruns } : { mode: 'trials', trials: args.trials };
	log(`${valid.length} task(s), ${schedule.mode === 'trials' ? `each ${schedule.trials} time(s) in rounds, each error retried once` : `up to ${schedule.reruns} rerun(s) of each failure`}, ${model.provider}/${model.model}, output in ${out}`);
	log(`model keys held: ${keys.map((k) => k.name).join(', ') || 'none'}`);
	const limits = Object.keys(args.limits).length ? args.limits : null;
	log(`agent limits: ${limits ? JSON.stringify(agentSettingsFile(limits).settings) : "the product's defaults"}`);
	log(`no trial starts once the finished trials' estimated cost reaches ${args.guards.maxSpendUsd === null ? '(no cap)' : `$${args.guards.maxSpendUsd.toFixed(2)}`}, or under ${args.guards.minFreeGb} GB free on the output disk`);

	const stacks = await openStacks(args.slots, { url: args.url ?? undefined, apiKey, modelKeys, scrubber, log }, out);
	if (!stacks.length) return 2;
	const stopStack = () => {
		void Promise.all(stacks.map((s) => s.stop())).finally(() => process.exit(130));
	};
	process.once('SIGINT', stopStack);
	process.once('SIGTERM', stopStack);
	const slotLog = slotLogger(args.slots, log);

	// step: one known-good call on each slot before the first trial: the first model call on a fresh engine loads the
	// provider's node and is slow, which would otherwise land on the first trial; it also shows a broken model early
	await Promise.all(
		stacks.map(async (stack) => {
			const warm = (await smokeModels(stack.engineUri, apiKey, [model], scrubber).catch((err: unknown) => [{ answered: false, seconds: 0, detail: String(err) }]))[0];
			slotLog(stack.slot)(`known-good call to ${model.provider}/${model.model}: ${warm?.answered ? `answered in ${warm.seconds}s` : `FAILED: ${scrubber.scrub(warm?.detail ?? '').slice(0, 200)}`}`);
		})
	);
	const startedAt = new Date().toISOString();
	const byId = new Map(valid.map((t) => [t.id, t]));
	let failedToRun = 0;
	const finished: TrialResult[] = [];
	let stopped: string | null = null;
	try {
		const label =(job: Job) => (job.retryOf ? ` (retry of trial ${job.retryOf})` : schedule.mode === 'reruns' && job.trial > 1 ? ' (rerun)' : '');
		const one = async (job: Job, worker: number): Promise<TrialResult> => {
			const stack = stacks[worker] as Stack;
			const task = byId.get(job.id) as Task;
			const n = job.trial;
			const dir = path.join(out, task.id, `trial-${n}`);
			const { record: r, result: raw } = await runTrial({ task, tasksDir: args.tasks, trial: n, model, stack, dir, headed: args.headed, previews: !args.noPreview, limits, keys, engineKeys, scrubber });
			if (job.retryOf) raw.retryOf = job.retryOf;
			raw.slot = stack.slot;
			// step: a trial whose stack died under it is the environment's error, whatever its grade says; the queue retries it
			const dead = stack.died();
			if (dead) {
				raw.status = 'error';
				raw.why = `the stack died during the trial: ${dead}`;
			}
			// step: the known-good call after every trial the runner drove, recorded with it; a failed trial gets its cause from it too
			const kg = r.endReason === 'not_supported' || dead ? null : ((await smokeModels(stack.engineUri, apiKey, [model], scrubber).catch(() => null))?.[0] ?? null);
			raw.knownGood = kg ? { model: kg.model, answered: kg.answered, seconds: kg.seconds, detail: kg.detail } : null;
			if (dead) raw.cause = { label: 'environment', evidence: dead };
			else if (raw.status !== 'pass' && raw.status !== 'pending') raw.cause = causeOf(raw, r, kg);
			// step: from here on the grade is scrubbed: the log, result.json, results.json and the report all read this copy
			const result = JSON.parse(scrubber.scrub(JSON.stringify(raw))) as typeof raw;
			fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(result, null, '\t')}\n`);
			const outcome = r.turns[0]?.result?.outcome ?? 'none';
			const card = r.browser.card ? `card "${r.browser.card.title}"${r.browser.cardMatchesOutcome === false ? ' (DISAGREES)' : ''}` : 'no card';
			const cards = r.confirms.length ? `, ${r.confirms.length} card(s): ${r.confirms.map((c) => c.answer).join(', ')}` : '';
			slotLog(stack.slot)(`${task.id} trial ${n}${label(job)}: ${result.status.toUpperCase()}, outcome ${outcome}, ${card}${cards}, ${Math.round(r.totalWallMs / 1000)}s: ${result.why.slice(0, 200)}`);
			log(`  ${dir}`);
			if (dead || r.endReason === 'runner_error' || r.endReason === 'environment' || r.browser.leaks.length) failedToRun++;
			if (result.cause) log(`  cause: ${result.cause.label}: ${result.cause.evidence.slice(0, 200)}`);
			finished.push(result);
			return result;
		};
		// a trial that threw past its own catch has no record to grade; nothing is written here, since a write may be what failed
		const fail = (job: Job, err: unknown, worker: number): TrialResult => {
			const task = byId.get(job.id) as Task;
			const slot = (stacks[worker] as Stack).slot;
			const leaks = findLeaks(path.join(out, task.id, `trial-${job.trial}`), keys);
			const leaked = leaks.length ? `; a held key is in the trial folder: ${leaks.map((l) => `${l.key} in ${l.file}`).join(', ')}` : '';
			const result = erroredTrial(task, job.trial, `${model.provider}/${model.model}`, `${scrubber.scrub((err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '')}${leaked}`);
			if (job.retryOf) result.retryOf = job.retryOf;
			result.slot = slot;
			slotLog(slot)(`${task.id} trial ${job.trial}${label(job)}: ${result.status.toUpperCase()}: ${result.why.slice(0, 200)}`);
			failedToRun++;
			finished.push(result);
			return result;
		};
		// step: before each trial starts, the spend cap and the disk floor; once one is hit no trial starts again
		const stop = (): string | null => {
			if (stopped === null) {
				stopped = stopReason(args.guards, spentUsd(finished), freeGb(out));
				if (stopped) log(`stopping: no more trials start, at ${stopped}`);
			}
			return stopped;
		};
		// step: a slot whose stack died takes no more trials; the others go on
		const retired = new Set<number>();
		const usable = (worker: number): boolean => {
			const stack = stacks[worker] as Stack;
			const dead = stack.died();
			if (dead && !retired.has(worker)) {
				retired.add(worker);
				log(`slot ${stack.slot} is out: ${dead}. It takes no more trials; a trial that errored on it is retried on another slot`);
			}
			return !dead;
		};
		const queue = { workers: stacks.length, stop, usable };
		const statusOf = (r: TrialResult) => r.status;
		const runs =
			schedule.mode === 'trials'
				? await runTrials(roundOrder(valid), schedule.trials, one, statusOf, fail, queue)
				: await runSchedule(
						valid.map((t) => t.id),
						(id, n, w) => one({ id, trial: n }, w),
						statusOf,
						(id, n, err, w) => fail({ id, trial: n }, err, w),
						schedule.reruns,
						queue
					);
		if (stopped === null && stacks.every((s) => s.died())) {
			stopped = 'the loss of every slot: each stack died, so the trials still queued did not run';
			log(`stopping: ${stopped}`);
		}
		const results = buildResults(runs, byId, out, {
			startedAt,
			finishedAt: new Date().toISOString(),
			model: `${model.provider}/${model.model}`,
			taskSet: path.relative(REPO_ROOT, args.tasks),
			schedule,
			stopped,
			engine: (stacks[0] as Stack).engine,
			...(args.slots > 1 ? { slots: stacks.map((s) => ({ slot: s.slot, shell: s.shellUrl, engine: s.engine.url, store: s.engine.store ?? null })) } : {}),
			checkout: checkout(),
		});
		writeResults(out, results);
		const report = writeRunReport(out, results);
		const s = results.summary;
		if (schedule.mode === 'trials') log(`${results.tasks.reduce((k, t) => k + t.score.passed, 0)} of ${results.tasks.reduce((k, t) => k + t.score.runs, 0)} runs passed (errors left out), over ${s.tasks} task(s)`);
		log(
			`first-run pass rate ${Math.round(s.firstRunPassRate * 100)}%, flake rate ${Math.round(s.flakeRate * 100)}%, over ${s.tasks} task(s): ${Object.entries(s.verdicts)
				.map(([v, n]) => `${n} ${v}`)
				.join(', ')}`
		);
		log(`estimated cost $${s.totals.estimatedCostUsd.toFixed(2)}, trial time ${Math.round(s.totals.trialWallMs / 60_000)} min summed`);
		log(`report: ${report}`);
	} finally {
		process.removeListener('SIGINT', stopStack);
		process.removeListener('SIGTERM', stopStack);
		await Promise.all(stacks.map((s) => s.stop()));
	}
	return failedToRun ? 1 : 0;
}

/** Each slot's log line, prefixed with its slot when there are several. */
function slotLogger(slots: number, log: (line: string) => void): (slot: number) => (line: string) => void {
	return (slot) => (slots > 1 ? (line) => log(`slot ${slot}: ${line}`) : log);
}

/**
 * Starts `slots` stacks side by side (or attaches to --url's), each in its slot's folder of the run folder.
 * A slot that fails to start is logged and left out; the others go on.
 *
 * @returns The stacks that came up, in slot order; none when every slot failed, which is reported.
 */
async function openStacks(slots: number, opts: Omit<StackOptions, 'dir' | 'slot'>, out: string): Promise<Stack[]> {
	const slotLog = slotLogger(slots, opts.log);
	const opened = await Promise.allSettled(Array.from({ length: slots }, (_, slot) => openStack({ ...opts, slot, dir: path.join(out, slotPlan(slot).dir), log: slotLog(slot) })));
	const why = (r: PromiseSettledResult<Stack>) => (r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : '');
	if (slots === 1 && opened[0]?.status === 'rejected') {
		console.error(`could not start the stack: ${why(opened[0])}`);
		return [];
	}
	opened.forEach((r, slot) => {
		if (r.status === 'rejected') opts.log(`slot ${slot} did not start and runs no trials: ${why(r)}`);
	});
	const up = opened.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
	if (!up.length) console.error('could not start any slot');
	return up;
}

/** The checkout under test: its commit, branch and uncommitted file count. */
function checkout(): { commit: string; branch: string; dirtyFiles: number } {
	const git = (...a: string[]) => {
		try {
			return execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
		} catch {
			return '';
		}
	};
	return { commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirtyFiles: git('status', '--porcelain').split('\n').filter(Boolean).length };
}

/** The environment variable a remote stack's API key comes from (task 2.8). */
const REMOTE_APIKEY_ENV = 'RR_EVAL_APIKEY';

/** The variable the API key comes from: --apikey-env, else RR_EVAL_APIKEY with --url when it is set, else none (the local engine's key). */
function apiKeyEnvOf(args: Args): string | null {
	return args.apikeyEnv ?? (args.url && process.env[REMOTE_APIKEY_ENV] ? REMOTE_APIKEY_ENV : null);
}

/** The API key the page and the client sign in with. */
function apiKeyOf(args: Args): string {
	const name = apiKeyEnvOf(args);
	if (!name) return LOCAL_APIKEY;
	const v = process.env[name];
	if (!v) throw new Error(`--apikey-env ${name}: that variable is not set`);
	return v;
}

/** The keys to scrub: the engine's, plus the API key when it comes from a variable. */
function keysFor(args: Args, apiKey: string, modelKeys: HeldKey[]): HeldKey[] {
	const keys = heldKeys(modelKeys);
	const name = apiKeyEnvOf(args);
	if (name && apiKey.length >= 8 && !keys.some((k) => k.value === apiKey)) keys.push({ name, value: apiKey });
	return keys;
}

async function holdStack(args: Args, modelKeys: HeldKey[]): Promise<number> {
	const keys = heldKeys(modelKeys);
	const scrubber = new Scrubber(keys);
	const out = args.out ?? path.join(REPO_ROOT, '.verify', 'browser-agent', `stack-${new Date().toISOString().replace(/[:.]/g, '-')}`);
	const log = (line: string) => console.log(`[eval] ${scrubber.scrub(line)}`);
	log(`model keys held: ${keys.map((k) => k.name).join(', ') || 'none'}`);
	const stacks = await openStacks(args.slots, { apiKey: LOCAL_APIKEY, modelKeys, scrubber, log }, out);
	if (!stacks.length) return 2;
	for (const stack of stacks) log(`${args.slots > 1 ? `slot ${stack.slot} ` : ''}up: ${stack.shellUrl} (engine ${stack.engineUri}). Ctrl-C stops ${args.slots > 1 ? 'them' : 'it'}.`);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	await Promise.all(stacks.map((s) => s.stop()));
	log('stopped');
	return 0;
}

async function check(args: Args, modelKeys: HeldKey[]): Promise<number> {
	const { valid, bad } = pick(args);
	if (bad.length || !valid.length) {
		console.error(bad.length ? `invalid tasks: ${bad.map((v) => v.id).join(', ')}` : `no task in ${args.tasks} matches ${args.only.join(', ')}`);
		return 2;
	}
	if (args.workspace && valid.length !== 1) {
		console.error(`--workspace grades one task; ${valid.length} match ${args.only.join(', ') || 'everything'}`);
		return 2;
	}
	let apiKey: string;
	try {
		apiKey = apiKeyOf(args);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
	const keys = heldKeys(modelKeys);
	const scrubber = new Scrubber(keys);
	const out = args.out ?? path.join(REPO_ROOT, '.verify', 'browser-agent', `check-${new Date().toISOString().replace(/[:.]/g, '-')}`);
	const log = (line: string) => console.log(`[eval] ${scrubber.scrub(line)}`);
	let stack: Stack;
	try {
		stack = await openStack({ url: args.url ?? undefined, apiKey, modelKeys, dir: path.join(out, 'stack'), scrubber, log, engineOnly: true });
	} catch (err) {
		console.error(`could not start the engine: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	let failed = 0;
	try {
		const store = await Store.connect(stack.engineUri, apiKey);
		try {
			const variables = await store.variableNames();
			for (const task of valid) {
				const final = args.workspace ? readTree(args.workspace) : referenceWorkspace(task, args.tasks);
				if (!final) {
					log(`${task.id}: no reference solution to grade (pass --workspace)`);
					continue;
				}
				const r = await checkWorkspace(store.client, task, args.tasks, final, keys, variables, path.join(out, 'app-check'));
				fs.mkdirSync(out, { recursive: true });
				fs.writeFileSync(path.join(out, `${task.id}.json`), `${scrubber.scrub(JSON.stringify(r, null, '\t'))}\n`);
				log(`${task.id}: ${r.status.toUpperCase()}: ${scrubber.scrub(r.why).slice(0, 200)}`);
				for (const c of r.checks) if (c.status !== 'pass') log(`  ${c.status} ${c.id} (${c.kind}): ${scrubber.scrub(c.detail).slice(0, 200)}`);
				if (r.status !== 'pass') failed++;
			}
		} finally {
			await store.close();
		}
	} finally {
		await stack.stop();
	}
	log(`written to ${out}`);
	return failed ? 1 : 0;
}

async function judge(args: Args, modelKeys: HeldKey[]): Promise<number> {
	try {
		const out = args.out ?? path.join(REPO_ROOT, '.verify', 'browser-agent', `judge-${new Date().toISOString().replace(/[:.]/g, '-')}`);
		return await judgeCommand(judgePlan({ workspace: args.workspace, app: args.app, checklist: args.checklist, out, runs: args.runs, keepStore: args.keepStore }), modelKeys);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
}

async function smoke(args: Args, modelKeys: HeldKey[]): Promise<number> {
	let models: ModelPick[];
	let apiKey: string;
	try {
		models = (args.models.length ? args.models : SMOKE_MODELS).map(parseModel);
		apiKey = apiKeyOf(args);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
	const keys = heldKeys(modelKeys);
	const scrubber = new Scrubber(keys);
	const out = args.out ?? path.join(REPO_ROOT, '.verify', 'browser-agent', `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
	const log = (line: string) => console.log(`[eval] ${scrubber.scrub(line)}`);
	log(`model keys held: ${keys.map((k) => k.name).join(', ') || 'none'}`);
	let stack: Stack;
	try {
		stack = await openStack({ url: args.url ?? undefined, apiKey, modelKeys, dir: path.join(out, 'stack'), scrubber, log, engineOnly: true });
	} catch (err) {
		console.error(`could not start the engine: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	try {
		const rows = await smokeModels(stack.engineUri, apiKey, models, scrubber);
		const table = smokeTable(rows);
		fs.mkdirSync(out, { recursive: true });
		fs.writeFileSync(path.join(out, 'smoke-models.md'), `${table}\n`);
		fs.writeFileSync(path.join(out, 'smoke-models.json'), `${JSON.stringify({ engine: stack.engine, rows }, null, '\t')}\n`);
		console.log(`\n${table}\n`);
		log(`written to ${out}`);
		return 0;
	} finally {
		await stack.stop();
	}
}

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
		return 2;
	}
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	if (args.command === 'validate') return validate(args);
	if (args.command === 'merge') return merge(args);
	const command = args.command === null ? undefined : KEYED[args.command];
	if (!command) {
		console.error(`${args.command === null ? 'no command' : `unknown command ${args.command}`}\n\n${USAGE}`);
		return 2;
	}
	let modelKeys: HeldKey[];
	try {
		modelKeys = readModelKeys(args.envFile);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
	return await command(args, modelKeys);
}

/** The commands that start an engine or grade against one, and so need the model keys (judge's sessions run on EVAL_ANTHROPIC_KEY too). */
const KEYED: Record<string, (args: Args, modelKeys: HeldKey[]) => Promise<number>> = { run, smoke, check, judge, stack: holdStack };

void main().then((code) => {
	process.exitCode = code;
});
