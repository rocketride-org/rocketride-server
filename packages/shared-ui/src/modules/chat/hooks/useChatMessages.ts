// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { useState, useCallback, useRef } from 'react';
import { Question, QuestionType, PIPELINE_RESULT } from 'rocketride';
import type { ChatMessage, TextResult, UseChatMessagesOptions } from '../types';

// Module-level monotonic counter — guarantees unique IDs even when multiple
// messages are created within the same millisecond (e.g. batched SSE updates).
let _nextId = 1;
const nextId = () => _nextId++;

// =============================================================================
// extractTextFromResult
// =============================================================================

/**
 * Extracts displayable text responses from a RocketRide pipeline result.
 * Handles the dynamic field system where result_types maps field names to types.
 */
function extractTextFromResult(result: PIPELINE_RESULT): TextResult[] {
	const out: TextResult[] = [];

	if (!result.result_types) {
		out.push({ text: '### No answers found\nAre you sure your pipeline returns them?', key: '' });
		return out;
	}

	for (const [field, type] of Object.entries(result.result_types)) {
		if (type !== 'text' && type !== 'answers') continue;
		const data = result[field];

		if (Array.isArray(data)) {
			data.filter((v) => typeof v === 'string' && v.trim()).forEach((v) => out.push({ text: v, key: field }));
		} else if (typeof data === 'string' && data.trim()) {
			out.push({ text: data, key: field });
		} else if (data !== null && typeof data === 'object' && typeof (data as Record<string, unknown>).answer === 'string') {
			const text = ((data as Record<string, unknown>).answer as string).trim();
			if (text) out.push({ text, key: field });
		}
	}

	return out;
}

// =============================================================================
// useChatMessages
// =============================================================================

export interface UseChatMessagesReturn {
	messages: ChatMessage[];
	isTyping: boolean;
	sendMessage: (text: string, client: any, authToken: string) => Promise<void>;
	clearMessages: () => void;
	addSystemMessage: (text: string) => void;
}

/**
 * Manages chat message state and RocketRide API communication.
 *
 * IMPORTANT: always use the internal updateMessages helper — never call
 * setMessages directly. Direct setMessages calls bypass the messagesRef
 * sync and will cause sendMessage to build history from a stale snapshot.
 */
export function useChatMessages({ welcomeMessage }: UseChatMessagesOptions = {}): UseChatMessagesReturn {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [isTyping, setIsTyping] = useState(false);

	const messagesRef = useRef<ChatMessage[]>([]);

	const updateMessages = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
		setMessages((prev) => {
			const next = updater(prev);
			messagesRef.current = next;
			return next;
		});
	}, []);

	const ts = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

	const sendMessageToAPI = useCallback(
		async (userMessage: string, client: any, authToken: string): Promise<TextResult[]> => {
			if (!client || !authToken) throw new Error('Not connected. Please refresh the page.');

			const question = new Question({ type: QuestionType.PROMPT, expectJson: false });
			question.addQuestion(userMessage);

			// Use ref so history is always built from the latest messages
			messagesRef.current
				.filter((m) => m.sender !== 'system' && m.sender !== 'status')
				.slice(-6)
				.forEach((m) =>
					question.addHistory({
						role: m.sender === 'user' ? 'user' : 'assistant',
						content: m.text,
					})
				);

			// SSE streaming contract: chunk / reasoning_chunk / chunk_end (#752).
			let streamingId: number | null = null;
			const lastSeq = new Map<string, number>();
			const lastReasoningSeq = new Map<string, number>();

			const acceptSeq = (m: Map<string, number>, data: Record<string, unknown>): boolean => {
				const seq = typeof data.seq === 'number' ? data.seq : undefined;
				if (seq === undefined) return true;
				const key = `${String(data.runId ?? '')}:${String(data.nodeId ?? '')}`;
				const prev = m.get(key);
				if (prev !== undefined && seq <= prev) return false;
				m.set(key, seq);
				return true;
			};

			const ensureBubble = (initial: Partial<ChatMessage> = {}): { id: number; created: boolean } => {
				if (streamingId !== null) return { id: streamingId, created: false };
				streamingId = nextId();
				const id = streamingId;
				updateMessages((prev) => [
					...prev,
					{ id, text: '', sender: 'bot', timestamp: ts(), ...initial },
				]);
				return { id, created: true };
			};

			const result: PIPELINE_RESULT = await client.chat({
				token: authToken,
				question,
				onSSE: async (type: string, data: Record<string, unknown>) => {
					if (type === 'chunk') {
						const delta = data.text as string | undefined;
						if (!delta || !acceptSeq(lastSeq, data)) return;
						const { id, created } = ensureBubble({ text: delta });
						if (created) return;  // bubble was just seeded with this delta
						updateMessages((prev) =>
							prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m))
						);
						return;
					}
					if (type === 'reasoning_chunk') {
						const delta = data.text as string | undefined;
						if (!delta || !acceptSeq(lastReasoningSeq, data)) return;
						const { id, created } = ensureBubble({ reasoning: delta, reasoningStreaming: true });
						if (created) return;  // bubble was just seeded with this reasoning delta
						updateMessages((prev) =>
							prev.map((m) =>
								m.id === id
									? { ...m, reasoning: (m.reasoning ?? '') + delta, reasoningStreaming: true }
									: m
							)
						);
						return;
					}
					if (type === 'reasoning_end') {
						if (streamingId !== null) {
							const id = streamingId;
							updateMessages((prev) =>
								prev.map((m) => (m.id === id ? { ...m, reasoningStreaming: false } : m))
							);
						}
						return;
					}
					if (type === 'chunk_end') {
						const reason = data.finishReason as string | null | undefined;
						if (reason && reason !== 'stop' && streamingId !== null) {
							const id = streamingId;
							const note =
								reason === 'length'
									? '\n\n_[response truncated by max_tokens]_'
									: `\n\n_[stream ended: ${reason}]_`;
							updateMessages((prev) =>
								prev.map((m) => (m.id === id ? { ...m, text: m.text + note } : m))
							);
						}
						return;
					}
					const text = typeof data.message === 'string' ? data.message : undefined;
					if (text) {
						updateMessages((prev) => [
							...prev,
							{
								id: nextId(),
								text,
								sender: 'status',
								sseType: type,
								timestamp: ts(),
							},
						]);
					}
				},
			});

			if (streamingId !== null) return [];

			const responses = extractTextFromResult(result);
			return responses.length > 0 ? responses : [{ text: 'No valid response received', key: '' }];
		},
		[updateMessages]
	);

	const sendMessage = useCallback(
		async (text: string, client: any, authToken: string) => {
			if (!text.trim()) return;

			updateMessages((prev) => [...prev, { id: nextId(), text, sender: 'user', timestamp: ts() }]);
			setIsTyping(true);

			try {
				const answers = await sendMessageToAPI(text, client, authToken);
				const botMsgs: ChatMessage[] = answers.map((a) => ({
					id: nextId(),
					text: a.text,
					sender: 'bot' as const,
					timestamp: ts(),
					...(a.key ? { resultKey: a.key } : {}),
				}));
				updateMessages((prev) => [...prev, ...botMsgs]);
			} catch (err) {
				updateMessages((prev) => [
					...prev,
					{
						id: nextId(),
						text: err instanceof Error ? err.message : 'An unexpected error occurred. Please try again.',
						sender: 'bot',
						timestamp: ts(),
					},
				]);
			} finally {
				setIsTyping(false);
			}
		},
		[sendMessageToAPI, updateMessages]
	);

	const addSystemMessage = useCallback(
		(text: string) => {
			updateMessages((prev) => [...prev, { id: nextId(), text, sender: 'system', timestamp: ts() }]);
		},
		[updateMessages]
	);

	const clearMessages = useCallback(() => {
		const text = welcomeMessage ?? 'Chat cleared. How can I help you?';
		updateMessages(() => [{ id: nextId(), text, sender: 'system', timestamp: ts() }]);
	}, [welcomeMessage, updateMessages]);

	return { messages, isTyping, sendMessage, clearMessages, addSystemMessage };
}
