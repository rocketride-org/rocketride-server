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

import { useState, useCallback, useRef } from 'react';
import { Question, QuestionType } from 'rocketride';
import type { PIPELINE_RESULT } from 'rocketride';
import { Message } from '../types/chat.types';
import { extractTextFromResult, extractMediaFromResult } from '../utils/pipelineUtils';

/**
 * Custom hook for managing chat message state and API communication
 *
 * Handles:
 * - Message history management
 * - Sending messages to RocketRide AI
 * - Processing API responses
 * - Typing indicators
 * - System messages (connection status, errors)
 * 
 * @returns Message state and control functions
 */
export const useChatMessages = () => {
	const [messages, setMessages] = useState<Message[]>([]);

	/** Artifact paths already rendered from an SSE announcement. */
	const announcedPaths = useRef(new Set<string>());
	const [isTyping, setIsTyping] = useState(false);

	/**
	 * Sends user message to RocketRide AI and processes response
	 * 
	 * Process:
	 * 1. Validates connection state
	 * 2. Builds Question object with user message
	 * 3. Adds conversation history for context (last 6 messages)
	 * 4. Sends to RocketRide via SDK
	 * 5. Extracts and returns text responses
	 * 
	 * @param userMessage - User's message text
	 * @param client - RocketRideClient instance
	 * @param authToken - Auth token for pipeline operations
	 * @returns Array of formatted response strings
	 * @throws Error if not connected or API request fails
	 */
	const sendMessageToAPI = useCallback(async (
		userMessage: string,
		client: any,
		authToken: string
	): Promise<{ answers: ReturnType<typeof extractTextFromResult>; media: ReturnType<typeof extractMediaFromResult> }> => {
		try {
			if (!client || !authToken) {
				throw new Error('Not connected to RocketRide. Please refresh the page.');
			}

			// Build question with conversation history for context
			const question = new Question({
				type: QuestionType.PROMPT,
				expectJson: false
			});

			question.addQuestion(userMessage);

			// Include last 6 messages for context - helps AI maintain conversation flow
			// Filter out system/status messages (UI-only) to avoid priming the LLM
			messages.filter(msg => msg.sender !== 'system' && msg.sender !== 'status').slice(-6).forEach(msg => {
				question.addHistory({
					role: msg.sender === 'user' ? 'user' : 'assistant',
					content: msg.text
				});
			});

			// Send to RocketRide; onSSE adds real-time status messages to the chat
			const result: PIPELINE_RESULT = await client.chat({
				token: authToken,
				question: question,
				onSSE: async (type: string, data: Record<string, unknown>) => {
					// The response node announces the artifact before its first byte exists.
					if (type === 'artifact_path' && typeof data.path === 'string') {
						announcedPaths.current.add(data.path);
						const whepUrl = data.live === true && typeof data.url === 'string' ? data.url : undefined;
						setMessages(prev => [...prev, {
							id: Date.now(),
							text: '',
							sender: 'bot',
							timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
							filePath: data.path as string,
							mediaMime: typeof data.mime_type === 'string' ? data.mime_type : undefined,
							mediaName: typeof data.name === 'string' ? data.name : undefined,
							whepUrl
						}]);
						return;
					}

					const text = data.message as string | undefined;
					if (text) {
						setMessages(prev => [...prev, {
							id: Date.now(),
							text,
							sender: 'status',
							sseType: type,
							timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
						}]);
					}
				}
			});

			// The result names every artifact. SSE may have announced some of them
			// already; the caller drops those and renders the rest.
			const media = extractMediaFromResult(result);

			// Extract text responses from result
			const textResponses = extractTextFromResult(result);
			const answers = textResponses.length > 0 || media.length > 0
				? textResponses
				: [{ text: 'No valid response received', key: '' }];

			return { answers, media };

		} catch (error) {
			console.error('Error sending message via SDK:', error);
			throw error;
		}
	}, [messages]);

	/**
	 * Sends a message and updates the chat history
	 * 
	 * @param text - Message text to send
	 * @param client - RocketRideClient instance
	 * @param authToken - Auth token for pipeline operations
	 * @returns Promise that resolves when message is sent and response received
	 */
	const sendMessage = useCallback(async (
		text: string,
		client: any,
		authToken: string
	): Promise<void> => {
		if (!text.trim()) return;

		// Add user message to chat
		const userMessage: Message = {
			id: Date.now(),
			text,
			sender: 'user',
			timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		};

		setMessages(prev => [...prev, userMessage]);
		setIsTyping(true);

		try {
			// Send to API and get response using authToken
			const { answers, media } = await sendMessageToAPI(text, client, authToken);

			const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			const botResponses: Message[] = answers.map((answer, index) => ({
				id: Date.now() + index + 1,
				text: answer.text,
				sender: 'bot' as const,
				timestamp,
				...(answer.key ? { resultKey: answer.key } : {})
			}));

			// The announcement bus is lossy; the result is not. Render whatever SSE
			// never delivered — a dropped event must not cost the user their media.
			const mediaResponses: Message[] = media
				.filter(item => item.url || (item.path && !announcedPaths.current.has(item.path)))
				.map((item, index) => ({
					id: Date.now() + answers.length + index + 1,
					text: '',
					sender: 'bot' as const,
					timestamp,
					...(item.url ? { mediaUrl: item.url } : { filePath: item.path as string }),
					mediaMime: item.mime,
					mediaName: item.name
				}));

			setMessages(prev => [...prev, ...botResponses, ...mediaResponses]);
		} catch (error) {
			// Show error message in chat
			const errorMessage: Message = {
				id: Date.now() + 1,
				text: error instanceof Error ? error.message : 'Sorry, I encountered an unexpected error. Please try again.',
				sender: 'bot',
				timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			};

			setMessages(prev => [...prev, errorMessage]);
		} finally {
			setIsTyping(false);
		}
	}, [sendMessageToAPI]);

	/**
	 * Adds a system message to the chat
	 * 
	 * Used for connection status updates, errors, and other system notifications.
	 * 
	 * @param text - System message text to display
	 */
	const addSystemMessage = useCallback((text: string) => {
		const systemMessage: Message = {
			id: Date.now(),
			text,
			sender: 'system',
			timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		};
		setMessages(prev => [...prev, systemMessage]);
	}, []);

	/**
	 * Clears all messages and resets to initial state
	 */
	const clearMessages = useCallback(() => {
		// Reset the announced-path set too: it lives for the hook's lifetime, so without this a
		// later run that reuses a fixed output path (e.g. outputs/response.mp3) would have its
		// artifact filtered out of the result-side reconciliation as "already announced".
		announcedPaths.current.clear();
		setMessages([
			{
				id: Date.now(),
				text: "Chat cleared! I'm your RocketRide assistant. How can I help you today?",
				sender: 'system',
				timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			}
		]);
	}, []);

	return {
		messages,
		isTyping,
		sendMessage,
		clearMessages,
		addSystemMessage
	};
};
