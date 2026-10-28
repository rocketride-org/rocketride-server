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
// WAVE LOOP TESTS — the done rule, reading replies, same-file order, stop and steering, no key past a tool, and timed-out calls
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CheckRecord, createChatModel } from '../run';
import type { CheckStatus } from '../toolkits/appCheck';
import { AgentTool } from '../tools';
import { runLoop, type FinishRule, type LoopOptions, type RanCall } from './loop';
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

test('a done block after the plan does not finish the run', async () => {
	const fence = (json: string) => '```json\n' + json + '\n```';
	const model = scriptedModel([fence(plan([['list_components']])) + '\n' + fence(done('waiting')), done('built')]);
	const list = stub('list_components');
	const result = await setup(model, [list]).run();
	assert.equal(model.questions[0].expectJson, false, 'the engine ends the turn on a reply with more than one block');
	assert.deepEqual({ ran: list.seen.length, answer: result.answer }, { ran: 1, answer: 'built' });
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

test('a call Stop kept from starting is not run, so the finish rule does not count it as a change', async () => {
	const stop = new AbortController();
	const checks = record();
	const edit = stub('edit_file');
	// The read stops the run while it works, and never finishes.
	const read = stub('read_file', () => {
		stop.abort();
		return new Promise<string>(() => undefined);
	});
	const model = scriptedModel([
		plan([
			['read_file', { path: 'b.ts' }],
			['edit_file', { path: APP_FILE }],
		]),
	]);
	const result = await setup(model, [read, edit], { signal: stop.signal, finish: checks }).run();
	assert.equal(result.stopReason, 'stopped');
	assert.equal(edit.seen.length, 0, 'the edit never started');
	assert.equal(checks.changed, false, 'nothing of the edit landed, so the run changed nothing');
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

// =============================================================================
// SECRETS — what a tool returns or throws is redacted before anything reads it
// =============================================================================

test('a key in a tool result, error or late return reaches no question, thinking line or finish rule', async () => {
	// Synthetic key shapes, one per way out of a tool.
	const keys = { result: `sk-${'r'.repeat(24)}`, error: `ghp_${'e'.repeat(36)}`, late: `xoxb-${'l'.repeat(24)}` };
	const leaky = stub('leaky', () => `connected with ${keys.result}`);
	const failing = new AgentTool({
		name: 'failing',
		description: 'failing',
		parameters: { type: 'object' },
		execute: async () => {
			throw new Error(`auth rejected for ${keys.error}`);
		},
	});
	// Times out (limit 10 ms), then ends with its key while the next wave plans.
	const slow = stub('slow', async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
		return `late with ${keys.late}`;
	});
	const replies = [plan([['leaky'], ['failing'], ['slow']]), plan([['leaky', { again: true }]]), done('finished')];
	const questions: QuestionSpec[] = [];
	const model: ModelCall = async (q) => {
		questions.push(q);
		// The second plan waits until the slow call has ended, so the finish rule hears its late return.
		if (questions.length === 2) await new Promise((resolve) => setTimeout(resolve, 50));
		return replies.shift() ?? done('finished');
	};
	const checks = record();
	const heard: RanCall[] = [];
	const finish: FinishRule = {
		checkTool: checks.checkTool,
		beginWave: (wave) => checks.beginWave(wave),
		endWave: async (calls) => {
			heard.push(...calls);
			await checks.endWave(calls);
		},
		unchecked: () => checks.unchecked(),
	};
	const status: string[] = [];
	const result = await setup(model, [leaky, failing, slow], { finish, emit: (_type, text) => status.push(text), timeoutMs: (tool) => (tool === 'slow' ? 10 : 0) }).run();

	const seen = { questions: JSON.stringify(questions), status: status.join('\n'), finish: JSON.stringify(heard) };
	for (const [where, text] of Object.entries(seen)) {
		for (const [kind, key] of Object.entries(keys)) assert.ok(!text.includes(key), `the ${kind} key reached the ${where}`);
	}
	assert.match(seen.questions, /auth rejected for \[redacted\]/, 'the error keeps its words, without the key');
	assert.match(seen.status, /failing — error: auth rejected for \[redacted\]/);
	assert.ok(
		heard.some((call) => call.late && call.result === 'late with [redacted]'),
		'the late return is redacted too'
	);
	assert.equal(result.answer, 'finished');
});

test('a key in a prepare error, a refusal or the late return of an approved call reaches no question, thinking line or finish rule', async () => {
	// Synthetic key shapes, one per way out that tool approval added.
	const keys = { prepare: `sk-${'p'.repeat(24)}`, refusal: `ghp_${'d'.repeat(36)}`, late: `xoxb-${'a'.repeat(24)}` };
	const tool = (name: string, prepare: AgentTool['prepare']): AgentTool => new AgentTool({ name, description: name, parameters: { type: 'object' }, prepare });
	const unreadable = tool('unreadable', async () => {
		throw new Error(`Cannot read 'pipelines/x.pipe': the store said ${keys.prepare}`);
	});
	const refused = tool('refused', async () => ({ act: { name: 'refused', params: [] }, run: async () => 'refused ran' }));
	// Approved, then times out (limit 10 ms) and ends with its key while the next wave plans.
	const slow = tool('slow', async () => ({
		act: { name: 'slow', params: [] },
		run: async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return `late with ${keys.late}`;
		},
	}));
	// The card's title, and so the refusal, is built from names the server holds.
	const approve: LoopOptions['approve'] = async (act, run) => {
		if (act.name === 'refused') throw new Error(`The user declined: Schedule Nightly ${keys.refusal}.`);
		return run;
	};
	const replies = [plan([['unreadable'], ['refused'], ['slow']]), plan([['unreadable', { again: true }]]), done('finished')];
	const questions: QuestionSpec[] = [];
	const model: ModelCall = async (q) => {
		questions.push(q);
		// The second plan waits until the slow call has ended, so the finish rule hears its late return.
		if (questions.length === 2) await new Promise((resolve) => setTimeout(resolve, 50));
		return replies.shift() ?? done('finished');
	};
	const checks = record();
	const heard: RanCall[] = [];
	const finish: FinishRule = {
		checkTool: checks.checkTool,
		beginWave: (wave) => checks.beginWave(wave),
		endWave: async (calls) => {
			heard.push(...calls);
			await checks.endWave(calls);
		},
		unchecked: () => checks.unchecked(),
	};
	const status: string[] = [];
	const result = await setup(model, [unreadable, refused, slow], { approve, finish, emit: (_type, text) => status.push(text), timeoutMs: (name) => (name === 'slow' ? 10 : 0) }).run();

	const seen = { questions: JSON.stringify(questions), status: status.join('\n'), finish: JSON.stringify(heard) };
	for (const [where, text] of Object.entries(seen)) {
		for (const [kind, key] of Object.entries(keys)) assert.ok(!text.includes(key), `the ${kind} key reached the ${where}`);
	}
	assert.match(seen.questions, /the store said \[redacted\]/, 'the prepare error keeps its words, without the key');
	assert.match(seen.questions, /The user declined: Schedule Nightly \[redacted\]\./, 'the refusal keeps its words, without the key');
	assert.match(seen.status, /refused — error: The user declined: Schedule Nightly \[redacted\]/);
	// the unstarted calls stay out of the finish rule; the approved one that ran late is heard, redacted
	assert.deepEqual(
		heard.map((call) => [call.tool, call.late === true, call.result ?? call.error]),
		[
			['slow', false, 'TimeoutError: no result after 0.01 s'],
			['slow', true, 'late with [redacted]'],
		]
	);
	assert.equal(result.answer, 'finished');
});

test('a key in a message the user sends during the run reaches no question', async () => {
	// A mid-run message skips AgentSession.execute and its pasted-key check.
	const key = `sk-ant-api03-${'k'.repeat(24)}`;
	const inbox: string[] = [];
	const read = stub('read_file', () => {
		inbox.push(`use this key instead: ${key}`);
		return 'file text';
	});
	// The second plan call fails after the run has gathered a result, so the best-effort question is asked too.
	const model = scriptedModel([plan([['read_file', { path: 'a.ts' }]]), new Error('The model provider failed'), 'Read a.ts.']);
	const result = await setup(model, [read], { takeQueued: () => inbox.splice(0) }).run();
	assert.equal(result.stopReason, 'error');
	assert.equal(model.questions.length, 3, 'the next plan and the best-effort question both came after the message');
	assert.ok(!JSON.stringify(model.questions).includes(key), 'the key reached a question');
	for (const q of model.questions.slice(1)) {
		assert.ok(
			q.context.some((c) => c.includes('1. use this key instead: [redacted]')),
			'the message keeps its words, without the key'
		);
	}
});

// =============================================================================
// TIMED-OUT CALLS — nothing runs over a call that timed out and still runs
// =============================================================================

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

/** An edit_file whose call `n: 0` hangs until `hang` settles; it records when each call starts and writes. */
function hangingEdit(hang: Promise<void>, events: string[]): AgentTool {
	return stub('edit_file', async (args) => {
		events.push(`start ${args.n}`);
		if (args.n === 0) await hang;
		events.push(`write ${args.n}`);
		return 'edited';
	});
}

/** The entries a question shows, by key. */
function entriesByKey(q: QuestionSpec): Map<string, Record<string, unknown>> {
	return new Map(resultsIn(q).map((entry) => [String(entry.key), entry]));
}

test('a call on the same file as one that timed out is not run, and the model hears when the first one ends', async () => {
	const hang = deferred();
	const events: string[] = [];
	const checks = record();
	const questions: QuestionSpec[] = [];
	const replies: Array<() => Promise<string>> = [
		async () =>
			plan([
				['edit_file', { path: APP_FILE, n: 0 }],
				['edit_file', { path: APP_FILE, n: 1 }],
			]),
		async () => {
			// step: the hung edit ends while the model thinks
			hang.resolve();
			await new Promise((resolve) => setTimeout(resolve, 5));
			return done('ok');
		},
		async () => plan([['check_app', CHECK_ARGS]]),
		async () => done('ok'),
	];
	const model: ModelCall = async (q) => {
		questions.push(q);
		const next = replies.shift();
		if (!next) throw new Error('no reply left');
		return next();
	};
	const result = await setup(model, [hangingEdit(hang.promise, events), checkTool(checks)], { finish: checks, timeoutMs: () => 10 }).run();

	assert.deepEqual(events, ['start 0', 'write 0'], 'the second edit never started, so it cannot land before or under the first');
	assert.match(String(entriesByKey(questions[1]).get('wave-0.r1')?.error), /^Not run: it waits for edit_file on apps\/a-ui\/src\/a\.ts, which timed out and is still running\. You will be told when that call ends; then plan this one again\.$/);
	const late = entriesByKey(questions[2]);
	assert.match(String(late.get('wave-1.late0')?.note), /timed out and has now ended/);
	assert.match(String(late.get('wave-1.done')?.error), /read how the call\(s\) that timed out ended/, 'done waits until the model has read how it ended');
	assert.equal(result.stopReason, 'done');
});

test('a call on a file that a timed-out call from an earlier wave still changes is not run either', async () => {
	const hang = deferred();
	const events: string[] = [];
	const checks = record();
	const model = scriptedModel([plan([['edit_file', { path: APP_FILE, n: 0 }]]), plan([['edit_file', { path: APP_FILE, n: 1 }]]), new Error('stop')]);
	await setup(model, [hangingEdit(hang.promise, events), checkTool(checks)], { finish: checks, timeoutMs: () => 10 }).run();
	assert.match(String(entriesByKey(model.questions[2]).get('wave-1.r0')?.error), /^Not run: it waits for edit_file on apps\/a-ui\/src\/a\.ts/);
	hang.resolve();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(events, ['start 0', 'write 0']);
});

test('a call that waits for a held-back call is held back too, naming the call that timed out', async () => {
	const hang = deferred();
	const events: string[] = [];
	const rename = stub('rename');
	const NEW_FILE = 'apps/a-ui/src/b.ts';
	// the edit of b overlaps only the rename, which waits for the timed-out edit of a
	const model = scriptedModel([
		plan([
			['edit_file', { path: APP_FILE, n: 0 }],
			['rename', { oldPath: APP_FILE, newPath: NEW_FILE }],
			['edit_file', { path: NEW_FILE, n: 2 }],
		]),
		new Error('stop'),
	]);
	await setup(model, [hangingEdit(hang.promise, events), rename], { timeoutMs: () => 10 }).run();

	const entries = entriesByKey(model.questions[1]);
	assert.match(String(entries.get('wave-0.r1')?.error), /^Not run: it waits for edit_file on apps\/a-ui\/src\/a\.ts/);
	assert.match(String(entries.get('wave-0.r2')?.error), /^Not run: it waits for edit_file on apps\/a-ui\/src\/a\.ts/, 'the edit of b would have run before the rename it was planned after');
	hang.resolve();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(rename.seen.length, 0);
	assert.deepEqual(events, ['start 0', 'write 0']);
});

test('the result of a call that timed out is stored under the key its late entry names', async () => {
	const hang = deferred();
	const big = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, text: `record ${i}` })) });
	const read = stub('read_file', async () => {
		await hang.promise;
		return big;
	});
	const write = stub('write_file');
	const replies: Array<() => Promise<string>> = [
		async () => plan([['read_file', { path: 'apps/a-ui/data.json' }]]),
		async () => {
			// step: the read ends while the model thinks
			hang.resolve();
			await new Promise((resolve) => setTimeout(resolve, 5));
			return done('ok');
		},
		async () =>
			plan([
				['memory.peek', { key: 'wave-1.late0', path: 'items[199].text' }],
				['write_file', { path: 'apps/a-ui/copy.json', content: '{{memory.ref:wave-1.late0}}' }],
			]),
		async () => done('ok'),
	];
	const questions: QuestionSpec[] = [];
	const model: ModelCall = async (q) => {
		questions.push(q);
		const next = replies.shift();
		if (!next) throw new Error('no reply left');
		return next();
	};
	await setup(model, [read, write], { timeoutMs: () => 10 }).run();

	assert.ok(entriesByKey(questions[2]).has('wave-1.late0'), 'the late entry names the key');
	const peeked = entriesByKey(questions[3]).get('wave-2.r0');
	assert.equal(peeked?.error, undefined, 'memory.peek finds the key');
	assert.match(JSON.stringify(peeked), /record 199/);
	assert.deepEqual(write.seen, [{ path: 'apps/a-ui/copy.json', content: big }], 'a reference to the key reads the whole result');
});

test('a key in the result of a call that timed out is redacted in its late entry and in memory under its key', async () => {
	const hang = deferred();
	const key = `sk-${'k'.repeat(24)}`;
	// the key is in the first record, which the entry's summary shows, and in a middle one only memory holds
	const items = Array.from({ length: 200 }, (_, i) => ({ id: i, text: i === 0 || i === 100 ? `token ${key}` : `record ${i}` }));
	const read = stub('read_file', async () => {
		await hang.promise;
		return JSON.stringify({ items });
	});
	const write = stub('write_file');
	const replies: Array<() => Promise<string>> = [
		async () => plan([['read_file', { path: 'apps/a-ui/data.json' }]]),
		async () => {
			// step: the read ends while the model thinks
			hang.resolve();
			await new Promise((resolve) => setTimeout(resolve, 5));
			return done('ok');
		},
		async () =>
			plan([
				['memory.peek', { key: 'wave-1.late0', path: 'items[100].text' }],
				['write_file', { path: 'apps/a-ui/copy.json', content: '{{memory.ref:wave-1.late0}}' }],
			]),
		async () => done('ok'),
	];
	const questions: QuestionSpec[] = [];
	const model: ModelCall = async (q) => {
		questions.push(q);
		const next = replies.shift();
		if (!next) throw new Error('no reply left');
		return next();
	};
	const status: string[] = [];
	await setup(model, [read, write], { timeoutMs: () => 10, emit: (_type, text) => status.push(text) }).run();

	const late = entriesByKey(questions[2]).get('wave-1.late0');
	assert.match(String(late?.summary), /token \[redacted\]/, 'the summary keeps its words, without the key');
	assert.equal(entriesByKey(questions[3]).get('wave-2.r0')?.preview, 'token [redacted]', 'memory holds the redacted result');
	assert.equal(write.seen.length, 1);
	assert.ok(!String(write.seen[0].content).includes(key), 'a reference to the key reads the redacted result');
	assert.match(String(write.seen[0].content), /record 199/, 'the reference still reads the whole result');
	assert.ok(!JSON.stringify(questions).includes(key), 'the key reached a question');
	assert.ok(!status.join('\n').includes(key), 'the key reached a thinking line');
});

test('a call that times out and ends before the rest of its wave still gets its late entry, redacted and stored under its key', async () => {
	const key = `sk-${'k'.repeat(24)}`;
	const events: string[] = [];
	// the edit times out at 10 ms and ends at 25 ms; an unrelated read with no limit keeps the wave going to 50 ms
	const edit = stub('edit_file', async (args) => {
		events.push(`start ${args.n}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
		events.push(`write ${args.n}`);
		return JSON.stringify({ text: `edited with ${key}` });
	});
	const read = stub('read_file', async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		return 'other file';
	});
	const model = scriptedModel([
		plan([
			['edit_file', { path: APP_FILE, n: 0 }],
			['edit_file', { path: APP_FILE, n: 1 }],
			['read_file', { path: 'apps/a-ui/src/other.ts' }],
		]),
		plan([['memory.peek', { key: 'wave-0.late0', path: 'text' }]]),
		new Error('stop'),
	]);
	await setup(model, [edit, read], { timeoutMs: (tool) => (tool === 'edit_file' ? 10 : 0) }).run();

	assert.deepEqual(events, ['start 0', 'write 0'], 'the held-back edit never started');
	const entries = entriesByKey(model.questions[1]);
	assert.match(String(entries.get('wave-0.r1')?.error), /^Not run: it waits for edit_file on apps\/a-ui\/src\/a\.ts/);
	const late = entries.get('wave-0.late0');
	assert.ok(late, 'the model hears that the timed-out edit ended, so it can plan the held-back one again');
	assert.match(String(late.note), /timed out and has now ended/);
	assert.match(String(late.summary), /edited with \[redacted\]/, 'the summary keeps its words, without the key');
	assert.equal(entriesByKey(model.questions[2]).get('wave-1.r0')?.preview, 'edited with [redacted]', 'memory holds the redacted result');
	assert.ok(!JSON.stringify(model.questions).includes(key), 'the key reached a question');
});

// =============================================================================
// APPROVALS AND TIMED-OUT CALLS — an OK is never tool time, and no card asks over a call still on its way
// =============================================================================

/**
 * A tool whose call asks for an OK first, as delete_file does. `events` records
 * each prepare and each run's start and write; the run of call `n: 0` waits for
 * `hang` when one is given.
 */
function askingTool(name: string, events: string[], hang?: Promise<void>): AgentTool {
	return new AgentTool({
		name,
		description: name,
		parameters: { type: 'object' },
		prepare: async (args) => {
			events.push(`prepare ${name} ${args.n}`);
			return {
				act: { name, params: [args.path] },
				run: async () => {
					events.push(`start ${name} ${args.n}`);
					if (hang && args.n === 0) await hang;
					events.push(`write ${name} ${args.n}`);
					return `${name} ran`;
				},
			};
		},
	});
}

/** An approve that records each act it is asked about, takes `waitMs` per answer, and refuses where `answers` says deny. */
function slowApprove(asked: string[], waitMs: number, answers: Array<'approve' | 'deny'> = []): LoopOptions['approve'] {
	return async (act, run) => {
		asked.push(act.name);
		await new Promise((resolve) => setTimeout(resolve, waitMs));
		if (answers.shift() === 'deny') throw new Error(`The user declined: ${act.name}.`);
		return run;
	};
}

test('a call that needs an OK is never prepared or asked while an earlier call on its file timed out and still runs', async () => {
	const hang = deferred();
	const events: string[] = [];
	const asked: string[] = [];
	const model = scriptedModel([
		plan([
			['edit_file', { path: APP_FILE, n: 0 }],
			['delete_file', { path: APP_FILE, n: 1 }],
		]),
		new Error('stop'),
	]);
	await setup(model, [hangingEdit(hang.promise, events), askingTool('delete_file', events)], { timeoutMs: () => 10, approve: slowApprove(asked, 0) }).run();

	assert.deepEqual(asked, [], 'no card asked for the delete');
	assert.match(String(entriesByKey(model.questions[1]).get('wave-0.r1')?.error), /^Not run: it waits for edit_file on apps\/a-ui\/src\/a\.ts, which timed out and is still running\./);
	hang.resolve();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(events, ['start 0', 'write 0'], 'the delete was never prepared, so it cannot land under the edit');
});

test('an OK that takes longer than the limit does not time the call out, so the next call on its file still runs', async () => {
	const events: string[] = [];
	const asked: string[] = [];
	const model = scriptedModel([
		plan([
			['delete_file', { path: APP_FILE, n: 0 }],
			['edit_file', { path: APP_FILE, n: 1 }],
		]),
		new Error('stop'),
	]);
	// the OK takes 30 ms, three times the 10 ms limit
	await setup(model, [askingTool('delete_file', events), hangingEdit(Promise.resolve(), events)], { timeoutMs: () => 10, approve: slowApprove(asked, 30) }).run();

	assert.deepEqual(asked, ['delete_file']);
	assert.deepEqual(events, ['prepare delete_file 0', 'start delete_file 0', 'write delete_file 0', 'start 1', 'write 1'], 'the edit ran after the delete, as planned');
	const entries = entriesByKey(model.questions[1]);
	assert.equal(entries.get('wave-0.r0')?.error, undefined, 'the wait for the OK did not time the delete out');
	assert.equal(entries.get('wave-0.r1')?.error, undefined);
});

test('a call that runs past its limit after a long OK holds back the next call on its file, whose card is never shown', async () => {
	const hang = deferred();
	const events: string[] = [];
	const asked: string[] = [];
	const model = scriptedModel([
		plan([
			['delete_file', { path: APP_FILE, n: 0 }],
			['write_file', { path: APP_FILE, n: 1 }],
		]),
		new Error('stop'),
	]);
	await setup(model, [askingTool('delete_file', events, hang.promise), askingTool('write_file', events)], { timeoutMs: () => 10, approve: slowApprove(asked, 30) }).run();

	assert.deepEqual(asked, ['delete_file'], 'only the first call was asked about');
	const entries = entriesByKey(model.questions[1]);
	assert.match(String(entries.get('wave-0.r0')?.error), /^TimeoutError: no result after 0\.01 s$/, 'the delete timed out in its run, not in the wait');
	assert.match(String(entries.get('wave-0.r1')?.error), /^Not run: it waits for delete_file on apps\/a-ui\/src\/a\.ts, which timed out and is still running\./);
	hang.resolve();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(events, ['prepare delete_file 0', 'start delete_file 0', 'write delete_file 0'], 'the write was never prepared or run');
});

test("a call that waits for an OK in the wave after a timed-out call is not asked when its file is that call's, and is asked when it is not", async () => {
	const hang = deferred();
	const events: string[] = [];
	const asked: string[] = [];
	const model = scriptedModel([
		plan([['edit_file', { path: APP_FILE, n: 0 }]]),
		plan([
			['delete_file', { path: APP_FILE, n: 1 }],
			['write_file', { path: 'apps/a-ui/src/b.ts', n: 2 }],
		]),
		new Error('stop'),
	]);
	await setup(model, [hangingEdit(hang.promise, events), askingTool('delete_file', events), askingTool('write_file', events)], { timeoutMs: () => 10, approve: slowApprove(asked, 30) }).run();

	assert.deepEqual(asked, ['write_file'], 'only the call on another file was asked about');
	const entries = entriesByKey(model.questions[2]);
	assert.match(String(entries.get('wave-1.r0')?.error), /^Not run: it waits for edit_file on apps\/a-ui\/src\/a\.ts/);
	assert.equal(entries.get('wave-1.r1')?.error, undefined, 'the write on the other file ran after its OK');
	hang.resolve();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(events, ['start 0', 'prepare write_file 2', 'start write_file 2', 'write write_file 2', 'write 0'], 'the delete was never prepared');
});

test('a refused call holds nothing back: the next call on its file is asked and runs', async () => {
	const events: string[] = [];
	const asked: string[] = [];
	const model = scriptedModel([
		plan([
			['delete_file', { path: APP_FILE, n: 0 }],
			['write_file', { path: APP_FILE, n: 1 }],
		]),
		new Error('stop'),
	]);
	await setup(model, [askingTool('delete_file', events), askingTool('write_file', events)], { timeoutMs: () => 10, approve: slowApprove(asked, 0, ['deny']) }).run();

	assert.deepEqual(asked, ['delete_file', 'write_file']);
	assert.deepEqual(events, ['prepare delete_file 0', 'prepare write_file 1', 'start write_file 1', 'write write_file 1'], 'the refused delete never ran, and the write did');
	assert.match(String(entriesByKey(model.questions[1]).get('wave-0.r0')?.error), /^The user declined: delete_file\.$/);
});

test('a call whose prepare timed out holds nothing back, since its work never began', async () => {
	const events: string[] = [];
	const slowPrepare = new AgentTool({
		name: 'delete_file',
		description: 'delete_file',
		parameters: { type: 'object' },
		prepare: async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return { act: { name: 'delete_file', params: [] }, run: async () => 'deleted' };
		},
	});
	const model = scriptedModel([
		plan([
			['delete_file', { path: APP_FILE, n: 0 }],
			['edit_file', { path: APP_FILE, n: 1 }],
		]),
		new Error('stop'),
	]);
	await setup(model, [slowPrepare, hangingEdit(Promise.resolve(), events)], { timeoutMs: () => 10 }).run();

	const entries = entriesByKey(model.questions[1]);
	assert.match(String(entries.get('wave-0.r0')?.error), /^TimeoutError/);
	assert.equal(entries.get('wave-0.r1')?.error, undefined);
	assert.deepEqual(events, ['start 1', 'write 1']);
});
