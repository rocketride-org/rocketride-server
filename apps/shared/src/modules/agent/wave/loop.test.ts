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
// WAVE LOOP TESTS — the done rule, reading replies, and same-file order, stop and steering
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CheckRecord, createChatModel } from '../run';
import type { CheckStatus } from '../toolkits/appCheck';
import { AgentTool } from '../tools';
import { runLoop, type LoopOptions } from './loop';
import type { ModelCall, PromptPrefix, QuestionSpec } from './plan';

// =============================================================================
// SCRIPTED MODEL — a fake ModelCall that replays canned replies
// =============================================================================

/** A ModelCall that also exposes every question it was asked. */
type ScriptedModel = ModelCall & { questions: QuestionSpec[] };

/**
 * A fake model for tests. Each call records its question, then returns the
 * next reply, or throws it when the reply is an Error. Running out of
 * replies throws, so a test that makes one call too many fails loudly.
 *
 * @param replies - The replies to give, in order.
 * @returns The fake model, with `questions` holding every question asked.
 */
function scriptedModel(replies: Array<string | Error>): ScriptedModel {
	const queue = [...replies];
	const questions: QuestionSpec[] = [];
	const call: ModelCall = async (q) => {
		questions.push(q);
		const next = queue.shift();
		if (next === undefined) throw new Error('scriptedModel: no reply left');
		if (next instanceof Error) throw next;
		return next;
	};
	return Object.assign(call, { questions });
}

// =============================================================================
// FIXTURES
// =============================================================================

/** The fixed start every wave question carries. */
const PREFIX: PromptPrefix = { role: 'You are Wave.', instructions: [{ title: 'Response Format', text: 'Reply with JSON.' }] };

/** A file inside the app `a-ui`, so a change to it needs a check_app on `a-ui`. */
const APP_FILE = 'apps/a-ui/src/a.ts';

/** The arguments of every check_app call here. */
const CHECK_ARGS = { app: 'a-ui' };

/** What a refused done tells the model. */
const NOT_CHECKED = 'Not finished: call check_app on a-ui on its own, after your last change to it, and fix what it reports before done=true.';

/** The run's record of check results, naming an app by the folder the call passed. */
function record(): CheckRecord {
	return new CheckRecord(async (ref) => ref);
}

/** A reply asking for tool calls; with `answer`, it also says it is done. */
function plan(calls: Array<[string, Record<string, unknown>?]>, answer?: string): string {
	return JSON.stringify({ thought: 'working', tool_calls: calls.map(([tool, args]) => ({ tool, args: args ?? {} })), ...(answer === undefined ? {} : { done: true, answer }) });
}

/** A reply that finishes with `answer`. */
function done(answer: string): string {
	return JSON.stringify({ thought: 'finishing', done: true, answer });
}

/** A tool that records the arguments it ran with and returns `result` (default `<name> ok`); `required` names the arguments its schema requires. */
function stub(name: string, result: (args: Record<string, unknown>) => string | Promise<string> = () => `${name} ok`, required?: string[]): AgentTool & { seen: Array<Record<string, unknown>> } {
	const seen: Array<Record<string, unknown>> = [];
	const tool = new AgentTool({
		name,
		description: name,
		parameters: required ? { type: 'object', required } : { type: 'object' },
		execute: async (args) => {
			seen.push(args);
			return result(args);
		},
	});
	return Object.assign(tool, { seen });
}

/** A check_app that gives `verdicts` in turn, then passes, reporting each to `checks` the way AppCheckToolkit does; 'error' throws and reports nothing. */
function checkTool(checks: CheckRecord, verdicts: Array<CheckStatus | 'error'> = []): AgentTool {
	return new AgentTool({
		name: 'check_app',
		description: 'check_app',
		parameters: { type: 'object', required: ['app'] },
		execute: async (args) => {
			const app = String(args.app);
			const status = verdicts.shift() ?? 'pass';
			if (status === 'error') throw new Error(`No app '${app}'.`);
			checks.appChecked(app, { target: app, evidence: [{ step: 'types', ran: 'markers', output: '', status, summary: status === 'pass' ? 'types clean' : '1 type error' }] });
			return `CHECK ${status === 'fail' ? 'FAILED' : 'PASSED'}: ${app}`;
		},
	});
}

/** A run over `tools` answering with `model`. */
function setup(model: ModelCall, tools: AgentTool[] = [], extra: Partial<LoopOptions> = {}) {
	const options: LoopOptions = {
		request: 'do it',
		history: [],
		prefix: PREFIX,
		tools,
		model,
		finish: record(),
		emit: () => undefined,
		signal: new AbortController().signal,
		takeQueued: () => [],
		approve: async (_act, run) => run,
		...extra,
	};
	return { run: () => runLoop(options) };
}

/** The result entries a question shows the model. */
function resultsIn(q: QuestionSpec): Array<Record<string, unknown>> {
	const head = 'Previous tool results:\n';
	const block = q.context.find((c) => c.startsWith(head));
	return block ? JSON.parse(block.slice(head.length)) : [];
}

// =============================================================================
// THE DONE RULE — no answer until each changed app passes check_app, and each changed pipeline validates
// =============================================================================

test('done after a change is refused until a check passes in a later wave', async () => {
	// A check in the change's own wave may run before the edit lands, so it does not count.
	const checks = record();
	const model = scriptedModel([
		plan([
			['edit_file', { path: APP_FILE }],
			['check_app', CHECK_ARGS],
		]),
		done('too soon'),
		plan([['check_app', CHECK_ARGS]]),
		done('checked'),
	]);
	const result = await setup(model, [stub('edit_file'), checkTool(checks)], { finish: checks }).run();
	assert.deepEqual(resultsIn(model.questions[2]).at(-1), { tool: 'reply-check', key: 'wave-1.done', error: NOT_CHECKED });
	assert.deepEqual({ answer: result.answer, stopReason: result.stopReason, changed: checks.changed }, { answer: 'checked', stopReason: 'done', changed: true });
});

test('a failed check blocks done until a newer one passes', async () => {
	// pass, then fail: the newest check decides, so the work is unchecked again
	const checks = record();
	const model = scriptedModel([plan([['edit_file', { path: APP_FILE }]]), plan([['check_app', CHECK_ARGS]]), plan([['check_app', CHECK_ARGS]]), done('too soon'), plan([['check_app', CHECK_ARGS]]), done('checked')]);
	const result = await setup(model, [stub('edit_file'), checkTool(checks, ['pass', 'fail', 'pass'])], { finish: checks }).run();
	assert.deepEqual(resultsIn(model.questions[4]).at(-1), { tool: 'reply-check', key: 'wave-3.done', error: NOT_CHECKED });
	assert.equal(result.answer, 'checked');
});

test('a check call that errors blocks done until another passes', async () => {
	const checks = record();
	const model = scriptedModel([plan([['edit_file', { path: APP_FILE }]]), plan([['check_app', CHECK_ARGS]]), plan([['check_app', CHECK_ARGS]]), done('too soon'), plan([['check_app', CHECK_ARGS]]), done('checked')]);
	const result = await setup(model, [stub('edit_file'), checkTool(checks, ['pass', 'error'])], { finish: checks }).run();
	assert.match(String(resultsIn(model.questions[3]).at(-1)?.error), /^No app/, 'the check threw before recording anything');
	assert.deepEqual(resultsIn(model.questions[4]).at(-1), { tool: 'reply-check', key: 'wave-3.done', error: NOT_CHECKED });
	assert.equal(result.answer, 'checked');
});

test('a changed pipeline whose last save failed validate blocks done until a save that passes', async () => {
	// Every save validates; this write reports each save's validate to the record the way the save hook does.
	const checks = record();
	const saves = [['llm_1: lane questions has no source'], []];
	const write = stub('write_file', (args) => {
		checks.pipelineSaved(String(args.path), { errors: saves.shift() ?? [] });
		return 'saved';
	});
	const model = scriptedModel([plan([['write_file', { path: 'pipelines/a.pipe' }]]), done('too soon'), plan([['write_file', { path: 'pipelines/a.pipe' }]]), done('valid')]);
	const result = await setup(model, [write], { finish: checks }).run();
	assert.deepEqual(resultsIn(model.questions[2]).at(-1), { tool: 'reply-check', key: 'wave-1.done', error: 'Not finished: pipelines/a.pipe failed validation on its last save: fix it and save again before done=true.' });
	assert.equal(result.answer, 'valid');
});

// =============================================================================
// READING REPLIES — argument shapes, missing arguments, unusable replies
// =============================================================================

test("a call's arguments are read from args, arguments, input, parameters or flat keys", async () => {
	const probe = stub('probe');
	const calls = ['{"tool":"probe","args":{"from":"args"}}', '{"type":"function","function":{"name":"probe","arguments":"{\\"from\\":\\"arguments\\"}"}}', '{"tool":"probe","input":{"from":"input"}}', '{"tool":"probe","parameters":{"from":"parameters"}}', '{"tool":"probe","from":"flat"}'];
	const model = scriptedModel([`{"thought":"t","tool_calls":[${calls.join(',')}]}`, done('ok')]);
	await setup(model, [probe]).run();
	assert.deepEqual(probe.seen.map((args) => args.from).sort(), ['args', 'arguments', 'flat', 'input', 'parameters']);
});

test('a call missing a required argument is skipped with a note, and the rest of the wave runs', async () => {
	const read = stub('read_file', () => 'file text', ['path']);
	const stat = stub('stat_file', () => 'stat text', ['path']);
	const model = scriptedModel([plan([['read_file'], ['stat_file', { path: 'a.ts' }]]), done('ok')]);
	await setup(model, [read, stat]).run();
	assert.equal(read.seen.length, 0, 'the call missing path never ran with {}');
	assert.deepEqual(stat.seen, [{ path: 'a.ts' }]);
	assert.deepEqual(resultsIn(model.questions[1])[0], { tool: 'read_file', key: 'wave-0.r0', error: 'Skipped: read_file is missing required argument(s) \'path\'. Put arguments under "args": {"tool": "read_file", "args": {...}}' });
});

test('an unusable reply is sent back once, then the run ends with a best-effort answer', async () => {
	const retried = scriptedModel(['{}', done('a')]);
	const answered = await setup(retried).run();
	assert.equal(retried.questions[1].context.at(-1), 'Your previous reply was not usable: it had neither done=true nor any tool_calls. Reply with exactly one of the two shapes in Response Format.');
	assert.deepEqual({ answer: answered.answer, stopReason: answered.stopReason }, { answer: 'a', stopReason: 'done' });

	const stuck = scriptedModel(['{}', '{}', 'best effort']);
	const gaveUp = await setup(stuck).run();
	assert.deepEqual({ answer: gaveUp.answer, stopReason: gaveUp.stopReason }, { answer: 'best effort', stopReason: 'empty_plan' });
	assert.equal(stuck.questions[2].expectJson, false, 'the third call asks for a plain answer, not another plan');
});

// =============================================================================
// SAME-FILE ORDER
// =============================================================================

test('calls on one file in one wave run in planned order', async () => {
	// The first edit is the slow one: run together, the second would finish first.
	const events: string[] = [];
	const edit = stub('edit_file', async (args) => {
		events.push(`start ${args.n}`);
		await new Promise((resolve) => setTimeout(resolve, args.n === 0 ? 20 : 0));
		events.push(`end ${args.n}`);
		return 'edited';
	});
	const checks = record();
	const model = scriptedModel([
		plan([
			['edit_file', { path: 'a.ts', n: 0 }],
			['edit_file', { path: 'a.ts', n: 1 }],
		]),
		plan([['check_app', CHECK_ARGS]]),
		done('ok'),
	]);
	await setup(model, [edit, checkTool(checks)], { finish: checks }).run();
	assert.deepEqual(events, ['start 0', 'end 0', 'start 1', 'end 1']);
});

// =============================================================================
// ASKING FIRST — a call that needs the user's OK
// =============================================================================

test('waiting for an OK never counts against the limit, and a refused call runs nothing, blocks done and is no change', async () => {
	const ran: string[] = [];
	const asking = (name: string): AgentTool =>
		new AgentTool({
			name,
			description: name,
			parameters: { type: 'object' },
			prepare: async (args) => ({
				act: { name, params: [args.path] },
				run: async () => {
					ran.push(name);
					return `${name} ran`;
				},
			}),
		});
	const answers = ['approve', 'deny'];
	// each OK takes 30 ms, three times the 10 ms limit
	const approve: LoopOptions['approve'] = async (act, run) => {
		await new Promise((resolve) => setTimeout(resolve, 30));
		if (answers.shift() === 'deny') throw new Error(`The user declined: ${act.name}.`);
		return run;
	};
	const model = scriptedModel([plan([['publish_app']]), plan([['delete_file', { path: APP_FILE }]], 'Deleted.'), done('Not deleted: the user said no.')]);
	const result = await setup(model, [asking('publish_app'), asking('delete_file')], { approve, timeoutMs: () => 10 }).run();

	assert.deepEqual(ran, ['publish_app'], 'the refused call never ran');
	assert.match(JSON.stringify(resultsIn(model.questions[1])), /publish_app ran/, 'the wait for an OK did not time the call out');
	assert.match(JSON.stringify(resultsIn(model.questions[2])), /The user declined: delete_file/, 'the model read the refusal');
	// a refused delete heard as a change would refuse this done until a check_app, and the script has no reply left
	assert.equal(result.answer, 'Not deleted: the user said no.', 'the done beside the refused call was not accepted, and the next one needed no check');
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
	const model = scriptedModel([
		plan([
			['edit_file', { path: 'a.ts' }],
			['deploy_app', { app: 'x' }],
			['edit_file', { path: 'a.ts' }],
		]),
	]);
	const result = await setup(model, [edit, deploy], { signal: stop.signal, emit: (_type, text) => emitted.push(text) }).run();
	assert.equal(result.stopReason, 'stopped');
	assert.equal(model.questions.length, 1, 'no model call after the stop');
	assert.equal(edit.seen.length, 1, 'the edit waiting on the same file never started');
	assert.match(emitted.at(-1) ?? '', /- deploy_app x/, 'the last row names the call still running');
});

test('a queued message reaches the next wave, and one sent before done is read before the run finishes', async () => {
	const inbox: string[] = [];
	const read = stub('read_file', () => {
		inbox.push('use folder B');
		return 'file text';
	});
	const replies = scriptedModel([plan([['read_file', { path: 'a.ts' }]]), done('too soon'), done('final')]);
	// The user writes again just as the model first says it is done.
	const model: ModelCall = async (q) => {
		const reply = await replies(q);
		if (replies.questions.length === 2) inbox.push('also do C');
		return reply;
	};
	const result = await setup(model, [read], { takeQueued: () => inbox.splice(0) }).run();
	const [first, second, third] = replies.questions;
	assert.ok(!first.context.some((c) => c.includes('use folder B')));
	assert.ok(
		second.context.some((c) => c.includes('use folder B')),
		'the next wave reads the message'
	);
	assert.deepEqual([second.instructions, second.history], [first.instructions, first.history], 'the cached start is unchanged');
	assert.ok(
		third.context.some((c) => c.includes('also do C')),
		'the done was sent back so the message is read'
	);
	assert.equal(result.answer, 'final');
});

test('a model call abandoned by Stop does not restart the pipeline when it fails late', async () => {
	let restarts = 0;
	const restart = async (): Promise<void> => {
		restarts++;
	};
	const token = async (): Promise<string> => 'tk-model';

	// Not stopped, the same failure restarts the pipeline once, so this test can see a restart.
	const failing = createChatModel({
		client: () => ({
			chat: async () => {
				throw new Error('pipeline ended');
			},
		}),
		token,
		toQuestion: (q) => q,
		onPipelineError: restart,
		signal: new AbortController().signal,
	});
	await assert.rejects(setup(failing).run(), /stopped responding/);
	assert.equal(restarts, 1);

	const stop = new AbortController();
	let failLate: ((error: Error) => void) | undefined;
	const abandoned = createChatModel({
		client: () => ({
			chat: () =>
				new Promise<{ answers?: unknown[] }>((_resolve, reject) => {
					failLate = reject;
				}),
		}),
		token,
		toQuestion: (q) => q,
		onPipelineError: restart,
		signal: stop.signal,
	});
	const running = setup(abandoned, [], { signal: stop.signal }).run();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.ok(failLate, 'the model call is in flight');
	stop.abort();
	assert.equal((await running).stopReason, 'stopped');
	failLate?.(new Error('pipeline ended'));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(restarts, 1, 'the late failure restarted nothing');
});
