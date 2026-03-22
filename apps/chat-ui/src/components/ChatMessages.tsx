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

import React, { useEffect, useRef, useMemo, useState } from 'react';
import { Message as MessageType } from '../types/chat.types';
import { Message } from './Message';
import { TypingIndicator } from './TypingIndicator';

interface ChatMessagesProps {
	messages: MessageType[];
	isTyping: boolean;
	statusMessage?: string | null;
}

type RenderItem = { kind: 'message'; message: MessageType } | { kind: 'thinking-group'; id: number; messages: MessageType[] };

const ThinkingGroup: React.FC<{ messages: MessageType[] }> = ({ messages }) => {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<div className="thinking-group">
			<button className="thinking-header" onClick={() => setIsOpen((o) => !o)}>
				<span className={`thinking-chevron${isOpen ? ' open' : ''}`} />
				<span className="thinking-label">Thinking...</span>
			</button>
			{isOpen && (
				<div className="thinking-messages">
					{messages.map((msg) => (
						<div key={msg.id} className="message-status">
							<span className="message-status-dot" />
							<span className="message-status-text">{msg.text}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
};

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

	const renderItems = useMemo((): RenderItem[] => {
		const items: RenderItem[] = [];
		let currentGroup: MessageType[] | null = null;

		for (const msg of messages) {
			if (msg.sender === 'status' && msg.sseType === 'thinking') {
				if (!currentGroup) {
					currentGroup = [];
					items.push({ kind: 'thinking-group', id: msg.id, messages: currentGroup });
				}
				currentGroup.push(msg);
			} else {
				currentGroup = null;
				items.push({ kind: 'message', message: msg });
			}
		}
		return items;
	}, [messages]);

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
		<div className="messages-container" role="log" aria-live="polite" aria-label="Chat messages">
			<div className="messages-content">
				{renderItems.map((item) => (item.kind === 'thinking-group' ? <ThinkingGroup key={`tg-${item.id}`} messages={item.messages} /> : <Message key={item.message.id} message={item.message} />))}

				{statusMessage && (
					<Message
						message={{
							id: -1,
							text: statusMessage,
							sender: 'bot',
							timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
						}}
					/>
				)}

				{isTyping && <TypingIndicator />}

				<div ref={messagesEndRef} />
			</div>
		</div>
	);
};
