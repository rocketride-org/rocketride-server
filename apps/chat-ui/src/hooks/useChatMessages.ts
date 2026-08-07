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

import { useState, useCallback } from 'react';
import { Question, QuestionType, PIPELINE_RESULT } from 'rocketride';
import { Message } from '../types/chat.types';
import { extractTextFromResult } from '../utils/pipelineUtils';

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
	): Promise<ReturnType<typeof extractTextFromResult>> => {
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

			// Extract text responses from result
			const textResponses = extractTextFromResult(result);

			return textResponses.length > 0 ? textResponses : [{ text: 'No valid response received', key: '' }];

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
			const answers = await sendMessageToAPI(text, client, authToken);

			// Add bot response(s) to chat
			const botResponses: Message[] = answers.map((answer, index) => ({
				id: Date.now() + index + 1,
				text: answer.text,
				sender: 'bot' as const,
				timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
				...(answer.key ? { resultKey: answer.key } : {})
			}));

			setMessages(prev => [...prev, ...botResponses]);
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
