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
// TRIAL: one conversation with the agent, in its own process
// =============================================================================

/**
 * One trial: one scenario, one conversation, up to the scenario's follow-ups.
 *
 * What is real, in every layer: the chat turn (the shell's TurnController,
 * which owns rows, Stop and the "Needs your OK" cards), AgentSession and its
 * session storage, agent() with its stand-in model pipeline, runAgent, the
 * Wave loop, every toolkit, the approval list, the save hook, and the
 * rocket-ui workspace with its read-only `.rocketride/` guides.
 *
 * What differs by layer is the client behind all of it:
 * - L1 and L2: the fake engine (engine.ts). Its stand-in chat asks a replay of
 *   recorded replies (L1) or a live provider (L2). The guides come from this
 *   checkout's docs/agents/context, zipped the way the server serves them.
 * - L3: a RocketRideClient connected to the branch-built engine, whose
 *   stand-in pipeline calls the model. The guides come from the engine's
 *   /client/docs.
 *
 * Not real: the shell around the chat (shell-stub.cjs), Monaco's markers
 * (none), and app scaffolding, packing and dev sessions (none).
 *
 * Recording only wraps; it never changes what the agent sees. The harness
 * stop (60 waves or 15 minutes per turn) presses Stop. The agent's own step
 * limit (60 by default) pauses a turn before the harness's wave stop, so
 * that stop fires only when the limits are off, as for a replay recorded
 * before the agent had them.
 *
 * Each turn's TurnResult (outcome, reason, usage with the estimated cost,
 * what it asks) goes into the record. A turn ask_user ended counts as asking;
 * a turn a limit paused ends the trial, since Continue is the user's call.
 *
 * Usage (cwd apps/shared; run.ts starts it):
 *   node --require ./scripts/stub-css.cjs --require <eval>/shell-stub.cjs --import tsx <eval>/trial.ts --config <file>
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { RocketRideClient } from 'rocketride';
import type { ChatAskAnswer, ChatMessage } from 'shell/src/components/chat/types';
import { TurnController } from 'shell/src/components/chat/turns/turnController';

import { isReferencePath } from '../../vfs/referenceTree';
import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { AgentSession } from '../agent';
import { DEFAULT_LIMITS, setAgentHost, type AgentLimits } from '../host';
import { CheckRecord } from '../run';
import { validateSaved } from '../toolkits/appCheck';
import { TurnError, type TurnResult } from '../turn';
import { CanaryScanner, fingerprint, scrubDeep, syntheticVariables, type Fingerprint } from './canary';
import { REPO_ROOT } from './catalog';
import { createFakeEngine, type ModelAnswer, type ModelQuestion } from './engine';
import { costOf, liveModel, ReplayModel, type LiveModelSpec } from './models';
import { callDigest, mismatches, stableJson, type Recording } from './recordings';
import { endOwnedRuns, runOutputCheck, type OwnedRun } from './runOutput';
import { CHANGE_TOOLS, sha256 } from './score';
import { loadScenario } from './scenarios';
import type { Layer, ModelCallRecord, RecordedCall, Scenario, TrialRecord, TurnRecord, TurnResultRecord } from './types';

/** Node's process. The package's global.d.ts declares a browser `process` that has only `env`. */
const proc = process as unknown as NodeJS.Process;

// =============================================================================
// CONFIG
// =============================================================================

/** What run.ts hands a trial, as a JSON file. */
export interface TrialConfig {
	layer: Layer;
	scenario: string;
	trial: number;
	/** Where the record goes. */
	out: string;
	/** L1: the recording file. */
	recording?: string;
	/** L2: the live model. */
	model?: LiveModelSpec;
	/** L3: the engine and what the runner knows about it. Its API key comes in RR_VERIFY_APIKEY, so no file holds it. */
	engine?: { uri: string; variables: string[]; fingerprints?: string };
	maxWaves: number;
	maxMinutes: number;
	/** Overrides each `asks` follow-up's max. */
	maxFollowups?: number;
	/** The agent's step and cost limits for each turn (0 is off). Unset: the product's defaults (host.ts DEFAULT_LIMITS). */
	limits?: AgentLimits;
}

/** The app id that namespaces the sessions, the Pipeline Builder's (the Agent tab's host). */
const SESSIONS_APP_ID = 'rocketride.pipeBuilder';

/** The text sent after a turn that stopped with an error. */
const RETRY_REPLY = 'That stopped with an error. Please continue where you left off.';
const FIRST_OPTION = 'Use the first option you listed.';

/** A model or engine failure that is the infrastructure's, not the model's: errors are left out of the denominator. */
const INFRA = /\b(5\d\d|overloaded|rate.?limit|429|ECONN\w*|socket hang up|Connection closed|connect(ion)? (refused|reset|timed out)|APIConnectionError|InternalServerError|fetch failed|not connected)\b/i;

const load = createRequire(__filename);

// =============================================================================
// RECORD
// =============================================================================

function newTurn(n: number, request: string): TurnRecord {
	return {
		turn: n,
		request,
		waves: 0,
		endedOnItsOwn: false,
		harnessStop: null,
		runError: null,
		wallMs: 0,
		modelCalls: [],
		modelErrors: [],
		calls: [],
		refusals: [],
		thinking: [],
		finalText: '',
		repeats: [],
		toolErrors: 0,
		gateStateWriteFailures: 0,
		changed: false,
		asked: null,
		finishedAfter: false,
		reply: null,
		followupKind: null,
		result: null,
		replies: [],
	};
}

/** GATE_STATE.md and .context/ always fail: the workspace has no such root. Counted apart from tool errors. */
const GATE_STATE = /(^|\/)\.context(\/|$)|GATE_STATE/i;

function closeTurn(t: TurnRecord): void {
	const seen = new Map<string, { tool: string; args: string; count: number; waves: number[] }>();
	for (const c of t.calls) {
		if (c.late) continue;
		const key = `${c.tool}\u0000${stableJson(c.args)}`;
		const s = seen.get(key) ?? { tool: c.tool, args: stableJson(c.args).slice(0, 300), count: 0, waves: [] };
		s.count += 1;
		s.waves.push(c.wave);
		seen.set(key, s);
	}
	t.repeats = [...seen.values()].filter((s) => s.count > 1);
	const failed = t.calls.filter((c) => c.error !== undefined);
	const isGate = (c: RecordedCall) => GATE_STATE.test(String(c.args?.path ?? c.args?.from ?? c.args?.to ?? ''));
	t.gateStateWriteFailures = failed.filter(isGate).length;
	t.toolErrors = failed.length - t.gateStateWriteFailures;
	t.changed = t.calls.some((c) => CHANGE_TOOLS.has(c.tool) && c.error === undefined && !isGate(c));
}

// =============================================================================
// ASKING AND FINISHED
// =============================================================================

const CHECKS_LINE = /^(?:Checked|Not checked)[*_]*:/;
const APPROVAL = /\b(approve|approval|confirm|proceed|go ahead|shall i|should i|would you like|do you want|let me know|which (one|option)|choose|prefer|ok to|okay to|sign[- ]off|gate [a-c])\b/i;
const OPTION_LINE = /^\s*(?:\d+[.)]|[-*•]|\(?[a-c]\)|option [a-z0-9]+[:.)]?)\s+\S/i;

function answerBody(finalText: string): string {
	return finalText
		.split('\n')
		.filter((l) => !CHECKS_LINE.test(l.replace(/^[\s>*+_-]+/, '')))
		.join('\n')
		.trim();
}

/** Whether a turn ended asking, and which rule said so. */
function detectAsk(t: TurnRecord): { rule: string; options: boolean } | null {
	const body = answerBody(t.finalText);
	if (!body) return null;
	const lines = body.split('\n').filter((l) => l.trim());
	const last = lines[lines.length - 1] ?? '';
	const tail = body.slice(-800);
	const options = lines.filter((l) => OPTION_LINE.test(l)).length >= 2 && /\b(option|which|choose|prefer|or)\b/i.test(tail);
	if (!t.changed && last.includes('?')) return { rule: 'question-last-line', options };
	if (/\?/.test(tail) && APPROVAL.test(tail)) return { rule: 'approval-question', options };
	if (APPROVAL.test(tail)) return { rule: 'approval-words', options };
	return null;
}

// =============================================================================
// THE GUIDES: what /client/docs serves
// =============================================================================

/** This checkout's guide bundle, zipped as the server's docs.zip is: the root-level files of docs/agents/context. */
function branchDocsZip(): { zip: Uint8Array; files: Record<string, string> } {
	const fflate = load(load.resolve('fflate', { paths: [path.join(REPO_ROOT, 'apps/rocket-ui/src')] })) as { zipSync: (f: Record<string, Uint8Array>) => Uint8Array; strToU8: (s: string) => Uint8Array };
	const dir = path.join(REPO_ROOT, 'docs/agents/context');
	const files: Record<string, string> = {};
	for (const name of fs.readdirSync(dir).sort()) if (name.endsWith('.md')) files[name] = fs.readFileSync(path.join(dir, name), 'utf8');
	return { zip: fflate.zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, fflate.strToU8(v)]))), files };
}

/** The guide bundle's identity: one digest over every file's name and sha256. */
function bundleId(files: Record<string, string>): { digest: string; files: number } {
	const lines = Object.keys(files)
		.sort()
		.map((k) => `${k} ${sha256(files[k])}`);
	return { digest: sha256(lines.join('\n')), files: lines.length };
}

// =============================================================================
// MAIN
// =============================================================================

async function main(cfg: TrialConfig, record: TrialRecord): Promise<void> {
	const t0 = performance.now();
	const scenario: Scenario = loadScenario(cfg.scenario);
	record.prompt = scenario.prompt;

	// step: the client, and the run's Variables as fingerprints (values stay in the engine)
	let client: RocketRideClient;
	let variablePrints: Fingerprint[] = [];
	let replay: ReplayModel | null = null;
	let recording: Recording | null = null;
	let liveUsage = false;
	if (cfg.layer === 'L3') {
		const engine = cfg.engine;
		if (!engine) throw new Error('L3 needs an engine');
		const { RocketRideClient: Client } = load('rocketride') as { RocketRideClient: new (o: Record<string, unknown>) => RocketRideClient };
		// env: {} so the client sends no ROCKETRIDE_* values of its own, as in the browser
		client = new Client({ uri: engine.uri, env: {}, module: 'eval-runner' });
		await client.connect(proc.env.RR_VERIFY_APIKEY);
		variablePrints = engine.fingerprints ? (JSON.parse(fs.readFileSync(engine.fingerprints, 'utf8')) as Fingerprint[]) : [];
		record.engineVariables = engine.variables;
		try {
			record.engine = await (await fetch(`${engine.uri}/version`)).json();
		} catch {
			// informational
		}
	} else {
		const names = [...new Set(['ROCKETRIDE_ANTHROPIC_KEY', 'ROCKETRIDE_OPENAI_KEY', ...scenario.variables])];
		const variables = syntheticVariables(names);
		variablePrints = Object.entries(variables).map(([name, value]) => fingerprint(name, value));
		let model: (q: ModelQuestion) => Promise<ModelAnswer>;
		if (cfg.layer === 'L1') {
			recording = JSON.parse(fs.readFileSync(cfg.recording ?? '', 'utf8')) as Recording;
			replay = new ReplayModel(recording.turns);
			model = replay.answer;
		} else {
			if (!cfg.model) throw new Error('L2 needs a model');
			model = liveModel(cfg.model);
			liveUsage = true;
			// the provider key this process holds is scanned for too, though no Variable carries it
			for (const name of ['ANTHROPIC_API_KEY', 'ROCKETRIDE_ANTHROPIC_KEY', 'OPENAI_API_KEY', 'ROCKETRIDE_OPENAI_KEY']) {
				const value = proc.env[name];
				if (value) variablePrints.push(fingerprint(`provider key ${name}`, value));
			}
		}
		const fake = createFakeEngine({ variables, model });
		client = fake.client;
		record.engineVariables = names;
		record.engine = { fake: true, version: 'eval-fake-engine' };
	}
	record.variablesMissing = scenario.variables.filter((v) => !record.engineVariables.includes(v));
	(globalThis as Record<string, unknown>).__evalClient = client;

	// step: the guides. /client/docs is a same-origin path in the browser; here it goes to the engine (L3) or to this checkout's bundle
	const branch = branchDocsZip();
	const realFetch = globalThis.fetch;
	let served: Record<string, string> | null = cfg.layer === 'L3' ? null : branch.files;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (!url.startsWith('/')) return realFetch(input, init);
		if (cfg.layer === 'L3') return realFetch(`${cfg.engine?.uri}${url}`, init);
		if (url.startsWith('/client/docs')) return new Response(branch.zip.slice().buffer, { status: 200, headers: { 'content-type': 'application/zip' } });
		return new Response('not found', { status: 404 });
	}) as typeof fetch;
	if (cfg.layer === 'L3') {
		try {
			const fflate = load(load.resolve('fflate', { paths: [path.join(REPO_ROOT, 'apps/rocket-ui/src')] })) as { unzipSync: (z: Uint8Array) => Record<string, Uint8Array>; strFromU8: (u: Uint8Array) => string };
			const zip = new Uint8Array(await (await realFetch(`${cfg.engine?.uri}/client/docs`)).arrayBuffer());
			served = Object.fromEntries(
				Object.entries(fflate.unzipSync(zip))
					.filter(([k]) => !k.includes('/') && k.endsWith('.md'))
					.map(([k, v]) => [k, fflate.strFromU8(v)])
			);
		} catch (err) {
			served = null;
			record.settings.guidesError = String(err);
		}
	}
	const branchId = bundleId(branch.files);
	const servedId = served ? bundleId(served) : null;
	record.settings.guides = { source: cfg.layer === 'L3' ? 'engine /client/docs' : 'checkout docs/agents/context', ...(servedId ?? { digest: null, files: 0 }), branchDigest: branchId.digest, matchesBranch: servedId?.digest === branchId.digest };

	// step: the workspace, the real one, over the client's store
	const wsModule = load(path.join(REPO_ROOT, 'apps/rocket-ui/src/surfaces/workspace/vfs/workspace.ts')) as {
		createWorkspace: (o: { hostAppId: string; autoCommit: boolean; scope?: unknown }) => Promise<{ view: IWorkspaceFileSystem }>;
		resolveWorkspaceScope: (auth: unknown) => { kind: string; teamId?: string };
	};
	const scope = wsModule.resolveWorkspaceScope(client.getAccountInfo() ?? null);
	record.scope = scope;
	if (cfg.layer === 'L3') await wipeStore(client, scope);
	const ws = await wsModule.createWorkspace({ hostAppId: 'eval.runner', autoCommit: true, scope });
	const view = ws.view;
	await view.refresh();

	// step: the turn limits the host serves; without them every turn gets the product's defaults
	const limits = cfg.limits;
	record.settings.limits = limits ?? { ...DEFAULT_LIMITS, source: 'product default' };
	const host = { vfs: view, scaffoldApp: notHere('scaffoldApp'), packApp: notHere('packApp'), devSession: () => null, ...(limits ? { limits: { read: () => limits } } : {}) };
	setAgentHost(host);
	AgentSession.configure(SESSIONS_APP_ID);
	const session = AgentSession.newSession();

	// step: canary scanners, one per canary_absent check; model questions are scanned as they go out
	const scanners = new Map(scenario.checks.filter((c) => c.kind === 'canary_absent').map((ck) => [ck.id, new CanaryScanner(ck, variablePrints)]));
	const scanAll = (surface: string, text: string) => {
		for (const s of scanners.values()) s.scan(surface, text);
	};

	// step: recording hooks (wrap, never change)
	let turn = newTurn(0, '');
	let wave = -1;
	let controller: TurnController | null = null;
	const proto = CheckRecord.prototype;
	const beginWave = proto.beginWave;
	proto.beginWave = function (this: CheckRecord, w: number) {
		wave = w;
		turn.waves = w + 1;
		if (w >= cfg.maxWaves && !turn.harnessStop) {
			turn.harnessStop = 'waves';
			controller?.stop();
		}
		return beginWave.call(this, w);
	};
	const endWave = proto.endWave;
	proto.endWave = function (this: CheckRecord, calls: Array<{ tool: string; args: Record<string, unknown>; result?: string; error?: string; late?: true }>) {
		for (const c of calls) turn.calls.push({ wave, tool: c.tool, args: c.args, error: c.error, late: c.late, resultChars: c.result?.length, argsHash: callDigest(c.args), resultHash: callDigest(c.error ?? c.result ?? '') });
		return endWave.call(this, calls);
	};
	const unchecked = proto.unchecked;
	proto.unchecked = function (this: CheckRecord) {
		const text = unchecked.call(this);
		if (text) turn.refusals.push({ wave, text });
		return text;
	};
	const owned: OwnedRun[] = [];
	wrapClient(
		client,
		cfg,
		record,
		owned,
		() => turn,
		() => wave,
		scanAll,
		session.sessionId
	);

	// step: the chat. Cards are answered no, and recorded
	const answer: ChatAskAnswer = 'deny';
	const answered = new Set<number>();
	// execute hands back how the turn ended; the chat renders only the rows, as AgentConversation does
	let ended: TurnResult[] = [];
	const execute = (text: string, onStatus?: (type: string, content: string) => void, chatTurn?: Parameters<AgentSession['execute']>[2]) =>
		session.execute(text, onStatus, chatTurn).then(
			({ results, turn: result }) => {
				ended.push(result);
				return results;
			},
			(err: unknown) => {
				if (err instanceof TurnError) ended.push(err.turn);
				throw err;
			}
		);
	controller = new TurnController({ request: () => execute, stopGraceMs: 3000 });
	const chat = controller;
	chat.subscribe(() => {
		for (const ask of chat.snapshot().asks) {
			if (answered.has(ask.id)) continue;
			answered.add(ask.id);
			record.confirms.push({ title: ask.card.title, answer });
			queueMicrotask(() => chat.answerAsk(ask.id, answer as Exclude<ChatAskAnswer, 'stopped'>));
		}
	});

	const asksMax = cfg.maxFollowups ?? scenario.followup.max;
	let asksSent = 0;
	let cutByLimit = false;
	let request = cfg.layer === 'L1' ? (replay?.request(0) ?? scenario.prompt) : scenario.prompt;

	for (let n = 1; ; n++) {
		turn = newTurn(n, request);
		wave = -1;
		record.turns.push(turn);
		replay?.beginTurn();
		ended = [];
		const turnsBefore = session.turns.length;
		const before = chat.snapshot().messages.length;
		const started = performance.now();
		chat.send(request);
		const timer = setTimeout(() => {
			turn.harnessStop = 'time';
			chat.stop();
		}, cfg.maxMinutes * 60_000);
		await untilIdle(chat);
		clearTimeout(timer);
		turn.wallMs = Math.round(performance.now() - started);
		const rows = chat.snapshot().messages.slice(before);
		readTurnRows(turn, rows);
		turn.endedOnItsOwn = turn.harnessStop === null;
		closeTurn(turn);
		for (const text of turn.thinking) scanAll('thinking', text);
		if (turn.finalText) scanAll('final_text', turn.finalText);
		for (const s of scanners.values()) s.empty('final_text');

		// step: the chat saves after every exchange, as the provider does
		try {
			await session.save(chat.snapshot().messages);
			record.session = { saved: true, messages: chat.snapshot().messages.length };
		} catch (err) {
			record.session = { saved: false, error: String(err instanceof Error ? err.message : err).slice(0, 300), messages: chat.snapshot().messages.length };
		}
		// step: how the product says the turn ended: execute's result, or the session's for a message it refused
		const result = ended.at(-1) ?? session.turns.slice(turnsBefore).at(-1);
		turn.result = result ? turnResultRecord(result) : null;
		saveRecord(cfg, record);

		if (turn.harnessStop) {
			record.endReason = `harness stop (${turn.harnessStop})`;
			break;
		}
		// step: ask_user ended the turn, so it asked, whatever its text says
		turn.asked = result?.reason === 'needs_input' ? { rule: 'ask_user', options: (result.request?.choices?.length ?? 0) >= 2 } : detectAsk(turn);
		turn.finishedAfter = await isFinished(view, client, result);

		// step: a limit paused the turn. Continue would start a fresh budget, which the user grants, not the scenario.
		// A replay it cuts short has replies left, which is the limit's doing, not a replay that left its recording
		const paused = result?.reason === 'limited' || result?.reason === 'cost_limit';
		if (replay && replay.left() > 0 && !replay.diverged) {
			replay.diverged = paused ? `turn ${n} paused at the ${result.reason === 'limited' ? 'step' : 'cost'} limit with ${replay.left()} recorded replies unused` : `turn ${n} ended with ${replay.left()} recorded replies unused`;
			cutByLimit = paused;
		}
		if (paused) {
			record.endReason = `paused at the ${result.reason === 'limited' ? 'step' : 'cost'} limit: ${result.request?.question ?? result.reason}`;
			break;
		}

		// step: L1 follows the recording's turns; L2 and L3 follow the scenario
		if (replay) {
			const next = replay.request(n);
			if (next === null) {
				record.finished = turn.finishedAfter;
				record.endReason = turn.finishedAfter ? 'finished' : turn.asked ? 'asked; the recording ends here' : 'the recording ends here';
				break;
			}
			request = next;
			turn.reply = next;
			continue;
		}
		if (turn.finishedAfter) {
			record.finished = true;
			record.endReason = 'finished';
			break;
		}
		if (result ? result.outcome === 'failed' : turn.runError) {
			if (asksSent >= asksMax) {
				record.endReason = `error after ${asksSent} follow-ups`;
				break;
			}
			request = RETRY_REPLY;
			turn.reply = request;
			turn.followupKind = 'retry';
			record.retryTurns += 1;
			asksSent += 1;
			continue;
		}
		if (!turn.asked) {
			record.endReason = 'ended without asking';
			break;
		}
		if (asksSent >= asksMax) {
			record.endReason = `still asking after ${asksSent} follow-ups`;
			break;
		}
		request = turn.asked.options ? `${FIRST_OPTION} ${scenario.followup.text}` : scenario.followup.text;
		turn.reply = request;
		turn.followupKind = 'approval';
		record.approvalTurns += 1;
		asksSent += 1;
	}

	record.totalWallMs = Math.round(performance.now() - t0);

	// step: the end state: every workspace file outside .rocketride/, and every .pipe validated
	await view.refresh();
	const files = view
		.listEntries()
		.filter((e) => e.type !== 'dir')
		.map((e) => e.path)
		.filter((p) => p && !isReferencePath(p) && !p.endsWith('/.dirmarker') && p !== '.dirmarker');
	for (const p of files) {
		const v = await view.read(p);
		const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
		if (text.length <= 400_000) record.finalFiles[p] = text;
		if (p.endsWith('.pipe')) record.pipes.push({ path: p, validate: await validateSaved(() => client, view, p) });
	}
	for (const text of Object.values(record.finalFiles)) scanAll('workspace_files', text);
	for (const s of scanners.values()) s.empty('workspace_files');

	// step: the saved session and its catalog, read back from the store
	try {
		scanAll('session_json', await client.fsReadString(`.agents/${SESSIONS_APP_ID}/${session.sessionId}.json`));
	} catch (err) {
		for (const s of scanners.values()) s.unreadable('session_json', record.session.error ?? String(err instanceof Error ? err.message : err).slice(0, 200));
	}
	try {
		scanAll('catalog', await client.fsReadString(`.agents/${SESSIONS_APP_ID}/catalog.json`));
	} catch (err) {
		for (const s of scanners.values()) s.unreadable('catalog', String(err instanceof Error ? err.message : err).slice(0, 200));
	}
	for (const [id, s] of scanners) record.canary[id] = s.result();

	// step: run_output, L3 only: the runner starts the saved pipeline itself
	if (cfg.layer === 'L3') {
		for (const ck of scenario.checks.filter((c) => c.kind === 'run_output')) {
			record.runOutput[ck.id] = await runOutputCheck(client, ck, record.finalFiles, record.engineVariables, owned);
		}
	}
	await endOwnedRuns(client, owned);

	// step: what the record says about itself
	record.totalModelMs = record.turns.reduce((n, t) => n + t.modelCalls.reduce((m, c) => m + c.ms, 0), 0);
	if (liveUsage) {
		const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		for (const t of record.turns) {
			for (const c of t.modelCalls) {
				tokens.input += c.usage?.input ?? 0;
				tokens.output += c.usage?.output ?? 0;
				tokens.cacheRead += c.usage?.cacheRead ?? 0;
				tokens.cacheWrite += c.usage?.cacheWrite ?? 0;
			}
		}
		record.tokens = tokens;
		record.costUsd = costOf(cfg.model?.model ?? '', tokens);
	}
	record.shellMissing = ((globalThis as Record<string, unknown>).__evalShellMissing as string[]) ?? [];
	const infra = record.turns.flatMap((t) => [t.runError ?? '', ...t.modelErrors.map((e) => e.message)]).find((m) => m && INFRA.test(m));
	if (infra) record.infraError = `the model or engine failed: ${infra.slice(0, 240)}`;
	if (replay) {
		record.replay = { recording: path.basename(cfg.recording ?? ''), consumed: replay.consumed, recorded: replay.recorded, diverged: replay.diverged, mismatches: mismatches(recording?.turns ?? [], record.turns) };
		if (replay.diverged && !cutByLimit) record.infraError = `the replay left its recording: ${replay.diverged}`;
	}
	saveRecord(cfg, record);
	try {
		if (cfg.layer === 'L3') await client.disconnect();
	} catch {
		// exiting anyway
	}
}

// =============================================================================
// PIECES
// =============================================================================

/**
 * How the product says a turn ended, for the record: its TurnResult without
 * the answer, which the turn record already holds, and with the runs it
 * started as a count.
 *
 * @param result - The turn's result.
 * @returns The part the record keeps.
 */
function turnResultRecord(result: TurnResult): TurnResultRecord {
	const { turnId: _id, messageId: _row, finalText: _text, runsStarted, ...rest } = result;
	return { ...rest, runsStarted: runsStarted?.length ?? 0 };
}

/** A host step the eval has no stand-in for. */
function notHere(what: string): () => Promise<never> {
	return async () => {
		throw new Error(`${what} is not available in the eval runner`);
	};
}

/** Resolves when the chat's turn slot is idle again. */
function untilIdle(chat: TurnController): Promise<void> {
	return new Promise((resolve) => {
		const check = () => {
			if (chat.snapshot().phase === 'idle') {
				off();
				resolve();
			}
		};
		const off = chat.subscribe(check);
		setTimeout(check, 0);
	});
}

/** Reads one turn's rows: thinking rows, the answer, an error, the card rows. */
function readTurnRows(turn: TurnRecord, rows: ChatMessage[]): void {
	for (const row of rows) {
		if (row.sender === 'status' && row.sseType === 'thinking') turn.thinking.push(row.text);
		else if (row.sender === 'bot' && row.isError) turn.runError = row.text.slice(0, 2000);
		else if (row.sender === 'bot' && !row.resultKey) turn.finalText = row.text;
	}
}

/** Whether a turn finished the task: its TurnResult is done, and every .pipe validates. */
async function isFinished(view: IWorkspaceFileSystem, client: RocketRideClient, result: TurnResult | undefined): Promise<boolean> {
	if (result?.outcome !== 'done') return false;
	await view.refresh();
	const pipes = view
		.listEntries()
		.filter((e) => e.type !== 'dir' && e.path.endsWith('.pipe') && !isReferencePath(e.path))
		.map((e) => e.path);
	for (const p of pipes) {
		const v = await validateSaved(() => client, view, p);
		if (!('errors' in v) || v.errors.length) return false;
	}
	return true;
}

/** Empties the workspace's store folders in this scope (L3: a fresh engine store still gets a clean start). */
async function wipeStore(client: RocketRideClient, scope: { kind: string; teamId?: string }): Promise<void> {
	const root = `${scope.kind === 'team' ? `@/Team/=${scope.teamId}/` : ''}.projects`;
	let entries: Array<{ name: string; type: string }> = [];
	try {
		entries = (await client.fsListDir(root)).entries ?? [];
	} catch {
		return;
	}
	for (const e of entries) {
		const p = `${root}/${e.name}`;
		if (e.type === 'dir') await client.fsRmdir(p, true);
		else await client.fsDelete(p);
	}
}

/**
 * Wraps the client's chat and use: every model question is measured and
 * scanned; the stand-in is found by its project id (the session id); every
 * run a `use` started is kept in `owned`, so the trial ends it.
 */
function wrapClient(client: RocketRideClient, cfg: TrialConfig, record: TrialRecord, owned: OwnedRun[], turnOf: () => TurnRecord, waveOf: () => number, scan: (surface: string, text: string) => void, conversationId: string): void {
	const c = client as unknown as Record<string, (o: Record<string, unknown>) => Promise<Record<string, unknown>>>;
	const use = c.use.bind(client);
	c.use = async (o) => {
		const pipeline = o?.pipeline as Record<string, unknown> | undefined;
		const isStandin = !!pipeline && pipeline.project_id === conversationId;
		if (isStandin) {
			const llm = (pipeline.components as Array<{ provider: string; config: { profile: string } }>).find((x) => String(x.provider).startsWith('llm_'));
			if (llm) record.settings.standin = `${llm.provider}:${llm.config.profile}`;
		}
		const t = turnOf();
		try {
			const r = await use(o);
			// as the product's run ledger does (toolkits/rocketrideClient.ts): only a run use did not reuse is this trial's
			if (r?.reused === false && typeof r.token === 'string') {
				try {
					owned.push({ token: r.token, startTime: Number((await client.getTaskStatus(r.token)).startTime) });
				} catch {
					// no start time, so not provably this trial's
				}
			}
			return r;
		} catch (err) {
			if (isStandin) t.modelErrors.push({ kind: 'use-threw', wave: waveOf(), callIndex: t.modelCalls.length, message: String(err instanceof Error ? err.message : err).slice(0, 2000) });
			throw err;
		}
	};
	const chat = c.chat.bind(client);
	c.chat = async (o) => {
		const t = turnOf();
		const t0 = performance.now();
		let questionText = '';
		try {
			questionText = JSON.stringify(o?.question);
		} catch {
			// not serializable
		}
		scan('model_questions', questionText);
		const rec: ModelCallRecord = { ms: 0, questionChars: questionText.length, answerChars: 0 };
		t.modelCalls.push(rec);
		try {
			const r = await chat(o);
			const first = (r?.answers as unknown[] | undefined)?.[0];
			const text = typeof first === 'string' ? first : JSON.stringify(first ?? '');
			rec.ms = Math.round(performance.now() - t0);
			rec.answerChars = text.length;
			if (r?.usage) rec.usage = r.usage as ModelCallRecord['usage'];
			// the plan question marks its stable start for caching; the best-effort question does not
			if (cfg.layer === 'L2') t.replies.push((o?.question as { cachePrefix?: boolean } | undefined)?.cachePrefix === true ? { wave: waveOf(), reply: text } : { bestEffort: text });
			if (text.startsWith('**LLM error** — ')) {
				rec.error = text.slice(0, 2000);
				t.modelErrors.push({ kind: 'llm-error-answer', wave: waveOf(), callIndex: t.modelCalls.length - 1, message: rec.error });
			}
			return r;
		} catch (err) {
			rec.ms = Math.round(performance.now() - t0);
			rec.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
			t.modelErrors.push({ kind: 'chat-threw', wave: waveOf(), callIndex: t.modelCalls.length - 1, message: rec.error });
			throw err;
		}
	};
}

/** Writes the record, with key-shaped strings blanked (canary.ts scrub). */
function saveRecord(cfg: TrialConfig, record: TrialRecord): void {
	fs.mkdirSync(path.dirname(cfg.out), { recursive: true });
	fs.writeFileSync(cfg.out, JSON.stringify(scrubDeep(record), null, 2));
}

// =============================================================================
// ENTRY
// =============================================================================

function emptyRecord(cfg: TrialConfig): TrialRecord {
	return {
		harness: 'eval-v5',
		layer: cfg.layer,
		scenario: cfg.scenario,
		prompt: '',
		trial: cfg.trial,
		startedAt: new Date().toISOString(),
		model: cfg.layer === 'L1' ? `replay:${path.basename(cfg.recording ?? '')}` : cfg.layer === 'L2' ? `${cfg.model?.provider}:${cfg.model?.model}` : 'stand-in on the engine',
		settings: { maxWaves: cfg.maxWaves, maxMinutes: cfg.maxMinutes, maxFollowups: cfg.maxFollowups ?? 'scenario', ...(cfg.model ? { provider: cfg.model.provider, maxTokens: cfg.model.maxTokens } : {}) },
		engine: null,
		engineVariables: [],
		variablesMissing: [],
		scope: null,
		maxFollowups: cfg.maxFollowups ?? -1,
		turns: [],
		approvalTurns: 0,
		retryTurns: 0,
		finished: false,
		endReason: '',
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
	};
}

if (require.main === module) {
	const at = proc.argv.indexOf('--config');
	const cfg = JSON.parse(fs.readFileSync(proc.argv[at + 1], 'utf8')) as TrialConfig;
	const record = emptyRecord(cfg);
	main(cfg, record)
		.then(() => proc.exit(0))
		.catch((err: unknown) => {
			record.infraError = `runner error: ${String(err instanceof Error ? (err.stack ?? err.message) : err).slice(0, 2000)}`;
			saveRecord(cfg, record);
			proc.exit(1);
		});
}
