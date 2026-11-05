// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { useState, useCallback, useRef } from 'react';
import { Question, QuestionType, type PIPELINE_RESULT } from 'rocketride';
import type { ChatMessage, TextResult, UseChatMessagesOptions } from '../types';
import { extractTextFromResult } from '../utils/pipelineUtils';

// Module-level monotonic counter — guarantees unique IDs even when multiple
// messages are created within the same millisecond (e.g. batched SSE updates).
let _nextId = 1;
const nextId = () => _nextId++;

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
export function useChatMessages({ welcomeMessage, initialMessages }: UseChatMessagesOptions = {}): UseChatMessagesReturn {
	const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
	const [isTyping, setIsTyping] = useState(false);

	const messagesRef = useRef<ChatMessage[]>(initialMessages ?? []);

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
						// Flag so MessageBubble renders this failure as an in-thread error Banner.
						isError: true,
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
