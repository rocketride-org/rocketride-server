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

			const result: PIPELINE_RESULT = await client.chat({
				token: authToken,
				question,
				onSSE: async (type: string, data: Record<string, unknown>) => {
					const text = data.message as string | undefined;
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
