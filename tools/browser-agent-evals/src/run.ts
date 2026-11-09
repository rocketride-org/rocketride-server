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
import { heldKeys, Scrubber, type HeldKey } from './evidence';
import { LOCAL_APIKEY, openStack, type Stack } from './stack';
import { Store } from './store';
import { loadTasks, type Task } from './task';
import { writeRunReport } from './report';
import { buildResults, writeResults } from './results';
import { checkWorkspace, readTree, referenceWorkspace } from './references';
import { causeOf } from './cause';
import { runSchedule } from './schedule';
import { SMOKE_MODELS, smokeModels, smokeTable } from './smoke-models';
import { runTrial } from './trial';

const DEFAULT_MODEL = 'anthropic/claude-haiku-5-5';

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
                  The model keys come from ROCKETRIDE_ANTHROPIC_KEY and
                  ROCKETRIDE_OPENAI_KEY (or ANTHROPIC_API_KEY and
                  OPENAI_API_KEY) and go to the engine only.
  check           Grade a hand-made workspace for each picked task with no
                  agent: the engine (started alone) validates and runs its
                  pipelines, and every check reads it as if the turn had
                  ended done. --workspace <dir> grades that folder; by
                  default each task's reference solution.
  stack           Start the local stack (engine, rocket-ui dev remote, shell
                  dev server) and keep it up until Ctrl-C; run --url uses it.
  smoke           Ask each model one question the way the Agent tab does
                  (task 0.2), on the engine alone. Prints a table: model,
                  answered, seconds, whether the engine lists the key name.

Options:
  --tasks <dir>   The task set folder (default: tasks/breadth).
  --task <ids>    Only tasks whose id contains one of these, comma-separated.
                  ./builder's --pattern=<id> sets it.
  --table         validate: print the tasks as a Markdown table.
  --model <p/m>   run: provider/model to pick (default: ${DEFAULT_MODEL}).
  --url <url>     run: use the shell at this URL instead of starting a stack.
  --apikey-env <name>
                  run: the environment variable holding the API key the page
                  signs in with (default: RR_EVAL_APIKEY with --url when it is
                  set, else the local engine's ${LOCAL_APIKEY}).
  --allow-remote-wipe
                  run: allow --url on another machine. Every trial empties the
                  workspace and sessions of the API key's account there.
  --out <dir>     run: where trial folders go (default: .verify/browser-agent/<time>).
  --reruns <n>    run: how many times to rerun a task whose first run failed
                  (default: 2). Flaky: a rerun passed. Failing: every run failed.
  --headed        run: show the browser.
  --no-preview    run: leave every Design preview closed. By default the
                  runner opens each app's preview as a user watching would:
                  each app the task starts with before the session, and each
                  app the agent creates as soon as it is written.
  --workspace <dir>
                  check: the workspace folder to grade (one task).
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
	headed: boolean;
	models: string[];
	workspace: string | null;
	allowRemoteWipe: boolean;
	noPreview: boolean;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { command: null, tasks: DATA_DIR, only: [], table: false, model: DEFAULT_MODEL, url: null, apikeyEnv: null, out: null, reruns: 2, headed: false, models: [], workspace: null, allowRemoteWipe: false, noPreview: false, help: false };
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
		} else if (a === '--headed') args.headed = true;
		else if (a === '--workspace') args.workspace = path.resolve(value());
		else if (a === '--allow-remote-wipe') args.allowRemoteWipe = true;
		else if (a === '--no-preview') args.noPreview = true;
		else if (a === '--models') args.models.push(...value().split(',').filter(Boolean));
		else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
		else if (args.command === null) args.command = a;
		else throw new Error(`unexpected argument ${a}`);
	}
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

async function run(args: Args): Promise<number> {
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
	if (args.url && !isLocalUrl(args.url) && !args.allowRemoteWipe) {
		console.error(`every trial empties the workspace (.projects), the agent sessions and the saved layouts of the account the API key belongs to on ${new URL(args.url).host}. Pass --allow-remote-wipe if that account is the eval account and nothing in it needs keeping.`);
		return 2;
	}
	let apiKey: string;
	try {
		apiKey = apiKeyOf(args);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
	const keys = keysFor(args, apiKey);
	const scrubber = new Scrubber(keys);
	const out = args.out ?? path.join(REPO_ROOT, '.verify', 'browser-agent', new Date().toISOString().replace(/[:.]/g, '-'));
	// every line is scrubbed: card titles and the agent's questions can quote anything
	const log = (line: string) => console.log(`[eval] ${scrubber.scrub(line)}`);
	// the engine's keys, for keys-not-leaked: never the account's API key, which the page sends to sign in
	const accountKeyEnv = apiKeyEnvOf(args);
	const engineKeys = heldKeys().filter((k) => k.name !== accountKeyEnv && k.value !== apiKey);
	log(`${valid.length} task(s), up to ${args.reruns} rerun(s) of each failure, ${model.provider}/${model.model}, output in ${out}`);
	log(`model keys held: ${keys.map((k) => k.name).join(', ') || 'none'}`);

	let stack: Stack;
	try {
		stack = await openStack({ url: args.url ?? undefined, apiKey, dir: path.join(out, 'stack'), scrubber, log });
	} catch (err) {
		console.error(`could not start the stack: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	const stopStack = () => {
		void stack.stop().finally(() => process.exit(130));
	};
	process.once('SIGINT', stopStack);
	process.once('SIGTERM', stopStack);

	// step: one known-good call before the first trial: the first model call on a fresh engine loads the
	// provider's node and is slow, which would otherwise land on the first trial; it also shows a broken model early
	const warm = (await smokeModels(stack.engineUri, apiKey, [model], scrubber).catch((err: unknown) => [{ answered: false, seconds: 0, detail: String(err) }]))[0];
	log(`known-good call to ${model.provider}/${model.model}: ${warm?.answered ? `answered in ${warm.seconds}s` : `FAILED: ${scrubber.scrub(warm?.detail ?? '').slice(0, 200)}`}`);
	const startedAt = new Date().toISOString();
	const byId = new Map(valid.map((t) => [t.id, t]));
	let failedToRun = 0;
	try {
		const runs = await runSchedule(
			valid.map((t) => t.id),
			async (id, n) => {
				const task = byId.get(id) as Task;
				const dir = path.join(out, task.id, `trial-${n}`);
				const { record: r, result: raw } = await runTrial({ task, tasksDir: args.tasks, trial: n, model, stack, dir, headed: args.headed, previews: !args.noPreview, keys, engineKeys, scrubber });
				// step: a failed trial gets its cause; the known-good call tells the model's fault from the agent's
				if (raw.status !== 'pass' && raw.status !== 'pending') {
					const kg = r.endReason === 'not_supported' ? null : ((await smokeModels(stack.engineUri, apiKey, [model], scrubber).catch(() => null))?.[0] ?? null);
					raw.cause = causeOf(raw, r, kg);
				}
				// step: from here on the grade is scrubbed: the log, result.json, results.json and the report all read this copy
				const result = JSON.parse(scrubber.scrub(JSON.stringify(raw))) as typeof raw;
				fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(result, null, '\t')}\n`);
				const outcome = r.turns[0]?.result?.outcome ?? 'none';
				const card = r.browser.card ? `card "${r.browser.card.title}"${r.browser.cardMatchesOutcome === false ? ' (DISAGREES)' : ''}` : 'no card';
				const cards = r.confirms.length ? `, ${r.confirms.length} card(s): ${r.confirms.map((c) => c.answer).join(', ')}` : '';
				log(`${task.id} trial ${n}${n > 1 ? ' (rerun)' : ''}: ${result.status.toUpperCase()}, outcome ${outcome}, ${card}${cards}, ${Math.round(r.totalWallMs / 1000)}s: ${result.why.slice(0, 200)}`);
				log(`  ${dir}`);
				if (r.endReason === 'runner_error' || r.endReason === 'environment' || r.browser.leaks.length) failedToRun++;
				if (result.cause) log(`  cause: ${result.cause.label}: ${result.cause.evidence.slice(0, 200)}`);
				return result;
			},
			(r) => r.status,
			args.reruns
		);
		const results = buildResults(runs, byId, out, {
			startedAt,
			finishedAt: new Date().toISOString(),
			model: `${model.provider}/${model.model}`,
			taskSet: path.relative(REPO_ROOT, args.tasks),
			engine: stack.engine,
			checkout: checkout(),
		});
		writeResults(out, results);
		const report = writeRunReport(out, results);
		const s = results.summary;
		log(
			`first-run pass rate ${Math.round(s.firstRunPassRate * 100)}%, flake rate ${Math.round(s.flakeRate * 100)}%, over ${s.tasks} task(s): ${Object.entries(s.verdicts)
				.map(([v, n]) => `${n} ${v}`)
				.join(', ')}`
		);
		log(`report: ${report}`);
	} finally {
		process.removeListener('SIGINT', stopStack);
		process.removeListener('SIGTERM', stopStack);
		await stack.stop();
	}
	return failedToRun ? 1 : 0;
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

/** Whether a URL is this machine, where the runner's own stack or a dev stack runs. */
export function isLocalUrl(url: string): boolean {
	return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname);
}

/** The keys to scrub: the engine's, plus the API key when it comes from a variable. */
function keysFor(args: Args, apiKey: string): HeldKey[] {
	const keys = heldKeys();
	const name = apiKeyEnvOf(args);
	if (name && apiKey.length >= 8 && !keys.some((k) => k.value === apiKey)) keys.push({ name, value: apiKey });
	return keys;
}

async function holdStack(args: Args): Promise<number> {
	const keys = heldKeys();
	const scrubber = new Scrubber(keys);
	const out = args.out ?? path.join(REPO_ROOT, '.verify', 'browser-agent', `stack-${new Date().toISOString().replace(/[:.]/g, '-')}`);
	const log = (line: string) => console.log(`[eval] ${scrubber.scrub(line)}`);
	log(`model keys held: ${keys.map((k) => k.name).join(', ') || 'none'}`);
	let stack: Stack;
	try {
		stack = await openStack({ apiKey: LOCAL_APIKEY, dir: path.join(out, 'stack'), scrubber, log });
	} catch (err) {
		console.error(`could not start the stack: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	log(`up: ${stack.shellUrl} (engine ${stack.engineUri}). Ctrl-C stops it.`);
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	await stack.stop();
	log('stopped');
	return 0;
}

async function check(args: Args): Promise<number> {
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
	const keys = heldKeys();
	const scrubber = new Scrubber(keys);
	const out = args.out ?? path.join(REPO_ROOT, '.verify', 'browser-agent', `check-${new Date().toISOString().replace(/[:.]/g, '-')}`);
	const log = (line: string) => console.log(`[eval] ${scrubber.scrub(line)}`);
	let stack: Stack;
	try {
		stack = await openStack({ url: args.url ?? undefined, apiKey, dir: path.join(out, 'stack'), scrubber, log, engineOnly: true });
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

async function smoke(args: Args): Promise<number> {
	let models: ModelPick[];
	let apiKey: string;
	try {
		models = (args.models.length ? args.models : SMOKE_MODELS).map(parseModel);
		apiKey = apiKeyOf(args);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
	const keys = heldKeys();
	const scrubber = new Scrubber(keys);
	const out = args.out ?? path.join(REPO_ROOT, '.verify', 'browser-agent', `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
	const log = (line: string) => console.log(`[eval] ${scrubber.scrub(line)}`);
	log(`model keys held: ${keys.map((k) => k.name).join(', ') || 'none'}`);
	let stack: Stack;
	try {
		stack = await openStack({ url: args.url ?? undefined, apiKey, dir: path.join(out, 'stack'), scrubber, log, engineOnly: true });
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
	if (args.command === 'run') return await run(args);
	if (args.command === 'smoke') return await smoke(args);
	if (args.command === 'check') return await check(args);
	if (args.command === 'stack') return await holdStack(args);
	console.error(`${args.command === null ? 'no command' : `unknown command ${args.command}`}\n\n${USAGE}`);
	return 2;
}

void main().then((code) => {
	process.exitCode = code;
});
