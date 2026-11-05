// =============================================================================
// MIT License
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
// EXPLORER RUNNER — the batch's promises, through a fake session
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abandonRuns, runStatementBatch } from './batch';
import type { IBatchHooks, IBatchView } from './batch';
import type { IFailureNotice, IFailureState, IPatternFinding, IRunTarget, IStatementRunBase, PatternAnswer } from './types';
import { createGeneration } from '../generation';
import { ExplorerToolError } from '../errors';
import type { IGenerationTicket } from '../generation';

// =============================================================================
// FIXTURES
// =============================================================================

/** A run as a Graph-shaped app would extend it. */
interface IRun extends IStatementRunBase {
	cypher: string;
	result?: { columns: string[]; rows: unknown[][] };
}

/** A fake session's answer. */
interface IAnswer {
	columns: string[];
	rows: unknown[][];
}

/** Everything a batch told its view and its hooks. */
interface ITrace {
	events: string[];
	runs: IRun[];
	failure: IFailureState | null;
	recorded: IRun[];
	refusal: string | null;
	started: IRun[] | null;
	finished: { runs: IRun[]; shown: IRun | null; resolved: IRun | null; failedAt: number } | null;
	sent: Array<{ text: string; send: unknown; ticket: IGenerationTicket }>;
	prompts: Array<{ text: string; finding: IPatternFinding }>;
	patternChecksOn: boolean;
}

/**
 * Build hooks, a view and a trace over a scripted fake session.
 *
 * @param behave - Decides each statement's outcome by text; throw to fail it.
 * @param over - Hook overrides and the answer to give to confirmations.
 * @returns The pieces.
 */
function rig(behave: (text: string, index: number) => Promise<IAnswer> | IAnswer, over: { hooks?: Partial<IBatchHooks<IRun, { cypher: string; limit: number }, IAnswer>>; answer?: (text: string) => PatternAnswer | Promise<PatternAnswer>; on?: boolean } = {}) {
	const trace: ITrace = { events: [], runs: [], failure: null, recorded: [], refusal: null, started: null, finished: null, sent: [], prompts: [], patternChecksOn: over.on ?? false };
	let clockValue = 1000;
	let calls = 0;
	const hooks: IBatchHooks<IRun, { cypher: string; limit: number }, IAnswer> = {
		initRun: (target: IRunTarget, index: number): IRun => ({ index, cypher: target.text, kind: /^\s*match/i.test(target.text) ? 'read' : 'write', verb: target.text.trim().split(/\s+/)[0]!.toUpperCase(), outcome: 'pending', start: target.start, end: target.end, startLine: target.startLine, endLine: target.endLine }),
		textOf: (run) => run.cypher,
		patternChecksOn: () => trace.patternChecksOn,
		patternCheck: (run) => (/delete/i.test(run.cypher) ? { kind: 'DELETE without WHERE' } : null),
		disablePatternChecks: () => { trace.patternChecksOn = false; trace.events.push('always'); },
		prepare: (run) => ({ send: { cypher: run.cypher, limit: 1000 }, patch: { limitApplied: 1000, limitState: 'sent' } }),
		execute: async (run, send, ticket) => {
			trace.sent.push({ text: run.cypher, send, ticket });
			const answer = await behave(run.cypher, calls);
			calls += 1;
			return answer;
		},
		settle: (_run, result) => ({ outcome: 'rows', rowCount: result.rows.length, result }),
		describeFailure: (message): IFailureNotice => ({ headline: `Database reported: ${message.split('\n')[0]}`, verbatim: message, generic: false }),
		formatPrior: (runs, failedIndex) => (failedIndex === 0 ? '' : `${failedIndex} before it already ran.`),
		record: (run) => { trace.recorded.push(run); },
		now: () => { clockValue += 10; return clockValue; },
		...(over.hooks ?? {}),
	};
	const view: IBatchView<IRun> = {
		refused: (message) => { trace.refusal = message; trace.events.push('refused'); },
		started: (runs) => { trace.started = runs; trace.runs = runs; trace.events.push('started'); },
		runs: (runs) => { trace.runs = runs; },
		active: (index) => { trace.events.push(`active:${index}`); },
		confirm: async (run, finding) => {
			trace.prompts.push({ text: run.cypher, finding });
			trace.events.push(`confirm:${run.index}`);
			return over.answer ? over.answer(run.cypher) : 'run';
		},
		failed: (failure) => { trace.failure = failure; trace.events.push('failed'); },
		finished: (info) => { trace.finished = info; trace.events.push('finished'); },
	};
	return { hooks, view, trace };
}

const ok = (rows: unknown[][] = [[1]]): IAnswer => ({ columns: ['n'], rows });
const targets = (...texts: string[]): IRunTarget[] => texts.map((text, i) => ({ text, start: i * 10, end: i * 10 + text.length, startLine: i + 1, endLine: i + 1 }));

// =============================================================================
// ORDER, FAILURE, SKIPPING
// =============================================================================

describe('runStatementBatch — sequence and failure', () => {
	it('sends statements one at a time, in order, and settles each with its own result', async () => {
		const { hooks, view, trace } = rig((text) => ok(text === 'MATCH (a)' ? [[1], [2]] : [[3]]));
		const generation = createGeneration();
		const status = await runStatementBatch(targets('MATCH (a)', 'MATCH (b)'), hooks, view, generation.next());
		assert.equal(status, 'done');
		assert.deepEqual(trace.sent.map((s) => s.text), ['MATCH (a)', 'MATCH (b)']);
		assert.deepEqual(trace.events, ['started', 'active:0', 'active:1', 'finished']);
		assert.deepEqual(trace.runs.map((r) => [r.outcome, r.rowCount]), [['rows', 2], ['rows', 1]]);
		assert.equal(trace.finished?.failedAt, -1);
		assert.equal(trace.finished?.shown?.index, 1);
		assert.deepEqual(trace.recorded.map((r) => r.index), [0, 1]);
	});

	it('merges what prepare decided into the run and sends the prepared payload (the limit is data, not appended text)', async () => {
		const { hooks, view, trace } = rig(() => ok());
		await runStatementBatch(targets('MATCH (a) RETURN a'), hooks, view, createGeneration().next());
		assert.deepEqual(trace.sent[0]!.send, { cypher: 'MATCH (a) RETURN a', limit: 1000 });
		assert.equal(trace.runs[0]!.limitApplied, 1000);
		assert.equal(trace.runs[0]!.limitState, 'sent');
		assert.equal(trace.runs[0]!.cypher, 'MATCH (a) RETURN a');
	});

	it('stops at the FIRST failure, skips the rest without sending them, and says what ran before it', async () => {
		const { hooks, view, trace } = rig((text) => { if (text === 'MATCH (bad)') throw new Error('Query failed\nDatabase said: Variable x not defined'); return ok(); });
		const status = await runStatementBatch(targets('MATCH (a)', 'MATCH (bad)', 'MATCH (c)', 'MATCH (d)'), hooks, view, createGeneration().next());
		assert.equal(status, 'done');
		assert.deepEqual(trace.sent.map((s) => s.text), ['MATCH (a)', 'MATCH (bad)']);
		assert.deepEqual(trace.runs.map((r) => r.outcome), ['rows', 'error', 'skipped', 'skipped']);
		assert.equal(trace.runs[1]!.error, 'Query failed\nDatabase said: Variable x not defined');
		assert.deepEqual(trace.failure, {
			notice: { headline: 'Database reported: Query failed', verbatim: 'Query failed\nDatabase said: Variable x not defined', generic: false },
			index: 1,
			lines: 'line 2',
			prior: '1 before it already ran.',
		});
		assert.equal(trace.finished?.failedAt, 1);
		// The failure is recorded; the skipped statements never ran and are never recorded.
		assert.deepEqual(trace.recorded.map((r) => [r.index, r.outcome]), [[0, 'rows'], [1, 'error']]);
	});

	it('uses no atomicity wording of its own: the prior sentence is whatever the app supplies, or empty', async () => {
		const { hooks, view, trace } = rig((text) => { if (text === 'CREATE (x)') throw new Error('boom'); return ok(); }, { hooks: { formatPrior: undefined } });
		await runStatementBatch(targets('MATCH (a)', 'CREATE (x)'), hooks, view, createGeneration().next());
		assert.equal(trace.failure?.prior, '');
	});

	it('hands describeFailure the ORIGINAL error as well as its message, so the app can read an ExplorerToolError\'s kind', async () => {
		const seen: Array<{ message: string; kind: string | undefined; error: unknown }> = [];
		const thrown = new ExplorerToolError({ kind: 'upgrade', tool: 'read_query', message: 'This node cannot run read_query' });
		const { hooks, view } = rig(() => { throw thrown; }, { hooks: { describeFailure: (message, error) => {
			seen.push({ message, kind: error instanceof ExplorerToolError ? error.kind : undefined, error });
			return { headline: message, verbatim: message, generic: false };
		} } });
		await runStatementBatch(targets('MATCH (a)'), hooks, view, createGeneration().next());
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.message, 'This node cannot run read_query');
		assert.equal(seen[0]!.kind, 'upgrade');
		assert.equal(seen[0]!.error, thrown);
	});

	it('passes the failure to the app (onFailure) and a failing first statement has no prior sentence', async () => {
		const seen: string[] = [];
		const { hooks, view, trace } = rig(() => { throw new Error('first one fails'); }, { hooks: { onFailure: (notice, run) => { seen.push(`${run.index}:${notice.headline}`); } } });
		await runStatementBatch(targets('MATCH (a)', 'MATCH (b)'), hooks, view, createGeneration().next());
		assert.deepEqual(seen, ['0:Database reported: first one fails']);
		assert.equal(trace.failure?.prior, '');
		assert.deepEqual(trace.runs.map((r) => r.outcome), ['error', 'skipped']);
	});

	it('shows the last statement that returned rows, else the last that resolved', async () => {
		const settleAffected: Partial<IBatchHooks<IRun, { cypher: string; limit: number }, IAnswer>> = { settle: (run) => ({ outcome: run.kind === 'read' ? 'rows' : 'affected', rowCount: 0, affected: 2 }) };
		const only = rig(() => ok(), { hooks: settleAffected });
		await runStatementBatch(targets('CREATE (a)', 'CREATE (b)'), only.hooks, only.view, createGeneration().next());
		assert.equal(only.trace.finished?.shown?.index, 1);
		assert.deepEqual(only.trace.runs.map((r) => r.outcome), ['affected', 'affected']);

		const mixed = rig(() => ok(), { hooks: settleAffected });
		await runStatementBatch(targets('MATCH (a)', 'CREATE (b)'), mixed.hooks, mixed.view, createGeneration().next());
		assert.equal(mixed.trace.finished?.shown?.index, 0);
		assert.equal(mixed.trace.finished?.resolved?.index, 1);
	});

	it('measures round trip per statement from the injected clock', async () => {
		const { hooks, view, trace } = rig(() => ok());
		await runStatementBatch(targets('MATCH (a)'), hooks, view, createGeneration().next());
		assert.equal(trace.runs[0]!.ms, 10);
	});
});

// =============================================================================
// REFUSAL
// =============================================================================

describe('runStatementBatch — refusal vetoes the whole batch before anything is sent', () => {
	it('refuses with the app\'s message, sends nothing, and never starts', async () => {
		const { hooks, view, trace } = rig(() => ok(), { hooks: { refuse: (runs) => (runs.some((r) => r.kind === 'write') ? 'The browse editor only runs reads. Use the write console.' : null) } });
		const status = await runStatementBatch(targets('MATCH (a)', 'CREATE (x)'), hooks, view, createGeneration().next());
		assert.equal(status, 'refused');
		assert.equal(trace.refusal, 'The browse editor only runs reads. Use the write console.');
		assert.deepEqual(trace.sent, []);
		assert.deepEqual(trace.events, ['refused']);
		assert.equal(trace.started, null);
	});

	it('lets a batch the app accepts through', async () => {
		const { hooks, view, trace } = rig(() => ok(), { hooks: { refuse: () => null } });
		assert.equal(await runStatementBatch(targets('MATCH (a)'), hooks, view, createGeneration().next()), 'done');
		assert.equal(trace.sent.length, 1);
	});
});

// =============================================================================
// PATTERN CHECKS
// =============================================================================

describe('runStatementBatch — the text pattern check', () => {
	it('asks before sending a matching statement, and sends it on "run"', async () => {
		const { hooks, view, trace } = rig(() => ok(), { on: true, answer: () => 'run' });
		await runStatementBatch(targets('MATCH (a)', 'MATCH (n) DELETE n', 'MATCH (b)'), hooks, view, createGeneration().next());
		assert.deepEqual(trace.prompts, [{ text: 'MATCH (n) DELETE n', finding: { kind: 'DELETE without WHERE' } }]);
		assert.deepEqual(trace.events, ['started', 'active:0', 'confirm:1', 'active:1', 'active:2', 'finished']);
		assert.equal(trace.sent.length, 3);
	});

	it('on "cancel" skips this statement and every later one, sends nothing more, and finishes normally', async () => {
		const { hooks, view, trace } = rig(() => ok(), { on: true, answer: () => 'cancel' });
		const status = await runStatementBatch(targets('MATCH (a)', 'MATCH (n) DELETE n', 'MATCH (b)'), hooks, view, createGeneration().next());
		assert.equal(status, 'done');
		assert.deepEqual(trace.sent.map((s) => s.text), ['MATCH (a)']);
		assert.deepEqual(trace.runs.map((r) => r.outcome), ['rows', 'skipped', 'skipped']);
		assert.deepEqual(trace.recorded.map((r) => r.index), [0]);
	});

	it('on "always" runs it, turns the check off, and does not ask again for the next match in the SAME batch', async () => {
		const { hooks, view, trace } = rig(() => ok(), { on: true, answer: () => 'always' });
		await runStatementBatch(targets('MATCH (n) DELETE n', 'MATCH (m) DELETE m'), hooks, view, createGeneration().next());
		assert.equal(trace.prompts.length, 1);
		assert.equal(trace.sent.length, 2);
		assert.ok(trace.events.includes('always'));
	});

	it('never asks when checks are off, or when the app has no check', async () => {
		const off = rig(() => ok(), { on: false });
		await runStatementBatch(targets('MATCH (n) DELETE n'), off.hooks, off.view, createGeneration().next());
		assert.equal(off.trace.prompts.length, 0);
		const none = rig(() => ok(), { on: true, hooks: { patternCheck: undefined } });
		await runStatementBatch(targets('MATCH (n) DELETE n'), none.hooks, none.view, createGeneration().next());
		assert.equal(none.trace.prompts.length, 0);
	});

	it('drops the batch if the ticket expired while the dialog was open, sending nothing', async () => {
		const generation = createGeneration();
		const ticket = generation.next();
		let release: ((answer: PatternAnswer) => void) | undefined;
		const { hooks, view, trace } = rig(() => ok(), { on: true, answer: () => new Promise<PatternAnswer>((resolve) => { release = resolve; }) });
		const running = runStatementBatch(targets('MATCH (n) DELETE n', 'MATCH (b)'), hooks, view, ticket);
		await new Promise((resolve) => setImmediate(resolve));
		generation.invalidate();
		release?.('run');
		assert.equal(await running, 'dropped');
		assert.deepEqual(trace.sent, []);
		assert.equal(trace.finished, null);
	});
});

// =============================================================================
// STOP WAITING / STALE RESULTS
// =============================================================================

describe('runStatementBatch — Stop waiting and the late answer', () => {
	it('ignores the late SUCCESS of an abandoned statement: nothing is published, recorded or finished', async () => {
		const generation = createGeneration();
		const ticket = generation.next();
		let release: ((answer: IAnswer) => void) | undefined;
		const { hooks, view, trace } = rig(() => new Promise<IAnswer>((resolve) => { release = resolve; }));
		const running = runStatementBatch(targets('MATCH (a)', 'MATCH (b)'), hooks, view, ticket);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(trace.runs[0]!.outcome, 'running');
		// The owner stops waiting: the ticket expires and the in-flight run is marked abandoned.
		generation.invalidate();
		const abandoned = abandonRuns(trace.runs, 4_200);
		release?.(ok());
		assert.equal(await running, 'dropped');
		assert.deepEqual(abandoned.runs.map((r) => r.outcome), ['abandoned', 'skipped']);
		assert.equal(abandoned.abandoned?.ms, 4_200);
		// The batch never touched state after the ticket expired.
		assert.equal(trace.runs[0]!.outcome, 'running');
		assert.deepEqual(trace.recorded, []);
		assert.equal(trace.finished, null);
		assert.equal(trace.sent.length, 1);
	});

	it('ignores the late FAILURE of an abandoned statement too', async () => {
		const generation = createGeneration();
		const ticket = generation.next();
		let fail: ((error: Error) => void) | undefined;
		const { hooks, view, trace } = rig(() => new Promise<IAnswer>((_resolve, reject) => { fail = reject; }));
		const running = runStatementBatch(targets('MATCH (a)'), hooks, view, ticket);
		await new Promise((resolve) => setImmediate(resolve));
		generation.invalidate();
		fail?.(new Error('database exploded'));
		assert.equal(await running, 'dropped');
		assert.equal(trace.failure, null);
		assert.deepEqual(trace.recorded, []);
	});

	it('treats a session-level stale marker as a drop, never as the statement\'s failure', async () => {
		const { hooks, view, trace } = rig(() => { throw new ExplorerToolError({ kind: 'stale', tool: 'read_query', message: 'dropped' }); });
		assert.equal(await runStatementBatch(targets('MATCH (a)'), hooks, view, createGeneration().next()), 'dropped');
		assert.equal(trace.failure, null);
		assert.deepEqual(trace.recorded, []);
	});

	it('hands the batch\'s ticket to execute so the app can pass it to the session', async () => {
		const generation = createGeneration();
		const ticket = generation.next();
		const { hooks, view, trace } = rig(() => ok());
		await runStatementBatch(targets('MATCH (a)', 'MATCH (b)'), hooks, view, ticket);
		assert.ok(trace.sent.every((s) => s.ticket === ticket));
	});

	it('drops a batch whose ticket expired between statements, without sending the next', async () => {
		const generation = createGeneration();
		const ticket = generation.next();
		const { hooks, view, trace } = rig((text) => { if (text === 'MATCH (a)') generation.invalidate(); return ok(); });
		assert.equal(await runStatementBatch(targets('MATCH (a)', 'MATCH (b)'), hooks, view, ticket), 'dropped');
		assert.deepEqual(trace.sent.map((s) => s.text), ['MATCH (a)']);
	});
});

describe('abandonRuns', () => {
	it('abandons only the statement in flight, skips the unsent ones, and keeps what settled', () => {
		const runs = [
			{ index: 0, kind: 'read', verb: 'MATCH', outcome: 'rows' },
			{ index: 1, kind: 'read', verb: 'MATCH', outcome: 'running' },
			{ index: 2, kind: 'read', verb: 'MATCH', outcome: 'pending' },
			{ index: 3, kind: 'read', verb: 'MATCH', outcome: 'skipped' },
		] as IStatementRunBase[];
		const { runs: next, abandoned } = abandonRuns(runs, 1500);
		assert.deepEqual(next.map((r) => r.outcome), ['rows', 'abandoned', 'skipped', 'skipped']);
		assert.equal(abandoned?.index, 1);
		assert.equal(next[1]!.ms, 1500);
		// Pure: the input list is untouched.
		assert.equal(runs[1]!.outcome, 'running');
	});

	it('reports no abandoned statement when nothing was in flight (declined at the dialog)', () => {
		const { abandoned } = abandonRuns([{ index: 0, kind: 'read', verb: 'M', outcome: 'pending' } as IStatementRunBase], 10);
		assert.equal(abandoned, null);
	});
});
