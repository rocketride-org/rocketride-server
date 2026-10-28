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
// ORDERING TESTS — every order of agent, editors, Commit all, discards, dialog answers, team switch, tool timeout and approvals
// =============================================================================

/** The ordering explorations; ordering.harness.ts holds the actors, the runs and every rule they check. The editor documents' are in ordering.<editor><Mode>.test.ts. */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { exploreManual, FILE, MAX_DEPTH, ORIGINAL, report, runManual, runOrder, runSwitchOrder, tokens, type Step, type SwitchStep } from './ordering.harness';

// =============================================================================
// THE CHECK
// =============================================================================

/**
 * Tries every team switch order of up to MAX_DEPTH steps, depth first, after
 * checking that both agent edits land when nothing interferes.
 *
 * @param asking - Whether every edit asks for an OK first.
 * @returns How many orders were tried, the kinds of step tried, and each failure with its order.
 */
async function exploreSwitch(asking: boolean): Promise<{ tried: number; kinds: string[]; failures: string[] }> {
	// step: with nothing in the way, both agent edits land
	const plain = await runSwitchOrder(['start'], asking);
	assert.deepEqual(plain.erased, []);
	assert.deepEqual(tokens(plain.final), new Set([ORIGINAL, 'agent', 'agent2']), 'the agent edits land when nothing interferes');

	const failures: string[] = [];
	const kinds = new Set<string>();
	let tried = 0;
	const explore = async (order: SwitchStep[]): Promise<void> => {
		const outcome = await runSwitchOrder(order, asking);
		tried += 1;
		for (const step of order) kinds.add(step.split(' ')[0]);
		for (const erased of outcome.erased) failures.push(`${order.join(' > ')}: ${erased}`);
		if (order.length < MAX_DEPTH) for (const step of outcome.next) await explore([...order, step]);
	};
	await explore([]);
	return { tried, kinds: [...kinds].sort(), failures };
}

test("no order of agent edits, an editor save, a teammate's change and a Reload erases a write", async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// step: with nothing in the way, both agent edits land
		const plain = await runOrder(['start']);
		assert.deepEqual(plain.erased, []);
		assert.deepEqual(tokens(plain.final), new Set([ORIGINAL, 'agent', 'agent2']), 'the agent edits land when nothing interferes');

		// step: depth-first over every order of up to MAX_DEPTH steps
		const failures: string[] = [];
		const kinds = new Set<string>();
		let tried = 0;
		const explore = async (order: Step[]): Promise<void> => {
			const outcome = await runOrder(order);
			tried += 1;
			for (const step of order) kinds.add(step.split(' ')[0]);
			for (const erased of outcome.erased) failures.push(`${order.join(' > ')}: ${erased}`);
			if (order.length < MAX_DEPTH) for (const step of outcome.next) await explore([...order, step]);
		};
		await explore([]);
		console.log(`ordering: ${tried} orders tried, ${failures.length} erased a write`);
		assert.deepEqual([...kinds].sort(), ['release', 'reload', 'save', 'start', 'teammate'], 'every kind of step was tried');
		assert.deepEqual(failures.slice(0, 10), [], `${failures.length} of ${tried} orders erased a write`);
	} finally {
		mock.timers.reset();
	}
});

test('no order of agent edits, team switch and tool timeout erases a write', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const { tried, kinds, failures } = await exploreSwitch(false);
		console.log(`ordering (team switch): ${tried} orders tried, ${failures.length} erased a write`);
		assert.deepEqual(kinds, ['release', 'start', 'switch', 'timeout'], 'every kind of step was tried');
		assert.deepEqual(failures.slice(0, 10), [], `${failures.length} of ${tried} orders erased a write`);
	} finally {
		mock.timers.reset();
	}
});

test('no order of approvals, agent edits, team switch and tool timeout erases a write or asks over one', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const { tried, kinds, failures } = await exploreSwitch(true);
		console.log(`ordering (team switch) with approvals: ${tried} orders tried, ${failures.length} erased a write or asked over one`);
		assert.deepEqual(kinds, ['approve', 'release', 'start', 'switch', 'timeout'], 'every kind of step was tried');
		assert.deepEqual(failures.slice(0, 10), [], `${failures.length} of ${tried} orders erased a write or asked over one`);
	} finally {
		mock.timers.reset();
	}
});

test('no order of agent edits, editor saves, Commit all, the discards, a rollback and dialog answers in manual mode loses or erases a write', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// step: with Save mine first for the first file, the user's and the agent's work both land
		const plain = await runManual(['start', 'answer save']);
		assert.deepEqual(tokens(plain.final.get(FILE) ?? ''), new Set([ORIGINAL, 'ed1', 'agent']), 'Save mine first keeps both changes');

		// step: depth-first over every order of up to MANUAL_DEPTH steps
		const found = await exploreManual();
		report('manual', found);
		assert.deepEqual([...found.kinds].sort(), ['answer', 'commit', 'discard', 'discard-file', 'release', 'rollback', 'save', 'start', 'type'], 'every kind of step was tried');
		assert.deepEqual(found.failures.slice(0, 10), [], `${found.failures.length} of ${found.tried} orders broke a rule`);
	} finally {
		mock.timers.reset();
	}
});

test('from a working layer the page restored, no order of the same steps in manual mode loses or erases a write', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// step: with Save mine first for the first file, the restored change, the user's and the agent's work all land
		const plain = await runManual(['start', 'answer save'], { restored: true });
		assert.deepEqual(plain.failures, []);
		assert.deepEqual(tokens(plain.final.get(FILE) ?? ''), new Set([ORIGINAL, 'saved', 'ed1', 'agent']));

		// step: depth-first over every order of up to MANUAL_DEPTH steps
		const found = await exploreManual({ restored: true });
		report('manual, from a restored working layer', found);
		assert.deepEqual([...found.kinds].sort(), ['answer', 'commit', 'discard', 'discard-file', 'release', 'rollback', 'save', 'start', 'type'], 'every kind of step was tried');
		assert.deepEqual(found.failures.slice(0, 10), [], `${found.failures.length} of ${found.tried} orders broke a rule`);
	} finally {
		mock.timers.reset();
	}
});

test("with an editor's first read slow, no order of the same steps in manual mode loses or erases a write", async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// step: with nothing in the way, the slow read lands and so does the agent's edit
		const plain = await runManual(['start'], { slowRead: true });
		assert.deepEqual(plain.failures, []);
		assert.deepEqual(tokens(plain.final.get(FILE) ?? ''), new Set([ORIGINAL, 'agent']));

		// step: depth-first over every order of up to MANUAL_DEPTH steps
		const found = await exploreManual({ slowRead: true });
		report('manual, with a slow first read', found);
		assert.deepEqual([...found.kinds].sort(), ['answer', 'commit', 'discard', 'discard-file', 'release', 'rollback', 'save', 'start', 'type'], 'every kind of step was tried');
		assert.deepEqual(found.failures.slice(0, 10), [], `${found.failures.length} of ${found.tried} orders broke a rule`);
	} finally {
		mock.timers.reset();
	}
});

test('in manual mode run as runAgent runs it, no question times out its call, and none outlives the run', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// step: the clock moves past the limit while the first question is open: the call waits for the answer
		const paused = await runManual(['start', 'timeout', 'answer save'], { userTime: true });
		assert.deepEqual(paused.failures, []);
		assert.deepEqual(tokens(paused.final.get(FILE) ?? ''), new Set([ORIGINAL, 'ed1', 'agent']));

		// step: depth-first over every order of up to MANUAL_DEPTH steps, with the clock as a step
		const found = await exploreManual({ userTime: true });
		report('manual, as runAgent runs it', found);
		assert.deepEqual([...found.kinds].sort(), ['answer', 'commit', 'discard', 'discard-file', 'release', 'rollback', 'save', 'start', 'timeout', 'type'], 'every kind of step was tried');
		assert.deepEqual(found.failures.slice(0, 10), [], `${found.failures.length} of ${found.tried} orders broke a rule`);
	} finally {
		mock.timers.reset();
	}
});

test("with the preview opening and a teammate's change to the server copy, no order of the same steps in manual mode loses, erases or caches what the server never held", async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// step: the preview opens over the unsaved typing, and the user answers Discard mine for the first file:
		// the cache keeps the stored file, and the agent's edit lands on it
		const plain = await runManual(['preview', 'start', 'answer discard'], { outside: true });
		assert.deepEqual(plain.failures, []);
		assert.deepEqual(tokens(plain.final.get(FILE) ?? ''), new Set([ORIGINAL, 'agent']));

		// step: depth-first over every order of up to MANUAL_DEPTH steps
		const found = await exploreManual({ outside: true });
		report('manual, with the preview and a teammate', found);
		assert.deepEqual([...found.kinds].sort(), ['answer', 'commit', 'discard', 'discard-file', 'preview', 'release', 'rollback', 'save', 'start', 'teammate', 'type'], 'every kind of step was tried');
		assert.deepEqual(found.failures.slice(0, 10), [], `${found.failures.length} of ${found.tried} orders broke a rule`);
	} finally {
		mock.timers.reset();
	}
});
