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
// AGENT TESTS — a conversation stays in its team, keys stay out of saves, the
// step and cost limits pause a turn, and Undo never loses or overwrites work
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatMessage } from 'shell';
import { TurnController } from 'shell/src/components/chat/turns/turnController';
import type { ChatTurn } from 'shell/src/components/chat/types';
import { CachedVfs } from 'shell/src/modules/explorer/CachedVfs';
import type { IVirtualFileSystem } from 'shell/src/modules/explorer/types';

import { StagedFileSystem } from '../vfs/stagedFileSystem';
import { AgentSession } from './agent';
import { setAgentHost, type AgentHost, type AgentLimits, type ApprovalSettings } from './host';
import type { AgentSessionFile } from './sessions';
import { FilesystemTools } from './toolkits/filesystem';
import type { UndoRecord } from './toolkits/undo';
import { UNDO } from './turn';

// =============================================================================
// HELPERS
// =============================================================================

// The run builds a Question for each model call, and the 'rocketride' stub has none.
(require('rocketride') as { Question?: unknown }).Question = class {
	addInstruction(): void {}
	addHistory(): void {}
	addGoal(): void {}
	addContext(): void {}
	addQuestion(): void {}
};

/** Session ids of the stored conversations. */
const TEAM_A_SESSION = '11111111-1111-4111-8111-111111111111';
const OLD_SESSION = '22222222-2222-4222-8222-222222222222';
const SAVED_SESSION = '55555555-5555-4555-8555-555555555555';

/** Where a conversation is saved. */
const sessionPath = (sessionId: string): string => `.agents/agent.test/${sessionId}.json`;

/**
 * A fake store holding a conversation started in team a, one saved before
 * conversations had a team, and `extra`. Unless the test gives an engine,
 * starting a model pipeline fails.
 *
 * @param engine - The engine calls a run makes.
 * @param extra - More conversations it holds.
 * @returns What was written, by path; a written session is what the next getSession reads.
 */
function store(engine: Record<string, unknown> = {}, extra: AgentSessionFile[] = []): Map<string, unknown> {
	const written = new Map<string, unknown>();
	const session = (sessionId: string, scopeKey?: string): AgentSessionFile => ({ version: 1, sessionId, title: 'Edit', date: 1, contextRefs: [], messages: [], ...(scopeKey !== undefined ? { scopeKey } : {}) });
	const files = new Map([session(TEAM_A_SESSION, 'team-a'), session(OLD_SESSION), ...extra].map((file): [string, string] => [sessionPath(file.sessionId), JSON.stringify(file)]));
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
	AgentSession.configure('agent.test');
	return written;
}

/** An engine whose model answers from `replies`, taking each in turn; once they run out, a model call never returns. */
function scripted(replies: string[]): Record<string, unknown> {
	return {
		use: async () => ({ token: 'tk_standin' }),
		chat: async () => {
			const next = replies.shift();
			return next === undefined ? new Promise(() => undefined) : { answers: [next] };
		},
	};
}

/** A reply asking for tool calls. */
function planReply(...calls: Array<[tool: string, args: Record<string, unknown>]>): string {
	return JSON.stringify({ thought: 'working', tool_calls: calls.map(([tool, args]) => ({ tool, args })) });
}

/** A reply that finishes with `answer`. */
function doneReply(answer: string): string {
	return JSON.stringify({ thought: 'finishing', done: true, answer });
}

/** A host in a team, with no workspace. */
function hostIn(scopeKey: string): AgentHost {
	return { vfs: undefined as never, scopeKey, scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }), packApp: async () => new Uint8Array(), devSession: () => null };
}

/** A host in team a over a workspace, with the given limits. */
function hostOver(vfs: StagedFileSystem, limits: AgentLimits = { steps: 60, costUsd: 2 }): AgentHost {
	return { ...hostIn('team-a'), vfs, limits: { read: () => limits } };
}

/** A chat turn with no messages sent during it and nobody to answer a card. */
function turn(): ChatTurn {
	return { history: [], signal: new AbortController().signal, takeQueued: () => [], ask: () => ({ answer: Promise.resolve('stopped'), approve: () => undefined }) };
}

/** A server in memory. `log` lists every change it took; a test may edit `files` directly, as a teammate would. */
function memoryBackend(seed: Record<string, string>): IVirtualFileSystem & { files: Map<string, string>; log: string[] } {
	const files = new Map(Object.entries(seed));
	const log: string[] = [];
	return {
		files,
		log,
		list: async () => [...files.keys()].map((name) => ({ name, type: 'file' as const })),
		read: async (path) => {
			if (!files.has(path)) throw new Error(`No such file: ${path}`);
			return files.get(path);
		},
		write: async (path, content) => {
			log.push(`write ${path}`);
			files.set(path, String(content));
		},
		rename: async (from, to) => {
			log.push(`rename ${from} ${to}`);
			files.set(to, files.get(from) ?? '');
			files.delete(from);
		},
		delete: async (path) => {
			log.push(`delete ${path}`);
			files.delete(path);
		},
		mkdir: async () => undefined,
	};
}

/** The real view over a server: Auto writes through, manual stages. */
function workspace(seed: Record<string, string>, mode: 'auto' | 'manual' = 'auto'): { backend: ReturnType<typeof memoryBackend>; vfs: StagedFileSystem } {
	const backend = memoryBackend(seed);
	return { backend, vfs: new StagedFileSystem(new CachedVfs(backend), null, { writeThrough: mode === 'auto' }) };
}

/** What the view serves for a path, or null when nothing. */
function shown(vfs: StagedFileSystem, path: string): Promise<string | null> {
	return vfs.read(path).then(String, () => null);
}

// =============================================================================
// TEAMS AND KEYS
// =============================================================================

test('a conversation from another team is refused, and one saved before scopes records its team before the model or a pasted key is reached', async () => {
	const key = `sk-proj-${'h'.repeat(40)}`;
	const written = store();
	setAgentHost(hostIn('team-b'));
	// step: the scope rule refuses first, so the key goes nowhere and nothing is saved
	const other = await AgentSession.getSession(TEAM_A_SESSION);
	await assert.rejects(other.execute(`Use ${key}`, undefined, turn()), /belongs to team a/);
	assert.equal(written.size, 0);
	// step: a turn can end without the idle save (a pasted key, or an unmount at a team switch), so the team is saved first
	const old = await AgentSession.getSession(OLD_SESSION);
	await assert.rejects(old.execute(`Use ${key}`, undefined, turn()), /looks like it contains a key/);
	assert.equal((written.get(sessionPath(OLD_SESSION)) as AgentSessionFile).scopeKey, 'team-b');
	assert.ok(![...written.values()].some((file) => JSON.stringify(file).includes(key)), 'a saved file holds the key');
});

test('a key in a stored turn, its card or a run record is redacted when the session saves again', async () => {
	const key = `sk-proj-${'s'.repeat(40)}`;
	const written = store({}, [
		{
			version: 2,
			sessionId: SAVED_SESSION,
			title: 'Old save',
			date: 1,
			contextRefs: [],
			scopeKey: 'team-a',
			messages: [
				{ id: 1, text: 'Check the key.', sender: 'user', timestamp: '09:00' },
				{ id: 2, text: 'Is [redacted] right?', sender: 'bot', timestamp: '09:00' },
			],
			turns: [{ turnId: 't1', messageId: 2, outcome: 'needs_input', reason: 'needs_input', finalText: `Is ${key} right?`, files: [], checks: [], usage: { waves: 1, modelRequests: 1, toolCalls: 1 }, request: { id: 'r1', kind: 'question', question: `Is ${key} right?`, choices: [`Yes, ${key}`] } }],
			runsStarted: [{ token: 'tk_owned_run_token', projectId: 'p1', source: `chat ${key}`, startTime: 1, scopeKey: 'team-a', conversationId: SAVED_SESSION }],
		},
	]);
	setAgentHost(hostIn('team-a'));
	const session = await AgentSession.getSession(SAVED_SESSION);
	await session.save(session.messages);
	const file = written.get(sessionPath(SAVED_SESSION)) as AgentSessionFile;
	assert.ok(!JSON.stringify(file).includes(key), 'the file holds the key');
	assert.equal(file.runsStarted?.[0].token, 'tk_owned_run_token', 'the run token stays readable, so the conversation can still stop its run');
});

// =============================================================================
// LIMITS
// =============================================================================

test('at the step limit the turn plans no more, answers with the best effort, and pauses for Continue', async () => {
	const read = planReply(['read_file', { path: 'a.txt' }]);
	store(scripted([read, read, 'I read a.txt twice; the rest is left.']));
	setAgentHost(hostOver(workspace({ 'a.txt': 'alpha' }).vfs, { steps: 2, costUsd: 0 }));
	const { turn: ended } = await AgentSession.newSession().execute('Read a lot.', undefined, turn());
	assert.deepEqual({ outcome: ended.outcome, reason: ended.reason, waves: ended.usage.waves, finalText: ended.finalText, request: ended.request?.kind }, { outcome: 'needs_input', reason: 'limited', waves: 2, finalText: 'I read a.txt twice; the rest is left.', request: 'continue' });
});

test('a request that could pass the cost limit is never sent, and the turn pauses for Continue, even in Auto', async () => {
	const replies = [planReply(['read_file', { path: 'a.txt' }])];
	store(scripted(replies));
	const auto: ApprovalSettings = { read: () => ({ mode: 'auto', grants: { schedules: false, deploymentToggles: false } }), subscribe: () => () => undefined, grant: () => undefined };
	setAgentHost({ ...hostIn('team-a'), limits: { read: () => ({ steps: 60, costUsd: 0.01 }) }, approvals: { run: auto, controls: { ...auto, setMode: () => undefined } } });
	const { turn: ended } = await AgentSession.newSession().execute('Read the files.', undefined, turn());
	assert.equal(replies.length, 1, 'no model request was sent: neither the plan nor the best-effort summary');
	assert.deepEqual({ outcome: ended.outcome, reason: ended.reason, request: ended.request?.kind }, { outcome: 'needs_input', reason: 'cost_limit', request: 'continue' });
});

// =============================================================================
// UNDO — the latest turn's file changes, put back or refused
// =============================================================================

/** The bot rows that close turns, as the chat shows them with their cards. */
function closingRows(session: AgentSession, chat: TurnController): ChatMessage[] {
	return session.decorate(chat.snapshot().messages).filter((m) => m.card);
}

/** Waits for a condition, a tick at a time. */
async function until(ready: () => boolean): Promise<void> {
	for (let i = 0; i < 5000 && !ready(); i++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(ready(), 'the condition never came true');
}

test("Undo on the latest turn's card puts the file back and is gone after; another team's workspace has no Undo", async () => {
	store(scripted([planReply(['read_file', { path: 'a.txt' }]), planReply(['edit_file', { path: 'a.txt', oldString: 'alpha', newString: 'ALPHA' }]), doneReply('Changed a.txt.')]));
	const { backend, vfs } = workspace({ 'a.txt': 'alpha' });
	setAgentHost(hostOver(vfs));
	const session = AgentSession.newSession();
	// step: the chat the Agent tab drives
	const chat = new TurnController({ initialMessages: session.messages, request: () => async (text, sink, turn) => (await session.execute(text, sink, turn)).results, now: () => '12:00', stopGraceMs: 0 });
	chat.send('Change a.txt.');
	await until(() => chat.snapshot().phase === 'idle' && closingRows(session, chat).length === 1);
	assert.equal(backend.files.get('a.txt'), 'ALPHA');
	const [row] = closingRows(session, chat);
	const notes: string[] = [];
	const press = { openFile: () => undefined, openVariables: () => undefined, send: () => undefined, note: (text: string) => void notes.push(text) };
	// step: after a team switch the host has another workspace, and the turn's changes are not in it
	setAgentHost(hostOver(workspace({}).vfs));
	assert.equal(closingRows(session, chat)[0].card?.actions, undefined);
	assert.equal(session.cardAction(row.id, { kind: 'action', id: UNDO }, press), false);
	setAgentHost(hostOver(vfs));
	assert.equal(session.cardAction(row.id, { kind: 'action', id: UNDO }, press), true);
	await until(() => notes.length === 1);
	assert.equal(backend.files.get('a.txt'), 'alpha');
	assert.equal(closingRows(session, chat)[0].card?.actions, undefined, 'one level: Undo is gone');
});

/** The agent's file tools over a view, as one run has them, and their Undo record. A delete's approval is the loop's; these let it through. */
function agentTools(vfs: StagedFileSystem): { record: UndoRecord; tool: (name: string, args: Record<string, unknown>) => Promise<string> } {
	const files = new FilesystemTools(vfs);
	const tools = files.tools();
	return { record: files.undo, tool: async (name, args) => (await (tools.find((t) => t.name === name) ?? assert.fail(name)).prepare(args)).run() };
}

/** The seed of the turn below. */
const SEED = { 'a.txt': 'alpha', 'd.txt': 'delta', 'r.txt': 'rho' };

/** One turn of each kind of change: a.txt edited, c.txt created, d.txt deleted, r.txt renamed to s.txt. */
async function changeEach(tool: (name: string, args: Record<string, unknown>) => Promise<string>): Promise<void> {
	await tool('read_file', { path: 'a.txt' });
	await tool('edit_file', { path: 'a.txt', oldString: 'alpha', newString: 'ALPHA' });
	await tool('write_file', { path: 'c.txt', content: 'gamma' });
	await tool('delete_file', { path: 'd.txt' });
	await tool('rename', { oldPath: 'r.txt', newPath: 's.txt' });
}

test('auto: Undo puts back a modified, a created, a deleted and a renamed file on the server', async () => {
	const { backend, vfs } = workspace(SEED);
	const { record, tool } = agentTools(vfs);
	await changeEach(tool);
	assert.deepEqual(Object.fromEntries(backend.files), { 'a.txt': 'ALPHA', 'c.txt': 'gamma', 's.txt': 'rho' });
	assert.equal((await record.undo()).kind, 'undone');
	assert.deepEqual(Object.fromEntries(backend.files), SEED);
	assert.deepEqual({ a: await shown(vfs, 'a.txt'), c: await shown(vfs, 'c.txt'), s: await shown(vfs, 's.txt') }, { a: 'alpha', c: null, s: null }, 'the view serves what the server holds');
});

test('manual: Undo drops what the turn staged, writes nothing to the server, and leaves nothing pending', async () => {
	const { backend, vfs } = workspace(SEED, 'manual');
	const { record, tool } = agentTools(vfs);
	await changeEach(tool);
	assert.ok(vfs.hasPendingChanges(), 'the turn staged its changes');
	assert.equal((await record.undo()).kind, 'undone');
	assert.deepEqual({ pending: vfs.hasPendingChanges(), log: backend.log }, { pending: false, log: [] });
	assert.deepEqual({ a: await shown(vfs, 'a.txt'), c: await shown(vfs, 'c.txt'), d: await shown(vfs, 'd.txt'), r: await shown(vfs, 'r.txt'), s: await shown(vfs, 's.txt') }, { a: 'alpha', c: null, d: 'delta', r: 'rho', s: null });
});

test('an editor with unsaved changes on any path refuses the whole Undo, and names it', async () => {
	const { backend, vfs } = workspace(SEED);
	const { record, tool } = agentTools(vfs);
	await changeEach(tool);
	vfs.registerOverlay('a.txt', { getContent: () => 'ALPHA, and typing', isDirty: () => true });
	const outcome = await record.undo();
	assert.deepEqual({ kind: outcome.kind, named: outcome.text.includes('a.txt') }, { kind: 'refused', named: true });
	assert.deepEqual(Object.fromEntries(backend.files), { 'a.txt': 'ALPHA', 'c.txt': 'gamma', 's.txt': 'rho' }, 'no other path was put back either');
});

test("auto: a teammate's server edit to a file the agent created refuses the Undo: the check reads the server afresh", async () => {
	const { backend, vfs } = workspace({});
	const { record, tool } = agentTools(vfs);
	await tool('write_file', { path: 'c.txt', content: 'gamma' });
	// step: another browser writes the server copy, which this page has not seen
	backend.files.set('c.txt', 'gamma, and a teammate');
	assert.equal((await record.undo()).kind, 'refused');
	assert.equal(backend.files.get('c.txt'), 'gamma, and a teammate', "the teammate's file is not deleted");
});
