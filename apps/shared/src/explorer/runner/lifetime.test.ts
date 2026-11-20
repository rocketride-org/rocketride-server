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
// EXPLORER RUNNER — the runner's lifetime (what unmounting its owner does)
// =============================================================================
//
// A query tab closing, or the shell switching apps, unmounts the component that
// owns the runner. The batch it started must stop there: the statement already
// at the node finishes there (nothing can cancel it), but nothing after it is
// sent. The cleanup is driven by hand here: this runner has no DOM to mount in.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runStatementBatch } from './batch';
import type { IBatchHooks, IBatchView } from './batch';
import type { IFailureNotice, IRunTarget, IStatementRunBase, PatternAnswer } from './types';
import { attachRunnerLifetime } from './useStatementRunner';
import type { IRunnerLifetime } from './useStatementRunner';
import { createGeneration } from '../generation';
import type { IGenerationTicket } from '../generation';

/** A minimal run. */
interface IRun extends IStatementRunBase {
	text: string;
}

/** A statement the fake session is holding, released by the test. */
interface IHeld {
	text: string;
	release: () => void;
}

/**
 * Build hooks whose session holds every statement until the test releases it.
 *
 * @param flagged - Statements the pattern check asks about.
 * @returns The hooks, the view, what was sent and what is held.
 */
function rig(flagged: (text: string) => boolean = () => false) {
	const sent: string[] = [];
	const recorded: string[] = [];
	const held: IHeld[] = [];
	const hooks: IBatchHooks<IRun, string, { rows: number }> = {
		initRun: (target: IRunTarget, index: number): IRun => ({ index, text: target.text, kind: 'write', verb: 'CREATE', outcome: 'pending', start: target.start, end: target.end, startLine: target.startLine, endLine: target.endLine }),
		textOf: (run) => run.text,
		patternChecksOn: () => true,
		patternCheck: (run) => (flagged(run.text) ? { kind: 'DELETE without WHERE' } : null),
		prepare: (run) => ({ send: run.text }),
		execute: (_run, send: string, _ticket: IGenerationTicket) => {
			sent.push(send);
			return new Promise((resolve) => { held.push({ text: send, release: () => resolve({ rows: 1 }) }); });
		},
		settle: () => ({ outcome: 'affected', affected: 1 }),
		describeFailure: (message): IFailureNotice => ({ headline: message, verbatim: message, generic: false }),
		record: (run) => { recorded.push(run.text); },
		now: () => 0,
	};
	const view: IBatchView<IRun> = {
		refused: () => undefined,
		started: () => undefined,
		runs: () => undefined,
		active: () => undefined,
		// What the hook's view does: the open dialog's resolver is the one unmount cancels.
		confirm: () => new Promise<PatternAnswer>((resolve) => { lifetimeResolver.current = resolve; }),
		failed: () => undefined,
		finished: () => undefined,
	};
	const lifetimeResolver: IRunnerLifetime['patternResolver'] = { current: null };
	return { hooks, view, sent, recorded, held, lifetimeResolver };
}

const targets = (...texts: string[]): IRunTarget[] => texts.map((text, i) => ({ text, start: i * 10, end: i * 10 + text.length, startLine: i + 1, endLine: i + 1 }));

/**
 * Let queued promise continuations run.
 *
 * @returns A promise that resolves on the next macrotask.
 */
function turn(): Promise<void> {
	return new Promise((resolve) => { setImmediate(resolve); });
}

describe('attachRunnerLifetime — unmounting the runner\'s owner', () => {
	it('stops the batch: the statement in flight finishes at the node, the rest are never sent', async () => {
		const { hooks, view, sent, recorded, held, lifetimeResolver } = rig();
		const generation = createGeneration();
		const lifetime: IRunnerLifetime = { generation, mounted: { current: false }, patternResolver: lifetimeResolver };
		const unmount = attachRunnerLifetime(lifetime);

		const batch = runStatementBatch(targets('CREATE (a)', 'CREATE (b)', 'CREATE (c)'), hooks, view, generation.next());
		await turn();
		assert.deepEqual(sent, ['CREATE (a)']);

		unmount();
		assert.equal(lifetime.mounted.current, false);
		held[0]!.release();
		await turn();
		assert.deepEqual(sent, ['CREATE (a)'], 'nothing after the statement in flight may be sent once the owner unmounted');
		assert.equal(await batch, 'dropped');
		assert.deepEqual(recorded, []);
	});

	it('stops a batch waiting on a confirmation: the dialog is answered "cancel" and nothing is sent', async () => {
		const { hooks, view, sent, lifetimeResolver } = rig((text) => /DELETE/.test(text));
		const generation = createGeneration();
		const unmount = attachRunnerLifetime({ generation, mounted: { current: false }, patternResolver: lifetimeResolver });
		const batch = runStatementBatch(targets('MATCH (n) DELETE n', 'CREATE (b)'), hooks, view, generation.next());
		await turn();
		assert.notEqual(lifetimeResolver.current, null);
		unmount();
		assert.equal(lifetimeResolver.current, null);
		assert.equal(await batch, 'dropped');
		assert.deepEqual(sent, []);
	});

	it('survives StrictMode\'s setup, cleanup, setup: the owner is mounted and a new batch runs to the end', async () => {
		const { hooks, view, sent, recorded, held, lifetimeResolver } = rig();
		const generation = createGeneration();
		const lifetime: IRunnerLifetime = { generation, mounted: { current: false }, patternResolver: lifetimeResolver };
		attachRunnerLifetime(lifetime)();
		attachRunnerLifetime(lifetime);
		assert.equal(lifetime.mounted.current, true);

		const batch = runStatementBatch(targets('CREATE (a)', 'CREATE (b)'), hooks, view, generation.next());
		await turn();
		held[0]!.release();
		await turn();
		held[1]!.release();
		assert.equal(await batch, 'done');
		assert.deepEqual(sent, ['CREATE (a)', 'CREATE (b)']);
		assert.deepEqual(recorded, ['CREATE (a)', 'CREATE (b)']);
	});
});
