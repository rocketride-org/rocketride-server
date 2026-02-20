/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
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

import React, { useEffect, useRef } from 'react';
import { Message as MessageType } from '../types/chat.types';
import { Message } from './Message';
import { TypingIndicator } from './TypingIndicator';

interface ChatMessagesProps {
	messages: MessageType[];
	isTyping: boolean;
	statusMessage?: string | null;
}

/**
 * Message history container with auto-scrolling
 * 
 * Displays all messages in chronological order and automatically
 * scrolls to show the latest message when new ones arrive.
 * Shows typing indicator when bot is composing a response.
 * Shows transient status messages (connection issues) that don't persist in history.
 * 
 * @param messages - Array of messages to display
 * @param isTyping - Whether bot is currently typing
 * @param statusMessage - Transient status message (null to hide)
 */
export const ChatMessages: React.FC<ChatMessagesProps> = ({ messages, isTyping, statusMessage }) => {
	const messagesEndRef = useRef<HTMLDivElement>(null);

	/**
	 * Auto-scroll to bottom when new messages arrive or status changes
	 * 
	 * Ensures the latest message is always visible by smoothly scrolling
	 * to the bottom of the message container.
	 */
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, statusMessage]);

	return (
		<div className="messages-container">
			<div className="messages-content">
				{messages.map((message) => (
					<Message key={message.id} message={message} />
				))}

				{statusMessage && (
					<Message
						message={{
							id: -1,
							text: statusMessage,
							sender: 'bot',
							timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
						}}
					/>
				)}

				{isTyping && <TypingIndicator />}

				<div ref={messagesEndRef} />
			</div>
		</div>
	);
};
