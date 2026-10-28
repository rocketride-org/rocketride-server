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
// LIMIT TESTS — the step limit, the usage meter and the cost limit
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CachedVfs } from 'shell/src/modules/explorer/CachedVfs';
import type { IVirtualFileSystem } from 'shell/src/modules/explorer/types';

import { StagedFileSystem } from '../vfs/stagedFileSystem';
import type { AgentHost, AgentLimits, ApprovalPrefs, ApprovalSettings } from './host';
import { BUILDER_PROMPTS } from './prompts';
import { createChatModel, runAgent, type ChatClient } from './run';
import { CONTINUE, turnCard, usageMeta, type TurnResult } from './turn';
import { CostLimitError, OUTPUT_ALLOWANCE_TOKENS, UsageMeter, type PriceRow } from './usage';
import type { ModelCall, QuestionSpec } from './wave/plan';

// =============================================================================
// HELPERS
// =============================================================================

/** The role of the best-effort question (wave/loop.ts), which tells a summary from a plan. */
const SUMMARY_ROLE = 'You are a helpful assistant.';

/** The stand-in's model, whose row the table has: $2 in, $2.50 cache write, $0.20 cache read, $10 out. */
const SONNET = 'claude-sonnet-5';

/** A store backend in memory, enough for reads. */
function memoryBackend(seed: Record<string, string>): IVirtualFileSystem {
	const files = new Map(Object.entries(seed));
	return {
		list: async () => [...files.keys()].map((name) => ({ name, type: 'file' as const })),
		read: async (path) => {
			if (!files.has(path)) throw new Error(`No such file: ${path}`);
			return files.get(path);
		},
		write: async (path, content) => {
			files.set(path, String(content));
		},
		rename: async () => undefined,
		delete: async (path) => {
			files.delete(path);
		},
		mkdir: async () => undefined,
	};
}

/** A model that answers from a script and keeps every question; running out throws. */
function scriptedModel(replies: Array<string | (() => Promise<string>)>): ModelCall & { questions: QuestionSpec[] } {
	const queue = [...replies];
	const questions: QuestionSpec[] = [];
	const call: ModelCall = async (q) => {
		questions.push(q);
		const next = queue.shift();
		if (next === undefined) throw new Error('scriptedModel: no reply left');
		return typeof next === 'function' ? next() : next;
	};
	return Object.assign(call, { questions });
}

/** A reply asking for tool calls. */
function plan(...calls: Array<[tool: string, args?: Record<string, unknown>]>): string {
	return JSON.stringify({ thought: 'working', tool_calls: calls.map(([tool, args]) => ({ tool, args: args ?? {} })) });
}

/** A reply that finishes with `answer`. */
function done(answer: string): string {
	return JSON.stringify({ thought: 'finishing', done: true, answer });
}

/** Approval settings in Auto. */
function autoSettings(): ApprovalSettings {
	const prefs: ApprovalPrefs = { mode: 'auto', grants: { schedules: false, deploymentToggles: false } };
	return { read: () => prefs, subscribe: () => () => undefined, grant: () => undefined };
}

/**
 * Runs one turn over a workspace holding a.txt and b.txt, with the given limits.
 *
 * @param model - The scripted model.
 * @param opts - The limits, the model's name for its price, messages the user sends during the turn (one per take), Auto, and the turn's Stop.
 * @returns The turn.
 */
async function turnWith(model: ModelCall, opts: { limits: AgentLimits; modelName?: string; steer?: string[][]; auto?: boolean; signal?: AbortSignal }): Promise<TurnResult> {
	const vfs = new StagedFileSystem(new CachedVfs(memoryBackend({ 'a.txt': 'alpha', 'b.txt': 'beta' })), null, { writeThrough: true });
	const settings = opts.auto ? autoSettings() : undefined;
	const host: AgentHost = {
		vfs,
		scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }),
		packApp: async () => new Uint8Array(),
		devSession: () => null,
		limits: { read: () => opts.limits },
		...(settings ? { approvals: { run: settings, controls: { ...settings, setMode: () => undefined } } } : {}),
	};
	const steer = [...(opts.steer ?? [])];
	const options = { history: [], prompts: BUILDER_PROMPTS, token: async () => 'tk', signal: opts.signal ?? new AbortController().signal, takeQueued: () => steer.shift() ?? [], conversationId: 'conv-1', model: opts.modelName };
	return runAgent('Read the files.', () => undefined, options, { host, client: () => null, model, markers: async () => null, currentScope: () => '' });
}

/** A question whose start (role and history) is 800 characters and whose rest (goal, context, question) is 800. */
function question(cachePrefix: boolean): QuestionSpec {
	return { role: 'r'.repeat(400), instructions: [], history: [{ role: 'user', content: 'h'.repeat(400) }], goals: ['g'.repeat(200)], context: ['c'.repeat(200)], question: 'q'.repeat(400), expectJson: false, cachePrefix };
}

/** Two amounts equal to a billionth of a dollar. */
function sameUsd(actual: number | undefined, expected: number, message?: string): void {
	assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${message ?? 'usd'}: ${actual} is not ${expected}`);
}

// =============================================================================
// THE STEP LIMIT
// =============================================================================

test('at the step limit the turn plans no more, answers with the best effort, and pauses for Continue', async () => {
	const model = scriptedModel([plan(['read_file', { path: 'a.txt' }]), plan(['read_file', { path: 'b.txt' }]), plan(['read_file', { path: 'a.txt' }]), 'I read a.txt and b.txt; the rest is left.']);
	const turn = await turnWith(model, { limits: { steps: 3, costUsd: 0 }, modelName: SONNET });
	assert.deepEqual({ outcome: turn.outcome, reason: turn.reason, waves: turn.usage.waves, finalText: turn.finalText }, { outcome: 'needs_input', reason: 'limited', waves: 3, finalText: 'I read a.txt and b.txt; the rest is left.' });
	assert.equal(model.questions.length, 4, 'three plans and the summary');
	assert.equal(model.questions[3].role, SUMMARY_ROLE, 'the fourth question is the best-effort summary, not a plan');
	assert.deepEqual({ kind: turn.request?.kind, question: turn.request?.question }, { kind: 'continue', question: 'Paused after 3 steps' });
	const card = turnCard(turn);
	assert.deepEqual({ title: card.title, lines: card.lines, actions: card.actions }, { title: 'Paused after 3 steps', lines: ['Continue starts a new turn with a fresh budget.'], actions: [{ id: CONTINUE, label: 'Continue' }] });
});

test('a one-step limit pauses after 1 step, in the singular', async () => {
	const model = scriptedModel([plan(['read_file', { path: 'a.txt' }]), 'I read a.txt.']);
	const turn = await turnWith(model, { limits: { steps: 1, costUsd: 0 }, modelName: SONNET });
	assert.deepEqual({ reason: turn.reason, question: turn.request?.question, title: turnCard(turn).title }, { reason: 'limited', question: 'Paused after 1 step', title: 'Paused after 1 step' });
});

test('messages the user sends during a turn do not reset its step count', async () => {
	const model = scriptedModel([plan(['read_file', { path: 'a.txt' }]), plan(['read_file', { path: 'b.txt' }]), plan(['read_file', { path: 'a.txt' }]), 'Paused here.']);
	// step: a message arrives at the second and the third wave
	const turn = await turnWith(model, { limits: { steps: 3, costUsd: 0 }, steer: [[], ['Also look at b.txt.'], ['And a.txt again.']] });
	assert.deepEqual({ reason: turn.reason, waves: turn.usage.waves }, { reason: 'limited', waves: 3 });
	assert.equal(model.questions[3].role, SUMMARY_ROLE, 'the turn paused after three waves, steers and all');
	assert.match(model.questions[3].context.join('\n'), /Also look at b\.txt\.[\s\S]*And a\.txt again\./, 'the summary still reads both messages');
});

test('a Stop while the step-limit summary is written ends the turn stopped, with no Continue', async () => {
	const stop = new AbortController();
	const model = scriptedModel([
		plan(['read_file', { path: 'a.txt' }]),
		async () => {
			stop.abort();
			return 'Paused here.';
		},
	]);
	const turn = await turnWith(model, { limits: { steps: 1, costUsd: 0 }, signal: stop.signal });
	assert.equal(model.questions[1].role, SUMMARY_ROLE, 'the Stop came during the summary');
	assert.deepEqual({ outcome: turn.outcome, reason: turn.reason, request: turn.request, title: turnCard(turn).title, actions: turnCard(turn).actions }, { outcome: 'stopped', reason: 'stopped', request: undefined, title: 'Stopped', actions: undefined });
});

test('a step limit of 0 is no limit', async () => {
	const reads = Array.from({ length: 5 }, () => plan(['read_file', { path: 'a.txt' }]));
	const model = scriptedModel([...reads, done('Read a.txt five times.')]);
	const turn = await turnWith(model, { limits: { steps: 0, costUsd: 0 } });
	assert.deepEqual({ outcome: turn.outcome, waves: turn.usage.waves, request: turn.request }, { outcome: 'done', waves: 6, request: undefined });
});

// =============================================================================
// THE METER
// =============================================================================

test('without the cache discount, every input token is at the full rate, and a reply replaces the output allowance', () => {
	const meter = new UsageMeter({ model: SONNET });
	const held = meter.reserve(question(false));
	// 1,600 characters in: 400 tokens at $2 per million, and the 8,192-token allowance at $10 per million
	sameUsd(meter.snapshot().usd, (400 * 2 + OUTPUT_ALLOWANCE_TOKENS * 10) / 1e6, 'reserved');
	held.settle(400);
	assert.deepEqual({ ...meter.snapshot(), usd: undefined }, { requests: 1, inputTokens: 400, outputTokens: 100, usd: undefined });
	sameUsd(meter.snapshot().usd, (400 * 2 + 100 * 10) / 1e6, 'settled');
	// step: the row caches, but a question that does not ask gets no discount
	const again = meter.reserve(question(false));
	again.settle(0);
	sameUsd(meter.snapshot().usd, (400 * 2 + 100 * 10 + 400 * 2) / 1e6, 'a second question without cachePrefix');
});

test('with the cache discount, the first request writes the start at 1.25 times the input rate, later ones read it, and after a gap over five minutes it is written again', () => {
	let now = 0;
	const meter = new UsageMeter({ model: SONNET, now: () => now });
	const cost = (): number => meter.snapshot().usd ?? NaN;
	meter.reserve(question(true)).settle(0);
	// the start (200 tokens) at $2.50, the rest (200 tokens) at $2
	sameUsd(cost(), (200 * 2.5 + 200 * 2) / 1e6, 'first: a write');
	now += 4 * 60_000;
	meter.reserve(question(true)).settle(0);
	sameUsd(cost(), (200 * 2.5 + 200 * 2 + 200 * 0.2 + 200 * 2) / 1e6, 'four minutes on: a read');
	now += 5 * 60_000 + 1;
	meter.reserve(question(true)).settle(0);
	sameUsd(cost(), (200 * 2.5 + 200 * 2 + 200 * 0.2 + 200 * 2 + 200 * 2.5 + 200 * 2) / 1e6, 'over five minutes on: a write again');

	// step: a provider whose row says it does not cache gets the full rate, even when the question asks
	const plain: PriceRow[] = [{ model: 'plain-model', input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10, cachesPrefix: false }];
	const other = new UsageMeter({ model: 'plain-model', prices: plain });
	other.reserve(question(true)).settle(0);
	other.reserve(question(true)).settle(0);
	sameUsd(other.snapshot().usd, (2 * 400 * 2) / 1e6, 'no cache rates');
});

test('a request that failed keeps its whole reservation', () => {
	const meter = new UsageMeter({ model: SONNET });
	meter.reserve(question(false)).keep();
	assert.deepEqual({ requests: meter.snapshot().requests, outputTokens: meter.snapshot().outputTokens }, { requests: 1, outputTokens: OUTPUT_ALLOWANCE_TOKENS });
	sameUsd(meter.snapshot().usd, (400 * 2 + OUTPUT_ALLOWANCE_TOKENS * 10) / 1e6);
});

test('the reservation refuses a request that could pass the limit, so it is never sent; the retry after a pipeline restart is reserved too', async () => {
	// step: one reservation fits under $0.10; a second does not while the first, which failed, keeps its own
	const meter = new UsageMeter({ model: SONNET, limitUsd: 0.1 });
	let chats = 0;
	let restarts = 0;
	const client: ChatClient = {
		chat: async () => {
			chats++;
			throw new Error('socket closed');
		},
	};
	const model = createChatModel({ client: () => client, token: async () => 'tk', toQuestion: (q) => q, onPipelineError: async () => void restarts++, meter });
	await assert.rejects(model(question(false)), (err: unknown) => {
		assert.ok(err instanceof CostLimitError, `a ${String(err)}`);
		assert.match(err.message, /^the next model request could pass this turn's cost limit of \$0\.10 \(~\$0\.08 est\. so far\)$/);
		return true;
	});
	assert.deepEqual({ chats, restarts, requests: meter.snapshot().requests }, { chats: 1, restarts: 1, requests: 1 });
});

test('the cost limit ends the turn as needs_input with Continue, even in Auto; the best-effort summary is reserved and refused too', async () => {
	const model = scriptedModel([plan(['read_file', { path: 'a.txt' }])]);
	const turn = await turnWith(model, { limits: { steps: 60, costUsd: 0.01 }, modelName: SONNET, auto: true });
	assert.equal(model.questions.length, 0, 'no request was sent: neither the plan nor the summary');
	assert.deepEqual({ outcome: turn.outcome, reason: turn.reason, kind: turn.request?.kind, question: turn.request?.question }, { outcome: 'needs_input', reason: 'cost_limit', kind: 'continue', question: 'Paused at the cost limit of $0.01' });
	assert.match(turn.finalText, /^I could not finish: the next model request could pass this turn's cost limit of \$0\.01 \(<\$0\.01 est\. so far\)\.$/);
	assert.deepEqual(turn.usage.cost, { usd: 0, estimated: true });
	const card = turnCard(turn);
	assert.deepEqual({ title: card.title, lines: card.lines, actions: card.actions }, { title: 'Paused at the cost limit of $0.01', lines: ['<$0.01 est. so far.', 'Continue starts a new turn with a fresh budget.'], actions: [{ id: CONTINUE, label: 'Continue' }] });
});

test('a best-effort summary the cost limit refuses ends the turn at the cost limit with Continue, though unusable replies ended the run', async () => {
	// step: two unusable replies of 400,000 characters each ($1.00 of output): the plan and its retry fit under $1.50, and the summary does not
	const unusable = 'x'.repeat(400_000);
	const model = scriptedModel([unusable, unusable, 'Never asked.']);
	const turn = await turnWith(model, { limits: { steps: 60, costUsd: 1.5 }, modelName: SONNET });
	assert.equal(model.questions.length, 2, 'the plan and its retry were sent, and the summary was not');
	assert.deepEqual({ outcome: turn.outcome, reason: turn.reason, kind: turn.request?.kind, question: turn.request?.question }, { outcome: 'needs_input', reason: 'cost_limit', kind: 'continue', question: 'Paused at the cost limit of $1.50' });
	assert.match(turn.finalText, /^I could not finish: the next model request could pass this turn's cost limit of \$1\.50 /);
	assert.deepEqual(turnCard(turn).actions, [{ id: CONTINUE, label: 'Continue' }]);
});

test('a turn under its cost limit runs, and its estimate is what the row shows', async () => {
	const model = scriptedModel([plan(['read_file', { path: 'a.txt' }]), done('a.txt says alpha.')]);
	const turn = await turnWith(model, { limits: { steps: 60, costUsd: 2 }, modelName: SONNET });
	assert.equal(turn.outcome, 'done');
	assert.ok(turn.usage.cost && turn.usage.cost.usd > 0 && turn.usage.cost.estimated, 'the turn has an estimated cost');
	assert.equal(usageMeta(turn.usage), `~$${(turn.usage.cost?.usd ?? 0).toFixed(2)} est., not counting thinking`);
});

test('a model with no price shows tokens and no cost, and the cost limit does not apply; the card says so', async () => {
	const model = scriptedModel([plan(['read_file', { path: 'a.txt' }]), done('a.txt says alpha.')]);
	const turn = await turnWith(model, { limits: { steps: 60, costUsd: 0.0001 }, modelName: 'some-unpriced-model' });
	assert.equal(turn.outcome, 'done', 'a limit of a hundredth of a cent stopped nothing');
	assert.equal(turn.usage.cost, undefined);
	const tokens = (turn.usage.tokens?.input ?? 0) + (turn.usage.tokens?.output ?? 0);
	assert.ok(tokens > 0 && turn.usage.tokens?.estimated, 'the turn counts estimated tokens');
	assert.equal(usageMeta(turn.usage), `~${tokens.toLocaleString('en-US')} tokens est.`);
	assert.deepEqual(turnCard(turn).lines, [`No price for this model, so the cost limit does not apply (~${tokens.toLocaleString('en-US')} tokens est.).`]);
});
