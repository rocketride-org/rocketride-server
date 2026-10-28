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
// EVAL RUNNER: shared:eval's entry: validate, run a layer, score, report
// =============================================================================

/**
 * Usage (cwd apps/shared, or through ./builder shared:eval):
 *
 *   node --import tsx src/modules/agent/eval/run.ts validate
 *   node --import tsx src/modules/agent/eval/run.ts run --layer L1 [--scenarios a,b] [--set <name>] [--jobs 4] [--limits recorded|default|off]
 *   node --import tsx src/modules/agent/eval/run.ts run --layer L2 --scenarios build-01-chat-claude [--provider anthropic] [--model claude-sonnet-5] [--trials 1] [--limits default|off]
 *   node --import tsx src/modules/agent/eval/run.ts run --layer L3 --scenarios build-01-chat-claude [--trials 1] [--limits default|off]
 *   node --import tsx src/modules/agent/eval/run.ts record --from <an L2 run's output folder> --set <name> [--head <commit>]
 *
 * Every run validates all scenarios, fixtures, references and recordings
 * first, and refuses to run when any is invalid, naming each. Output goes to
 * --out (default .verify/eval/<layer>-<time>/ in the checkout): report.md,
 * results.json, and one record and log per trial.
 *
 * Keys follow the verify skill's rules: the caller's environment, else
 * tokenstash (in EVAL_KEYS_DIR, or RR_VERIFY_KEYS_DIR, or the checkout) when
 * it is installed. L1 needs none. L2 gives the provider key to the trial,
 * whose model calls use it. L3 gives the keys to the engine only, through the
 * skill's launcher; trials run with every key unset, and get the engine's API
 * key (RR_VERIFY_APIKEY) in their environment. No value is printed or written.
 *
 * --limits sets the agent's step and cost limits for each turn: `recorded`
 * (L1's default) replays a trial under the limits it was recorded with;
 * `default` (L2's and L3's) is the product's 60 steps and $2; `off` is no
 * limit.
 *
 * Exit codes: 0 done; 1 an L1 scenario has no recording, or its replay did
 * not reproduce the recorded trial; 2 invalid scenarios or a runner failure.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fingerprint, type Fingerprint } from './canary';
import { EVAL_DIR, REPO_ROOT } from './catalog';
import { fromTrial, loadRecordings, RECORDINGS_DIR, validateRecording, type Recording } from './recordings';
import { compare, counts, reproduces, STATUSES, writeReport, type Comparison, type Provenance } from './report';
import { loadScenario, scenarioIds, validateAll } from './scenarios';
import { scoreTrial, sha256 } from './score';
import type { TrialConfig } from './trial';
import type { Layer, Scenario, ScenarioResult, TrialRecord } from './types';

/** Node's process. The package's global.d.ts declares a browser `process` that has only `env`. */
const proc = process as unknown as NodeJS.Process;

// =============================================================================
// PATHS AND ARGUMENTS
// =============================================================================

const SHARED_DIR = path.join(REPO_ROOT, 'apps/shared');
const SKILL = path.join(REPO_ROOT, '.claude/skills/rr-verify-agent/scripts/rr-verify-agent');
const STATE_DIR = proc.env.RR_VERIFY_STATE ?? path.join(REPO_ROOT, '.verify/agent-state');
const LOCK = proc.env.RR_VERIFY_LOCK ?? '/tmp/rr-verify-5565.lock';
const ENGINE_URI = 'http://127.0.0.1:5565';
const ENGINE_AUTH = proc.env.RR_VERIFY_APIKEY ?? 'local-test';
const KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ROCKETRIDE_ANTHROPIC_KEY', 'ROCKETRIDE_OPENAI_KEY'];

/** `--name value` and `--flag` arguments after the command. */
function args(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) continue;
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith('--')) out[argv[i].slice(2)] = argv[++i];
		else out[argv[i].slice(2)] = 'true';
	}
	return out;
}

function log(...a: unknown[]): void {
	console.error('[eval]', ...a);
}

function git(...a: string[]): string {
	try {
		return execFileSync('git', ['-C', REPO_ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return 'unknown';
	}
}

function checkout(): Provenance['checkout'] {
	const status = git('status', '--porcelain');
	let base = git('merge-base', 'HEAD', 'origin/feat/rocket-agent-browser');
	if (base === 'unknown') base = git('rev-parse', 'HEAD^');
	return { path: REPO_ROOT, commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirtyFiles: status === 'unknown' || !status ? 0 : status.split('\n').length, base };
}

/** Whether a command is on the PATH. */
function has(cmd: string): boolean {
	return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

/** The environment with every model key removed. */
function keyless(): NodeJS.ProcessEnv {
	const env = { ...proc.env };
	for (const k of KEY_NAMES) delete env[k];
	return env;
}

/** Where a key comes from for L2, without reading it. */
function keySource(provider: string): 'environment' | 'tokenstash' | 'none' {
	const names = provider === 'openai' ? ['OPENAI_API_KEY', 'ROCKETRIDE_OPENAI_KEY'] : ['ANTHROPIC_API_KEY', 'ROCKETRIDE_ANTHROPIC_KEY'];
	if (names.some((n) => proc.env[n])) return 'environment';
	return has('tokenstash') ? 'tokenstash' : 'none';
}

function keysDir(): string {
	return proc.env.EVAL_KEYS_DIR ?? proc.env.RR_VERIFY_KEYS_DIR ?? REPO_ROOT;
}

// =============================================================================
// VALIDATION
// =============================================================================

/** Every invalid scenario and recording, by name. */
function invalidData(): Array<{ id: string; problems: string[] }> {
	const ids = new Set(scenarioIds());
	const bad = validateAll()
		.map((v) => ({ id: v.id, problems: v.problems }))
		.filter((v) => v.problems.length);
	// L1 matches each replay to its recording by scenario and trial
	const seen = new Map<string, string>();
	for (const { file, recording } of loadRecordings()) {
		const problems = validateRecording(recording, ids);
		const rel = path.relative(RECORDINGS_DIR, file);
		const pair = `${recording.scenario} trial ${recording.trial}`;
		if (seen.has(pair)) problems.push(`${pair} is also recorded in ${seen.get(pair)}; delete one`);
		seen.set(pair, rel);
		if (problems.length) bad.push({ id: `recording ${rel}`, problems });
	}
	return bad;
}

function cmdValidate(): number {
	const all = validateAll();
	const bad = invalidData();
	for (const v of all) {
		console.log(`${v.problems.length ? 'INVALID' : 'ok     '} ${v.id.padEnd(34)} reference ${v.reference ? `${v.reference.passed}/${v.reference.counted} static checks` : 'none'}${v.problems.length ? `: ${v.problems.join('; ')}` : ''}`);
	}
	const recs = loadRecordings();
	console.log(`${all.length} scenarios, ${all.length - bad.filter((b) => !b.id.startsWith('recording')).length} valid; ${recs.length} recordings; ${bad.length} invalid in all.`);
	for (const b of bad.filter((x) => x.id.startsWith('recording'))) console.log(`INVALID ${b.id}: ${b.problems.join('; ')}`);
	return bad.length ? 2 : 0;
}

// =============================================================================
// TRIALS
// =============================================================================

interface Spawned {
	record: TrialRecord | null;
	recordPath: string;
	logPath: string;
	code: number | null;
}

/**
 * Runs one trial in its own process.
 *
 * @param cfg - The trial's config.
 * @param env - Its environment.
 * @param wrap - A command to run it under (tokenstash), or none.
 * @returns The record it wrote.
 */
function spawnTrial(cfg: TrialConfig, env: NodeJS.ProcessEnv, wrap: string[] = []): Promise<Spawned> {
	const configPath = cfg.out.replace(/\.json$/, '.config.json');
	const logPath = cfg.out.replace(/\.json$/, '.log');
	fs.mkdirSync(path.dirname(cfg.out), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
	const node = [proc.execPath, '--require', './scripts/stub-css.cjs', '--require', path.join(EVAL_DIR, 'shell-stub.cjs'), '--import', 'tsx', path.join(EVAL_DIR, 'trial.ts'), '--config', configPath];
	const argv = wrap.length ? [...wrap, 'env', '-C', SHARED_DIR, ...node] : node;
	const out = fs.openSync(logPath, 'w');
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { cwd: wrap.length ? keysDir() : SHARED_DIR, env, stdio: ['ignore', out, out] });
		const limit = setTimeout(() => child.kill('SIGTERM'), (cfg.maxMinutes * 6 + 10) * 60_000);
		child.on('close', (code) => {
			clearTimeout(limit);
			fs.closeSync(out);
			let record: TrialRecord | null = null;
			try {
				record = JSON.parse(fs.readFileSync(cfg.out, 'utf8')) as TrialRecord;
			} catch {
				record = null;
			}
			resolve({ record, recordPath: cfg.out, logPath, code });
		});
	});
}

/** Runs async jobs, a few at a time. */
async function pool<T>(items: T[], jobs: number, work: (item: T, i: number) => Promise<void>): Promise<void> {
	let next = 0;
	const lanes = Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
		while (next < items.length) {
			const i = next++;
			await work(items[i], i);
		}
	});
	await Promise.all(lanes);
}

/** A scenario that ran no trial in this layer, and why. */
function notRun(scenario: Scenario, layer: Layer, why: string, model: string): ScenarioResult {
	return { scenario: scenario.id, layer, trial: 0, model, status: 'pending', why, checks: [], blockersFired: [], counted: { passed: 0, total: 0, pending: 0, notInLayer: 0 }, diagnostics: {}, record: null };
}

/** A trial that wrote no record: an error, left out of the denominator. */
function crashed(scenario: Scenario, layer: Layer, trial: number, model: string, s: Spawned): ScenarioResult {
	return { ...notRun(scenario, layer, `the trial wrote no record (exit ${s.code}); see ${s.logPath}`, model), trial, status: 'error', record: s.logPath };
}

// =============================================================================
// RUN
// =============================================================================

interface RunOptions {
	layer: Layer;
	scenarios: string[];
	out: string;
	trials: number;
	jobs: number;
	set?: string;
	provider: 'anthropic' | 'openai';
	model: string;
	maxTokens: number;
	maxWaves: number;
	maxMinutes: number;
	maxFollowups?: number;
	limits: 'recorded' | 'default' | 'off';
}

/** A trial's limits under --limits: undefined is the product's defaults. */
function limitsFor(o: RunOptions, recording?: Recording): TrialConfig['limits'] {
	if (o.limits === 'off') return { steps: 0, costUsd: 0 };
	if (o.limits === 'recorded') return recording?.limits;
	return undefined;
}

/** --limits as the report's settings say it. */
function limitsSetting(o: RunOptions): string {
	if (o.limits === 'off') return 'off';
	if (o.limits === 'recorded') return "each recording's own";
	return 'the product default (60 steps, $2 estimated)';
}

function runOptions(a: Record<string, string>): RunOptions {
	const layer = (a.layer ?? 'L1').toUpperCase() as Layer;
	if (!['L1', 'L2', 'L3'].includes(layer)) throw new Error(`--layer must be L1, L2 or L3 (got ${a.layer})`);
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const provider = (a.provider ?? 'anthropic') as 'anthropic' | 'openai';
	return {
		layer,
		scenarios: a.scenarios ? a.scenarios.split(',').filter(Boolean) : scenarioIds(),
		out: path.resolve(a.out ?? path.join(REPO_ROOT, '.verify/eval', `${layer}-${stamp}`)),
		trials: Number(a.trials ?? 1),
		jobs: Number(a.jobs ?? (layer === 'L1' ? 4 : 1)),
		set: a.set,
		provider,
		model: a.model ?? (provider === 'anthropic' ? standinModel() : 'gpt-5-5'),
		maxTokens: Number(a['max-tokens'] ?? 64000),
		maxWaves: Number(a['max-waves'] ?? 60),
		maxMinutes: Number(a['max-minutes'] ?? 15),
		maxFollowups: a['max-followups'] ? Number(a['max-followups']) : undefined,
		limits: limitsOption(a.limits, layer),
	};
}

function limitsOption(given: string | undefined, layer: Layer): RunOptions['limits'] {
	const limits = given ?? (layer === 'L1' ? 'recorded' : 'default');
	if (limits !== 'recorded' && limits !== 'default' && limits !== 'off') throw new Error(`--limits must be recorded, default or off (got ${limits})`);
	if (limits === 'recorded' && layer !== 'L1') throw new Error('--limits recorded is for L1 replays; L2 and L3 take default or off');
	return limits;
}

/** The model id behind the product's stand-in profile (standin.ts STANDIN_PROFILE), read from the branch. */
function standinModel(): string {
	const src = fs.readFileSync(path.join(REPO_ROOT, 'apps/shared/src/modules/agent/standin.ts'), 'utf8');
	const profile = /STANDIN_PROFILE = '([^']+)'/.exec(src)?.[1] ?? 'claude-sonnet-5';
	const services = fs.readFileSync(path.join(REPO_ROOT, 'nodes/src/nodes/llm_anthropic/services.json'), 'utf8');
	return new RegExp(`"${profile}":\\s*\\{[^}]*?"model":\\s*"([^"]+)"`).exec(services)?.[1] ?? profile;
}

/** Scores one trial record. */
function score(scenario: Scenario, layer: Layer, s: Spawned, outDir: string): ScenarioResult {
	return scoreTrial(scenario, layer, s.record as TrialRecord, path.relative(outDir, s.recordPath));
}

export async function cmdRun(a: Record<string, string>): Promise<number> {
	const o = runOptions(a);
	const startedAt = new Date().toISOString();
	const invalid = invalidData();
	const prov: Provenance = { layer: o.layer, startedAt, checkout: checkout(), model: '', settings: {}, guides: null, engine: null, keys: '', command: `run.ts ${proc.argv.slice(2).join(' ')}` };
	if (invalid.length) {
		for (const v of invalid) log(`INVALID ${v.id}: ${v.problems.join('; ')}`);
		writeReport(o.out, prov, [], [], invalid);
		log(`refusing to run: ${invalid.length} invalid. Report: ${o.out}/report.md`);
		return 2;
	}
	const unknown = o.scenarios.filter((id) => !scenarioIds().includes(id));
	if (unknown.length) throw new Error(`no such scenario: ${unknown.join(', ')}`);
	const results: ScenarioResult[] = [];
	const comparisons: Comparison[] = [];
	const records = path.join(o.out, 'records');

	if (o.layer === 'L1') {
		prov.model = 'replay of recorded replies';
		prov.settings = { maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, limits: limitsSetting(o), set: o.set ?? 'all' };
		prov.engine = 'the eval fake engine (engine.ts): in-memory store, static validate, no pipeline runs';
		prov.keys = 'none (L1 needs no key)';
		const recs = loadRecordings().filter((r) => o.scenarios.includes(r.recording.scenario) && (!o.set || r.recording.set === o.set));
		for (const id of o.scenarios) if (!recs.some((r) => r.recording.scenario === id)) results.push(notRun(loadScenario(id), 'L1', 'no recording to replay', 'replay'));
		await pool(recs, o.jobs, async ({ file, recording }) => {
			const scenario = loadScenario(recording.scenario);
			const label = path.basename(file, '.json');
			const cfg: TrialConfig = { layer: 'L1', scenario: scenario.id, trial: recording.trial, out: path.join(records, `${scenario.id}--${label}.json`), recording: file, maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, limits: limitsFor(o, recording) };
			log(`L1 ${scenario.id} ${label}`);
			const s = await spawnTrial(cfg, keyless());
			if (!s.record) {
				results.push(crashed(scenario, 'L1', recording.trial, label, s));
				return;
			}
			const r = score(scenario, 'L1', s, o.out);
			r.model = `replay ${recording.set}`;
			results.push(r);
			const finalShas = Object.fromEntries(Object.entries(s.record.finalFiles).map(([p, text]) => [p, sha256(text)]));
			comparisons.push(compare(r, recording, label, s.record.replay?.mismatches ?? [], s.record.replay?.diverged ?? null, finalShas));
			if (!prov.guides) prov.guides = s.record.settings.guides;
		});
	} else if (o.layer === 'L2') {
		const source = keySource(o.provider);
		if (source === 'none') throw new Error(`L2 needs a ${o.provider} key: set it in the environment, or install tokenstash`);
		prov.model = `${o.provider}:${o.model} direct, behind the fake engine's stand-in`;
		prov.settings = { maxTokens: o.maxTokens, maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, limits: limitsSetting(o), maxFollowups: o.maxFollowups ?? 'scenario', trials: o.trials, thinking: 'not set (the engine sets none on this path)' };
		prov.engine = 'the eval fake engine (engine.ts): in-memory store, static validate, no pipeline runs';
		prov.keys = source === 'tokenstash' ? `tokenstash in ${keysDir()}, names only` : 'the caller environment, names only';
		const wrap = source === 'tokenstash' ? ['tokenstash', 'run', '--retries', '0', '--'] : [];
		for (const id of o.scenarios) {
			const scenario = loadScenario(id);
			for (let t = 1; t <= o.trials; t++) {
				const cfg: TrialConfig = { layer: 'L2', scenario: id, trial: t, out: path.join(records, `${id}-t${t}.json`), model: { provider: o.provider, model: o.model, maxTokens: o.maxTokens }, maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, maxFollowups: o.maxFollowups, limits: limitsFor(o) };
				log(`L2 ${id} trial ${t} (${o.provider}:${o.model})`);
				const s = await spawnTrial(cfg, source === 'tokenstash' ? keyless() : proc.env, wrap);
				if (!s.record) results.push(crashed(scenario, 'L2', t, o.model, s));
				else {
					results.push(score(scenario, 'L2', s, o.out));
					prov.guides ??= s.record.settings.guides;
				}
			}
		}
	} else {
		// launch refuses when this checkout's engine already runs, and leaves its records; cleanup would stop that engine
		const before = launchRecords();
		try {
			const engine = await startEngine(prov);
			for (const id of o.scenarios) {
				const scenario = loadScenario(id);
				for (let t = 1; t <= o.trials; t++) {
					const cfg: TrialConfig = { layer: 'L3', scenario: id, trial: t, out: path.join(records, `${id}-t${t}.json`), engine: { uri: ENGINE_URI, variables: engine.variables, fingerprints: engine.fingerprints }, maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, maxFollowups: o.maxFollowups, limits: limitsFor(o) };
					log(`L3 ${id} trial ${t}`);
					const s = await spawnTrial(cfg, { ...keyless(), RR_VERIFY_APIKEY: ENGINE_AUTH });
					if (!s.record) results.push(crashed(scenario, 'L3', t, 'stand-in', s));
					else {
						const r = score(scenario, 'L3', s, o.out);
						r.model = String(s.record.settings.standin ?? 'stand-in');
						results.push(r);
						prov.guides ??= s.record.settings.guides;
						prov.model = `${r.model} through the stand-in pipeline on the engine`;
					}
				}
			}
		} finally {
			if (launchRecords() !== before) stopEngine();
		}
		prov.settings = { maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, limits: limitsSetting(o), maxFollowups: o.maxFollowups ?? 'scenario', trials: o.trials };
	}

	results.sort((x, y) => (x.scenario + x.model + x.trial < y.scenario + y.model + y.trial ? -1 : 1));
	comparisons.sort((x, y) => (`${x.scenario} ${x.recording}` < `${y.scenario} ${y.recording}` ? -1 : 1));
	const report = writeReport(o.out, prov, results, comparisons, []);
	const c = counts(results);
	console.log(`${o.layer}: ${STATUSES.map((s) => `${s} ${c[s]}`).join(', ')} (of ${results.length}). Report: ${report}`);
	if (o.layer === 'L1') {
		// a scenario with no recording, or whose trial crashed, has a result and no comparison
		const off = results.filter((r) => !comparisons.some((x) => x.scenario === r.scenario && x.trial === r.trial && reproduces(x)));
		console.log(`L1: ${results.length - off.length} of ${results.length} reproduce their recorded trial${off.length ? `; not: ${off.map((r) => `${r.scenario} (${r.status}: ${r.why.slice(0, 80)})`).join(', ')}` : ''}.`);
		return off.length ? 1 : 0;
	}
	return 0;
}

// =============================================================================
// L3 ENGINE: the verify skill's launcher, held under the 5565 lock
// =============================================================================

/** Starts the branch-built engine with the skill, and fingerprints its Variables in a process that holds the keys. The caller stops the engine it started, whether this throws or not. */
export async function startEngine(prov: Provenance): Promise<{ variables: string[]; fingerprints: string }> {
	if (!proc.env.EVAL_LOCK_HELD) throw new Error('L3 must run under the 5565 lock (run.ts takes it itself; this is a runner bug)');
	log('starting the branch-built engine through the verify skill (rr-verify-agent launch --engine source --engine-only)');
	// the skill's tokenstash runs in RR_VERIFY_KEYS_DIR, so EVAL_KEYS_DIR goes there
	const launched = spawnSync(SKILL, ['launch', '--engine', 'source', '--engine-only'], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...proc.env, RR_VERIFY_KEYS_DIR: keysDir(), RR_VERIFY_LOCK_HELD: '1' } });
	if (launched.status !== 0) throw new Error(`the engine did not start (rr-verify-agent launch exited ${launched.status})`);
	const variables = fs.existsSync(path.join(STATE_DIR, 'engine-vars.txt')) ? fs.readFileSync(path.join(STATE_DIR, 'engine-vars.txt'), 'utf8').split('\n').filter(Boolean) : [];
	const fingerprints = path.join(STATE_DIR, 'eval-fingerprints.json');
	// tokenstash runs in the keys folder, so the command moves back to apps/shared, where tsx resolves
	const made = spawnSync(SKILL, ['keys', 'env', '-C', SHARED_DIR, proc.execPath, '--import', 'tsx', path.join(EVAL_DIR, 'run.ts'), 'fingerprint', fingerprints, ...variables], { cwd: SHARED_DIR, stdio: ['ignore', 'inherit', 'inherit'], env: { ...proc.env, RR_VERIFY_KEYS_DIR: keysDir() } });
	if (made.status !== 0) throw new Error('could not fingerprint the engine Variables');
	let engine: unknown = 'unknown';
	try {
		engine = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'engine.json'), 'utf8'));
	} catch {
		// the launcher writes it; a missing one is reported as unknown
	}
	prov.engine = engine;
	prov.keys = `${fs.existsSync(path.join(STATE_DIR, 'key-source.txt')) ? fs.readFileSync(path.join(STATE_DIR, 'key-source.txt'), 'utf8').trim() : 'unknown'} (to the engine only, by name; trials run with no keys). Variables: ${variables.join(', ') || 'none'}`;
	return { variables, fingerprints };
}

/** The run id or container id launch recorded for the engine it started, which cleanup stops. Each launch records a new one. */
function launchRecords(): string {
	return ['engine.run', 'engine.container'].map((f) => (fs.existsSync(path.join(STATE_DIR, f)) ? fs.readFileSync(path.join(STATE_DIR, f), 'utf8') : '')).join('\n');
}

function stopEngine(): void {
	spawnSync(SKILL, ['cleanup'], { stdio: ['ignore', 'inherit', 'inherit'], env: proc.env });
}

/** Re-runs this command under the 5565 lock, as every engine run on this machine must. */
function underLock(): number {
	log(`taking ${LOCK} (other runs on this machine share port 5565); this waits while another run holds it`);
	const r = spawnSync('flock', [LOCK, proc.execPath, ...proc.execArgv, ...proc.argv.slice(1)], { stdio: 'inherit', env: { ...proc.env, EVAL_LOCK_HELD: '1' } });
	return r.status ?? 2;
}

/** `fingerprint <out> <names...>`: run with the keys in the environment; writes fingerprints, never values. */
function cmdFingerprint(argv: string[]): number {
	const [out, ...names] = argv;
	const prints: Fingerprint[] = names.filter((n) => proc.env[n]).map((n) => fingerprint(n, proc.env[n] as string));
	fs.writeFileSync(out, JSON.stringify(prints));
	console.error(`[eval] fingerprinted ${prints.length} of ${names.length} Variables: ${prints.map((p) => p.name).join(', ') || 'none'}`);
	return 0;
}

// =============================================================================
// RECORD
// =============================================================================

/** `record --from <dir> --set <name>`: each scored L2 trial of a run as an L1 recording. --head names the product commit when the run's own was a local one. */
function cmdRecord(a: Record<string, string>): number {
	if (!a.from || !a.set) throw new Error('record needs --from <an L2 run folder> --set <name>');
	const run = JSON.parse(fs.readFileSync(path.join(a.from, 'results.json'), 'utf8')) as { provenance: Provenance; results: ScenarioResult[] };
	let wrote = 0;
	for (const result of run.results.filter((r) => r.record)) {
		const record = JSON.parse(fs.readFileSync(path.join(a.from, result.record as string), 'utf8')) as TrialRecord;
		const r = fromTrial(record, result, a.set, a.head ?? run.provenance.checkout.commit);
		if (typeof r === 'string') {
			log(`skipped: ${r}`);
			continue;
		}
		const out = path.join(RECORDINGS_DIR, r.scenario, `${a.set}-t${r.trial}.json`);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, JSON.stringify(r, null, '\t') + '\n');
		wrote++;
		log(`wrote ${path.relative(REPO_ROOT, out)} (${r.turns.length} turns, ${r.turns.reduce((n, t) => n + t.events.length, 0)} replies, ${r.expected.status})`);
	}
	console.log(`${wrote} recordings written to ${RECORDINGS_DIR}`);
	return 0;
}

// =============================================================================
// ENTRY
// =============================================================================

async function main(): Promise<number> {
	const [cmd, ...rest] = proc.argv.slice(2);
	const a = args(rest);
	switch (cmd) {
		case 'validate':
			return cmdValidate();
		case 'run':
			if ((a.layer ?? '').toUpperCase() === 'L3' && !proc.env.EVAL_LOCK_HELD) return underLock();
			return cmdRun(a);
		case 'record':
			return cmdRecord(a);
		case 'fingerprint':
			return cmdFingerprint(rest);
		default:
			console.error(
				fs
					.readFileSync(__filename, 'utf8')
					.split('\n')
					.filter((l) => l.startsWith(' *   node'))
					.map((l) => l.slice(3))
					.join('\n')
			);
			return 2;
	}
}

if (require.main === module) {
	main()
		.then((code) => proc.exit(code))
		.catch((err: unknown) => {
			console.error(`[eval] ${err instanceof Error ? err.message : String(err)}`);
			proc.exit(2);
		});
}
