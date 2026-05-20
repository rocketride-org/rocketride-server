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

import React, { useState, useEffect } from 'react';
import { Message as MessageType } from '../types/chat.types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageProps {
	message: MessageType;
}

// Collapsible "Thinking" panel for streamed reasoning; auto-collapses when the answer starts.
const ReasoningPanel: React.FC<{ reasoning: string; streaming?: boolean; hasContent: boolean }> = ({
	reasoning,
	streaming,
	hasContent,
}) => {
	const [isOpen, setIsOpen] = useState(true);
	const [userToggled, setUserToggled] = useState(false);

	useEffect(() => {
		if (userToggled) return;
		if (!streaming && hasContent) setIsOpen(false);
	}, [streaming, hasContent, userToggled]);

	return (
		<div className="thinking-group reasoning-panel">
			<button
				className="thinking-header"
				onClick={() => { setUserToggled(true); setIsOpen(o => !o); }}
			>
				<span className={`thinking-chevron${isOpen ? ' open' : ''}`} />
				<span className="thinking-label">{streaming ? 'Thinking…' : 'Thought process'}</span>
			</button>
			{isOpen && (
				<div className="thinking-messages reasoning-content">
					<MarkdownRenderer content={reasoning} />
				</div>
			)}
		</div>
	);
};

/**
 * Individual message bubble component
 *
 * Displays a single message with appropriate styling based on sender.
 * Bot messages use markdown rendering, user messages display as plain text.
 *
 * @param message - Message data to display
 */
export const Message: React.FC<MessageProps> = ({ message }) => {
	if (message.sender === 'status') {
		return (
			<div className="message-status">
				<span className="message-status-dot" />
				<span className="message-status-text">{message.text}</span>
			</div>
		);
	}

	if (message.sender === 'bot' || message.sender === 'system') {
		const hasChart = message.text.includes('```chartjs');
		const hasReasoning = !!(message.reasoning && message.reasoning.length > 0);
		return (
			<div className="message-wrapper bot">
				<div className={`message-bubble bot${hasChart ? ' has-chart' : ''}`}>
					{hasReasoning && (
						<ReasoningPanel
							reasoning={message.reasoning!}
							streaming={!!message.reasoningStreaming}
							hasContent={message.text.length > 0}
						/>
					)}
					<div className="markdown-content">
						<MarkdownRenderer content={message.text} />
					</div>
					<div className="message-timestamp">
						{message.timestamp}
						{message.resultKey && <span className="message-result-key">{message.resultKey}</span>}
					</div>
				</div>
			</div>
		);
	}

	// User message
	return (
		<div className="message-wrapper user">
			<div className="message-bubble user">
				<div className="user-bubble-content">
					<p>{message.text}</p>
				</div>
				<div className="message-timestamp">
					{message.timestamp}
				</div>
			</div>
		</div>
	);
};
