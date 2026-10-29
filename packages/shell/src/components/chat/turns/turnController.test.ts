// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// TURN CONTROLLER TESTS — one turn at a time, queued sends, Stop
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatStatusSink, ChatTurn, TextResult } from '../types';
import { TurnController, type ChatRequest } from './turnController';

/** One request the controller made: what it was handed, and how the test settles it. */
interface Call {
	text: string;
	onStatus: ChatStatusSink;
	turn: ChatTurn;
	answer: (text: string) => void;
	fail: (message: string) => void;
}

/** A controller over a request the test settles by hand; `calls` holds every request made, in order. */
function scripted(o: { stopGraceMs?: number } = {}): { chat: TurnController; calls: Call[] } {
	const calls: Call[] = [];
	const request: ChatRequest = (text, onStatus, turn) =>
		new Promise<TextResult[]>((resolve, reject) => {
			calls.push({ text, onStatus, turn, answer: (t) => resolve([{ text: t, key: '' }]), fail: (m) => reject(new Error(m)) });
		});
	return { chat: new TurnController({ ...o, request: () => request, now: () => '12:00' }), calls };
}

/** Lets settled promises run their handlers. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The thread as [sender, text, queued], which is what these tests read. */
function thread(chat: TurnController): Array<[string, string, boolean]> {
	return chat.snapshot().messages.map((m) => [m.sender, m.text, m.queued === true]);
}

test('a send during a turn queues, and runs as its own turn once the first settles, even after a failure', async () => {
	const { chat, calls } = scripted();
	chat.send('a');
	chat.send('b');
	assert.equal(calls.length, 1, 'the second send started no request');
	assert.deepEqual(thread(chat), [
		['user', 'a', false],
		['user', 'b', true],
	]);
	calls[0].fail('model down');
	await tick();
	assert.equal(calls.length, 2);
	assert.equal(calls[1].text, 'b');
	assert.equal(chat.snapshot().phase, 'running');
});

test('the running turn takes queued messages, and they start no turn of their own', async () => {
	const { chat, calls } = scripted();
	chat.send('a');
	chat.send('b');
	assert.deepEqual(calls[0].turn.takeQueued(), ['b']);
	assert.deepEqual(calls[0].turn.takeQueued(), [], 'a message is taken once');
	calls[0].answer('done');
	await tick();
	assert.equal(calls.length, 1, 'b did not start a turn of its own');
	assert.equal(chat.snapshot().phase, 'idle');
});

test('Stop aborts the turn, hands queued text back, and drops what the turn does after it', async () => {
	const { chat, calls } = scripted();
	chat.send('a');
	calls[0].onStatus('thinking', '- edit_file x.ts — ok');
	chat.send('b');
	chat.stop();
	const { turn } = calls[0];
	assert.equal(turn.signal.aborted, true);
	assert.equal(chat.snapshot().returned?.text, 'b', 'the queued message goes back to the composer');
	assert.deepEqual(turn.takeQueued(), [], 'a stopping turn takes nothing');
	calls[0].answer('ignored');
	await tick();
	assert.ok(chat.snapshot().messages.at(-1)?.text.startsWith('Stopped by you'), "the agent's prompt rule reads this opening");
	assert.ok(!chat.snapshot().messages.some((m) => m.text === 'ignored'), 'an answer after Stop is dropped');
	calls[0].onStatus('thinking', 'late');
	assert.ok(!chat.snapshot().messages.some((m) => m.text === 'late'), 'a settled turn writes nothing');
	assert.equal(calls.length, 1, 'b did not run');
});

test('a request that ignores Stop is closed after the grace, and nothing it does later lands', async () => {
	const { chat, calls } = scripted({ stopGraceMs: 0 });
	chat.send('a');
	chat.stop();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(chat.snapshot().phase, 'idle');
	const count = chat.snapshot().messages.length;
	calls[0].onStatus('thinking', 'late');
	calls[0].answer('late answer');
	await tick();
	assert.equal(chat.snapshot().messages.length, count);
	chat.send('next');
	assert.equal(calls.length, 2, 'the chat is free for the next turn');
});

test('a card open at Stop answers stopped, a click after it does nothing, and a settled turn shows no card', async () => {
	const { chat, calls } = scripted();
	chat.send('delete it');
	const [call] = calls;
	const card = call.turn.ask({ title: 'Delete apps/x' });
	const id = chat.snapshot().asks[0].id;
	chat.stop();
	assert.equal(await card.answer, 'stopped');
	chat.answerAsk(id, 'approve');
	assert.equal(chat.snapshot().asks.length, 0, 'a click after Stop does nothing');
	call.answer('ignored');
	await tick();
	assert.equal(await call.turn.ask({ title: 'late' }).answer, 'stopped');
	assert.equal(chat.snapshot().asks.length, 0);
});
