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

import type { ChatMessage } from 'shell';
import { TurnController } from 'shell/src/components/chat/turns/turnController';
import type { ChatTurn } from 'shell/src/components/chat/types';

import { AgentSession, type CardActionHandlers } from './agent';
import { setAgentHost, type AgentHost, type ApprovalPrefs, type ApprovalSettings } from './host';
import type { AgentSessionFile } from './sessions';
import { choiceAction, CONTINUE, OPEN_VARIABLES, type RunRecord, type TurnRecord } from './turn';

/** Session ids for the stored conversations. */
const TEAM_A_SESSION = '11111111-1111-4111-8111-111111111111';
const OLD_SESSION = '22222222-2222-4222-8222-222222222222';

/** What a test's engine does when a run starts its model pipeline and asks it a question, and the other client calls a run makes. */
interface Engine {
	use?: () => Promise<{ token: string }>;
	chat?: (o: { token: string }) => Promise<unknown>;
	[method: string]: unknown;
}

/**
 * A fake store holding two conversations: one started in team a, and one
 * saved before sessions had a scope. Unless the test gives an engine,
 * starting a model pipeline fails, so a run that gets past the scope rule
 * stops at the model.
 *
 * @param engine - The engine calls a run makes.
 * @param extra - More conversations it holds.
 * @returns What was written, by path. A written session is also what the next getSession reads.
 */
function store(engine: Engine = {}, extra: AgentSessionFile[] = []): Map<string, unknown> {
	const written = new Map<string, unknown>();
	const session = (sessionId: string, scopeKey?: string): AgentSessionFile => ({ version: 1, sessionId, title: 'Edit', date: 1, contextRefs: [], messages: [], ...(scopeKey !== undefined ? { scopeKey } : {}) });
	const files = new Map<string, string>([[`.agents/agent.test/${TEAM_A_SESSION}.json`, JSON.stringify(session(TEAM_A_SESSION, 'team-a'))], [`.agents/agent.test/${OLD_SESSION}.json`, JSON.stringify(session(OLD_SESSION))], ...extra.map((file): [string, string] => [`.agents/agent.test/${file.sessionId}.json`, JSON.stringify(file)])]);
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

// =============================================================================
// TURNS — session file version 2, the cards, needs-you answers, unmount and Stop
// =============================================================================

/** A conversation saved as version 1, with one exchange. */
const V1_SESSION = '44444444-4444-4444-8444-444444444444';

/** A conversation saved as version 2. */
const V2_SESSION = '55555555-5555-4555-8555-555555555555';

/** A run the version 2 conversation started, still live with this start time. */
const OWNED: RunRecord = { token: 'tk_owned_run_token', projectId: 'p1', source: 'chat_1', startTime: 1234.5, scopeKey: 'team-a', conversationId: V2_SESSION };

/** A reply asking for tool calls. */
function planReply(...calls: Array<[tool: string, args: Record<string, unknown>]>): string {
	return JSON.stringify({ thought: 'working', tool_calls: calls.map(([tool, args]) => ({ tool, args })) });
}

/** A reply that finishes with `answer`. */
function doneReply(answer: string): string {
	return JSON.stringify({ thought: 'finishing', done: true, answer });
}

/**
 * Puts a Question stub on the 'rocketride' stub, which the run builds one of
 * for each model call, recording each question's goals (the request).
 *
 * @returns The goals, in call order, and the undo.
 */
function recordQuestions(): { goals: string[]; restore(): void } {
	const rocketride = require('rocketride') as { Question?: unknown };
	const goals: string[] = [];
	rocketride.Question = class {
		addInstruction(): void {}
		addHistory(): void {}
		addGoal(goal: string): void {
			goals.push(goal);
		}
		addContext(): void {}
		addQuestion(): void {}
	};
	return {
		goals,
		restore: () => {
			delete rocketride.Question;
		},
	};
}

/** An engine whose model answers from a script; once the script runs out, a model call never returns. */
function scripted(replies: string[], more: Engine = {}): Engine {
	return {
		use: async () => ({ token: 'tk_standin' }),
		chat: async () => {
			const next = replies.shift();
			return next === undefined ? new Promise(() => undefined) : { answers: [next] };
		},
		...more,
	};
}

/** A chat over a session, as the Agent tab drives one. */
function chatOver(session: AgentSession, stopGraceMs = 0): TurnController {
	return new TurnController({ initialMessages: session.messages, request: () => async (text, sink, turn) => (await session.execute(text, sink, turn)).results, now: () => '12:00', stopGraceMs });
}

/** Waits for a condition, a tick at a time. */
async function until(ready: () => boolean): Promise<void> {
	for (let i = 0; i < 5000 && !ready(); i++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(ready(), 'the condition never came true');
}

/** Whether a chat is idle with `n` bot rows: `n` turns closed. */
function answered(chat: TurnController, n: number): boolean {
	return chat.snapshot().phase === 'idle' && chat.snapshot().messages.filter((m) => m.sender === 'bot').length === n;
}

/** A host in team a whose approval mode is Auto. */
function autoHost(): AgentHost {
	const prefs: ApprovalPrefs = { mode: 'auto', grants: { schedules: false, deploymentToggles: false } };
	const run: ApprovalSettings = { read: () => prefs, subscribe: () => () => undefined, grant: () => undefined };
	return { ...hostIn('team-a'), approvals: { run, controls: { ...run, setMode: () => undefined } } };
}

/** Card handlers that record what they were asked to do. */
function handlers(send: (text: string) => void = () => undefined): CardActionHandlers & { opened: string[]; variables: number; sent: string[] } {
	const did = { opened: [] as string[], variables: 0, sent: [] as string[] };
	return {
		...did,
		get opened() {
			return did.opened;
		},
		get variables() {
			return did.variables;
		},
		get sent() {
			return did.sent;
		},
		openFile: (path) => did.opened.push(path),
		openVariables: () => {
			did.variables++;
		},
		send: (text) => {
			did.sent.push(text);
			send(text);
		},
	};
}

/** The saved session file of a conversation. */
function savedFile(written: Map<string, unknown>, sessionId: string): AgentSessionFile | undefined {
	return written.get(`.agents/agent.test/${sessionId}.json`) as AgentSessionFile | undefined;
}

test('a version 1 file loads with no turns and no runs, and the next save is version 2 with the turn linked to its answer row and its card', async () => {
	const v1: AgentSessionFile & { runsStarted: RunRecord[] } = {
		version: 1,
		sessionId: V1_SESSION,
		title: 'Old',
		date: 1,
		contextRefs: [],
		messages: [
			{ id: 1, text: 'hi', sender: 'user', timestamp: '09:00' },
			{ id: 2, text: 'Hi there.', sender: 'bot', timestamp: '09:00' },
		],
		scopeKey: 'team-a',
		// a field a version 1 file never had: it still owns nothing
		runsStarted: [{ ...OWNED, conversationId: V1_SESSION }],
	};
	const written = store(scripted([doneReply('Hello.')]), [v1]);
	const questions = recordQuestions();
	try {
		AgentSession.configure('agent.test');
		setAgentHost(hostIn('team-a'));
		const session = await AgentSession.getSession(V1_SESSION);
		assert.deepEqual({ turns: session.turns, runs: session.runsStarted }, { turns: [], runs: [] });
		const chat = chatOver(session);
		chat.send('Say hello.');
		await until(() => answered(chat, 2));
		await session.save(chat.snapshot().messages);
		const file = savedFile(written, V1_SESSION);
		assert.equal(file?.version, 2);
		const answer = file?.messages.at(-1);
		assert.deepEqual({ sender: answer?.sender, text: answer?.text, card: answer?.card }, { sender: 'bot', text: 'Hello.', card: { tone: 'success', title: 'Done' } });
		assert.deepEqual(
			file?.turns?.map((t) => ({ messageId: t.messageId, outcome: t.outcome })),
			[{ messageId: answer?.id, outcome: 'done' }]
		);
		assert.deepEqual(file?.runsStarted, []);
		assert.deepEqual(file?.messages.slice(0, 2), v1.messages, 'the old rows are kept as they were');
	} finally {
		questions.restore();
	}
});

test('a message the session refuses still ends as a failed turn, linked to its error row, which shows no card', async () => {
	const key = `sk-proj-${'r'.repeat(40)}`;
	const written = store();
	AgentSession.configure('agent.test');
	setAgentHost(hostIn('team-a'));
	const session = await AgentSession.getSession(TEAM_A_SESSION);
	const chat = chatOver(session);
	chat.send(`Use ${key}`);
	await until(() => chat.snapshot().messages.length === 2);
	const rows = chat.snapshot().messages;
	await session.save(rows);
	const file = savedFile(written, TEAM_A_SESSION);
	assert.deepEqual(
		file?.turns?.map((t) => ({ messageId: t.messageId, outcome: t.outcome, reason: t.reason })),
		[{ messageId: rows[1].id, outcome: 'failed', reason: 'refused' }]
	);
	assert.equal(file?.messages[1].card, undefined);
	assert.ok(!JSON.stringify(file).includes(key), 'the file holds the key');
});

test('a reloaded version 2 conversation still owns the runs it started, so Auto stops one; the same run in a version 1 file is refused', async () => {
	const stopped: string[] = [];
	const engine = (replies: string[]): Engine =>
		scripted(replies, {
			getTaskStatus: async (token: string) => ({ project_id: OWNED.projectId, source: OWNED.source, startTime: OWNED.startTime, name: 'chat_1', token }),
			terminate: async (token: string) => {
				stopped.push(token);
			},
		});
	const base = { title: 'Runs', date: 1, contextRefs: [], messages: [], scopeKey: 'team-a' };
	const v2: AgentSessionFile = { version: 2, sessionId: V2_SESSION, ...base, turns: [], runsStarted: [OWNED] };
	const v1 = { version: 1 as const, sessionId: V1_SESSION, ...base, runsStarted: [{ ...OWNED, conversationId: V1_SESSION }] };
	const questions = recordQuestions();
	try {
		store(engine([planReply(['rocketride_client', { method: 'terminate', params: [OWNED.token] }]), doneReply('Stopped your run.')]), [v2, v1]);
		AgentSession.configure('agent.test');
		setAgentHost(autoHost());
		const reloaded = await AgentSession.getSession(V2_SESSION);
		assert.deepEqual(reloaded.runsStarted, [OWNED]);
		const chat = chatOver(reloaded);
		chat.send('Stop the run you started.');
		await until(() => answered(chat, 1));
		assert.deepEqual(stopped, [OWNED.token]);

		store(engine([planReply(['rocketride_client', { method: 'terminate', params: [OWNED.token] }]), doneReply('I could not stop it.')]), [v2, v1]);
		const old = await AgentSession.getSession(V1_SESSION);
		const oldChat = chatOver(old);
		oldChat.send('Stop the run you started.');
		await until(() => answered(oldChat, 1));
		assert.deepEqual(stopped, [OWNED.token], 'the version 1 conversation stopped nothing');
		assert.match(
			oldChat
				.snapshot()
				.messages.filter((m) => m.sender === 'status')
				.map((m) => m.text)
				.join('\n'),
			/terminate — error: Not done: this conversation did not start the pipeline run/
		);
	} finally {
		questions.restore();
	}
});

test('a turn running when the Agent tab unmounts is saved: its rows at once, then a closing row and the stopped turn linked to it', async () => {
	const writes: AgentSessionFile[] = [];
	let asked = 0;
	const written = store(
		scripted([], {
			chat: async () => {
				asked++;
				return new Promise(() => undefined);
			},
		})
	);
	const client = (globalThis as { __shellTestClient?: { fsWriteJson: (path: string, value: unknown) => Promise<void> } }).__shellTestClient!;
	const write = client.fsWriteJson;
	client.fsWriteJson = async (path, value) => {
		writes.push(JSON.parse(JSON.stringify(value)) as AgentSessionFile);
		await write(path, value);
	};
	const questions = recordQuestions();
	try {
		AgentSession.configure('agent.test');
		setAgentHost(hostIn('team-a'));
		const session = await AgentSession.getSession(TEAM_A_SESSION);
		const chat = chatOver(session, 3_000);
		chat.send('Build the chat pipeline.');
		await until(() => asked === 1);
		const rows = chat.snapshot().messages;
		// step: what unmounting does: the chat hook stops its turn, then the tab hands the session the rows it showed
		chat.stop();
		session.detach(rows);
		await until(() => (savedFile(written, TEAM_A_SESSION)?.turns?.length ?? 0) === 1);
		assert.deepEqual(writes[0].messages, rows, 'the rows were saved at once');
		const file = savedFile(written, TEAM_A_SESSION)!;
		const closing = file.messages[1];
		assert.deepEqual({ sender: closing.sender, text: closing.text }, { sender: 'bot', text: 'Stopped by you: the Agent tab closed.' });
		assert.deepEqual(
			file.turns?.map((t) => ({ messageId: t.messageId, outcome: t.outcome, reason: t.reason })),
			[{ messageId: closing.id, outcome: 'stopped', reason: 'unmounted' }]
		);
		assert.equal(file.scopeKey, 'team-a');
		// step: reopened, the conversation shows the turn's card under its closing row
		const reopened = await AgentSession.getSession(TEAM_A_SESSION);
		assert.deepEqual(reopened.decorate(reopened.messages)[1].card, { tone: 'neutral', title: 'Stopped' });
	} finally {
		questions.restore();
	}
});

test("a turn that ends after Stop's grace closed it saves itself, linked to the chat's stop row", async () => {
	const written = store(scripted([]));
	const client = (globalThis as { __shellTestClient?: { fsWriteJson: (path: string, value: unknown) => Promise<void> } }).__shellTestClient!;
	const write = client.fsWriteJson;
	// step: a slow store holds the turn before its run, past the grace
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	client.fsWriteJson = async (path, value) => {
		await gate;
		await write(path, value);
	};
	AgentSession.configure('agent.test');
	setAgentHost(hostIn('team-a'));
	const session = await AgentSession.getSession(OLD_SESSION);
	const chat = chatOver(session, 0);
	chat.send('Start work.');
	chat.stop();
	await until(() => chat.snapshot().phase === 'idle');
	const rows = chat.snapshot().messages;
	assert.match(rows[1].text, /^Stopped by you\./);
	// step: the tab's idle save, then the store catches up and the turn ends
	void session.save(rows);
	release();
	await until(() => (savedFile(written, OLD_SESSION)?.turns?.length ?? 0) === 1);
	assert.deepEqual(
		savedFile(written, OLD_SESSION)?.turns?.map((t) => ({ messageId: t.messageId, outcome: t.outcome })),
		[{ messageId: rows[1].id, outcome: 'stopped' }]
	);
});

test('only the next reply answers a needs-you request: a second press, a press after the reply, and a press after a typed reply do nothing', async () => {
	const ask = (question: string, choices: string[]): string => planReply(['ask_user', { question, choices }]);
	const written = store(scripted([ask('Which model?', ['Claude', 'GPT-5']), doneReply('Using Claude.'), ask('Which region?', ['us', 'eu']), doneReply('Using eu.')]));
	const questions = recordQuestions();
	try {
		AgentSession.configure('agent.test');
		setAgentHost(hostIn('team-a'));
		const session = AgentSession.newSession();
		const chat = chatOver(session);
		const rowsNow = (): ChatMessage[] => session.decorate(chat.snapshot().messages);
		const asking = (): ChatMessage =>
			rowsNow()
				.filter((m) => m.card?.title === 'Needs you')
				.at(-1)!;
		chat.send('Build it.');
		await until(() => answered(chat, 1));
		const first = asking();
		assert.deepEqual(first.card?.actions, [
			{ id: choiceAction(0), label: 'Claude' },
			{ id: choiceAction(1), label: 'GPT-5' },
		]);
		const press = handlers((text) => chat.send(text));
		assert.equal(session.cardAction(first.id, { kind: 'action', id: choiceAction(0) }, press), true);
		assert.equal(session.cardAction(first.id, { kind: 'action', id: choiceAction(1) }, press), false, 'a second press sends nothing');
		assert.ok(
			asking().card?.actions?.every((a) => a.disabled),
			'the buttons go dead at once'
		);
		await until(() => answered(chat, 2));
		const request = session.turns.find((t) => t.request)?.request;
		assert.equal(questions.goals.at(-1), `Claude\n\n(answering request ${request?.id})`);
		assert.equal(session.cardAction(first.id, { kind: 'action', id: choiceAction(1) }, press), false, 'a late press sends nothing');
		assert.deepEqual(press.sent, ['Claude']);

		chat.send('Build another.');
		await until(() => answered(chat, 3));
		const second = asking();
		chat.send('eu please');
		await until(() => answered(chat, 4));
		const typed = session.turns.filter((t) => t.request).at(-1)?.request;
		assert.equal(questions.goals.at(-1), `eu please\n\n(answering request ${typed?.id})`);
		assert.equal(questions.goals.filter((g) => g === 'Build another.').length, 1, 'a message with no open request carries no note');
		assert.equal(session.cardAction(second.id, { kind: 'action', id: choiceAction(1) }, press), false, 'a press after a typed reply sends nothing');
		await session.save(chat.snapshot().messages);
		assert.deepEqual(
			savedFile(written, session.sessionId)?.turns?.map((t) => t.request?.answeredBy !== undefined),
			[true, false, true, false]
		);
	} finally {
		questions.restore();
	}
});

test('a turn stopped in the wave that asked the user answers nothing: the next message is not a reply to the question', async () => {
	let chat: TurnController | undefined;
	store(
		scripted([planReply(['ask_user', { kind: 'variable', variable: 'ROCKETRIDE_OPENAI_KEY', question: 'Add your OpenAI key.' }]), doneReply('Done.')], {
			// step: the user presses Stop after the model asked, while the tool reads the Variable names
			account: {
				getEnvironmentKeys: async () => {
					chat?.stop();
					return [];
				},
			},
		})
	);
	const questions = recordQuestions();
	try {
		AgentSession.configure('agent.test');
		setAgentHost(hostIn('team-a'));
		chat = chatOver(AgentSession.newSession(), 60_000);
		chat.send('Build it.');
		await until(() => answered(chat!, 1));
		chat.send('Use Claude instead.');
		await until(() => answered(chat!, 2));
		assert.equal(questions.goals.at(-1), 'Use Claude instead.');
	} finally {
		questions.restore();
	}
});

test('a message sent while the model asks the user is read in the same turn, and the model can ask again', async () => {
	let chat: TurnController | undefined;
	// step: the first reply also says done, as a model may when it asks
	const asking = JSON.stringify({ thought: 'asking', done: true, answer: 'Which model?', tool_calls: [{ tool: 'ask_user', args: { question: 'Which model?' } }] });
	const replies = [asking, planReply(['ask_user', { question: 'Which region?' }])];
	store({
		use: async () => ({ token: 'tk_standin' }),
		chat: async () => {
			// step: the user writes while the model asks its first question
			if (replies.length === 2) chat?.send('Use Claude.');
			return { answers: [replies.shift()] };
		},
	});
	const questions = recordQuestions();
	try {
		AgentSession.configure('agent.test');
		setAgentHost(hostIn('team-a'));
		chat = chatOver(AgentSession.newSession());
		chat.send('Build it.');
		await until(() => chat!.snapshot().phase === 'idle' && replies.length === 0);
		assert.deepEqual(questions.goals, ['Build it.', 'Build it.'], 'no turn of its own answered the first question');
		const answers = chat.snapshot().messages.filter((m) => m.sender === 'bot');
		assert.equal(answers.at(-1)?.text, 'Which region?');
	} finally {
		questions.restore();
	}
});

test('a card press opens a file, opens Variables, or sends Continue once, and the reloaded card shows its state', async () => {
	const paused: TurnRecord = {
		turnId: 't1',
		messageId: 2,
		scopeKey: 'team-a',
		outcome: 'needs_input',
		reason: 'needs_input',
		finalText: 'Paused after 60 steps.',
		files: [{ path: 'pipelines/a.pipe', change: 'added' }],
		checks: [],
		usage: { waves: 60, modelRequests: 60, toolCalls: 80 },
		request: { id: 'r1', kind: 'continue', question: 'Paused after 60 steps.' },
	};
	const v2: AgentSessionFile = {
		version: 2,
		sessionId: V2_SESSION,
		title: 'Paused',
		date: 1,
		contextRefs: [],
		scopeKey: 'team-a',
		messages: [
			{ id: 1, text: 'Build it.', sender: 'user', timestamp: '09:00' },
			{ id: 2, text: 'Paused after 60 steps.', sender: 'bot', timestamp: '09:00' },
		],
		turns: [paused],
		runsStarted: [],
	};
	store({}, [v2]);
	AgentSession.configure('agent.test');
	setAgentHost(hostIn('team-a'));
	const session = await AgentSession.getSession(V2_SESSION);
	assert.deepEqual(session.decorate(session.messages)[1].card, { tone: 'info', title: 'Needs you', files: ['pipelines/a.pipe'], actions: [{ id: CONTINUE, label: 'Continue' }] });
	const press = handlers();
	assert.equal(session.cardAction(2, { kind: 'file', path: 'pipelines/a.pipe' }, press), true);
	assert.equal(session.cardAction(2, { kind: 'action', id: OPEN_VARIABLES }, press), true);
	assert.equal(session.cardAction(2, { kind: 'action', id: CONTINUE }, press), true);
	assert.equal(session.cardAction(2, { kind: 'action', id: CONTINUE }, press), false);
	assert.equal(session.cardAction(1, { kind: 'action', id: CONTINUE }, press), false, 'a row with no turn has no card to press');
	assert.deepEqual({ opened: press.opened, variables: press.variables, sent: press.sent }, { opened: ['pipelines/a.pipe'], variables: 1, sent: ['Continue.'] });
	assert.deepEqual(session.decorate(session.messages)[1].card?.actions, [{ id: CONTINUE, label: 'Continue', disabled: true }]);
});

test('a key in a needs-you question never reaches the saved rows, cards or turns', async () => {
	const key = `sk-proj-${'n'.repeat(40)}`;
	const written = store(scripted([planReply(['ask_user', { question: `Should I use ${key}?`, choices: [`Use ${key}`, 'No'] }])]));
	const questions = recordQuestions();
	try {
		AgentSession.configure('agent.test');
		setAgentHost(hostIn('team-a'));
		const session = AgentSession.newSession();
		const chat = chatOver(session);
		chat.send('Set up the key.');
		await until(() => answered(chat, 1));
		await session.save(chat.snapshot().messages);
		const file = savedFile(written, session.sessionId);
		assert.equal(file?.messages.find((m) => m.card)?.card?.actions?.[0].label, 'Use [redacted]');
		assert.ok(!JSON.stringify(file).includes(key), 'the file holds the key');
	} finally {
		questions.restore();
	}
});

test("a tab mounted again after an unmount (React's dev double mount) is attached: a turn that ends waits for the chat's own rows", async () => {
	const written = store(scripted([doneReply('Hello.')]));
	const questions = recordQuestions();
	try {
		AgentSession.configure('agent.test');
		setAgentHost(hostIn('team-a'));
		const session = await AgentSession.getSession(TEAM_A_SESSION);
		// step: what the dev double mount does to the tab's effect: cleanup, then setup again
		session.attach();
		session.detach([]);
		session.attach();
		const chat = chatOver(session);
		chat.send('Say hello.');
		await until(() => answered(chat, 1));
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(savedFile(written, TEAM_A_SESSION), undefined, 'an attached session leaves the save to the tab');
		await session.save(chat.snapshot().messages);
		const file = savedFile(written, TEAM_A_SESSION)!;
		assert.deepEqual(
			file.messages.map((m) => m.text),
			['Say hello.', 'Hello.'],
			'no closing row of a closed tab'
		);
		assert.deepEqual(
			file.turns?.map((t) => ({ messageId: t.messageId, reason: t.reason })),
			[{ messageId: file.messages[1].id, reason: 'done' }]
		);
	} finally {
		questions.restore();
	}
});

test("a chat request the stand-in pipeline retries after a restart counts as two model requests in the turn's usage", async () => {
	let chats = 0;
	store({
		use: async () => ({ token: 'tk_standin' }),
		terminate: async () => undefined,
		chat: async () => {
			chats++;
			if (chats === 1) throw new Error('pipeline ended');
			return { answers: [doneReply('Hello.')] };
		},
	});
	const questions = recordQuestions();
	try {
		AgentSession.configure('agent.test');
		setAgentHost(hostIn('team-a'));
		const session = await AgentSession.getSession(TEAM_A_SESSION);
		const { turn: ended } = await session.execute('Say hello.', undefined, turn());
		assert.equal(chats, 2, 'the failed request was sent again');
		assert.deepEqual({ outcome: ended.outcome, usage: ended.usage }, { outcome: 'done', usage: { waves: 1, modelRequests: 2, toolCalls: 0 } });
	} finally {
		questions.restore();
	}
});

test('a key in a stored turn, its card or a run record is redacted when the session saves again', async () => {
	const key = `sk-proj-${'s'.repeat(40)}`;
	const leaky: TurnRecord = {
		turnId: 't1',
		messageId: 2,
		outcome: 'needs_input',
		reason: 'needs_input',
		finalText: `Is ${key} right?`,
		files: [],
		checks: [],
		usage: { waves: 1, modelRequests: 1, toolCalls: 1 },
		request: { id: 'r1', kind: 'question', question: `Is ${key} right?`, choices: [`Yes, ${key}`] },
	};
	const v2: AgentSessionFile = {
		version: 2,
		sessionId: V2_SESSION,
		title: 'Old save',
		date: 1,
		contextRefs: [],
		scopeKey: 'team-a',
		messages: [
			{ id: 1, text: 'Check the key.', sender: 'user', timestamp: '09:00' },
			{ id: 2, text: 'Is [redacted] right?', sender: 'bot', timestamp: '09:00' },
		],
		turns: [leaky],
		runsStarted: [{ ...OWNED, source: `chat ${key}` }],
	};
	const written = store({}, [v2]);
	AgentSession.configure('agent.test');
	setAgentHost(hostIn('team-a'));
	const session = await AgentSession.getSession(V2_SESSION);
	await session.save(session.messages);
	const file = savedFile(written, V2_SESSION);
	assert.ok(!JSON.stringify(file).includes(key), 'the file holds the key');
	assert.equal(file?.messages[1].card?.actions?.[0].label, 'Yes, [redacted]');
	assert.equal(file?.runsStarted?.[0].token, OWNED.token, 'the run token stays readable');
});
