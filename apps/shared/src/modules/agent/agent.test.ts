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

/**
 * A fake store holding two conversations: one started in team a, and one
 * saved before sessions had a scope.
 *
 * @returns What was written, by path.
 */
function store(): Map<string, unknown> {
	const written = new Map<string, unknown>();
	const session = (sessionId: string, scopeKey?: string): AgentSessionFile => ({ version: 1, sessionId, title: 'Edit', date: 1, contextRefs: [], messages: [], ...(scopeKey !== undefined ? { scopeKey } : {}) });
	const files = new Map<string, string>([
		[`.agents/agent.test/${TEAM_A_SESSION}.json`, JSON.stringify(session(TEAM_A_SESSION, 'team-a'))],
		[`.agents/agent.test/${OLD_SESSION}.json`, JSON.stringify(session(OLD_SESSION))],
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
		},
	};
	AgentSession.configure('agent.test');
	return written;
}

/** A host in a scope. */
function hostIn(scopeKey: string): AgentHost {
	return { vfs: undefined as never, scopeKey, scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }), packApp: async () => new Uint8Array(), devSession: () => null };
}

/** A chat turn with no messages sent during it and nobody to answer a card. */
function turn(): ChatTurn {
	return { history: [], signal: new AbortController().signal, takeQueued: () => [], ask: () => ({ answer: Promise.resolve('stopped'), approve: () => undefined }) };
}

test("the refusal names the conversation's team by name when the host knows it", async () => {
	store();
	setAgentHost({ ...hostIn('team-b'), scopeName: (scopeKey) => (scopeKey === 'team-a' ? 'Acme Research' : undefined) });
	const session = await AgentSession.getSession(TEAM_A_SESSION);
	await assert.rejects(session.execute('Change the heading.', undefined, turn()), /^Error: This conversation belongs to team Acme Research; switch back to continue it\.$/);
});

test('a conversation from another team is refused, and one saved before scopes records its team before the model or a pasted key is reached', async () => {
	const key = `sk-proj-${'h'.repeat(40)}`;
	const written = store();
	setAgentHost(hostIn('team-b'));
	// step: the scope rule refuses first, so the key goes nowhere and nothing is saved
	const other = await AgentSession.getSession(TEAM_A_SESSION);
	await assert.rejects(other.execute(`Use ${key}`, undefined, turn()), /^Error: This conversation belongs to team a; switch back to continue it\.$/);
	assert.equal(written.size, 0);
	// step: a turn can end without the idle save (a pasted key, or an unmount at a team switch), so the team is saved first
	const old = await AgentSession.getSession(OLD_SESSION);
	await assert.rejects(old.execute(`Use ${key}`, undefined, turn()), /looks like it contains a key/);
	const saved = written.get(`.agents/agent.test/${OLD_SESSION}.json`) as AgentSessionFile;
	assert.equal(saved.scopeKey, 'team-b');
	assert.ok(![...written.values()].some((file) => JSON.stringify(file).includes(key)), 'a saved file holds the key');
});
