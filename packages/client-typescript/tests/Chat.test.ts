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

/**
 * Unit tests for the persistent Chat class — TDD §12.1 checklist.
 *
 * All file IO goes through an in-memory `MockFsClient` so the tests do not
 * touch the network or a real FileStore. The client implements the structural
 * `RocketRideChatClient` interface and tracks every call so we can assert on
 * write atomicity and sequencing.
 */

import { Chat, CHAT_SCHEMA_VERSION, CATALOG_SCHEMA_VERSION, CatalogContentionError, ChatNotFoundError, EAGER_HISTORY_TURNS, makeChatsNamespace, parseChatFile, type RocketRideChatClient } from '../src/client/Chat';
import { Question } from '../src/client/schema/Question';

class MockFsClient implements RocketRideChatClient {
	files: Map<string, string> = new Map();
	dirs: Set<string> = new Set();
	chatCalls: Array<{ token: string; question: Question }> = [];
	answerSupplier: () => unknown = () => ({ body: 'mock answer text' });

	async fsMkdir(path: string): Promise<void> {
		this.dirs.add(path);
	}
	async fsRmdir(path: string, recursive?: boolean): Promise<void> {
		this.dirs.delete(path);
		if (recursive) {
			for (const key of Array.from(this.files.keys())) {
				if (key.startsWith(path + '/')) this.files.delete(key);
			}
		}
	}
	async fsStat(path: string) {
		if (this.files.has(path)) return { exists: true as const, type: 'file' as const, size: this.files.get(path)!.length };
		if (this.dirs.has(path)) return { exists: true as const, type: 'dir' as const };
		return { exists: false as const };
	}
	async fsReadString(path: string): Promise<string> {
		if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`);
		return this.files.get(path)!;
	}
	async fsWriteString(path: string, text: string): Promise<void> {
		this.files.set(path, text);
	}
	async fsReadJson<T = unknown>(path: string): Promise<T> {
		return JSON.parse(await this.fsReadString(path));
	}
	async fsWriteJson(path: string, obj: unknown): Promise<void> {
		await this.fsWriteString(path, JSON.stringify(obj, null, 2));
	}
	async chat(opts: { token: string; question: Question }): Promise<any> {
		this.chatCalls.push({ token: opts.token, question: opts.question });
		return this.answerSupplier();
	}
}

const PIPELINE_ID = 'pipe-test';
const TOKEN = 'test-token';

describe('Chat persistence (TDD §12.1)', () => {
	test('create writes the header line exactly once and leaves catalog empty', async () => {
		const fs = new MockFsClient();
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		expect(chat.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

		const file = fs.files.get(`.chats/${chat.id}/chat.jsonl`)!;
		expect(file).toBeDefined();
		const lines = file.trim().split('\n');
		expect(lines).toHaveLength(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe('header');
		expect(header.schema_version).toBe(CHAT_SCHEMA_VERSION);
		expect(header.guid).toBe(chat.id);
		expect(header.pipeline_id).toBe(PIPELINE_ID);
		expect(fs.files.has('.chats/catalog.json')).toBe(false);
	});

	test('round-trip: create → send → open(sameId) reproduces history', async () => {
		const fs = new MockFsClient();
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await chat.send('first message');
		await chat.send('second message');

		const reopened = await Chat.open({ client: fs, token: TOKEN, chatId: chat.id });
		expect(reopened.id).toBe(chat.id);
		expect(reopened.pipelineId).toBe(PIPELINE_ID);
		expect(reopened.history).toHaveLength(2);
		expect(reopened.history.map((t) => t.seq)).toEqual([1, 2]);
	});

	test('open() throws ChatNotFoundError when chat file is missing', async () => {
		const fs = new MockFsClient();
		await expect(Chat.open({ client: fs, token: TOKEN, chatId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })).rejects.toBeInstanceOf(ChatNotFoundError);
	});

	test('each send writes exactly one turn line (atomic-per-turn)', async () => {
		const fs = new MockFsClient();
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await chat.send('hello');
		const lines = fs.files.get(`.chats/${chat.id}/chat.jsonl`)!.trim().split('\n');
		expect(lines).toHaveLength(2); // header + 1 turn
		const turn = JSON.parse(lines[1]);
		expect(turn.type).toBe('turn');
		expect(turn.seq).toBe(1);
		expect(turn.schema_version).toBe(CHAT_SCHEMA_VERSION);
	});

	test('engine failure during send leaves no partial turn on disk', async () => {
		const fs = new MockFsClient();
		fs.answerSupplier = () => {
			throw new Error('engine boom');
		};
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await expect(chat.send('hi')).rejects.toThrow('engine boom');
		const lines = fs.files.get(`.chats/${chat.id}/chat.jsonl`)!.trim().split('\n');
		expect(lines).toHaveLength(1); // header only
	});

	test('seq numbers monotonically increase across sequential sends', async () => {
		const fs = new MockFsClient();
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await chat.send('one');
		await chat.send('two');
		await chat.send('three');
		const seqs = chat.history.map((t) => t.seq);
		expect(seqs).toEqual([1, 2, 3]);
	});

	test('stored question and answer round-trip byte-for-byte', async () => {
		const fs = new MockFsClient();
		fs.answerSupplier = () => ({ body: 'precise answer 123', meta: { latency_ms: 42 } });
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await chat.send('the question');
		const reopened = await Chat.open({ client: fs, token: TOKEN, chatId: chat.id });
		expect(reopened.history[0].answer).toEqual({ body: 'precise answer 123', meta: { latency_ms: 42 } });
		expect((reopened.history[0].question as any).chat_id).toBe(chat.id);
		expect((reopened.history[0].question as any).questions[0].text).toBe('the question');
	});

	test('send populates catalog entry on first turn (updated, message_count, preview)', async () => {
		const fs = new MockFsClient();
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await chat.send('hello world '.repeat(20));
		const cat = JSON.parse(fs.files.get('.chats/catalog.json')!);
		expect(cat.schema_version).toBe(CATALOG_SCHEMA_VERSION);
		expect(cat.chats).toHaveLength(1);
		const entry = cat.chats[0];
		expect(entry.guid).toBe(chat.id);
		expect(entry.pipeline_id).toBe(PIPELINE_ID);
		expect(entry.message_count).toBe(1);
		expect(entry.preview.length).toBeLessThanOrEqual(80);
		expect(entry.preview).toContain('hello world');
	});

	test('catalog version monotonically increments on each mutation', async () => {
		const fs = new MockFsClient();
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await chat.send('one');
		const v1 = JSON.parse(fs.files.get('.chats/catalog.json')!).version;
		await chat.send('two');
		const v2 = JSON.parse(fs.files.get('.chats/catalog.json')!).version;
		expect(v2).toBeGreaterThan(v1);
	});

	test('rename mutates catalog title and does not touch chat.jsonl', async () => {
		const fs = new MockFsClient();
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await chat.send('first');
		const beforeFile = fs.files.get(`.chats/${chat.id}/chat.jsonl`)!;
		await chat.rename('My renamed chat');
		const afterFile = fs.files.get(`.chats/${chat.id}/chat.jsonl`)!;
		expect(afterFile).toBe(beforeFile);
		const cat = JSON.parse(fs.files.get('.chats/catalog.json')!);
		expect(cat.chats[0].title).toBe('My renamed chat');
	});

	test('delete removes catalog entry AND the directory recursively', async () => {
		const fs = new MockFsClient();
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await chat.send('alpha');
		await chat.delete();
		const cat = JSON.parse(fs.files.get('.chats/catalog.json')!);
		expect(cat.chats).toEqual([]);
		expect(fs.files.has(`.chats/${chat.id}/chat.jsonl`)).toBe(false);
	});

	test('send threads chat_id into outgoing Question and last-3 turns into history', async () => {
		const fs = new MockFsClient();
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await chat.send('t1');
		await chat.send('t2');
		await chat.send('t3');
		await chat.send('t4');
		const lastQ = fs.chatCalls[fs.chatCalls.length - 1].question;
		expect(lastQ.chat_id).toBe(chat.id);
		// EAGER_HISTORY_TURNS turns × 2 messages (user + assistant) = 6 entries.
		expect(lastQ.history.length).toBeLessThanOrEqual(EAGER_HISTORY_TURNS * 2);
		// First entry should be the oldest of the last-3 turns (i.e. t1's user line — the very first send).
		expect(lastQ.history[0]).toEqual({ role: 'user', content: 't1' });
	});

	test('client.chats.list filters by pipelineId and returns [] when no catalog', async () => {
		const fs = new MockFsClient();
		const ns = makeChatsNamespace(fs);
		expect(await ns.list()).toEqual([]);

		const chatA = await Chat.create({ client: fs, token: TOKEN, pipelineId: 'pipe-A' });
		await chatA.send('hi A');
		const chatB = await Chat.create({ client: fs, token: TOKEN, pipelineId: 'pipe-B' });
		await chatB.send('hi B');

		const allEntries = await ns.list();
		expect(allEntries).toHaveLength(2);

		const justA = await ns.list({ pipelineId: 'pipe-A' });
		expect(justA).toHaveLength(1);
		expect(justA[0].guid).toBe(chatA.id);
	});

	test('parseChatFile tolerates trailing partial-write line', () => {
		const good = JSON.stringify({ type: 'header', schema_version: 1, guid: 'x', created: 't', pipeline_id: 'p' });
		const turn = JSON.stringify({ type: 'turn', schema_version: 1, seq: 1, created: 't', question: {}, answer: {} });
		const raw = good + '\n' + turn + '\n{"type":"turn","sch';
		const { header, turns } = parseChatFile(raw);
		expect(header).not.toBeNull();
		expect(turns).toHaveLength(1);
	});

	test('parseChatFile skips unknown record types (forward-compat per TDD §5.4)', () => {
		const lines = [JSON.stringify({ type: 'header', schema_version: 1, guid: 'x', created: 't', pipeline_id: 'p' }), JSON.stringify({ type: 'future_record', schema_version: 7, payload: 'opaque' }), JSON.stringify({ type: 'turn', schema_version: 1, seq: 1, created: 't', question: {}, answer: {} })];
		const { header, turns } = parseChatFile(lines.join('\n'));
		expect(header).not.toBeNull();
		expect(turns).toHaveLength(1);
	});
});

describe('optimistic-lock retry on catalog.json (TDD §8.1)', () => {
	test('CatalogContentionError fires when interleaved writes exceed retry budget', async () => {
		const fs = new MockFsClient();
		const chat = await Chat.create({ client: fs, token: TOKEN, pipelineId: PIPELINE_ID });
		await chat.send('one');

		// Force a contention scenario: the second read inside mutateCatalog observes
		// a different `version` from the first read, every attempt.
		const origRead = fs.fsReadJson.bind(fs);
		let reads = 0;
		fs.fsReadJson = async <T = any>(path: string): Promise<T> => {
			reads += 1;
			const cat = (await origRead(path)) as any;
			// On every "verify" read (even-numbered: 2,4,6,...), pretend someone
			// else has bumped the version since we last looked.
			if (reads % 2 === 0) cat.version += 100;
			return cat as T;
		};

		await expect(chat.rename('contention test')).rejects.toBeInstanceOf(CatalogContentionError);
	});
});

describe('chat_id format guard', () => {
	test('open rejects a non-UUID chatId', async () => {
		const fs = new MockFsClient();
		await expect(Chat.open({ client: fs, token: TOKEN, chatId: 'not-a-uuid' })).rejects.toThrow();
	});

	test('Question.fromDict rejects a chat_id that is not a valid UUID', () => {
		expect(() => Question.fromDict({ chat_id: 'nope' } as any)).toThrow();
		const ok = Question.fromDict({ chat_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } as any);
		expect(ok.chat_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
	});
});
