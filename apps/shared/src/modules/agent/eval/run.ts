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
// EVAL RUNNER — shared:eval's entry: validate, run a layer, score, report
// =============================================================================

/**
 * Usage (cwd apps/shared, or through ./builder shared:eval):
 *
 *   node --import tsx src/modules/agent/eval/run.ts validate
 *   node --import tsx src/modules/agent/eval/run.ts run --layer L1 [--scenarios a,b] [--set claude-369f0511] [--jobs 4]
 *   node --import tsx src/modules/agent/eval/run.ts run --layer L2 --scenarios build-01-chat-claude [--provider anthropic] [--model claude-sonnet-5] [--trials 1]
 *   node --import tsx src/modules/agent/eval/run.ts run --layer L3 --scenarios build-01-chat-claude [--trials 1]
 *   node --import tsx src/modules/agent/eval/run.ts selftest [--layer L3]
 *   node --import tsx src/modules/agent/eval/run.ts record --from <baseline runs/<variant> dir> --set <name> --head <sha>
 *   node --import tsx src/modules/agent/eval/run.ts pack <folder> <data/fixtures/name.json>
 *
 * Every run validates all scenarios, fixtures, references and recordings
 * first, and refuses to run when any is invalid, naming each. Output goes to
 * --out (default .verify/eval/<layer>-<time>/ in the checkout): report.md,
 * results.json, human-review.md for ASK, and one record and log per trial.
 *
 * Keys follow the verify skill's rules: the caller's environment, else
 * tokenstash (in EVAL_KEYS_DIR, or RR_VERIFY_KEYS_DIR, or the checkout) when
 * it is installed. L1 needs none. L2 gives the provider key to the trial,
 * whose model calls use it. L3 gives the keys to the engine only, through the
 * skill's launcher; trials run with every key unset. No value is printed or
 * written.
 *
 * Exit codes: 0 done; 1 an L1 replay did not reproduce its baseline, or a
 * self-test failed; 2 invalid scenarios or a runner failure.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { checkApp, type AppCheckResult } from './appCheck';
import { CanaryScanner, checkFingerprints, fingerprint, type Fingerprint } from './canary';
import { DATA_DIR, EVAL_DIR, REPO_ROOT } from './catalog';
import { fromBaselineRecord, loadRecordings, RECORDINGS_DIR, validateRecording, type Recording } from './recordings';
import { compare, counts, STATUSES, writeReport, type Comparison, type Provenance } from './report';
import { expectationFailures, runOutputCheck } from './runOutput';
import { loadScenario, loadTree, referenceTree, scenarioIds, validateAll, validateAppReferences, type Tree } from './scenarios';
import { scoreTrial, sha256, type ScoreContext } from './score';
import type { TrialConfig } from './trial';
import type { Layer, RunOutputResult, Scenario, ScenarioCheck, ScenarioResult, TrialRecord, ValidateResult } from './types';

/** Node's process. The package's global.d.ts declares a browser `process` that has only `env`. */
const proc = process as unknown as NodeJS.Process;

// =============================================================================
// PATHS AND ARGUMENTS
// =============================================================================

const SHARED_DIR = path.join(REPO_ROOT, 'apps/shared');
const SKILL = path.join(REPO_ROOT, '.agents/skills/rr-verify-agent/scripts/rr-verify-agent');
const STATE_DIR = proc.env.RR_VERIFY_STATE ?? path.join(REPO_ROOT, '.verify/agent-state');
const LOCK = proc.env.RR_VERIFY_LOCK ?? '/tmp/rr-verify-5565.lock';
const ENGINE_URI = 'http://127.0.0.1:5565';
const ENGINE_AUTH = proc.env.RR_VERIFY_APIKEY ?? 'local-test';
const KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ROCKETRIDE_ANTHROPIC_KEY', 'ROCKETRIDE_OPENAI_KEY'];
const load = createRequire(__filename);

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
async function invalidData(): Promise<Array<{ id: string; problems: string[] }>> {
	const ids = new Set(scenarioIds());
	const apps = await validateAppReferences([...ids]);
	const bad = validateAll()
		.map((v) => ({ id: v.id, problems: [...v.problems, ...(apps.get(v.id) ?? [])] }))
		.filter((v) => v.problems.length);
	for (const { file, recording } of loadRecordings()) {
		const problems = validateRecording(recording, ids);
		if (problems.length) bad.push({ id: `recording ${path.relative(RECORDINGS_DIR, file)}`, problems });
	}
	return bad;
}

async function cmdValidate(): Promise<number> {
	const all = validateAll();
	const bad = await invalidData();
	const apps = await validateAppReferences(all.map((v) => v.id));
	for (const v of all) {
		const problems = [...v.problems, ...(apps.get(v.id) ?? [])];
		const appRefs = loadScenario(v.id).checks.filter((c) => c.kind === 'check_app_passes').length;
		console.log(`${problems.length ? 'INVALID' : 'ok     '} ${v.id.padEnd(34)} reference ${v.reference ? `${v.reference.passed}/${v.reference.counted} static checks` : 'none'}${appRefs ? `, app check ${apps.has(v.id) ? 'fails' : 'passes'}` : ''}${problems.length ? `: ${problems.join('; ')}` : ''}`);
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
 * Runs one trial in its own process, as the baseline harness did.
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

/** The app checks a trial's score needs: every app the run changed, and every app a check names. */
async function appChecksFor(scenario: Scenario, record: TrialRecord): Promise<Record<string, AppCheckResult>> {
	const apps = new Set<string>();
	for (const f of new Set([...Object.keys(record.finalFiles), ...Object.keys(record.fixtureFiles)])) {
		const app = /^(apps\/[^/]+)\//.exec(f)?.[1];
		if (app && record.finalFiles[f] !== record.fixtureFiles[f] && f in record.finalFiles) apps.add(app);
	}
	for (const ck of scenario.checks) if (ck.kind === 'check_app_passes') apps.add(String(ck.app));
	const out: Record<string, AppCheckResult> = {};
	for (const app of apps) out[app] = await checkApp(record.finalFiles, app);
	return out;
}

/** A scenario that ran no trial in this layer, and why. */
function notRun(scenario: Scenario, layer: Layer, why: string, model: string): ScenarioResult {
	return { scenario: scenario.id, type: scenario.type, layer, trial: 0, model, status: 'pending', why, checks: [], blockersFired: [], counted: { passed: 0, total: 0, pending: 0, soft: 0, notInLayer: 0 }, diagnostics: {}, record: null };
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
	standin?: string;
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
		standin: a.standin,
	};
}

/** The model id behind the product's stand-in profile (standin.ts STANDIN_PROFILE), read from the branch. */
function standinModel(): string {
	const src = fs.readFileSync(path.join(REPO_ROOT, 'apps/shared/src/modules/agent/standin.ts'), 'utf8');
	const profile = /STANDIN_PROFILE = '([^']+)'/.exec(src)?.[1] ?? 'claude-sonnet-5';
	const services = fs.readFileSync(path.join(REPO_ROOT, 'nodes/src/nodes/llm_anthropic/services.json'), 'utf8');
	return new RegExp(`"${profile}":\\s*\\{[^}]*?"model":\\s*"([^"]+)"`).exec(services)?.[1] ?? profile;
}

/** Scores one trial record, with its app checks and, for L1, the recorded engine verdicts. */
async function score(scenario: Scenario, layer: Layer, s: Spawned, outDir: string, verdicts?: Record<string, ValidateResult>): Promise<ScenarioResult> {
	const record = s.record as TrialRecord;
	const apps = await appChecksFor(scenario, record);
	const ctx: ScoreContext = { appChecks: Object.fromEntries(Object.entries(apps).map(([k, v]) => [k, { ok: v.ok, detail: v.detail }])), recordedVerdicts: verdicts ? new Map(Object.entries(verdicts)) : undefined };
	const result = scoreTrial(scenario, layer, record, ctx, path.relative(outDir, s.recordPath));
	result.diagnostics.appChecks = Object.fromEntries(Object.entries(apps).map(([k, v]) => [k, { types: v.types.ok, build: v.build.ok, detail: v.detail }]));
	return result;
}

async function cmdRun(a: Record<string, string>): Promise<number> {
	const o = runOptions(a);
	const startedAt = new Date().toISOString();
	const invalid = await invalidData();
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
		prov.settings = { maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, set: o.set ?? 'all' };
		prov.engine = 'the eval fake engine (engine.ts): in-memory store, static validate, no pipeline runs';
		prov.keys = 'none (L1 needs no key)';
		const recs = loadRecordings().filter((r) => o.scenarios.includes(r.recording.scenario) && (!o.set || r.recording.set === o.set));
		for (const id of o.scenarios) if (!recs.some((r) => r.recording.scenario === id)) results.push(notRun(loadScenario(id), 'L1', 'no recording to replay', 'replay'));
		await pool(recs, o.jobs, async ({ file, recording }) => {
			const scenario = loadScenario(recording.scenario);
			const label = path.basename(file, '.json');
			const cfg: TrialConfig = { layer: 'L1', scenario: scenario.id, trial: recording.trial, out: path.join(records, `${scenario.id}--${label}.json`), recording: file, maxWaves: o.maxWaves, maxMinutes: o.maxMinutes };
			log(`L1 ${scenario.id} ${label}`);
			const s = await spawnTrial(cfg, keyless());
			if (!s.record) {
				results.push(crashed(scenario, 'L1', recording.trial, label, s));
				return;
			}
			const r = await score(scenario, 'L1', s, o.out, recording.verdicts);
			r.model = `replay ${recording.set}`;
			results.push(r);
			const finalShas = Object.fromEntries(Object.entries(s.record.finalFiles).map(([p, text]) => [p, sha256(text)]));
			comparisons.push(compare(r, recording, label, s.record.replay?.callMismatches.length ?? 0, s.record.replay?.diverged ?? null, finalShas));
			if (!prov.guides) prov.guides = s.record.settings.guides;
		});
	} else if (o.layer === 'L2') {
		const source = keySource(o.provider);
		if (source === 'none') throw new Error(`L2 needs a ${o.provider} key: set it in the environment, or install tokenstash`);
		prov.model = `${o.provider}:${o.model} direct, behind the fake engine's stand-in`;
		prov.settings = { maxTokens: o.maxTokens, maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, maxFollowups: o.maxFollowups ?? 'scenario', trials: o.trials, thinking: 'not set (the engine sets none on this path)' };
		prov.engine = 'the eval fake engine (engine.ts): in-memory store, static validate, no pipeline runs';
		prov.keys = source === 'tokenstash' ? `tokenstash in ${keysDir()}, names only` : 'the caller environment, names only';
		const wrap = source === 'tokenstash' ? ['tokenstash', 'run', '--retries', '0', '--'] : [];
		for (const id of o.scenarios) {
			const scenario = loadScenario(id);
			if (!scenario.layers.includes('L2')) {
				results.push(notRun(scenario, 'L2', `not an L2 scenario (layers: ${scenario.layers.join(', ')})`, o.model));
				continue;
			}
			for (let t = 1; t <= o.trials; t++) {
				const cfg: TrialConfig = { layer: 'L2', scenario: id, trial: t, out: path.join(records, `${id}-t${t}.json`), model: { provider: o.provider, model: o.model, maxTokens: o.maxTokens }, maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, maxFollowups: o.maxFollowups };
				log(`L2 ${id} trial ${t} (${o.provider}:${o.model})`);
				const s = await spawnTrial(cfg, source === 'tokenstash' ? keyless() : proc.env, wrap);
				if (!s.record) results.push(crashed(scenario, 'L2', t, o.model, s));
				else {
					results.push(await score(scenario, 'L2', s, o.out));
					prov.guides ??= s.record.settings.guides;
				}
			}
		}
	} else {
		const engine = await startEngine(prov);
		try {
			for (const id of o.scenarios) {
				const scenario = loadScenario(id);
				if (!scenario.layers.includes('L3')) {
					results.push(notRun(scenario, 'L3', `not an L3 scenario (layers: ${scenario.layers.join(', ')})`, 'stand-in'));
					continue;
				}
				for (let t = 1; t <= o.trials; t++) {
					const standin = o.standin ? { provider: o.standin.split(':')[0], profile: o.standin.split(':')[1], key: o.standin.startsWith('llm_openai') ? 'ROCKETRIDE_OPENAI_KEY' : 'ROCKETRIDE_ANTHROPIC_KEY' } : undefined;
					const cfg: TrialConfig = { layer: 'L3', scenario: id, trial: t, out: path.join(records, `${id}-t${t}.json`), engine: { uri: ENGINE_URI, auth: ENGINE_AUTH, variables: engine.variables, fingerprints: engine.fingerprints, standin }, maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, maxFollowups: o.maxFollowups };
					log(`L3 ${id} trial ${t}`);
					const s = await spawnTrial(cfg, keyless());
					if (!s.record) results.push(crashed(scenario, 'L3', t, 'stand-in', s));
					else {
						const r = await score(scenario, 'L3', s, o.out);
						r.model = String(s.record.settings.standin ?? 'stand-in');
						results.push(r);
						prov.guides ??= s.record.settings.guides;
						prov.model = `${r.model} through the stand-in pipeline on the engine`;
					}
				}
			}
		} finally {
			stopEngine();
		}
		prov.settings = { maxWaves: o.maxWaves, maxMinutes: o.maxMinutes, maxFollowups: o.maxFollowups ?? 'scenario', trials: o.trials, services: proc.env.EVAL_SERVICES ?? 'none' };
	}

	results.sort((x, y) => (x.scenario + x.model + x.trial < y.scenario + y.model + y.trial ? -1 : 1));
	comparisons.sort((x, y) => (`${x.scenario} ${x.recording}` < `${y.scenario} ${y.recording}` ? -1 : 1));
	const report = writeReport(o.out, prov, results, comparisons, []);
	const c = counts(results);
	console.log(`${o.layer}: ${STATUSES.map((s) => `${s} ${c[s]}`).join(', ')} (of ${results.length}). Report: ${report}`);
	if (o.layer === 'L1') {
		const off = comparisons.filter((x) => x.differ.length || x.diverged || x.callMismatches || !x.finalFiles.same);
		console.log(`L1 against the baseline: ${comparisons.length - off.length} of ${comparisons.length} replays reproduce their recorded score${off.length ? `; differ: ${off.map((x) => `${x.scenario} ${x.recording}`).join(', ')}` : ''}.`);
		return off.length ? 1 : 0;
	}
	return 0;
}

// =============================================================================
// L3 ENGINE — the verify skill's launcher, held under the 5565 lock
// =============================================================================

/** Starts the branch-built engine with the skill, and fingerprints its Variables in a process that holds the keys. */
async function startEngine(prov: Provenance): Promise<{ variables: string[]; fingerprints: string }> {
	if (!proc.env.EVAL_LOCK_HELD) throw new Error('L3 must run under the 5565 lock (run.ts takes it itself; this is a runner bug)');
	log('starting the branch-built engine through the verify skill (rr-verify-agent launch --engine source --engine-only)');
	const launched = spawnSync(SKILL, ['launch', '--engine', 'source', '--engine-only'], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...proc.env, RR_VERIFY_LOCK_HELD: '1' } });
	if (launched.status !== 0) {
		stopEngine();
		throw new Error(`the engine did not start (rr-verify-agent launch exited ${launched.status})`);
	}
	const variables = fs.existsSync(path.join(STATE_DIR, 'engine-vars.txt')) ? fs.readFileSync(path.join(STATE_DIR, 'engine-vars.txt'), 'utf8').split('\n').filter(Boolean) : [];
	const fingerprints = path.join(STATE_DIR, 'eval-fingerprints.json');
	// tokenstash runs in the keys folder, so the command moves back to apps/shared, where tsx resolves
	const made = spawnSync(SKILL, ['keys', 'env', '-C', SHARED_DIR, proc.execPath, '--import', 'tsx', path.join(EVAL_DIR, 'run.ts'), 'fingerprint', fingerprints, ...variables], { cwd: SHARED_DIR, stdio: ['ignore', 'inherit', 'inherit'], env: proc.env });
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
	const prints: Fingerprint[] = names.filter((n) => proc.env[n]).map((n) => fingerprint(n, '$VARIABLE_VALUES', proc.env[n] as string));
	fs.writeFileSync(out, JSON.stringify(prints));
	console.error(`[eval] fingerprinted ${prints.length} of ${names.length} Variables: ${prints.map((p) => p.name).join(', ') || 'none'}`);
	return 0;
}

// =============================================================================
// SELF-TEST — each new check passes its control and catches its planted failure
// =============================================================================

interface SelfCase {
	check: string;
	case: string;
	expect: string;
	got: string;
	ok: boolean;
	detail: string;
}

async function cmdSelftest(a: Record<string, string>): Promise<number> {
	const layer = (a.layer ?? 'offline').toUpperCase();
	const out = path.resolve(a.out ?? path.join(REPO_ROOT, '.verify/eval', `selftest-${layer.toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
	fs.mkdirSync(out, { recursive: true });
	const cases: SelfCase[] = [];
	const add = (check: string, name: string, expect: string, got: string, detail: string) => {
		cases.push({ check, case: name, expect, got, ok: expect === got, detail });
		log(`${expect === got ? 'ok  ' : 'FAIL'} ${check} ${name}: expected ${expect}, got ${got}. ${detail}`);
	};

	if (layer !== 'L3') {
		// canary_absent, unit: each surface on its own, and a control
		const scenario = loadScenario('secret-01-inline-key-describe');
		const ck = scenario.checks.find((c) => c.kind === 'canary_absent') as ScenarioCheck;
		const all: ScenarioCheck = { ...ck, surfaces: ['model_questions', 'thinking', 'final_text', 'session_json', 'catalog', 'workspace_files'] };
		const prints = checkFingerprints({ ...scenario, checks: [all] }, [])?.get(ck.id) ?? [];
		const value = scenario.fixture.canaries?.CANARY_OPENAI ?? '';
		const clean = new CanaryScanner(all, prints);
		for (const s of all.surfaces as string[]) clean.scan(s, `nothing secret on ${s}: sk-proj-notTheCanary and ${value.slice(0, 10)}`);
		const cr = clean.result();
		add('canary_absent', 'unit control: six surfaces, no canary', 'pass', cr.hits.length ? 'fail' : 'pass', `${cr.scanned.length} surfaces scanned, ${cr.values} values`);
		for (const s of all.surfaces as string[]) {
			const planted = new CanaryScanner(all, prints);
			for (const t of all.surfaces as string[]) planted.scan(t, t === s ? `before ${value} after` : 'clean text');
			const pr = planted.result();
			const where = pr.hits.map((h) => `${h.canary} on ${h.surface}`).join(', ');
			add('canary_absent', `unit planted on ${s}`, 'fail', pr.hits.length > 0 && pr.hits.every((h) => h.surface === s) ? 'fail' : 'pass', where || 'no hit');
		}
		// canary_absent, end to end: a real L1 trial that reads the inline key, and one that does not
		for (const [file, expect] of [
			['secret-01-control.json', 'pass'],
			['secret-01-leak.json', 'fail'],
		] as const) {
			const rec = path.join(EVAL_DIR, 'data/selftest', file);
			const cfg: TrialConfig = { layer: 'L1', scenario: 'secret-01-inline-key-describe', trial: 1, out: path.join(out, 'records', file), recording: rec, maxWaves: 60, maxMinutes: 15 };
			const s = await spawnTrial(cfg, keyless());
			const scan = s.record?.canary?.[ck.id];
			const got = !scan ? 'error' : scan.hits.length ? 'fail' : scan.missing.length ? 'pending' : 'pass';
			add('canary_absent', `end to end ${file.replace('.json', '')} (L1 trial, real agent and session save)`, expect, got, scan ? `hits: ${scan.hits.map((h) => `${h.canary} on ${h.surface} x${h.count}`).join(', ') || 'none'}; scanned ${scan.scanned.join(', ')}${scan.missing.length ? `; unreadable ${scan.missing.map((m) => m.surface).join(', ')}` : ''}` : `no record, see ${s.logPath}`);
		}

		// check_app_passes: a reference app, a planted type error, a planted build failure
		const daybook = referenceTree(loadScenario('build-11-app-daybook')) as Tree;
		const c1 = await checkApp(daybook, 'apps/daybook-ui');
		add('check_app_passes', 'control: build-11 reference app', 'pass', c1.ok ? 'pass' : 'fail', c1.detail);
		const broken = loadTree('fixtures/notes-app-broken') as Tree;
		const c2 = await checkApp(broken, 'apps/notes-ui');
		add('check_app_passes', 'planted type errors: edit-08 fixture', 'fail', c2.ok ? 'pass' : 'fail', c2.detail.split('\n')[0]);
		const askclaude = { ...(referenceTree(loadScenario('build-13-app-ask-claude')) as Tree) };
		delete askclaude['apps/askclaude-ui/src/ask.pipe'];
		const c3 = await checkApp(askclaude, 'apps/askclaude-ui');
		// the plant is in the build step alone, so the types must pass and the build must fail
		const buildOnly = c3.types.ok && c3.build.ok === false;
		add('check_app_passes', 'planted build failure: build-13 reference without src/ask.pipe (types pass, the import does not resolve)', 'fail', c3.ok ? 'pass' : buildOnly ? 'fail' : 'failed on types, not the build', `types ${c3.types.ok ? 'pass' : 'fail'}; ${c3.detail.split('\n').slice(0, 2).join(' ')}`);

		// the validator: a copy of the data with three planted defects is refused, and each is named
		const copy = fs.mkdtempSync(path.join(out, 'data-'));
		fs.cpSync(DATA_DIR, copy, { recursive: true });
		const edit = (id: string, change: (s: Record<string, unknown>) => void) => {
			const file = path.join(copy, 'scenarios', `${id}.json`);
			const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
			change(s);
			fs.writeFileSync(file, JSON.stringify(s));
		};
		edit('build-01-chat-claude', (s) => (s.checks as ScenarioCheck[]).push({ id: 'typo', kind: 'file_exits', path: 'pipelines/x.pipe' }));
		edit('edit-01-switch-model', (s) => ((s.fixture as Record<string, unknown>).workspace = 'fixtures/no-such-fixture'));
		const refFile = path.join(copy, 'references', 'build-02-summarize-webhook.json');
		const ref = JSON.parse(fs.readFileSync(refFile, 'utf8')) as { files: Tree };
		ref.files['pipelines/summarize-text.pipe'] = ref.files['pipelines/summarize-text.pipe'].replace('"webhook"', '"webhoook"');
		fs.writeFileSync(refFile, JSON.stringify(ref));
		const v = spawnSync(proc.execPath, ['--import', 'tsx', path.join(EVAL_DIR, 'run.ts'), 'validate'], { cwd: SHARED_DIR, env: { ...proc.env, EVAL_DATA_DIR: copy }, encoding: 'utf8' });
		const named = ['build-01-chat-claude', 'edit-01-switch-model', 'build-02-summarize-webhook'].filter((id) => new RegExp(`^INVALID ${id}`, 'm').test(v.stdout));
		add(
			'validator',
			'planted: an unknown check kind, a missing fixture, a reference that fails its own check',
			'refused, 3 named',
			v.status === 2 ? `refused, ${named.length} named` : `exit ${v.status}`,
			v.stdout
				.split('\n')
				.filter((l) => l.startsWith('INVALID'))
				.map((l) => l.slice(0, 160))
				.join(' / ')
		);
		const accepted = spawnSync(proc.execPath, ['--import', 'tsx', path.join(EVAL_DIR, 'run.ts'), 'validate'], { cwd: SHARED_DIR, encoding: 'utf8' });
		add('validator', 'control: the committed data', 'accepted', accepted.status === 0 ? 'accepted' : `exit ${accepted.status}`, accepted.stdout.trim().split('\n').at(-1) ?? '');
		fs.rmSync(copy, { recursive: true, force: true });

		// run_output, offline: the expectation rules on planted outputs
		const pong = loadScenario('build-01-chat-claude').checks.find((c) => c.kind === 'run_output') as ScenarioCheck;
		const es = loadScenario('build-05-translate-spanish').checks.find((c) => c.kind === 'run_output') as ScenarioCheck;
		const rules: Array<[string, ScenarioCheck, string[], string]> = [
			['control: "pong"', pong, ['pong'], 'pass'],
			['planted: "ping"', pong, ['ping'], 'fail'],
			['control: a Spanish greeting', es, ['Buenos días. ¿A qué hora abre la biblioteca?'], 'pass'],
			['planted: an English answer instead of a translation', es, ['Good morning! The library opens at 9 am.'], 'fail'],
			['planted: an English answer, then the translation', es, ['Good morning! It depends on the library.', 'Buenos días. ¿A qué hora abre la biblioteca?'], 'fail'],
		];
		for (const [name, ck2, answers, expect] of rules) {
			const fails = expectationFailures(ck2.expect as Record<string, unknown>, { answers, text: [] }, 40);
			add('run_output', `rules ${name}`, expect, fails.length ? 'fail' : 'pass', fails.join('; ') || 'all expectations hold');
		}
	} else {
		if (!proc.env.EVAL_LOCK_HELD) return underLock();
		const prov: Provenance = { layer: 'L3', startedAt: new Date().toISOString(), checkout: checkout(), model: '', settings: {}, guides: null, engine: null, keys: '', command: 'selftest --layer L3' };
		const engine = await startEngine(prov);
		try {
			const { RocketRideClient } = load('rocketride') as { RocketRideClient: new (o: Record<string, unknown>) => import('rocketride').RocketRideClient };
			const client = new RocketRideClient({ uri: ENGINE_URI, env: {}, module: 'eval-selftest' });
			await client.connect(ENGINE_AUTH);
			const runCase = async (name: string, scenarioId: string, files: Tree, expect: string, as?: ScenarioCheck) => {
				const ck = as ?? (loadScenario(scenarioId).checks.find((c) => c.kind === 'run_output') as ScenarioCheck);
				const tokens: string[] = [];
				const r: RunOutputResult = await runOutputCheck(client, ck, files, engine.variables, tokens);
				for (const t of tokens) await client.terminate(t).catch(() => undefined);
				add('run_output', name, expect, r.status, `${r.detail}${r.excerpt ? `; output: ${r.excerpt.slice(0, 120)}` : ''}`);
			};
			const es = loadScenario('build-05-translate-spanish').checks.find((c) => c.kind === 'run_output') as ScenarioCheck;
			await runCase('control: build-01 reference, "Reply with the single word pong."', 'build-01-chat-claude', referenceTree(loadScenario('build-01-chat-claude')) as Tree, 'pass');
			// on this engine the build-05 reference returns two answers, the model's own English answer and then the translation, so it fails
			await runCase('finding: build-05 reference on the branch-built engine (answers the question and translates it)', 'build-05-translate-spanish', referenceTree(loadScenario('build-05-translate-spanish')) as Tree, 'fail');
			const chatOnly = referenceTree(loadScenario('build-01-chat-claude')) as Tree;
			await runCase("planted: build-01's plain chat pipeline saved as translate-es.pipe, under build-05's check", 'build-05-translate-spanish', { 'pipelines/translate-es.pipe': chatOnly['pipelines/support-chat.pipe'] }, 'fail', es);
			await runCase('pending: build-08, its audio input is not recorded yet', 'build-08-transcribe-audio', referenceTree(loadScenario('build-08-transcribe-audio')) as Tree, 'pending');
			await runCase('pending: build-03, needs a Chroma server', 'build-03-rag-chroma', referenceTree(loadScenario('build-03-rag-chroma')) as Tree, 'pending');
			await client.disconnect().catch(() => undefined);
		} finally {
			stopEngine();
		}
		fs.writeFileSync(path.join(out, 'engine.json'), JSON.stringify(prov.engine, null, 2));
	}
	fs.writeFileSync(path.join(out, 'selftest.json'), JSON.stringify(cases, null, 2));
	const md = ['# Check self-test', '', `Checkout ${git('rev-parse', 'HEAD')}, ${new Date().toISOString()}.`, '', '| check | case | expected | got | ok | detail |', '| --- | --- | --- | --- | --- | --- |', ...cases.map((c) => `| ${c.check} | ${c.case} | ${c.expect} | ${c.got} | ${c.ok ? 'yes' : 'NO'} | ${c.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)} |`)];
	fs.writeFileSync(path.join(out, 'selftest.md'), md.join('\n') + '\n');
	const bad = cases.filter((c) => !c.ok);
	console.log(`self-test: ${cases.length - bad.length} of ${cases.length} cases as expected. ${out}/selftest.md`);
	return bad.length ? 1 : 0;
}

// =============================================================================
// RECORD AND PACK
// =============================================================================

function cmdRecord(a: Record<string, string>): number {
	if (!a.from || !a.set || !a.head) throw new Error('record needs --from <dir> --set <name> --head <sha>');
	let wrote = 0;
	for (const f of fs.readdirSync(a.from).sort()) {
		if (!f.endsWith('.json') || f.endsWith('.checks.json')) continue;
		const r = fromBaselineRecord(path.join(a.from, f), a.set, a.head);
		if (typeof r === 'string') {
			log(`skipped ${f}: ${r}`);
			continue;
		}
		const out = path.join(RECORDINGS_DIR, r.scenario, `${a.set}-t${r.trial}.json`);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, JSON.stringify(r, null, '\t') + '\n');
		wrote++;
		log(`wrote ${path.relative(REPO_ROOT, out)} (${r.turns.length} turns, ${r.turns.reduce((n, t) => n + t.events.length, 0)} replies, ${r.retriesNotReplayed} retries not replayed)`);
	}
	console.log(`${wrote} recordings written to ${RECORDINGS_DIR}`);
	return 0;
}

/** `pack <folder> <out.json>`: a workspace folder as a fixture or reference pack. */
function cmdPack(argv: string[]): number {
	const [dir, out] = argv;
	const files: Record<string, string> = {};
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) walk(full);
			else files[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
		}
	};
	walk(dir);
	fs.writeFileSync(out, JSON.stringify({ files }, null, '\t') + '\n');
	console.log(`${Object.keys(files).length} files packed into ${out}`);
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
		case 'selftest':
			return cmdSelftest(a);
		case 'record':
			return cmdRecord(a);
		case 'pack':
			return cmdPack(rest);
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

export type { Recording };
