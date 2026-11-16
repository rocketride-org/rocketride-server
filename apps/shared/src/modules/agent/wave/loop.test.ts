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
// WAVE LOOP TESTS — the done rule, running calls (order, approval, timeouts, user time), stop and steering, cut replies, peek, summaries, no key past a tool
// =============================================================================

import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';

import type { Message } from 'rocketride';

import { ModelFailure, type ChatModel, type ModelRequest, type ModelResponse } from '../model';
import { CheckRecord } from '../run';
import type { CheckStatus } from '../toolkits/appCheck';
import { AgentTool, UserTime } from '../tools';
import { UsageMeter } from '../usage';
import { runLoop, type FinishRule, type LoopOptions, type RanCall } from './loop';
import { peek, RunMemory } from './memory';
import type { PromptPrefix } from './plan';
import { cut, done, notesIn, plan, raw, resultsIn, scriptedModel, type ScriptedModel, type Step } from './scripted';
import { openSession } from './session';
import { summarize } from './summary';

// =============================================================================
// FIXTURES
// =============================================================================

type Call = readonly [string, Record<string, unknown>?];

const PREFIX: PromptPrefix = { role: 'You are Wave.', instructions: [], tools: [] };

/** An edit inside the app `a-ui`, so it needs a check_app on `a-ui`. */
const APP_FILE = 'apps/a-ui/src/a.ts';
const EDIT: Call = ['edit_file', { path: APP_FILE }];
const CHECK: Call = ['check_app', { app: 'a-ui' }];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The scripted models of the running test; each must keep the turn rules on every send. */
const models: ScriptedModel[] = [];

afterEach(() => {
	for (const model of models.splice(0)) assert.deepEqual(model.broken, [], 'every send kept the turn rules');
});

/** A scripted model under one adapter: native, or a node that refuses tools and so is asked in text. */
function scripted(script: Step[], native: boolean, onSend?: (step: number) => void | Promise<void>): ScriptedModel {
	const model = scriptedModel(script, { native, onSend });
	models.push(model);
	return model;
}

/** Registers one test per adapter: the same script, two ways of talking. */
function both(name: string, fn: (native: boolean, t: TestContext) => Promise<void>): void {
	for (const native of [true, false]) test(`${name} (${native ? 'native' : 'text'})`, (t) => fn(native, t));
}

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

/** Runs the loop on a session over `model` and `tools`; `extra` overrides the defaults. */
function loop(model: ChatModel, tools: AgentTool[] = [], extra: Partial<LoopOptions> & { meter?: UsageMeter; limitMs?: number } = {}) {
	const { meter, limitMs, ...options } = extra;
	const signal = options.signal ?? new AbortController().signal;
	const session = openSession({ model, prefix: PREFIX, history: [], request: 'do it', signal, meter, limitMs });
	return runLoop({ session, tools, finish: record(), emit: () => undefined, signal, takeQueued: () => [], approve: async (_act, run) => run, ...options });
}

/** The notes of a request that are result entries as text (how timed-out calls ended). */
function entriesIn(notes: string[]): Array<Record<string, unknown>> {
	return notes.flatMap((note) => {
		try {
			return [JSON.parse(note) as Record<string, unknown>];
		} catch {
			return [];
		}
	});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

// =============================================================================
// THE DONE RULE — no answer until each changed app passes check_app, and each changed pipeline validates
// =============================================================================

both('done after a change is refused until a check passes in a later wave', async (native) => {
	// A check in the change's own wave may run before the edit lands, so it does not count.
	const checks = record();
	const meter = new UsageMeter({ model: 'claude-sonnet-5-5' });
	const model = scripted([plan(EDIT, CHECK), done('too soon'), plan(CHECK), done('checked')], native);
	const result = await loop(model, [stub('edit_file'), checkTool(checks)], { finish: checks, meter });
	assert.deepEqual({ answer: result.answer, stopReason: result.stopReason }, { answer: 'checked', stopReason: 'done' });
	assert.match(notesIn(model.asked[2]).join('\n'), /^Not finished: call check_app on a-ui/m, "the refusal went back as the user's text");
	assert.equal(meter.snapshot().estimated, !native, "a native turn is metered at the provider's tokens, a text turn at an estimate");
});

both('a call whose memory reference names nothing did not run, so it is no change and done needs no check', async (native) => {
	const checks = record();
	const write = stub('write_file');
	const result = await loop(scripted([plan(['write_file', { path: APP_FILE, content: '{{memory.ref:wave-0.r9}}' }]), done('finished')], native), [write, checkTool(checks)], { finish: checks });
	assert.deepEqual({ answer: result.answer, ran: write.seen.length }, { answer: 'finished', ran: 0 });
});

both('a failed check, or a check call that errors, blocks done until a newer one passes', async (native) => {
	// pass, then fail or error: the newest check decides, so the work is unchecked again
	for (const verdict of ['fail', 'error'] as const) {
		const checks = record();
		const model = scripted([plan(EDIT), plan(CHECK), plan(CHECK), done('too soon'), plan(CHECK), done('checked')], native);
		const result = await loop(model, [stub('edit_file'), checkTool(checks, ['pass', verdict])], { finish: checks });
		assert.equal(result.answer, 'checked', `after a check that ended in ${verdict}`);
	}
});

both('a changed pipeline whose last save failed validate blocks done until a save that passes', async (native) => {
	// This write reports each save's validate to the record, the way the save hook does.
	const checks = record();
	const saves = [['llm_1: lane questions has no source'], []];
	const write = stub('write_file', (args) => {
		checks.pipelineSaved(String(args.path), { errors: saves.shift() ?? [] });
		return 'saved';
	});
	const save = plan(['write_file', { path: 'pipelines/a.pipe' }]);
	const result = await loop(scripted([save, done('too soon'), save, done('valid')], native), [write], { finish: checks });
	assert.equal(result.answer, 'valid');
});

test('a done block after the plan does not finish the run (text: only a JSON reply can hold both)', async () => {
	const fence = (json: object) => '```json\n' + JSON.stringify(json) + '\n```';
	const list = stub('list_components');
	const both = raw(fence({ thought: 'working', tool_calls: [{ tool: 'list_components', args: {} }] }) + '\n' + fence({ thought: 'finishing', done: true, answer: 'waiting' }));
	const result = await loop(scripted([both, done('built')], false), [list]);
	assert.deepEqual({ ran: list.seen.length, answer: result.answer }, { ran: 1, answer: 'built' });
});

// =============================================================================
// RUNNING CALLS — same-file order, asking first, timed-out calls, user time
// =============================================================================

both('calls on one file in one wave run in planned order', async (native) => {
	// The first edit is the slow one: run together, the second would finish first.
	const events: string[] = [];
	const edit = loggedEdit(events, (n) => sleep(n === 0 ? 20 : 0));
	await loop(scripted([plan(['edit_file', { path: 'a.ts', n: 0 }], ['edit_file', { path: 'a.ts', n: 1 }]), new Error('stop'), done('stopped')], native), [edit]);
	assert.deepEqual(events, ['start 0', 'write 0', 'start 1', 'write 1']);
});

both('a read planned after a write of the same file in one wave sees what the write wrote, and a read of another file runs alongside', async (native) => {
	const pipe = 'pipelines/a.pipe';
	const files = new Map([
		[pipe, 'old'],
		['guide.md', 'guide'],
	]);
	const guideRead = deferred();
	// The write lands only once the read of guide.md has started, so a wave that held that read back would time the write out.
	const write = stub('write_file', async ({ path, content }) => {
		await guideRead.promise;
		files.set(String(path), String(content));
		return 'saved';
	});
	const read = stub('read_file', ({ path }) => {
		if (path === 'guide.md') guideRead.resolve();
		return files.get(String(path)) ?? 'File not found';
	});
	// Like the real tool, validate reads params[0].filepath while it prepares.
	const client = prepared('rocketride_client', async ({ params }) => {
		const text = files.get(String((params as Array<{ filepath: string }>)[0].filepath));
		if (text === undefined) throw new Error('File not found');
		return { run: async () => `validate: ${text}` };
	});
	const model = scripted([plan(['write_file', { path: pipe, content: 'new' }], ['rocketride_client', { method: 'validate', params: [{ filepath: pipe }] }], ['read_file', { path: pipe }], ['read_file', { path: 'guide.md' }]), done('read')], native);
	await loop(model, [write, read, client], { timeoutMs: () => 1000 });
	assert.deepEqual(
		resultsIn(model.asked[1]).map((entry) => entry.summary ?? entry.error),
		['saved', 'validate: new', 'new', 'guide']
	);
});

both('waiting for an OK never counts against the limit, and a refused call runs nothing and is no change', async (native) => {
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
	const model = scripted([plan(['publish_app']), plan(['delete_file', { path: APP_FILE }]), done('Not deleted: the user said no.')], native);
	const result = await loop(model, [asking('publish_app'), asking('delete_file')], { approve, timeoutMs: () => 10 });
	assert.deepEqual(ran, ['publish_app'], 'the refused call never ran');
	assert.match(JSON.stringify(resultsIn(model.asked[1])), /publish_app ran/, 'the wait for an OK did not time the call out');
	assert.match(JSON.stringify(resultsIn(model.asked[2])), /The user declined: delete_file/, 'the model read the refusal');
	// a refused delete heard as a change would refuse this done until a check_app, and the script has no reply left
	assert.equal(result.answer, 'Not deleted: the user said no.', 'the done after the refused call needed no check');
});

both('a call on a file a timed-out call still changes is not run, and done waits until the model reads how that call ended', async (native) => {
	const hang = deferred();
	const events: string[] = [];
	// The hung edit ends as the finish rule hears the second wave, after the loop took the timed-out calls that had ended.
	let waves = 0;
	const finish = satisfied(async () => {
		if (++waves !== 2) return;
		hang.resolve();
		await sleep(5);
	});
	const model = scripted([plan(['edit_file', { path: APP_FILE, n: 0 }], ['edit_file', { path: APP_FILE, n: 1 }]), done('too soon'), done('too soon'), done('ok')], native);
	const edit = loggedEdit(events, (n) => (n === 0 ? hang.promise : Promise.resolve()));
	const shown = new AgentTool({ name: edit.name, description: edit.description, parameters: edit.parameters, prepare: (args) => edit.prepare(args), show: (result, args) => `${result}, shown for n=${args.n}` });
	const result = await loop(model, [shown], { finish, timeoutMs: () => 10 });
	assert.deepEqual(events, ['start 0', 'write 0'], 'the second edit never started, so it cannot land before or under the first');
	assert.equal(result.answer, 'ok', 'a done before the model read how the edit ended was accepted');
	const late = entriesIn(notesIn(model.asked[3])).find((entry) => entry.key === 'wave-2.late0');
	assert.equal(late?.summary, 'edited, shown for n=0', 'the model read how the edit ended, in the view its tool gives of the call it ran');
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

both("a call's time limit stands still while the user answers its question", async (native, t) => {
	const advance = fakeClock(t);
	const userTime = new UserTime();
	const answered = deferred();
	// step: 50 ms of work, then a second in a dialog, under a 100 ms limit
	const asking = stub('edit_file', async () => {
		await sleep(50);
		await userTime.during(answered.promise);
		return 'edited';
	});
	const model = scripted([plan(['edit_file', { path: 'a.ts' }]), done('ok')], native);
	const running = loop(model, [asking], { timeoutMs: () => 100, userTime });
	await advance(50);
	await advance(1000);
	answered.resolve();
	await running;
	const [entry] = resultsIn(model.asked[1]);
	assert.ok(entry && entry.error === undefined, 'no timeout while the user decides');
});

// =============================================================================
// STOP AND STEERING
// =============================================================================

both('Stop mid-wave ends the run at once: nothing new starts, and what is still running is named', async (native) => {
	const stop = new AbortController();
	const emitted: string[] = [];
	const edit = stub('edit_file');
	// The deploy stops the run while it works, and never finishes.
	const deploy = stub('deploy_app', () => {
		stop.abort();
		return new Promise<string>(() => undefined);
	});
	const model = scripted([plan(['edit_file', { path: 'a.ts' }], ['deploy_app', { app: 'x' }], ['edit_file', { path: 'a.ts' }])], native);
	const result = await loop(model, [edit, deploy], { signal: stop.signal, emit: (_type, text) => emitted.push(text) });
	assert.equal(result.stopReason, 'stopped');
	assert.equal(model.asked.length, 1, 'no model call after the stop');
	assert.equal(edit.seen.length, 1, 'the edit waiting on the same file never started');
	assert.match(emitted.at(-1) ?? '', /- deploy_app x/, 'the last row names the call still running');
});

/** A model whose sends `answer` decides, recording which were fresh (a fresh send restarts the pipeline). */
function freshCounting(answer: (request: ModelRequest, fresh: boolean) => Promise<ModelResponse>): ChatModel & { fresh: boolean[] } {
	const fresh: boolean[] = [];
	return {
		name: 'm',
		fresh,
		send: (request, o) => {
			fresh.push(o?.fresh === true);
			return answer(request, o?.fresh === true);
		},
	};
}

test('a model call abandoned by Stop does not restart the pipeline when it fails late (the send policy, the same under either adapter)', async () => {
	const ended = (): ModelFailure => new ModelFailure('The model pipeline stopped responding: pipeline ended', { retryable: true, billed: true });
	// Not stopped, the same failure restarts the pipeline once, so this test can see a restart.
	const failing = freshCounting(() => Promise.reject(ended()));
	// the loop throws, since nothing was gathered
	await assert.rejects(loop(failing), /stopped responding/);
	assert.deepEqual(failing.fresh, [false, true]);

	const stop = new AbortController();
	let failLate: ((error: Error) => void) | undefined;
	const abandoned = freshCounting(() => new Promise((_resolve, reject) => (failLate = reject)));
	const running = loop(abandoned, [], { signal: stop.signal });
	await sleep(0);
	assert.ok(failLate, 'the model call is in flight');
	stop.abort();
	assert.equal((await running).stopReason, 'stopped');
	failLate?.(ended());
	await sleep(0);
	assert.deepEqual(abandoned.fresh, [false], 'the late failure restarted nothing');
});

test('a model call with no answer inside the limit is asked again on a fresh pipeline (the send policy, the same under either adapter)', async () => {
	const script = scripted([done('built')], true);
	const model = freshCounting((request, fresh) => (fresh ? script.send(request) : new Promise<ModelResponse>(() => undefined)));
	const result = await loop(model, [], { limitMs: 20 });
	assert.equal(result.answer, 'built');
	assert.deepEqual(model.fresh, [false, true], 'the hung send was retried once, on a fresh pipeline');
});

both('a message sent before done is read before the run finishes', async (native) => {
	const inbox: string[] = [];
	// The user writes again just as the model says it is done.
	const model = scripted([done('too soon'), done('final')], native, (step) => {
		if (step === 0) inbox.push('also do C');
	});
	const result = await loop(model, [], { takeQueued: () => inbox.splice(0) });
	assert.match(notesIn(model.asked[1]).join('\n'), /also do C/, 'the done was sent back so the message is read');
	assert.equal(result.answer, 'final');
});

// =============================================================================
// CUT REPLIES AND THE TURN RULES — what the session answers itself
// =============================================================================

both('a reply cut at the output limit never runs its calls, and an answer cut there is continued', async (native) => {
	const write = stub('write_file');
	const model = scripted([cut(plan(['write_file', { path: 'big.ts' }])), plan(['write_file', { path: 'small.ts' }]), cut(done('Part one, ')), done('part two.')], native);
	const result = await loop(model, [write]);
	assert.deepEqual(
		write.seen.map((args) => args.path),
		['small.ts'],
		'only the call from a whole reply ran'
	);
	// a text reply carries no stop reason: cut, it is not JSON, and is sent back as unusable
	assert.equal(result.answer, native ? 'Part one, part two.' : 'part two.');
});

test('the scripted model refuses a request that breaks a turn rule, so every loop test checks them', async () => {
	const model = scriptedModel([done('never')]);
	const ask = (messages: Message[]) => model.send({ kind: 'turn', system: { role: '', instructions: [] }, messages, tools: [] });
	const call: Message = { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: {} }] };
	await assert.rejects(ask([{ role: 'user', content: 'go' }, call, { role: 'user', content: 'go on' }]), /not each answered once/);
	await assert.rejects(
		ask([
			{ role: 'user', content: 'go' },
			{ role: 'user', content: 'again' },
		]),
		/both the user's/
	);
	await assert.rejects(ask([{ role: 'user', content: 'go' }, call]), /last message is not the user's/);
	assert.equal(model.asked.length, 0, 'no step answered a broken request');
});

// =============================================================================
// PEEK AND ANSWER REFERENCES — one peek, or one reference in the answer, puts at most 32,000 characters in front of the model or user
// =============================================================================

test('a chunk peek returns at most 32,000 characters, and a path peek past that is cut and says by how much', () => {
	const memory = new RunMemory();
	memory.put('text', 'x'.repeat(100_000));
	memory.put('json', JSON.stringify({ note: 'y'.repeat(40_000), rows: Array.from({ length: 60 }, () => 'z'.repeat(1_000)) }));

	const chunk = JSON.parse(peek(memory, { key: 'text', length: 50_000 }));
	assert.deepEqual({ ...chunk, preview: chunk.preview.length }, { preview: 32_000, offset: 0, length: 32_000, total_chars: 100_000 });

	const note = JSON.parse(peek(memory, { key: 'json', path: 'note' }));
	assert.deepEqual({ ...note, preview: note.preview.length }, { path: 'note', preview: 32_000, truncated: true, returned_chars: 32_000, total_chars: 40_000 });

	// the array cap leaves 50 rows, still over 32,000 characters, so both counts come back
	const rows = JSON.parse(peek(memory, { key: 'json', path: 'rows' }));
	assert.deepEqual({ ...rows, preview: rows.preview.length }, { path: 'rows', preview: 32_000, truncated: true, returned_items: 50, total_items: 60, returned_chars: 32_000, total_chars: 50 * 1_003 + 1 });
});

both('a reference in the final answer pastes at most 32,000 characters and says how many it cut, while one in a tool argument arrives whole', async (native) => {
	const big = 'x'.repeat(40_000);
	const take = stub('take');
	const model = scripted([plan(['big']), plan(['take', { data: '{{memory.ref:wave-0.r0}}' }]), done('Here: {{memory.ref:wave-0.r0}}')], native);
	const result = await loop(model, [stub('big', () => big), take]);
	assert.equal(take.seen[0].data, big);
	assert.equal(result.answer, `Here: ${'x'.repeat(32_000)} ... (cut at 32,000 of 40,000 characters)`);
});

both('the partial report shows a path peek cut by characters with its real counts', async (native) => {
	const model = scripted([plan(['big']), plan(['memory.peek', { key: 'wave-0.r0', path: 'note' }]), new Error('down')], native);
	const result = await loop(model, [stub('big', () => JSON.stringify({ note: 'y'.repeat(40_000) }))], { maxWaves: 2 });
	assert.match(result.answer, /note = y{2000} \.\.\. \(cut at 2,000 of 32,000 characters\) \(characters 0 to 32,000 of 40,000\)$/m);
	assert.doesNotMatch(result.answer, /undefined/);
});

// =============================================================================
// SUMMARIES — what the model sees of a stored result: a lookup table names its entries, a long list shows both ends
// =============================================================================

/** A lookup table under `names`: each entry has three shared fields, one long, and one field of its own. */
const lookupTable = (names: string[]): Record<string, unknown> => Object.fromEntries(names.map((name, i) => [name, { title: `Service ${i}`, plans: null, description: 'd'.repeat(300), [`only_${i}`]: i }]));

test('a lookup table too big to show as a record shows every name that fits, then whole entries labelled as a path writes them', () => {
	const names = ['llm-anthropic', ...Array.from({ length: 199 }, (_, i) => `svc_${i}`)];
	const summary = summarize(JSON.stringify({ services: lookupTable(names) }));
	assert.match(summary, /^services:\n200 items, shared fields: \['title', 'plans', 'description'\] \(showing [1-9]\d* of 200\)\n/);
	const sample = `\n  "llm-anthropic":\n    title: "Service 0"\n    plans: null\n    description: "${'d'.repeat(80)}..." (300 chars)\n    only_0: 0\n  svc_0:\n`;
	assert.ok(summary.includes(`\n  names: ["llm-anthropic", ${names.slice(1).join(', ')}]${sample}`), 'every name, then the first entries whole');
	assert.ok(summary.length <= 6000);

	const many = summarize(JSON.stringify({ services: lookupTable(Array.from({ length: 1000 }, (_, i) => `service_number_${i}`)) }));
	assert.match(many, /\n {2}names: \[service_number_0, service_number_1, .*, service_number_\d+\] and \d+ more\n\(short fields/, 'names past the room end with how many more there are');
});

test('a lookup table that fits, and a record of entries that share no field, show as records as before', () => {
	assert.equal(summarize(JSON.stringify({ a: { id: 1, name: 'x' }, b: { id: 2, name: 'y' }, c: { id: 3, name: 'z' } })), 'a:\n  id: 1\n  name: "x"\nb:\n  id: 2\n  name: "y"\nc:\n  id: 3\n  name: "z"');

	const unlike = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k_${i}`, { [`f_${i}`]: 'v'.repeat(100) }]));
	const summary = summarize(JSON.stringify(unlike));
	assert.match(summary, /^k_0: {3}f_0: \(100 chars, peek the key to read it\)\n/);
	assert.match(summary, /\n\.\.\. \(showing \d+ of 300 fields, peek the key for the rest\)$/);
	assert.doesNotMatch(summary, /shared fields|names:/);
});

test('a list too long to show whole shows rows from its start and end, two thirds from the start, each under its real index', () => {
	const events = Array.from({ length: 60 }, (_, i) => ({ seq: i, message: 'm'.repeat(100) }));
	const summary = summarize(JSON.stringify({ events }));
	const shown = [...summary.matchAll(/row\[(\d+)\]:\n {4}seq: (\d+)/g)].map(([, row, seq]) => {
		assert.equal(row, seq, 'each row is labelled with its own index');
		return Number(row);
	});
	const last = shown.filter((i) => i >= 30).length;
	const first = shown.length - last;
	assert.ok(last >= 1 && Math.abs(first - 2 * last) <= 1, `first ${first}, last ${last}`);
	assert.deepEqual(shown, [...Array.from({ length: first }, (_, i) => i), ...Array.from({ length: last }, (_, i) => 60 - last + i)]);
	assert.match(summary, new RegExp(`^events:\\n60 items, fields: \\['seq', 'message'\\] \\(showing first ${first} and last ${last} of 60\\)\\n`));
});

// =============================================================================
// SECRETS — what a tool returns or throws, and what the user sends mid-run, is redacted before anything reads it
// =============================================================================

both('a key in a result, error, prepare error, refusal, late return or user message reaches no request, thinking line or finish rule', async (native) => {
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
	const inbox: string[] = [];
	// The third reply fails after results were gathered, so the final answer is asked too.
	const model = scripted([plan(['leaky'], ['failing'], ['unreadable'], ['refused'], ['slow']), done('too soon'), new Error('The model provider failed'), raw('best effort')], native, async (step) => {
		// A mid-run message skips AgentSession.execute and its pasted-key check.
		if (step === 0) inbox.push(`use this key instead: ${key('message')}`);
		// The second reply waits until the slow call has ended, so the finish rule hears its late return.
		if (step === 1) await sleep(50);
	});
	const heard: RanCall[] = [];
	const status: string[] = [];
	const finish = satisfied(async (calls) => {
		heard.push(...calls);
	});
	await loop(model, tools, { approve, finish, emit: (_type, text) => status.push(text), takeQueued: () => inbox.splice(0), timeoutMs: (tool) => (tool === 'slow' ? 10 : 0) });
	const seen = { request: JSON.stringify(model.requests), 'thinking line': status.join('\n'), 'finish rule': JSON.stringify(heard) };
	for (const [kind, [secret, kept]] of Object.entries(leaks)) {
		for (const [where, text] of Object.entries(seen)) assert.ok(!text.includes(secret), `the ${kind} key reached a ${where}`);
		assert.ok(seen.request.includes(kept), `the ${kind} reached the model with its words, without the key`);
	}
	assert.equal(heard.find((call) => call.late)?.result, 'late with [redacted]', 'the finish rule heard the late return, redacted');
});
