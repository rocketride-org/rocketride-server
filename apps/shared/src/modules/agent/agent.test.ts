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
// AGENT SESSION TESTS — a conversation stays in the team it started in
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatTurn } from 'shell/src/components/chat/types';

import { AgentSession } from './agent';
import { setAgentHost, type AgentHost } from './host';
import type { AgentSessionFile } from './sessions';

/** Session ids for the stored conversations. */
const TEAM_A_SESSION = '11111111-1111-4111-8111-111111111111';
const OLD_SESSION = '22222222-2222-4222-8222-222222222222';
const STOPPED_SESSION = '33333333-3333-4333-8333-333333333333';

/** What a test's engine does when a run starts its model pipeline and asks it a question. */
interface Engine {
	use?: () => Promise<{ token: string }>;
	chat?: (o: { token: string }) => Promise<unknown>;
}

/**
 * A fake store holding three conversations: one started in team a, and two
 * saved before sessions had a scope. Unless the test gives an engine,
 * starting a model pipeline fails, so a run that gets past the scope rule
 * stops at the model.
 *
 * @param engine - The engine calls a run makes.
 * @returns What was written, by path. A written session is also what the next getSession reads.
 */
function store(engine: Engine = {}): Map<string, unknown> {
	const written = new Map<string, unknown>();
	const session = (sessionId: string, scopeKey?: string): AgentSessionFile => ({ version: 1, sessionId, title: 'Edit', date: 1, contextRefs: [], messages: [], ...(scopeKey !== undefined ? { scopeKey } : {}) });
	const files = new Map<string, string>([
		[`.agents/agent.test/${TEAM_A_SESSION}.json`, JSON.stringify(session(TEAM_A_SESSION, 'team-a'))],
		[`.agents/agent.test/${OLD_SESSION}.json`, JSON.stringify(session(OLD_SESSION))],
		[`.agents/agent.test/${STOPPED_SESSION}.json`, JSON.stringify(session(STOPPED_SESSION))],
	]);
	(globalThis as { __shellTestClient?: unknown }).__shellTestClient = {
		fsReadString: async (path: string) => {
			if (!files.has(path)) throw new Error('File not found');
			return files.get(path);
		},
		fsReadJson: async () => {
			throw new Error('File not found');
		},
		fsWriteJson: async (path: string, value: unknown) => {
			written.set(path, value);
			files.set(path, JSON.stringify(value));
		},
		use: async () => {
			throw new Error('no engine in this test');
		},
		...engine,
	};
	return written;
}

/** A host in a scope. */
function hostIn(scopeKey: string): AgentHost {
	return { vfs: undefined as never, scopeKey, scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }), packApp: async () => new Uint8Array(), devSession: () => null };
}

/** A chat turn with no messages sent during it and nobody to answer a card; stopping it is the signal's. */
function turn(signal = new AbortController().signal): ChatTurn {
	return { history: [], signal, takeQueued: () => [], ask: () => ({ answer: Promise.resolve('stopped'), approve: () => undefined }) };
}

test('a turn in a conversation from another team is refused before anything runs', async () => {
	store();
	AgentSession.configure('agent.test');
	setAgentHost(hostIn('team-b'));
	const session = await AgentSession.getSession(TEAM_A_SESSION);
	assert.equal(session.scopeKey, 'team-a');
	await assert.rejects(session.execute('Change the heading.', undefined, turn()), /^Error: This conversation belongs to team a; switch back to continue it\.$/);
	assert.equal(session.title, 'Edit', 'the refused turn changed nothing');
});

test("the refusal names the conversation's team by name when the host knows it", async () => {
	store();
	AgentSession.configure('agent.test');
	setAgentHost({ ...hostIn('team-b'), scopeName: (scopeKey) => (scopeKey === 'team-a' ? 'Acme Research' : undefined) });
	const session = await AgentSession.getSession(TEAM_A_SESSION);
	await assert.rejects(session.execute('Change the heading.', undefined, turn()), /^Error: This conversation belongs to team Acme Research; switch back to continue it\.$/);
});

test('a conversation saved before scopes runs in the current team and keeps it', async () => {
	const written = store();
	AgentSession.configure('agent.test');
	setAgentHost(hostIn('team-b'));
	const session = await AgentSession.getSession(OLD_SESSION);
	// step: past the scope rule the run starts, and stops at the model this test has none of
	await assert.rejects(session.execute('Change the heading.', undefined, turn()), (err: Error) => !/belongs to/.test(err.message));
	assert.equal(session.scopeKey, 'team-b');
	await session.save([]);
	assert.equal((written.get(`.agents/agent.test/${OLD_SESSION}.json`) as AgentSessionFile).scopeKey, 'team-b');
});

test('a pasted key is refused in a conversation from another team or saved before scopes, and no file holds it', async () => {
	const key = `sk-proj-${'h'.repeat(40)}`;
	const written = store();
	AgentSession.configure('agent.test');
	setAgentHost(hostIn('team-b'));
	// step: the scope rule refuses first, so the key goes nowhere and nothing is saved
	const other = await AgentSession.getSession(TEAM_A_SESSION);
	await assert.rejects(other.execute(`Use ${key}`, undefined, turn()), /^Error: This conversation belongs to team a; switch back to continue it\.$/);
	assert.equal(written.size, 0);
	// step: a conversation saved before scopes records its team, then refuses the key before the model
	const old = await AgentSession.getSession(OLD_SESSION);
	await assert.rejects(old.execute(`Use ${key}`, undefined, turn()), /looks like it contains a key/);
	const saved = written.get(`.agents/agent.test/${OLD_SESSION}.json`) as AgentSessionFile;
	assert.equal(saved.scopeKey, 'team-b');
	assert.ok(![...written.values()].some((file) => JSON.stringify(file).includes(key)), 'a saved file holds the key');
});

test('a conversation saved before scopes records its team before the model is called, so a turn ended by unmount keeps it', async () => {
	const path = `.agents/agent.test/${STOPPED_SESSION}.json`;
	const chats: string[] = [];
	let uses = 0;
	let scopeAtModel: string | undefined;
	const written = store({
		use: async () => {
			uses++;
			return { token: 'started-in-a' };
		},
		chat: async ({ token }) => {
			scopeAtModel = (written.get(path) as AgentSessionFile | undefined)?.scopeKey;
			chats.push(token);
			return new Promise(() => undefined);
		},
	});
	// step: the stub leaves 'rocketride' empty, and the run builds a Question for each model call
	const rocketride = require('rocketride') as { Question?: unknown };
	rocketride.Question = class {
		addInstruction(): void {}
		addHistory(): void {}
		addGoal(): void {}
		addContext(): void {}
		addQuestion(): void {}
	};
	try {
		AgentSession.configure('agent.test');
		setAgentHost(hostIn('team-a'));
		const session = await AgentSession.getSession(STOPPED_SESSION);
		const stop = new AbortController();
		const running = session.execute('Start work.', undefined, turn(stop.signal));
		for (let i = 0; i < 1000 && chats.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(chats.length, 1, 'the model was called');
		assert.equal(scopeAtModel, 'team-a', 'the team was on disk before the model was called');
		// step: what the unmount does: the turn stops, and the idle save never runs
		stop.abort();
		await running;
		setAgentHost(hostIn('team-b'));
		const reopened = await AgentSession.getSession(STOPPED_SESSION);
		await assert.rejects(reopened.execute('Continue here.', undefined, turn()), /^Error: This conversation belongs to team a; switch back to continue it\.$/);
		assert.equal(chats.length, 1, 'the other team never reached the model');
		assert.equal(uses, 1);
	} finally {
		delete rocketride.Question;
	}
});
