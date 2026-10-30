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
// WAVE LOOP TESTS — the done rule, running calls (order, approval, timeouts, user time), stop and steering, no key past a tool
// =============================================================================

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { CheckRecord, createChatModel } from '../run';
import type { CheckStatus } from '../toolkits/appCheck';
import { AgentTool, UserTime } from '../tools';
import { runLoop, type FinishRule, type LoopOptions, type RanCall } from './loop';
import type { ModelCall, PromptPrefix, QuestionSpec } from './plan';

// =============================================================================
// FIXTURES
// =============================================================================

type Call = [string, Record<string, unknown>?];

/** A fake model that records each question and gives the next reply, throwing it when it is an Error; one call too many throws. */
function scriptedModel(replies: Array<string | Error>): ModelCall & { questions: QuestionSpec[] } {
	const questions: QuestionSpec[] = [];
	const call: ModelCall = async (q) => {
		questions.push(q);
		const next = replies.shift();
		if (next === undefined) throw new Error('scriptedModel: no reply left');
		if (next instanceof Error) throw next;
		return next;
	};
	return Object.assign(call, { questions });
}

const PREFIX: PromptPrefix = { role: 'You are Wave.', instructions: [{ title: 'Response Format', text: 'Reply with JSON.' }] };

/** An edit inside the app `a-ui`, so it needs a check_app on `a-ui`. */
const APP_FILE = 'apps/a-ui/src/a.ts';
const EDIT: Call = ['edit_file', { path: APP_FILE }];
const CHECK: Call = ['check_app', { app: 'a-ui' }];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const plan = (...calls: Call[]): string => JSON.stringify({ thought: 'working', tool_calls: calls.map(([tool, args]) => ({ tool, args: args ?? {} })) });
const done = (answer: string): string => JSON.stringify({ thought: 'finishing', done: true, answer });

/** The run's record of check results, naming an app by the folder the call passed. */
const record = (): CheckRecord => new CheckRecord(async (ref) => ref);

/** A finish rule with nothing unchecked, so only a timed-out call can send a done back. */
const satisfied = (endWave: FinishRule['endWave'] = async () => undefined): FinishRule => ({ checkTool: 'check_app', beginWave: () => undefined, endWave, unchecked: () => null });

/** A tool that records the arguments it ran with and returns `result`. */
function stub(name: string, result: (args: Record<string, unknown>) => string | Promise<string> = () => `${name} ok`): AgentTool & { seen: Array<Record<string, unknown>> } {
	const seen: Array<Record<string, unknown>> = [];
	const execute = async (args: Record<string, unknown>): Promise<string> => {
		seen.push(args);
		return result(args);
	};
	return Object.assign(new AgentTool({ name, description: name, parameters: { type: 'object' }, execute }), { seen });
}

/** A tool that asks for an OK (or fails) in `prepare` before it runs. */
const prepared = (name: string, prepare: AgentTool['prepare']): AgentTool => new AgentTool({ name, description: name, parameters: { type: 'object' }, prepare });

/** An edit_file that logs when each call (by its `n`) starts and writes, waiting on `wait(n)` between. */
const loggedEdit = (events: string[], wait: (n: unknown) => Promise<void>): AgentTool =>
	stub('edit_file', async (args) => {
		events.push(`start ${args.n}`);
		await wait(args.n);
		events.push(`write ${args.n}`);
		return 'edited';
	});

/** A check_app that gives `verdicts` in turn, then passes, reporting each to `checks` the way AppCheckToolkit does; 'error' throws and reports nothing. */
function checkTool(checks: CheckRecord, verdicts: Array<CheckStatus | 'error'> = []): AgentTool {
	return stub('check_app', ({ app }) => {
		const status = verdicts.shift() ?? 'pass';
		if (status === 'error') throw new Error(`No app '${app}'.`);
		checks.appChecked(String(app), { target: String(app), evidence: [{ step: 'types', ran: 'markers', output: '', status, summary: status }] });
		return `CHECK ${status}: ${app}`;
	});
}

/** Runs the loop over `tools` answering with `model`; `extra` overrides the defaults. */
function loop(model: ModelCall, tools: AgentTool[] = [], extra: Partial<LoopOptions> = {}) {
	return runLoop({ request: 'do it', history: [], prefix: PREFIX, tools, model, finish: record(), emit: () => undefined, signal: new AbortController().signal, takeQueued: () => [], approve: async (_act, run) => run, ...extra });
}

/** The result entries a question shows the model. */
function resultsIn(q: QuestionSpec): Array<Record<string, unknown>> {
	const head = 'Previous tool results:\n';
	const block = q.context.find((c) => c.startsWith(head));
	return block ? JSON.parse(block.slice(head.length)) : [];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

// =============================================================================
// THE DONE RULE — no answer until each changed app passes check_app, and each changed pipeline validates
// =============================================================================

test('done after a change is refused until a check passes in a later wave', async () => {
	// A check in the change's own wave may run before the edit lands, so it does not count.
	const checks = record();
	const result = await loop(scriptedModel([plan(EDIT, CHECK), done('too soon'), plan(CHECK), done('checked')]), [stub('edit_file'), checkTool(checks)], { finish: checks });
	assert.deepEqual({ answer: result.answer, stopReason: result.stopReason }, { answer: 'checked', stopReason: 'done' });
});

test('a failed check, or a check call that errors, blocks done until a newer one passes', async () => {
	// pass, then fail or error: the newest check decides, so the work is unchecked again
	for (const verdict of ['fail', 'error'] as const) {
		const checks = record();
		const model = scriptedModel([plan(EDIT), plan(CHECK), plan(CHECK), done('too soon'), plan(CHECK), done('checked')]);
		const result = await loop(model, [stub('edit_file'), checkTool(checks, ['pass', verdict])], { finish: checks });
		assert.equal(result.answer, 'checked', `after a check that ended in ${verdict}`);
	}
});

test('a changed pipeline whose last save failed validate blocks done until a save that passes', async () => {
	// This write reports each save's validate to the record, the way the save hook does.
	const checks = record();
	const saves = [['llm_1: lane questions has no source'], []];
	const write = stub('write_file', (args) => {
		checks.pipelineSaved(String(args.path), { errors: saves.shift() ?? [] });
		return 'saved';
	});
	const save = plan(['write_file', { path: 'pipelines/a.pipe' }]);
	const result = await loop(scriptedModel([save, done('too soon'), save, done('valid')]), [write], { finish: checks });
	assert.equal(result.answer, 'valid');
});

test('a done block after the plan does not finish the run', async () => {
	const fence = (json: string) => '```json\n' + json + '\n```';
	const list = stub('list_components');
	const result = await loop(scriptedModel([fence(plan(['list_components'])) + '\n' + fence(done('waiting')), done('built')]), [list]);
	assert.deepEqual({ ran: list.seen.length, answer: result.answer }, { ran: 1, answer: 'built' });
});

// =============================================================================
// RUNNING CALLS — same-file order, asking first, timed-out calls, user time
// =============================================================================

test('calls on one file in one wave run in planned order', async () => {
	// The first edit is the slow one: run together, the second would finish first.
	const events: string[] = [];
	const edit = loggedEdit(events, (n) => sleep(n === 0 ? 20 : 0));
	await loop(scriptedModel([plan(['edit_file', { path: 'a.ts', n: 0 }], ['edit_file', { path: 'a.ts', n: 1 }]), new Error('stop')]), [edit]);
	assert.deepEqual(events, ['start 0', 'write 0', 'start 1', 'write 1']);
});

test('waiting for an OK never counts against the limit, and a refused call runs nothing, blocks done and is no change', async () => {
	const ran: string[] = [];
	const asking = (name: string): AgentTool =>
		prepared(name, async (args) => ({
			act: { name, params: [args.path] },
			run: async () => {
				ran.push(name);
				return `${name} ran`;
			},
		}));
	const answers = ['approve', 'deny'];
	// each OK takes 30 ms, three times the 10 ms limit
	const approve: LoopOptions['approve'] = async (act, run) => {
		await sleep(30);
		if (answers.shift() === 'deny') throw new Error(`The user declined: ${act.name}.`);
		return run;
	};
	const deleteAndFinish = JSON.stringify({ thought: 'deleting', tool_calls: [{ tool: 'delete_file', args: { path: APP_FILE } }], done: true, answer: 'Deleted.' });
	const model = scriptedModel([plan(['publish_app']), deleteAndFinish, done('Not deleted: the user said no.')]);
	const result = await loop(model, [asking('publish_app'), asking('delete_file')], { approve, timeoutMs: () => 10 });
	assert.deepEqual(ran, ['publish_app'], 'the refused call never ran');
	assert.match(JSON.stringify(resultsIn(model.questions[1])), /publish_app ran/, 'the wait for an OK did not time the call out');
	assert.match(JSON.stringify(resultsIn(model.questions[2])), /The user declined: delete_file/, 'the model read the refusal');
	// a refused delete heard as a change would refuse this done until a check_app, and the script has no reply left
	assert.equal(result.answer, 'Not deleted: the user said no.', 'the done beside the refused call was not accepted, and the next one needed no check');
});

test('a call on a file a timed-out call still changes is not run, and done waits until the model reads how that call ended', async () => {
	const hang = deferred();
	const events: string[] = [];
	// The hung edit ends as the finish rule hears the second wave, after the loop took the timed-out calls that had ended.
	let waves = 0;
	const finish = satisfied(async () => {
		if (++waves !== 2) return;
		hang.resolve();
		await sleep(5);
	});
	const model = scriptedModel([plan(['edit_file', { path: APP_FILE, n: 0 }], ['edit_file', { path: APP_FILE, n: 1 }]), done('too soon'), done('too soon'), done('ok')]);
	const result = await loop(model, [loggedEdit(events, (n) => (n === 0 ? hang.promise : Promise.resolve()))], { finish, timeoutMs: () => 10 });
	assert.deepEqual(events, ['start 0', 'write 0'], 'the second edit never started, so it cannot land before or under the first');
	assert.equal(result.answer, 'ok', 'a done before the model read how the edit ended was accepted');
	assert.match(JSON.stringify(resultsIn(model.questions[3])), /wave-2\.late0/, 'the accepted done came after the model read how the edit ended');
});

/** Fakes setTimeout and performance.now together, so only the test moves the clock; the returned function moves it on once the loop is idle. */
function fakeClock(t: TestContext): (ms: number) => Promise<void> {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
	t.mock.method(performance, 'now', () => Date.now());
	const idle = async (): Promise<void> => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	return async (ms) => {
		await idle();
		t.mock.timers.tick(ms);
		await idle();
	};
}

test("a call's time limit stands still while the user answers its question", async (t) => {
	const advance = fakeClock(t);
	const userTime = new UserTime();
	const answered = deferred();
	// step: 50 ms of work, then a second in a dialog, under a 100 ms limit
	const asking = stub('edit_file', async () => {
		await sleep(50);
		await userTime.during(answered.promise);
		return 'edited';
	});
	const model = scriptedModel([plan(['edit_file', { path: 'a.ts' }]), done('ok')]);
	const running = loop(model, [asking], { timeoutMs: () => 100, userTime });
	await advance(50);
	await advance(1000);
	answered.resolve();
	await running;
	const [entry] = resultsIn(model.questions[1]);
	assert.ok(entry && entry.error === undefined, 'no timeout while the user decides');
});

// =============================================================================
// STOP AND STEERING
// =============================================================================

test('Stop mid-wave ends the run at once: nothing new starts, and what is still running is named', async () => {
	const stop = new AbortController();
	const emitted: string[] = [];
	const edit = stub('edit_file');
	// The deploy stops the run while it works, and never finishes.
	const deploy = stub('deploy_app', () => {
		stop.abort();
		return new Promise<string>(() => undefined);
	});
	const model = scriptedModel([plan(['edit_file', { path: 'a.ts' }], ['deploy_app', { app: 'x' }], ['edit_file', { path: 'a.ts' }])]);
	const result = await loop(model, [edit, deploy], { signal: stop.signal, emit: (_type, text) => emitted.push(text) });
	assert.equal(result.stopReason, 'stopped');
	assert.equal(model.questions.length, 1, 'no model call after the stop');
	assert.equal(edit.seen.length, 1, 'the edit waiting on the same file never started');
	assert.match(emitted.at(-1) ?? '', /- deploy_app x/, 'the last row names the call still running');
});

test('a model call abandoned by Stop does not restart the pipeline when it fails late', async () => {
	let restarts = 0;
	const onPipelineError = async (): Promise<void> => {
		restarts++;
	};
	const chatModel = (chat: () => Promise<{ answers?: unknown[] }>, signal: AbortSignal) => createChatModel({ client: () => ({ chat }), token: async () => 'tk-model', toQuestion: (q) => q, onPipelineError, signal });
	// Not stopped, the same failure restarts the pipeline once, so this test can see a restart.
	await assert.rejects(loop(chatModel(() => Promise.reject(new Error('pipeline ended')), new AbortController().signal)), /stopped responding/);
	assert.equal(restarts, 1);

	const stop = new AbortController();
	let failLate: ((error: Error) => void) | undefined;
	const abandoned = chatModel(() => new Promise((_resolve, reject) => (failLate = reject)), stop.signal);
	const running = loop(abandoned, [], { signal: stop.signal });
	await sleep(0);
	assert.ok(failLate, 'the model call is in flight');
	stop.abort();
	assert.equal((await running).stopReason, 'stopped');
	failLate?.(new Error('pipeline ended'));
	await sleep(0);
	assert.equal(restarts, 1, 'the late failure restarted nothing');
});

test('a message sent before done is read before the run finishes', async () => {
	const inbox: string[] = [];
	const replies = scriptedModel([done('too soon'), done('final')]);
	// The user writes again just as the model says it is done.
	const model: ModelCall = async (q) => {
		const reply = await replies(q);
		if (replies.questions.length === 1) inbox.push('also do C');
		return reply;
	};
	const result = await loop(model, [], { takeQueued: () => inbox.splice(0) });
	assert.match(replies.questions[1].context.join('\n'), /also do C/, 'the done was sent back so the message is read');
	assert.equal(result.answer, 'final');
});

// =============================================================================
// SECRETS — what a tool returns or throws, and what the user sends mid-run, is redacted before anything reads it
// =============================================================================

test('a key in a result, error, prepare error, refusal, late return or user message reaches no question, thinking line or finish rule', async () => {
	// Synthetic key shapes, one per way in, each with the words that must still reach the model without it.
	const leaks = {
		result: [`sk-${'r'.repeat(24)}`, 'connected with [redacted]'],
		error: [`ghp_${'e'.repeat(36)}`, 'auth rejected for [redacted]'],
		prepare: [`sk-${'p'.repeat(24)}`, 'the store said [redacted]'],
		refusal: [`ghp_${'d'.repeat(36)}`, 'The user declined: Schedule Nightly [redacted]'],
		late: [`xoxb-${'l'.repeat(24)}`, 'late with [redacted]'],
		message: [`sk-ant-api03-${'k'.repeat(24)}`, 'use this key instead: [redacted]'],
	};
	const key = (kind: keyof typeof leaks): string => leaks[kind][0];
	const tools = [
		stub('leaky', () => `connected with ${key('result')}`),
		stub('failing', () => Promise.reject(new Error(`auth rejected for ${key('error')}`))),
		prepared('unreadable', () => Promise.reject(new Error(`Cannot read 'pipelines/x.pipe': the store said ${key('prepare')}`))),
		prepared('refused', async () => ({ act: { name: 'refused', params: [] }, run: async () => 'refused ran' })),
		// times out (limit 10 ms), then ends with its key while the next wave plans
		stub('slow', () => sleep(30).then(() => `late with ${key('late')}`)),
	];
	// The card's title, and so the refusal, is built from names the server holds.
	const approve: LoopOptions['approve'] = async (act, run) => {
		if (act.name === 'refused') throw new Error(`The user declined: Schedule Nightly ${key('refusal')}.`);
		return run;
	};
	// The third question fails after results were gathered, so the best-effort question is asked too.
	const replies = scriptedModel([plan(['leaky'], ['failing'], ['unreadable'], ['refused'], ['slow']), done('too soon'), new Error('The model provider failed'), 'best effort']);
	const inbox: string[] = [];
	const model: ModelCall = async (q) => {
		// A mid-run message skips AgentSession.execute and its pasted-key check.
		if (replies.questions.length === 0) inbox.push(`use this key instead: ${key('message')}`);
		// The second question waits until the slow call has ended, so the finish rule hears its late return.
		if (replies.questions.length === 1) await sleep(50);
		return replies(q);
	};
	const heard: RanCall[] = [];
	const status: string[] = [];
	const finish = satisfied(async (calls) => {
		heard.push(...calls);
	});
	await loop(model, tools, { approve, finish, emit: (_type, text) => status.push(text), takeQueued: () => inbox.splice(0), timeoutMs: (tool) => (tool === 'slow' ? 10 : 0) });
	const seen = { question: JSON.stringify(replies.questions), 'thinking line': status.join('\n'), 'finish rule': JSON.stringify(heard) };
	for (const [kind, [secret, kept]] of Object.entries(leaks)) {
		for (const [where, text] of Object.entries(seen)) assert.ok(!text.includes(secret), `the ${kind} key reached a ${where}`);
		assert.ok(seen.question.includes(kept), `the ${kind} reached the model with its words, without the key`);
	}
	assert.equal(heard.find((call) => call.late)?.result, 'late with [redacted]', 'the finish rule heard the late return, redacted');
});
