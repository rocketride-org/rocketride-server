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
// VECTOR-UI — CHAT AND INGEST STATE PER CONNECTION
// =============================================================================
//
// The conversation and the upload list of a connection outlive the panels
// that show them (switching between the Console and Map tabs must not lose an
// answer or an upload in flight), so they are kept here, keyed by the
// connection's endpoint key. The panels hand in fresh dependencies on every
// render (the channels and actions of the moment); the session and queue
// read them through a live reference, so nothing captures a stale channel.
//
// forgetChatAndIngest() is the reset: the console calls it when the signed-in
// identity changes (every connection) or when a connection is closed (one).
// It disposes the sessions and queues, so late answers and upload results
// are dropped and nothing of the previous account remains.
// =============================================================================

import { createChatSession } from './chatSession';
import type { ChatDeps, ChatSession } from './chatSession';
import { createIngestQueue } from '../ingest/ingestQueue';
import type { IngestDeps, IngestQueue } from '../ingest/ingestQueue';

const chats = new Map<string, { session: ChatSession; live: { current: ChatDeps } }>();
const queues = new Map<string, { queue: IngestQueue; live: { current: IngestDeps } }>();

/**
 * The chat session of a connection (created on first use).
 *
 * @param connectionKey - The connection's endpoint key.
 * @param deps - The dependencies of the moment.
 * @returns The session.
 */
export function chatSessionFor(connectionKey: string, deps: ChatDeps): ChatSession {
	const existing = chats.get(connectionKey);
	if (existing) {
		existing.live.current = deps;
		return existing.session;
	}
	const live = { current: deps };
	const session = createChatSession({
		ask: (question, options) => live.current.ask(question, options),
		makeQuestion: (text, scope) => live.current.makeQuestion(text, scope),
		now: () => live.current.now(),
		onAnswer: (turn) => live.current.onAnswer?.(turn),
		announce: (message) => live.current.announce(message),
	});
	chats.set(connectionKey, { session, live });
	return session;
}

/**
 * The upload queue of a connection (created on first use).
 *
 * @param connectionKey - The connection's endpoint key.
 * @param deps - The dependencies of the moment.
 * @returns The queue.
 */
export function ingestQueueFor(connectionKey: string, deps: IngestDeps): IngestQueue {
	const existing = queues.get(connectionKey);
	if (existing) {
		existing.live.current = deps;
		return existing.queue;
	}
	const live = { current: deps };
	const queue = createIngestQueue({
		get canProbe() {
			return live.current.canProbe;
		},
		get canCount() {
			return live.current.canCount;
		},
		callTool: (tool, input) => live.current.callTool(tool, input),
		sendFiles: (files, options) => live.current.sendFiles(files, options),
		onDocumentsChanged: (objectIds) => live.current.onDocumentsChanged(objectIds),
		announce: (message) => live.current.announce(message),
		sleep: (ms) => (live.current.sleep ? live.current.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms))),
		...(deps.locks !== undefined ? { locks: deps.locks } : {}),
	});
	queues.set(connectionKey, { queue, live });
	return queue;
}

/**
 * Forget the chat and uploads of one connection, or of every connection.
 *
 * @param connectionKey - The connection, or null/undefined for all (identity change).
 */
export function forgetChatAndIngest(connectionKey?: string | null): void {
	for (const [key, entry] of [...chats]) {
		if (connectionKey === undefined || connectionKey === null || key === connectionKey) {
			entry.session.dispose();
			chats.delete(key);
		}
	}
	for (const [key, entry] of [...queues]) {
		if (connectionKey === undefined || connectionKey === null || key === connectionKey) {
			entry.queue.dispose();
			queues.delete(key);
		}
	}
}

/**
 * Connections that hold chat or upload state (diagnostics and tests).
 *
 * @returns Their keys.
 */
export function heldConnections(): string[] {
	return [...new Set([...chats.keys(), ...queues.keys()])].sort();
}
