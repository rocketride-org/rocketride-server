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

import React, { useCallback, useState, useRef } from 'react';
import { RocketRideClient } from 'rocketride';
import { useRocketRideClient } from '../hooks/useRocketRide';
import { useChatMessages } from '../hooks/useChatMessages';
import { ChatHeader } from './ChatHeader';
import { ChatMessages } from './ChatMessages';
import { ChatInput } from './ChatInput';

export const ChatContainer: React.FC<{ authToken: string | null }> = ({ authToken }) => {
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	const [connectionErrorMessage, setConnectionErrorMessage] = useState<string | null>(null);
	const connectionAttemptsRef = useRef<number>(0);
	const hasWelcomedRef = useRef(false);

	const { messages, isTyping, sendMessage, clearMessages, addSystemMessage } = useChatMessages();

	// Handle connection established
	const handleConnected = useCallback(async (_client: RocketRideClient) => {
		connectionAttemptsRef.current = 0; // Reset on success
		setStatusMessage(null);
		setConnectionErrorMessage(null);

		// Show welcome message only once
		if (!hasWelcomedRef.current) {
			addSystemMessage("Hello! I'm your RocketRide assistant. How can I help you today?");
			hasWelcomedRef.current = true;
		}
	}, [addSystemMessage]);

	// Handle disconnection (reason is the error message from connect failure or server)
	const handleDisconnected = useCallback(async (reason: string, hasError: boolean) => {
		connectionAttemptsRef.current++;
		// Store the last error from connect so we show the most recent failure; clear on successful connect
		setConnectionErrorMessage((prev) => (hasError ? (reason || null) : prev));
		if (connectionAttemptsRef.current < 5) {
			setStatusMessage(null); // No banner for first 4 attempts
		} else {
			setStatusMessage('CONNECTION_FAILED'); // Show detailed banner after 5 attempts
		}
	}, []);

	// Initialize connection
	const { isConnected, client } = useRocketRideClient(
		handleConnected,
		handleDisconnected,
		setStatusMessage
	);

	// Send message handler - uses authToken instead of pipelineToken
	const handleSendMessage = useCallback(async (text: string) => {
		if (!client || !authToken) {
			addSystemMessage('Not connected. Please wait...');
			return;
		}
		await sendMessage(text, client, authToken);
	}, [client, authToken, sendMessage, addSystemMessage]);

	// Show error panel when disconnected and we have an error (after 5 attempts) or a specific error message (e.g. auth failed)
	if (!isConnected && (statusMessage === 'CONNECTION_FAILED' || connectionErrorMessage)) {
		return (
			<div className="chatbot-container">
				<ChatHeader isConnected={isConnected} onClearChat={clearMessages} />
				<div className="messages-container">
					<div className="messages-content">
						<div className="connection-error-panel">
							<div className="connection-error-icon">⚠️</div>
							<h2 className="connection-error-title">Having Trouble Connecting</h2>
							{connectionErrorMessage && (
								<p className="connection-error-message">{connectionErrorMessage}</p>
							)}
							<p className="connection-error-subtitle">We can't reach your pipeline. Here's what to check:</p>
							<div className="connection-error-checklist">
								<div className="connection-error-item">
									<span className="connection-error-bullet">✓</span>
									<span className="connection-error-text">Make sure your pipeline is running</span>
								</div>
								<div className="connection-error-item">
									<span className="connection-error-bullet">✓</span>
									<span className="connection-error-text">Verify you are authorized to use this pipeline</span>
								</div>
								<div className="connection-error-item">
									<span className="connection-error-bullet">✓</span>
									<span className="connection-error-text">Check that your server is running and reachable</span>
								</div>
							</div>
							<p className="connection-error-footer">We'll keep trying to connect automatically...</p>
						</div>
					</div>
				</div>
				<ChatInput onSend={handleSendMessage} disabled={true} />
			</div>
		);
	}

	return (
		<div className="chatbot-container">
			<ChatHeader isConnected={isConnected} onClearChat={clearMessages} />
			<ChatMessages messages={messages} isTyping={isTyping} statusMessage={statusMessage} />
			<ChatInput onSend={handleSendMessage} disabled={!isConnected} />
		</div>
	);
};
