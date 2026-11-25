// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * One conversation: its messages, sending questions and files, and saving.
 *
 * Messages are the shell's ChatMessage rows. A question is a plain user
 * message; files are a user message whose body lists them (BODY_UPLOAD);
 * every answer is a bot message whose body carries its progress, thinking
 * and results (BODY_ANSWER). Bodies are plain JSON, so the conversation is
 * saved verbatim. The rows live in a ref that is always current, so a save
 * after a request settles writes exactly what is on screen.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ChatMessage, RocketRideClient } from 'shell';
import { clockTime, titleFromFiles, titleFromQuestion } from './friendly';
import { openConversation } from './history';
import type { AgentSession, AgentSessionMeta } from './history';
import { BODY_ANSWER, BODY_REFUSAL, BODY_UPLOAD } from './model';
import type { AgentInfo, AgentSource, AnswerBodyData, AnswerFile, RefusalBodyData, ResultBody, UploadBodyData, UploadFile } from './model';
import { plainTextOf } from './results';
import { FILE_CONCURRENCY, failureOf, runLimited, sendFile, sendTyped } from './send';
import type { HistoryTurn } from './send';
import { mediaNoun, mediaWords, takesFile } from './sources';

// =============================================================================
// TYPES
// =============================================================================

/** What the hook needs from its host. */
export interface UseConversationOptions {
	/** The realm's client, null while disconnected. */
	client: RocketRideClient | null;
	/** The agent, once read. */
	agent: AgentInfo | null;
	/** The connection's id (the agent's address as opened). */
	connectionId: string;
	/** The conversation to show, or null for a new one. */
	sessionId: string | null;
	/** Settings values by public name (Advanced), or undefined for the saved ones. */
	params?: Record<string, unknown>;
	/**
	 * Called after each save with the conversation's catalog row. The file is
	 * already written; the host commits the row (it owns the catalog).
	 */
	onSaved: (meta: AgentSessionMeta) => void;
}

/** What the hook gives its host. */
export interface ConversationApi {
	/** The rows to draw. */
	messages: ChatMessage[];
	/** True while the conversation loads. */
	loading: boolean;
	/** Why it could not load, if it could not. */
	loadError: string | null;
	/** The conversation's id (null until a new one is first saved). */
	savedId: string | null;
	/** Sends typed text. */
	sendText: (text: string) => void;
	/** Sends files (each on its own pipe). */
	sendFiles: (files: File[]) => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** The most thinking rows an answer keeps. */
const THINKING_MAX = 200;

/** The stand-in title of a conversation before its first request. */
const UNTITLED = 'New session';

// =============================================================================
// HELPERS
// =============================================================================

/** Monotonic message ids that never collide within one millisecond. */
let idCounter = 0;
function nextId(): number {
	idCounter = (idCounter + 1) % 1000;
	return Date.now() * 1000 + idCounter;
}

/**
 * A stored answer that was still running when the conversation was saved is
 * shown as interrupted: nothing is listening for it any more.
 *
 * @param messages - Rows as stored.
 * @returns Rows as shown.
 */
function settleStale(messages: ChatMessage[]): ChatMessage[] {
	return messages.map((m) => {
		if (m.body?.kind !== BODY_ANSWER) return m;
		const data = m.body.data as AnswerBodyData;
		return data?.state === 'running' ? { ...m, body: { ...m.body, data: { ...data, state: 'interrupted' } } } : m;
	});
}

/**
 * The sentence for files the source does not take ("Product Shots takes
 * images. invoice.pdf isn't an image, so it wasn't sent.").
 *
 * @param agent - The agent.
 * @param source - The connection's source.
 * @param names - The refused files.
 * @returns The sentence.
 */
function refusalSentence(agent: AgentInfo, source: AgentSource, names: string[]): string {
	const takes = mediaWords(source) || 'files';
	const noun = mediaNoun(source);
	if (names.length === 1) return `${agent.listing.name} takes ${takes}. ${names[0]} isn't ${noun}, so it wasn't sent.`;
	return `${agent.listing.name} takes ${takes}. ${names.length} of these files aren't, so they weren't sent.`;
}

/**
 * The earlier turns of a conversation, for a question's history: questions
 * as the caller's turns, answers' text as the agent's.
 *
 * @param messages - The conversation so far.
 * @returns The turns, oldest first.
 */
function historyOf(messages: ChatMessage[]): HistoryTurn[] {
	const turns: HistoryTurn[] = [];
	for (const m of messages) {
		if (m.sender === 'user' && !m.body) turns.push({ role: 'user', content: m.text });
		else if (m.sender === 'bot' && m.body?.kind === BODY_ANSWER) {
			const text = plainTextOf((m.body.data as AnswerBodyData)?.result);
			if (text) turns.push({ role: 'assistant', content: text });
		}
	}
	return turns;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Drives one conversation with one agent.
 *
 * @param options - {@link UseConversationOptions}.
 * @returns {@link ConversationApi}.
 */
export function useConversation(options: UseConversationOptions): ConversationApi {
	const { client, agent, connectionId, sessionId, params, onSaved } = options;

	// The rows are a ref (always current for saves) plus a render tick.
	const rowsRef = useRef<ChatMessage[]>([]);
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const sessionRef = useRef<AgentSession | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [savedId, setSavedId] = useState<string | null>(sessionId);

	// Latest props for callbacks that outlive a render.
	const latest = useRef({ client, agent, params, onSaved });
	latest.current = { client, agent, params, onSaved };

	// ── Rows ──────────────────────────────────────────────────────────────

	const setRows = useCallback((next: (rows: ChatMessage[]) => ChatMessage[]) => {
		rowsRef.current = next(rowsRef.current);
		rerender();
	}, []);

	const append = useCallback((...rows: ChatMessage[]) => setRows((cur) => [...cur, ...rows]), [setRows]);

	/** Rewrites one message's body data. */
	const updateBody = useCallback(
		<T>(id: number, mutate: (data: T) => T) => {
			setRows((cur) => cur.map((m) => (m.id === id && m.body ? { ...m, body: { ...m.body, data: mutate(m.body.data as T) } } : m)));
		},
		[setRows]
	);

	// ── Load ──────────────────────────────────────────────────────────────

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setLoadError(null);
		setSavedId(sessionId);
		rowsRef.current = [];
		rerender();
		openConversation(connectionId, sessionId)
			.then((session) => {
				if (cancelled) return;
				sessionRef.current = session;
				rowsRef.current = settleStale(session.messages);
				setLoading(false);
				rerender();
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setLoadError(failureOf(err).message);
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [connectionId, sessionId]);

	// ── Save ──────────────────────────────────────────────────────────────

	/** Writes the conversation file and hands its row to the host. */
	const save = useCallback(async (firstTitle: string) => {
		const session = sessionRef.current;
		if (!session) return;
		if (session.title === UNTITLED || !session.title) session.title = firstTitle;
		try {
			await session.save(rowsRef.current, { catalog: false });
			setSavedId(session.sessionId);
			latest.current.onSaved(session.meta());
		} catch (err) {
			console.log('[playground] save failed:', failureOf(err).message);
		}
	}, []);

	// ── Send typed text ────────────────────────────────────────────────────

	const sendText = useCallback(
		(text: string) => {
			const { client: c, agent: a, params: p } = latest.current;
			const source = a?.source;
			if (!c || !source?.typed || !text.trim()) return;

			const history = historyOf(rowsRef.current);
			const started = Date.now();
			const answerId = nextId();
			append({ id: nextId(), text, sender: 'user', timestamp: clockTime(started) }, { id: answerId, text: '', sender: 'bot', timestamp: clockTime(started), body: { kind: BODY_ANSWER, data: { state: 'running', startedAt: started, thinking: [] } satisfies AnswerBodyData } });

			void sendTyped(c, source.address, source.typed, text, history, p, {
				onThinking: (line) => updateBody<AnswerBodyData>(answerId, (d) => ({ ...d, thinking: [...d.thinking, line].slice(-THINKING_MAX) })),
			})
				.then((result: ResultBody) => {
					updateBody<AnswerBodyData>(answerId, (d) => ({ ...d, state: 'done', endedAt: Date.now(), result }));
					setRows((cur) => cur.map((m) => (m.id === answerId ? { ...m, text: plainTextOf(result) } : m)));
				})
				.catch((err: unknown) => {
					const failure = failureOf(err);
					updateBody<AnswerBodyData>(answerId, (d) => ({ ...d, state: 'failed', endedAt: Date.now(), error: failure.message, code: failure.code }));
				})
				.finally(() => void save(titleFromQuestion(text)));
		},
		[append, save, setRows, updateBody]
	);

	// ── Send files ─────────────────────────────────────────────────────────

	const sendFiles = useCallback(
		(files: File[]) => {
			const { client: c, agent: a, params: p } = latest.current;
			const source = a?.source;
			if (!c || !a || !source || files.length === 0) return;

			// step: the caller's bubble lists every file; ones the source does not take are refused
			const started = Date.now();
			const uploads: UploadFile[] = files.map((f) => {
				const mime = f.type || 'application/octet-stream';
				return takesFile(source, f.type) ? { name: f.name, size: f.size, mime, sent: 0, state: 'waiting' } : { name: f.name, size: f.size, mime, sent: 0, state: 'refused' };
			});
			// step: where each accepted file sits in the caller's bubble
			const acceptedAt: number[] = [];
			uploads.forEach((u, k) => {
				if (u.state !== 'refused') acceptedAt.push(k);
			});
			const accepted = acceptedAt.map((k) => files[k]);
			const refused = files.filter((_f, k) => uploads[k].state === 'refused');

			const uploadId = nextId();
			const answerId = nextId();
			const answerFiles: AnswerFile[] = accepted.map((f) => ({ name: f.name, state: 'waiting' }));
			append({ id: uploadId, text: titleFromFiles(files.map((f) => f.name)), sender: 'user', timestamp: clockTime(started), body: { kind: BODY_UPLOAD, data: { files: uploads } satisfies UploadBodyData } });

			// step: the refused files get one sentence of their own, never a pipe
			if (refused.length > 0) {
				const sentence = refusalSentence(
					a,
					source,
					refused.map((f) => f.name)
				);
				append({ id: nextId(), text: sentence, sender: 'bot', timestamp: clockTime(started), body: { kind: BODY_REFUSAL, data: { text: sentence } satisfies RefusalBodyData } });
			}
			if (accepted.length === 0) return;
			append({ id: answerId, text: '', sender: 'bot', timestamp: clockTime(started), body: { kind: BODY_ANSWER, wide: accepted.length > 1, data: { state: 'running', startedAt: started, thinking: [], files: answerFiles } satisfies AnswerBodyData } });

			// step: per-file updates in both bubbles
			const setUpload = (i: number, patch: Partial<UploadFile>) => {
				const at = acceptedAt[i];
				updateBody<UploadBodyData>(uploadId, (d) => ({ files: d.files.map((u, k) => (k === at ? { ...u, ...patch } : u)) }));
			};
			const setFile = (i: number, patch: Partial<AnswerFile>) => updateBody<AnswerBodyData>(answerId, (d) => ({ ...d, files: (d.files ?? []).map((f, k) => (k === i ? { ...f, ...patch } : f)) }));

			// step: at most five files in flight, each on its own pipe
			void runLimited(accepted, FILE_CONCURRENCY, async (file, i) => {
				setUpload(i, { state: 'uploading' });
				try {
					const result = await sendFile(c, source.address, file, p, {
						onOpened: () => setFile(i, { state: 'working' }),
						onProgress: (sent) => setUpload(i, { sent }),
						onThinking: (line) => {
							setFile(i, { latest: line });
							updateBody<AnswerBodyData>(answerId, (d) => ({ ...d, thinking: [...d.thinking, line].slice(-THINKING_MAX) }));
						},
					});
					setUpload(i, { state: 'done', sent: file.size });
					setFile(i, { state: 'done', result });
				} catch (err) {
					const failure = failureOf(err);
					setUpload(i, { state: 'failed', reason: failure.message });
					setFile(i, { state: 'failed', error: failure.message });
					updateBody<AnswerBodyData>(answerId, (d) => (d.code ? d : { ...d, code: failure.code }));
				}
			}).finally(() => {
				updateBody<AnswerBodyData>(answerId, (d) => ({ ...d, state: (d.files ?? []).every((f) => f.state === 'failed') ? 'failed' : 'done', endedAt: Date.now() }));
				void save(titleFromFiles(files.map((f) => f.name)));
			});
		},
		[append, save, updateBody]
	);

	return { messages: rowsRef.current, loading, loadError, savedId, sendText, sendFiles };
}
