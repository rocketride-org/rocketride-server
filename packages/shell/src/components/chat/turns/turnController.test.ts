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
import type { ChatMessage, ChatStatusSink, ChatTurn, TextResult } from '../types';
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
function scripted(o: { initialMessages?: ChatMessage[]; stopGraceMs?: number } = {}): { chat: TurnController; calls: Call[] } {
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
	calls[0].onStatus('thinking', 'working on a');
	assert.deepEqual(thread(chat).at(-1), ['user', 'b', true], 'progress lands above the queued row');
	calls[0].fail('model down');
	await tick();
	assert.ok(
		chat.snapshot().messages.some((m) => m.isError && m.text === 'model down'),
		'the failure shows as an error row'
	);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].text, 'b');
	assert.deepEqual(
		calls[1].turn.history.map((m) => m.text),
		['a', 'working on a', 'model down'],
		'the next turn answers in the conversation so far'
	);
	assert.equal(chat.snapshot().phase, 'running');
});

test('the running turn takes queued messages, and they start no turn of their own', async () => {
	const { chat, calls } = scripted();
	chat.send('a');
	chat.send('b');
	assert.deepEqual(calls[0].turn.takeQueued(), ['b']);
	assert.deepEqual(calls[0].turn.takeQueued(), [], 'a message is taken once');
	calls[0].onStatus('thinking', 'read b');
	calls[0].answer('done');
	await tick();
	assert.equal(calls.length, 1, 'b did not start a turn of its own');
	assert.deepEqual(thread(chat), [
		['user', 'a', false],
		['user', 'b', false],
		['status', 'read b', false],
		['bot', 'done', false],
	]);
	assert.equal(chat.snapshot().phase, 'idle');
});

test('Stop aborts the turn, hands queued text back, and closes the turn with one row built from its progress', async () => {
	const { chat, calls } = scripted();
	chat.send('a');
	calls[0].onStatus('thinking', '- edit_file x.ts — ok');
	chat.send('b');
	chat.stop();
	const { turn } = calls[0];
	assert.equal(turn.signal.aborted, true);
	assert.equal(chat.snapshot().phase, 'stopping');
	assert.equal(chat.snapshot().returned?.text, 'b', 'the queued message goes back to the composer');
	assert.ok(!chat.snapshot().messages.some((m) => m.queued));
	assert.deepEqual(turn.takeQueued(), [], 'a stopping turn takes nothing');
	calls[0].onStatus('thinking', '- deploy_app x — still running');
	calls[0].answer('ignored');
	await tick();
	const last = chat.snapshot().messages.at(-1);
	assert.equal(last?.sender, 'bot');
	assert.ok(last?.text.startsWith('Stopped by you'), "the agent's prompt rule reads this opening");
	assert.match(last?.text ?? '', /edit_file x\.ts — ok[\s\S]*deploy_app x — still running/, 'the row carries the progress the model reads next turn');
	assert.ok(!chat.snapshot().messages.some((m) => m.text === 'ignored'), 'an answer after Stop is dropped');
	assert.equal(chat.snapshot().phase, 'idle');
	calls[0].onStatus('thinking', 'late');
	assert.ok(!chat.snapshot().messages.some((m) => m.text === 'late'), 'a settled turn writes nothing');
	assert.equal(calls.length, 1);
});

test('a request that ignores Stop is closed after the grace, and nothing it does later lands', async () => {
	const { chat, calls } = scripted({ stopGraceMs: 0 });
	chat.send('a');
	chat.stop();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(chat.snapshot().phase, 'idle');
	assert.ok(chat.snapshot().messages.at(-1)?.text.startsWith('Stopped by you'));
	const count = chat.snapshot().messages.length;
	calls[0].onStatus('thinking', 'late');
	calls[0].answer('late answer');
	await tick();
	assert.equal(chat.snapshot().messages.length, count);
	chat.send('next');
	assert.equal(calls.length, 2, 'the chat is free for the next turn');
});

test('a card waits on the turn, leaves one row once answered, and ends not answered on Stop or after the turn', async () => {
	const { chat, calls } = scripted();
	chat.send('publish it');
	const [call] = calls;

	const first = call.turn.ask({ title: 'Publish Daybook v3 to everyone' });
	assert.equal(chat.snapshot().asks.length, 1);
	assert.equal(chat.snapshot().messages.length, 1, 'a waiting card is not a row');
	chat.answerAsk(chat.snapshot().asks[0].id, 'approve');
	assert.equal(await first.answer, 'approve');
	assert.deepEqual(thread(chat).at(-1), ['status', 'Approved: Publish Daybook v3 to everyone', false]);

	// the request's own approve() closes its card the same way (the switch to Auto)
	const second = call.turn.ask({ title: 'Turn off digest for team Staging' });
	second.approve();
	assert.equal(await second.answer, 'approve');

	const third = call.turn.ask({ title: 'Delete apps/x' });
	const id = chat.snapshot().asks[0].id;
	chat.stop();
	assert.equal(await third.answer, 'stopped');
	chat.answerAsk(id, 'approve');
	assert.equal(chat.snapshot().asks.length, 0, 'a click after Stop does nothing');
	call.answer('ignored');
	await tick();
	assert.match(chat.snapshot().messages.at(-1)?.text ?? '', /Progress before the stop:[\s\S]*Not answered: Delete apps\/x\. The run ended first, so nothing was done\./, 'the model reads what went unanswered');

	assert.equal(await call.turn.ask({ title: 'late' }).answer, 'stopped', 'a settled turn shows no card');
	assert.equal(chat.snapshot().asks.length, 0);
});

test('Edit and Remove take a queued message out, and Edit hands its text back', async () => {
	const { chat, calls } = scripted();
	chat.send('a');
	chat.send('b');
	chat.send('c');
	const [b, c] = chat.snapshot().messages.filter((m) => m.queued);
	chat.editQueued(b.id);
	assert.equal(chat.snapshot().returned?.text, 'b');
	chat.removeQueued(c.id);
	const handedBack = chat.snapshot().returned;
	chat.editQueued(chat.snapshot().messages[0].id);
	assert.equal(chat.snapshot().returned, handedBack, 'a row that is not queued cannot be edited');
	calls[0].answer('done');
	await tick();
	assert.equal(calls.length, 1, 'nothing was left to run');
	assert.deepEqual(thread(chat), [
		['user', 'a', false],
		['bot', 'done', false],
	]);
});

test('a restored conversation drops stale queued flags, and new rows get ids above every restored one', () => {
	const saved: ChatMessage[] = [
		{ id: 41, text: 'old question', sender: 'user', timestamp: '09:00' },
		{ id: 7, text: 'old answer', sender: 'bot', timestamp: '09:00' },
		{ id: 12, text: 'sent while busy', sender: 'user', timestamp: '09:01', queued: true },
	];
	const { chat, calls } = scripted({ initialMessages: saved });
	assert.ok(!chat.snapshot().messages.some((m) => m.queued), 'no queue survives a load');
	chat.send('new');
	assert.equal(calls.length, 1, 'the loaded chat is idle');
	const ids = chat.snapshot().messages.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length, 'ids stay unique');
	assert.ok((chat.snapshot().messages.at(-1)?.id ?? 0) > 41);
});
