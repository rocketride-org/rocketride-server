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

import React from 'react';
import { User } from 'lucide-react';
import { Message as MessageType } from '../types/chat.types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageProps {
	message: MessageType;
}

/**
 * Individual message bubble component
 * 
 * Displays a single message with appropriate styling based on sender.
 * Bot messages use markdown rendering, user messages display as plain text.
 * 
 * @param message - Message data to display
 */
export const Message: React.FC<MessageProps> = ({ message }) => {
	if (message.sender === 'bot') {
		return (
			<div className="message-wrapper bot">
				<div className="message-bubble bot">
					<div className="markdown-content">
						<MarkdownRenderer content={message.text} />
					</div>
					<div className="message-timestamp">
						{message.timestamp}
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
					<div className="user-avatar-inline">
						<User className="w-4 h-4" />
					</div>
					<div className="user-text">
						<p>{message.text}</p>
					</div>
				</div>
				<div className="message-timestamp">
					{message.timestamp}
				</div>
			</div>
		</div>
	);
};