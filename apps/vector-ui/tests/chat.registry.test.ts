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
// chat.registry — chat and uploads live per connection, and a reset forgets them
// =============================================================================
//
// Switching tabs must not lose a conversation or an upload in flight, so both
// are kept per connection key; an identity change (or closing a connection)
// must leave nothing of them behind, and answers or upload results arriving
// afterwards are dropped.
// =============================================================================

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatDeps } from '../src/chat/chatSession';
import type { IngestDeps } from '../src/ingest/ingestQueue';
import { chatSessionFor, forgetChatAndIngest, heldConnections, ingestQueueFor } from '../src/chat/registry';
import { createNameLocks } from '../src/ingest/nameLocks';

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

/**
 * Chat deps that answer with `text`.
 *
 * @param text - The answer.
 * @param seen - Collects the questions asked.
 * @returns The deps.
 */
function chatDeps(text: string, seen: string[]): ChatDeps {
	return {
		ask: async (question) => {
			seen.push(String((question as { text: string }).text));
			return { answers: [text] };
		},
		makeQuestion: (questionText) => ({ text: questionText }),
		now: () => 0,
		announce: () => undefined,
	};
}

/**
 * Ingest deps with a switchable probe flag.
 *
 * @param canProbe - The flag.
 * @returns The deps.
 */
function ingestDeps(canProbe: boolean): IngestDeps {
	return {
		canProbe,
		canCount: false,
		callTool: async () => ({ ok: false, code: 'NOT_FOUND', message: 'x', kind: null, error: null }),
		sendFiles: async (files) => files.map((file) => ({ action: 'complete', filepath: file.file.name, bytes_sent: 1, file_size: 1, upload_time: 0 })),
		onDocumentsChanged: () => undefined,
		announce: () => undefined,
		locks: createNameLocks(),
	};
}

test('registry: one chat session per connection, reading the newest dependencies', async () => {
	forgetChatAndIngest();
	const seenA: string[] = [];
	const seenB: string[] = [];
	const first = chatSessionFor('conn-1', chatDeps('one', seenA));
	const again = chatSessionFor('conn-1', chatDeps('two', seenB));
	assert.equal(again, first);
	await first.send('hello', null);
	assert.deepEqual(seenA, []);
	assert.deepEqual(seenB, ['hello']);
	assert.equal(first.getState().turns[0].answer?.text, 'two');
	assert.notEqual(chatSessionFor('conn-2', chatDeps('x', [])), first);
	assert.deepEqual(heldConnections(), ['conn-1', 'conn-2']);
	forgetChatAndIngest();
});

test('registry: forgetting one connection keeps the others; forgetting all clears every one', async () => {
	forgetChatAndIngest();
	const kept = chatSessionFor('keep', chatDeps('a', []));
	await kept.send('q', null);
	const dropped = chatSessionFor('drop', chatDeps('b', []));
	await dropped.send('q', null);
	ingestQueueFor('drop', ingestDeps(true));
	forgetChatAndIngest('drop');
	assert.deepEqual(heldConnections(), ['keep']);
	assert.equal(kept.getState().turns.length, 1);
	assert.equal(dropped.getState().turns.length, 0);
	// A fresh session for the forgotten key starts empty.
	assert.equal(chatSessionFor('drop', chatDeps('c', [])).getState().turns.length, 0);
	forgetChatAndIngest(null);
	assert.deepEqual(heldConnections(), []);
	assert.equal(kept.getState().turns.length, 0);
});

test('registry: an answer that arrives after the reset is dropped', async () => {
	forgetChatAndIngest();
	let release: (value: Record<string, unknown>) => void = () => undefined;
	const session = chatSessionFor('late', {
		...chatDeps('', []),
		ask: () =>
			new Promise((resolve) => {
				release = resolve;
			}),
	});
	const sending = session.send('q', null);
	await new Promise((resolve) => setTimeout(resolve, 0));
	forgetChatAndIngest();
	release({ answers: ['too late'] });
	await sending;
	assert.deepEqual(session.getState().turns, []);
});

test('registry: one upload queue per connection; its flags follow the newest dependencies', async () => {
	forgetChatAndIngest();
	const queue = ingestQueueFor('q-1', ingestDeps(true));
	assert.equal(ingestQueueFor('q-1', ingestDeps(false)), queue);
	const drop = queue.addDrop([{ file: { name: 'a.md', size: 1 } as unknown as File, relPath: 'a.md' }]);
	// The newest deps say the store cannot be probed, so the drop asks first.
	await queue.waitFor((state) => state.confirm !== null);
	assert.match(queue.getState().confirm?.message[0] ?? '', /could not check|Could not check/);
	forgetChatAndIngest('q-1');
	await drop;
	assert.deepEqual(queue.getState().rows, []);
	assert.deepEqual(heldConnections(), []);
});
