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
 * Persistent chat session, fully client-driven.
 *
 * The TS client owns all filestore reads and writes via existing `fs*` primitives;
 * the engine/chat node does no chat-aware writes. One `Chat` instance represents one
 * persistent conversation in the per-user filestore at `.chats/<chat_id>/`.
 *
 * On-disk layout:
 *   .chats/
 *     catalog.json               ← per-user mutable index (this file)
 *     <chat_id>/                 ← one directory per chat
 *       chat.jsonl               ← header line + N turn lines
 *       <attachment-id>.<ext>    ← future: feature-2 attachments
 */

import { Question, QuestionType, type QuestionHistory } from './schema/Question.js';
import type { PIPELINE_RESULT } from './types/index.js';

// Allow the Chat class to talk to RocketRideClient via a structural interface
// instead of importing the concrete class (which would create a cyclic import:
// client.ts → Chat.ts → client.ts). The structural type covers exactly the
// surface Chat needs — fs* primitives + chat() + the namespace accessor.
export interface RocketRideChatClient {
	fsMkdir(path: string): Promise<void>;
	fsRmdir(path: string, recursive?: boolean): Promise<void>;
	fsStat(path: string): Promise<{ exists: boolean; type?: 'file' | 'dir'; size?: number; modified?: number }>;
	fsReadString(path: string): Promise<string>;
	fsWriteString(path: string, text: string): Promise<void>;
	fsReadJson<T = unknown>(path: string): Promise<T>;
	fsWriteJson(path: string, obj: unknown): Promise<void>;
	chat(options: { token: string; question: Question; onSSE?: (type: string, data: Record<string, unknown>) => Promise<void> }): Promise<PIPELINE_RESULT>;
}

export const CHAT_SCHEMA_VERSION = 1;
export const CATALOG_SCHEMA_VERSION = 1;
export const CATALOG_PREVIEW_LEN = 80;
export const CATALOG_MAX_RETRY = 3;
const CHATS_ROOT = '.chats';
const CATALOG_PATH = '.chats/catalog.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Header line written once at chat creation. */
export interface ChatHeader {
	type: 'header';
	schema_version: number;
	guid: string;
	created: string;
	pipeline_id: string;
}

/** Turn line — one round-trip per line, full Question/Answer stored verbatim. */
export interface ChatTurn {
	type: 'turn';
	schema_version: number;
	seq: number;
	created: string;
	question: Record<string, unknown>;
	answer: unknown;
}

export type ChatLine = ChatHeader | ChatTurn;

/** Per-user catalog entry (mutable index). */
export interface ChatCatalogEntry {
	guid: string;
	title: string;
	created: string;
	updated: string;
	message_count: number;
	preview: string;
	pipeline_id: string;
}

interface ChatCatalog {
	schema_version: number;
	version: number;
	chats: ChatCatalogEntry[];
}

export class ChatNotFoundError extends Error {
	constructor(public chatId: string) {
		super(`Chat ${chatId} does not exist`);
		this.name = 'ChatNotFoundError';
	}
}

export class CatalogContentionError extends Error {
	constructor(public attempts: number) {
		super(`catalog.json optimistic-lock retry exhausted after ${attempts} attempts`);
		this.name = 'CatalogContentionError';
	}
}

/**
 * One persistent chat session.
 *
 * Built via the static factories `Chat.create()` (new chat) or `Chat.open()`
 * (resume existing). Persistence happens entirely client-side; the chat node
 * and engine are unchanged except for the `chat_id` field on the inbound Question.
 */
export class Chat {
	readonly id: string;
	readonly pipelineId: string;
	readonly created: string;
	/** Loaded turn list, hydrated from `chat.jsonl`. Newest is last. */
	history: ChatTurn[];

	private readonly _client: RocketRideChatClient;
	private readonly _token: string;

	private constructor(opts: { client: RocketRideChatClient; token: string; id: string; pipelineId: string; created: string; history: ChatTurn[] }) {
		this._client = opts.client;
		this._token = opts.token;
		this.id = opts.id;
		this.pipelineId = opts.pipelineId;
		this.created = opts.created;
		this.history = opts.history;
	}

	// =========================================================================
	// Factories
	// =========================================================================

	/**
	 * Create a new persistent chat. Generates a fresh `chat_id`, makes the
	 * directory, writes the header line. The catalog is NOT touched until the
	 * first turn lands — keeps abandoned-empty chats out of the list.
	 */
	static async create(opts: { client: RocketRideChatClient; token: string; pipelineId: string }): Promise<Chat> {
		if (!opts.pipelineId) throw new Error('pipelineId is required');
		const id = newChatId();
		const created = new Date().toISOString();
		const dir = `${CHATS_ROOT}/${id}`;

		await opts.client.fsMkdir(dir);
		const header: ChatHeader = {
			type: 'header',
			schema_version: CHAT_SCHEMA_VERSION,
			guid: id,
			created,
			pipeline_id: opts.pipelineId,
		};
		await opts.client.fsWriteString(`${dir}/chat.jsonl`, JSON.stringify(header) + '\n');

		return new Chat({
			client: opts.client,
			token: opts.token,
			id,
			pipelineId: opts.pipelineId,
			created,
			history: [],
		});
	}

	/**
	 * Resume an existing chat by id. Reads `chat.jsonl`, parses every line,
	 * hydrates `history` from the turn lines. Throws `ChatNotFoundError` if the
	 * chat file is missing.
	 */
	static async open(opts: { client: RocketRideChatClient; token: string; chatId: string }): Promise<Chat> {
		if (!UUID_RE.test(opts.chatId)) {
			throw new Error(`chatId must be a UUID; got ${opts.chatId}`);
		}
		const path = `${CHATS_ROOT}/${opts.chatId}/chat.jsonl`;
		let raw: string;
		try {
			raw = await opts.client.fsReadString(path);
		} catch {
			// fsReadString throws when the file is missing on the FS backend.
			throw new ChatNotFoundError(opts.chatId);
		}
		const { header, turns } = parseChatFile(raw);
		if (!header || header.guid !== opts.chatId) {
			throw new Error(`chat file at ${path} is missing or has mismatched header`);
		}
		return new Chat({
			client: opts.client,
			token: opts.token,
			id: header.guid,
			pipelineId: header.pipeline_id,
			created: header.created,
			history: turns,
		});
	}

	// =========================================================================
	// Actions
	// =========================================================================

	/**
	 * Send a new user message. Atomic per turn:
	 *   1. (Attachments parked for feature 2 — accepted but no-op here.)
	 *   2. Build a Question with `chat_id`, the new user turn, and any
	 *      `opts.history` items pushed onto `Question.history` in order.
	 *   3. Call `client.chat({token, question, onSSE})`, await the result.
	 *   4. Append ONE turn line to `chat.jsonl` (read-then-rewrite — `fsWrite`
	 *      is not append-native at the TS-client level today).
	 *   5. Update the catalog entry (insert on first turn).
	 *
	 * Returns the raw `PIPELINE_RESULT` from `client.chat()`.
	 *
	 * If step 3 throws (engine error, network drop) nothing is written to disk —
	 * the chat file ends at the prior completed turn.
	 *
	 * `opts.history` is a caller-supplied list of prior turns to prime the
	 * model with. The client SDK does not derive history from `chat.jsonl`
	 * itself — callers (e.g. chat-ui) decide what to pass.
	 */
	async send(
		text: string,
		opts?: {
			attachments?: unknown[];
			onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>;
			history?: QuestionHistory[];
		}
	): Promise<PIPELINE_RESULT> {
		const question = new Question({ type: QuestionType.PROMPT, chat_id: this.id });
		question.addQuestion(text);
		if (opts?.history) {
			for (const item of opts.history) {
				question.addHistory(item);
			}
		}

		const result = await this._client.chat({
			token: this._token,
			question,
			onSSE: opts?.onSSE,
		});

		const seq = (this.history[this.history.length - 1]?.seq ?? 0) + 1;
		const turn: ChatTurn = {
			type: 'turn',
			schema_version: CHAT_SCHEMA_VERSION,
			seq,
			created: new Date().toISOString(),
			question: question.toDict(),
			answer: result as unknown,
		};
		await this._appendTurnLine(turn);
		this.history.push(turn);
		await this._updateCatalogEntryForTurn(turn);

		return result;
	}

	/** Rename a chat. Mutates catalog only; `chat.jsonl` header is immutable. */
	async rename(title: string): Promise<void> {
		const trimmed = (title ?? '').trim() || 'Untitled chat';
		await this._mutateCatalog((catalog) => {
			const entry = catalog.chats.find((c) => c.guid === this.id);
			if (entry) {
				entry.title = trimmed;
				entry.updated = new Date().toISOString();
			}
			// If the entry doesn't exist yet (chat has no turns), rename is a no-op —
			// the title will be applied to the entry on first send via _updateCatalogEntryForTurn.
		});
	}

	/** Hard-delete the chat: remove catalog entry, then remove the directory recursively. */
	async delete(): Promise<void> {
		await this._mutateCatalog((catalog) => {
			catalog.chats = catalog.chats.filter((c) => c.guid !== this.id);
		});
		try {
			await this._client.fsRmdir(`${CHATS_ROOT}/${this.id}`, true);
		} catch (err) {
			// Best-effort. Orphan directory is recoverable by §5.5 rebuild.
			// Log so we can see WHY rmdir is failing during development.
			console.warn(`Chat.delete: fsRmdir failed for ${CHATS_ROOT}/${this.id}`, err);
		}
	}

	// =========================================================================
	// Internals
	// =========================================================================

	/** Append a single JSONL turn line by read-then-rewrite. */
	private async _appendTurnLine(turn: ChatTurn): Promise<void> {
		const path = `${CHATS_ROOT}/${this.id}/chat.jsonl`;
		const existing = await this._client.fsReadString(path);
		const tail = existing.endsWith('\n') ? '' : '\n';
		await this._client.fsWriteString(path, existing + tail + JSON.stringify(turn) + '\n');
	}

	private async _updateCatalogEntryForTurn(turn: ChatTurn): Promise<void> {
		const userText = extractQuestionText(turn.question);
		const preview = userText.slice(0, CATALOG_PREVIEW_LEN);

		await this._mutateCatalog((catalog) => {
			let entry = catalog.chats.find((c) => c.guid === this.id);
			if (!entry) {
				entry = {
					guid: this.id,
					title: 'Untitled chat',
					created: this.created,
					updated: turn.created,
					message_count: 0,
					preview: '',
					pipeline_id: this.pipelineId,
				};
				catalog.chats.push(entry);
			}
			entry.updated = turn.created;
			entry.message_count = (entry.message_count ?? 0) + 1;
			entry.preview = preview;
		});
	}

	/**
	 * Optimistic-version mutate-and-write on `catalog.json`.
	 * Read → mutate → write only if the on-disk `version` is still V; retry
	 * a bounded number of times, then throw.
	 */
	private async _mutateCatalog(mutator: (cat: ChatCatalog) => void): Promise<void> {
		await mutateCatalog(this._client, mutator);
	}
}

/**
 * `client.chats` namespace surface for listing the user's catalog.
 *
 * Implementation note: chat-aware callers like the chat-list UI invoke
 * `client.chats.list({pipelineId})`. Sort order is not guaranteed —
 * callers sort by `updated` descending themselves.
 */
export function makeChatsNamespace(client: RocketRideChatClient): {
	list: (opts?: { pipelineId?: string }) => Promise<ChatCatalogEntry[]>;
} {
	return {
		async list(opts?: { pipelineId?: string }): Promise<ChatCatalogEntry[]> {
			let cat: ChatCatalog | null;
			try {
				cat = await client.fsReadJson<ChatCatalog>(CATALOG_PATH);
			} catch {
				return [];
			}
			if (!cat || !Array.isArray(cat.chats)) return [];
			const entries = cat.chats;
			if (opts?.pipelineId) {
				return entries.filter((e) => e.pipeline_id === opts.pipelineId);
			}
			return entries.slice();
		},
	};
}

// ============================================================================
// Module-internal helpers
// ============================================================================

function newChatId(): string {
	const g = globalThis as { crypto?: { randomUUID?: () => string } };
	if (g.crypto?.randomUUID) return g.crypto.randomUUID();
	// Fallback for old runtimes — generate a v4 from Math.random. Good enough
	// for an id; the engine validates UUID format on receipt.
	const hex = (n: number) => n.toString(16).padStart(2, '0');
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const h = Array.from(bytes, hex).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Parse a chat.jsonl text blob. Tolerates trailing empty lines and partial-write tails. */
export function parseChatFile(raw: string): { header: ChatHeader | null; turns: ChatTurn[] } {
	let header: ChatHeader | null = null;
	const turns: ChatTurn[] = [];
	const lines = raw.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		let rec: ChatLine;
		try {
			rec = JSON.parse(line) as ChatLine;
		} catch {
			// Partial write on the last line — tolerate; at most we lose the trailing line.
			continue;
		}
		if (rec.type === 'header') {
			if (!header) header = rec;
			continue;
		}
		if (rec.type === 'turn') {
			turns.push(rec);
			continue;
		}
		// Unknown record type — skip with no error (forward-compat).
	}
	return { header, turns };
}

function extractQuestionText(questionDict: Record<string, unknown>): string {
	const qs = (questionDict?.questions as Array<{ text?: string }> | undefined) ?? [];
	if (qs.length === 0) return '';
	return String(qs[qs.length - 1]?.text ?? '');
}

/**
 * Extract a plain-text assistant rendering from a stored PIPELINE_RESULT.
 *
 * PIPELINE_RESULT shapes vary across pipeline outputs; this helper digs the
 * conventional places the chat node emits text. Mirrors the public
 * `extractTextFromResult` in `apps/chat-ui/src/hooks/useChatMessages.ts` but
 * stays local to the SDK so the SDK has no dependency on the UI app.
 */
export function extractAnswerText(answer: unknown): string {
	if (answer == null) return '';
	if (typeof answer === 'string') return answer;
	if (typeof answer !== 'object') return String(answer);
	const a = answer as Record<string, unknown>;
	// PIPELINE_RESULT.body is a likely carrier (chat node emits the Answer here).
	if (typeof a.body === 'string') return a.body;
	if (a.body && typeof a.body === 'object') {
		const b = a.body as Record<string, unknown>;
		if (typeof b.content === 'string') return b.content;
		if (typeof b.text === 'string') return b.text;
		if (typeof b.message === 'string') return b.message;
	}
	if (typeof a.content === 'string') return a.content;
	if (typeof a.text === 'string') return a.text;
	// Chat node returns { answers: string[], name, result_types, ... } — flatten the array.
	if (Array.isArray(a.answers)) {
		const parts = (a.answers as unknown[]).filter((x): x is string => typeof x === 'string');
		if (parts.length > 0) return parts.join('\n');
	}
	return '';
}

/**
 * Optimistic-version retry loop for `catalog.json`. Exposed at module scope
 * so future catalog-rebuild / maintenance code can reuse it without going
 * through a `Chat` instance.
 */
export async function mutateCatalog(client: RocketRideChatClient, mutator: (cat: ChatCatalog) => void): Promise<void> {
	for (let attempt = 1; attempt <= CATALOG_MAX_RETRY; attempt++) {
		const { catalog, observedVersion } = await readOrInitCatalog(client);
		mutator(catalog);
		catalog.version = observedVersion + 1;
		// Re-read just before writing to detect concurrent mutations between
		// our read and write. Not true CAS — the filestore has per-path write
		// locks but no compare-and-swap primitive — so collisions are still
		// possible. Bounded retry covers the realistic same-user-two-tab case.
		try {
			const fresh = await client.fsReadJson<ChatCatalog>(CATALOG_PATH);
			if ((fresh?.version ?? 0) !== observedVersion) {
				if (attempt === CATALOG_MAX_RETRY) throw new CatalogContentionError(attempt);
				await sleep(20 * attempt);
				continue;
			}
		} catch (err) {
			if (err instanceof CatalogContentionError) throw err;
			// catalog absent on second read — proceed; the write will create it.
		}
		try {
			await client.fsWriteJson(CATALOG_PATH, catalog);
			return;
		} catch (err) {
			// The filestore enforces a per-path write-lock — concurrent writers
			// hit "File already open for writing" before our version check sees
			// the conflict. Retry the read-modify-write cycle like a normal
			// version-contention case.
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('already open for writing') && attempt < CATALOG_MAX_RETRY) {
				await sleep(20 * attempt);
				continue;
			}
			throw err;
		}
	}
	throw new CatalogContentionError(CATALOG_MAX_RETRY);
}

async function readOrInitCatalog(client: RocketRideChatClient): Promise<{ catalog: ChatCatalog; observedVersion: number }> {
	try {
		const cat = await client.fsReadJson<ChatCatalog>(CATALOG_PATH);
		if (!cat || typeof cat !== 'object') {
			return {
				catalog: { schema_version: CATALOG_SCHEMA_VERSION, version: 0, chats: [] },
				observedVersion: 0,
			};
		}
		return {
			catalog: {
				schema_version: cat.schema_version ?? CATALOG_SCHEMA_VERSION,
				version: cat.version ?? 0,
				chats: Array.isArray(cat.chats) ? cat.chats : [],
			},
			observedVersion: cat.version ?? 0,
		};
	} catch {
		return {
			catalog: { schema_version: CATALOG_SCHEMA_VERSION, version: 0, chats: [] },
			observedVersion: 0,
		};
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}
