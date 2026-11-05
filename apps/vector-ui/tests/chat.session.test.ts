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
// chat.session — one connection's conversation over its documents
// =============================================================================
//
// One question in flight at a time, at most 4,000 characters, never retried,
// 120 s before the console stops waiting. Answers carry their citations; a
// late answer after "Stop waiting" or a reset is dropped. History keeps the
// questions only.
// =============================================================================

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer';
import type { IGenerationTicket } from 'shared/explorer';
import { CHAT_TIMEOUT_MS, CHAT_TIMEOUT_SENTENCE } from '../src/vector/chatResult';
import { HISTORY_MAX, STOPPED_SENTENCE, createChatSession, threadScrollKey } from '../src/chat/chatSession';
import type { ChatDeps, ChatTurn } from '../src/chat/chatSession';

/** Most a test here may take: they await fakes, so a regression must fail, not hang the run. */
const TEST_TIMEOUT_MS = 10_000;

/**
 * Declare a test bounded by {@link TEST_TIMEOUT_MS}.
 *
 * @param name - What it checks.
 * @param fn - The test.
 */
function test(name: string, fn: () => void | Promise<void>): void {
	void nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

const WITH_DOCUMENTS = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'provisional', 'chat_result_with_documents.json'), 'utf8')) as Record<string, unknown>;

/** A promise and its settlers. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	return { promise, resolve, reject };
}

interface AskCall {
	question: unknown;
	timeoutMs: number;
	generation: IGenerationTicket;
	answer: ReturnType<typeof deferred<Record<string, unknown>>>;
}

/**
 * Fake deps: every ask waits until the test settles it; a settled answer whose
 * ticket expired is dropped the way the role channel drops it.
 *
 * @param overrides - Fields to replace.
 * @returns The deps and what they saw.
 */
function fakeDeps(overrides: Partial<ChatDeps> = {}): { deps: ChatDeps; asks: AskCall[]; answered: ChatTurn[]; announced: string[] } {
	const asks: AskCall[] = [];
	const answered: ChatTurn[] = [];
	const announced: string[] = [];
	const deps: ChatDeps = {
		async ask(question, options) {
			const answer = deferred<Record<string, unknown>>();
			asks.push({ question, timeoutMs: options.timeoutMs, generation: options.generation, answer });
			const value = await answer.promise;
			if (!options.generation.isCurrent()) throw new ExplorerToolError({ kind: 'stale', tool: 'chat', message: 'The answer was dropped: a newer question replaced it.' });
			return value;
		},
		makeQuestion: (text, scope) => ({ text, scope }),
		now: () => 1000,
		onAnswer(turn) {
			answered.push(turn);
		},
		announce(message) {
			announced.push(message);
		},
		...overrides,
	};
	return { deps, asks, answered, announced };
}

/** Let pending promise callbacks run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('chat: a question is asked once, with a 120 s wait and a generation ticket', async () => {
	const fake = fakeDeps();
	const session = createChatSession(fake.deps);
	const sending = session.send('  Where does Falcon Station get its water?  ', null);
	await flush();
	assert.equal(fake.asks.length, 1);
	assert.deepEqual(fake.asks[0].question, { text: 'Where does Falcon Station get its water?', scope: null });
	assert.equal(fake.asks[0].timeoutMs, CHAT_TIMEOUT_MS);
	assert.equal(fake.asks[0].generation.isCurrent(), true);
	assert.equal(session.getState().asking, true);
	assert.equal(session.getState().turns[0].status, 'asking');
	fake.asks[0].answer.resolve(WITH_DOCUMENTS);
	await sending;
	const turn = session.getState().turns[0];
	assert.equal(turn.status, 'answered');
	assert.equal(turn.answer?.sources.length, 3);
	assert.equal(session.getState().asking, false);
	assert.equal(fake.answered.length, 1);
	assert.ok(fake.announced.includes('Answer received with 3 sources.'));
});

test('chat: the thread scrolls when a question is posted and again when its answer arrives', async () => {
	const fake = fakeDeps();
	const session = createChatSession(fake.deps);
	const keys = [threadScrollKey(session.getState().turns)];
	const sending = session.send('Where does Falcon Station get its water?', null);
	await flush();
	keys.push(threadScrollKey(session.getState().turns));
	fake.asks[0].answer.resolve(WITH_DOCUMENTS);
	await sending;
	keys.push(threadScrollKey(session.getState().turns));
	// Each step changes what the thread shows at its end, so each must scroll.
	assert.equal(new Set(keys).size, 3, keys.join(' | '));
	// A change elsewhere in the state (a refused second send) does not.
	const before = threadScrollKey(session.getState().turns);
	void session.send('', null);
	assert.equal(threadScrollKey(session.getState().turns), before);
	// A question that ends without an answer (Stop waiting) also changes the end of the thread.
	void session.send('Second question?', null);
	await flush();
	const asking = threadScrollKey(session.getState().turns);
	session.stopWaiting();
	assert.notEqual(threadScrollKey(session.getState().turns), asking);
});

test('chat: one question in flight per connection; a second send is refused, not queued', async () => {
	const fake = fakeDeps();
	const session = createChatSession(fake.deps);
	void session.send('first', null);
	await flush();
	await session.send('second', null);
	assert.equal(fake.asks.length, 1);
	assert.equal(session.getState().notice, 'Wait for the answer to the current question.');
	assert.equal(session.getState().turns.length, 1);
});

test('chat: empty and over-long questions are refused before anything is sent', async () => {
	const fake = fakeDeps();
	const session = createChatSession(fake.deps);
	await session.send('   ', null);
	assert.equal(session.getState().notice, 'Type a question first.');
	await session.send('x'.repeat(4001), null);
	assert.match(session.getState().notice ?? '', /4,000 characters/);
	assert.equal(fake.asks.length, 0);
	assert.equal(session.getState().turns.length, 0);
});

test('chat: "Ask about these only" restricts the question to the scoped documents', async () => {
	const fake = fakeDeps();
	const session = createChatSession(fake.deps);
	void session.send('summarise', ['o1', 'o2']);
	await flush();
	assert.deepEqual(fake.asks[0].question, { text: 'summarise', scope: ['o1', 'o2'] });
	assert.deepEqual(session.getState().turns[0].scope, ['o1', 'o2']);
});

test('chat: a timeout says the pipeline may still be answering', async () => {
	const fake = fakeDeps({
		async ask() {
			throw new ExplorerToolError({ kind: 'timeout', tool: 'chat', message: 'Stopped waiting for the answer after 120 s.' });
		},
	});
	const session = createChatSession(fake.deps);
	await session.send('slow?', null);
	const turn = session.getState().turns[0];
	assert.equal(turn.status, 'timeout');
	assert.equal(turn.error?.message, CHAT_TIMEOUT_SENTENCE);
	assert.equal(session.getState().asking, false);
});

test('chat: a failure shows the reason; nothing is retried', async () => {
	let calls = 0;
	const fake = fakeDeps({
		async ask() {
			calls += 1;
			throw new ExplorerToolError({ kind: 'raised', tool: 'chat', message: 'LLM call failed\nHTTP 401' });
		},
	});
	const session = createChatSession(fake.deps);
	await session.send('q', null);
	assert.equal(calls, 1);
	const turn = session.getState().turns[0];
	assert.equal(turn.status, 'failed');
	assert.equal(turn.error?.message, 'The question failed: LLM call failed');
	assert.equal(turn.error?.detail, 'HTTP 401');
});

test('chat: Stop waiting frees the composer and drops the late answer', async () => {
	const fake = fakeDeps();
	const session = createChatSession(fake.deps);
	const sending = session.send('q1', null);
	await flush();
	session.stopWaiting();
	assert.equal(session.getState().asking, false);
	assert.equal(session.getState().turns[0].status, 'stopped');
	assert.equal(session.getState().turns[0].error?.message, STOPPED_SENTENCE);
	fake.asks[0].answer.resolve(WITH_DOCUMENTS);
	await sending;
	assert.equal(session.getState().turns[0].status, 'stopped');
	assert.equal(fake.answered.length, 0);
	// The composer is free again.
	void session.send('q2', null);
	await flush();
	assert.equal(fake.asks.length, 2);
});

test('chat: a late answer the channel still delivers after "Stop waiting" or a reset is dropped by the session itself', async () => {
	// A channel that does not drop expired answers: the session's own ticket check must.
	let pending = deferred<Record<string, unknown>>();
	const fake = fakeDeps({ ask: () => pending.promise });
	const session = createChatSession(fake.deps);

	const stopped = session.send('q1', null);
	await flush();
	session.stopWaiting();
	pending.resolve(WITH_DOCUMENTS);
	await stopped;
	assert.equal(session.getState().turns[0].status, 'stopped');
	assert.equal(session.getState().turns[0].answer, null);
	assert.equal(session.getState().asking, false);

	pending = deferred<Record<string, unknown>>();
	const reset = session.send('q2', null);
	await flush();
	session.clear();
	pending.resolve(WITH_DOCUMENTS);
	await reset;
	assert.deepEqual(session.getState().turns, []);
	assert.equal(session.getState().asking, false);

	assert.equal(fake.answered.length, 0);
	assert.ok(!fake.announced.some((message) => message.startsWith('Answer received')), fake.announced.join(' | '));
});

test('chat: dispose forgets the conversation and ignores a late answer', async () => {
	const fake = fakeDeps();
	const session = createChatSession(fake.deps);
	const sending = session.send('q', null);
	await flush();
	session.dispose();
	fake.asks[0].answer.resolve(WITH_DOCUMENTS);
	await sending;
	assert.deepEqual(session.getState().turns, []);
	assert.equal(fake.answered.length, 0);
	await session.send('after', null);
	assert.equal(fake.asks.length, 1);
});

test('chat: history keeps questions only, newest first, bounded; clear empties it', async () => {
	const fake = fakeDeps({ ask: async () => ({ answers: ['ok'] }) });
	const session = createChatSession(fake.deps);
	for (let i = 0; i < HISTORY_MAX + 5; i++) await session.send(`question ${i}`, null);
	const history = session.history();
	assert.equal(history.length, HISTORY_MAX);
	assert.equal(history[0], `question ${HISTORY_MAX + 4}`);
	assert.ok(history.every((entry) => entry.startsWith('question ')));
	// Asking the same question again does not duplicate it.
	await session.send(`question ${HISTORY_MAX + 4}`, null);
	assert.equal(session.history().filter((entry) => entry === `question ${HISTORY_MAX + 4}`).length, 1);
	session.clear();
	assert.deepEqual(session.history(), []);
	assert.deepEqual(session.getState().turns, []);
});
