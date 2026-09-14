/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { buildTurnSystem, buildTurnSystemAndConsume, injectSystemIntoPromptBody } from '../src/turnContext';
import type { TurnState } from '../src/types';

describe('buildTurnSystem', () => {
	it('names the open pipe as the edit target', () => {
		const s = buildTurnSystem({ openDocUri: 'my_flow.pipe', openDocShape: 'webhook → parse → response_text', turn: {} });
		expect(s).toContain('my_flow.pipe');
		expect(s).toContain('webhook → parse → response_text');
		expect(s.toLowerCase()).toContain('edit');
	});
	it('re-asserts the active phase', () => {
		expect(buildTurnSystem({ turn: { activePhase: 'configuring' } })).toContain('configuring');
	});
	it('states an awaiting gate and that the next message answers it', () => {
		const s = buildTurnSystem({ turn: { awaitingGate: { id: 'run-cost', options: ['run', 'cancel'] } } });
		expect(s).toContain('run-cost');
		expect(s.toLowerCase()).toContain('answer');
	});
	it('returns empty string when nothing is live', () => {
		expect(buildTurnSystem({ turn: {} })).toBe('');
	});
});

describe('buildTurnSystemAndConsume (one-shot gate consumption)', () => {
	it('injects the awaiting gate into THIS turn, then clears it so it never re-injects', () => {
		const turn: TurnState = { awaitingGate: { id: 'run-cost', options: ['run', 'cancel'] } };

		// First (answering) turn: carries the awaiting-gate context.
		const first = buildTurnSystemAndConsume({ turn });
		expect(first).toContain('run-cost');
		expect(first.toLowerCase()).toContain('answer');
		// Consumed one-shot.
		expect(turn.awaitingGate).toBeUndefined();

		// Every later turn: no stale re-assertion (the pre-fix infinite-re-injection bug).
		const second = buildTurnSystemAndConsume({ turn });
		expect(second).toBe('');
	});
	it('leaves persistent state (activePhase) untouched — only awaitingGate is one-shot', () => {
		const turn: TurnState = { activePhase: 'configuring', awaitingGate: { id: 'g', options: ['ok'] } };
		const s = buildTurnSystemAndConsume({ turn });
		expect(s).toContain('configuring');
		expect(turn.awaitingGate).toBeUndefined();
		expect(turn.activePhase).toBe('configuring');
		// The phase still re-asserts on the next turn; the gate does not.
		expect(buildTurnSystemAndConsume({ turn })).toContain('configuring');
	});
	it('is a no-op on turn with no gate', () => {
		const turn: TurnState = {};
		expect(buildTurnSystemAndConsume({ turn })).toBe('');
		expect(turn.awaitingGate).toBeUndefined();
	});
});

describe('injectSystemIntoPromptBody', () => {
	it('adds system to a prompt_async body', () => {
		const body = Buffer.from(JSON.stringify({ agent: 'rr-builder', parts: [{ type: 'text', text: 'hi' }] }));
		const out = JSON.parse(injectSystemIntoPromptBody(body, 'LIVE STATE').toString());
		expect(out.system).toBe('LIVE STATE');
		expect(out.parts).toHaveLength(1);
	});
	it('is a no-op for empty system', () => {
		const body = Buffer.from(JSON.stringify({ agent: 'x', parts: [] }));
		expect(injectSystemIntoPromptBody(body, '')).toBe(body);
	});
	it('is a no-op for non-JSON', () => {
		const body = Buffer.from('not json');
		expect(injectSystemIntoPromptBody(body, 'X')).toBe(body);
	});
});
