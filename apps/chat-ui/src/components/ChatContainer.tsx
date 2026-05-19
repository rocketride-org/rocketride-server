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

import React, { useCallback, useState, useRef, useEffect } from 'react';
import { RocketRideClient, Chat } from 'rocketride';
import { useRocketRideClient } from '../hooks/useRocketRide';
import { useChatMessages } from '../hooks/useChatMessages';
import { ChatHeader } from './ChatHeader';
import { ChatMessages } from './ChatMessages';
import { ChatInput } from './ChatInput';
import { ChatList } from './ChatList';

interface ChatContainerProps {
	authToken: string | null;
	/** Stable pipeline identifier. Delivered alongside ?auth= when ?persist=1. */
	pipelineId?: string | null;
	/** True when the chat node has Persist sessions ON. */
	persistEnabled?: boolean;
}

export const ChatContainer: React.FC<ChatContainerProps> = ({ authToken, pipelineId, persistEnabled }) => {
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	const [connectionErrorMessage, setConnectionErrorMessage] = useState<string | null>(null);
	const connectionAttemptsRef = useRef<number>(0);
	const hasWelcomedRef = useRef(false);

	const { messages, isTyping, sendMessage, clearMessages, addSystemMessage, hydrateFromChat, setMessages } = useChatMessages();

	// Persistent-chat state: which chat is currently open, plus a refresh key
	// that bumps when something changes the on-disk catalog so the list re-reads.
	const [currentChat, setCurrentChat] = useState<Chat | null>(null);
	const [listRefreshKey, setListRefreshKey] = useState(0);

	// Handle connection established
	const handleConnected = useCallback(
		async (_client: RocketRideClient) => {
			connectionAttemptsRef.current = 0; // Reset on success
			setStatusMessage(null);
			setConnectionErrorMessage(null);

			// Show welcome message only once
			if (!hasWelcomedRef.current) {
				addSystemMessage("Hello! I'm your RocketRide assistant. How can I help you today?");
				hasWelcomedRef.current = true;
			}
		},
		[addSystemMessage]
	);

	// Handle disconnection (reason is the error message from connect failure or server)
	const handleDisconnected = useCallback(async (reason: string, hasError: boolean) => {
		connectionAttemptsRef.current++;
		// Store the last error from connect so we show the most recent failure; clear on successful connect
		setConnectionErrorMessage((prev) => (hasError ? reason || null : prev));
		if (connectionAttemptsRef.current < 5) {
			setStatusMessage(null); // No banner for first 4 attempts
		} else {
			setStatusMessage('CONNECTION_FAILED'); // Show detailed banner after 5 attempts
		}
	}, []);

	// Initialize connection
	const { isConnected, client } = useRocketRideClient(handleConnected, handleDisconnected, setStatusMessage);

	// When persistence is on, auto-open the most recent chat ONCE per chat-ui
	// session — so users land back in their last conversation after a window
	// close/refresh.  Gated by a ref so subsequent transitions to currentChat=null
	// (e.g. clicking "New chat") don't immediately re-open the old chat.
	const autoResumeAttemptedRef = useRef(false);
	useEffect(() => {
		if (!persistEnabled || !client || !pipelineId || !authToken) return;
		if (autoResumeAttemptedRef.current) return;
		autoResumeAttemptedRef.current = true;
		let cancelled = false;
		(async () => {
			try {
				const list = await client.chats.list({ pipelineId });
				if (cancelled || list.length === 0) return;
				list.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
				const recent = list[0];
				if (!recent) return;
				const chat = await Chat.open({ client, token: authToken, chatId: recent.guid });
				if (cancelled) return;
				setCurrentChat(chat);
				hydrateFromChat(chat);
			} catch (err) {
				console.warn('ChatContainer: failed to auto-open most recent chat', err);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [persistEnabled, client, pipelineId, authToken, hydrateFromChat]);

	const handleSelectChat = useCallback(
		async (chatId: string) => {
			if (!client || !authToken) return;
			try {
				const chat = await Chat.open({ client, token: authToken, chatId });
				setCurrentChat(chat);
				hydrateFromChat(chat);
			} catch (err) {
				console.warn('ChatContainer: failed to open chat', chatId, err);
			}
		},
		[client, authToken, hydrateFromChat]
	);

	const handleNewChat = useCallback(() => {
		// Defer creating the on-disk chat until the first send (TDD §7.1).
		setCurrentChat(null);
		setMessages([]);
		hasWelcomedRef.current = false;
		addSystemMessage("Hello! I'm your RocketRide assistant. How can I help you today?");
		hasWelcomedRef.current = true;
	}, [addSystemMessage, setMessages]);

	const handleRenameChat = useCallback(
		async (chatId: string, title: string) => {
			if (!client || !authToken) return;
			try {
				const target = currentChat?.id === chatId ? currentChat : await Chat.open({ client, token: authToken, chatId });
				await target.rename(title);
				setListRefreshKey((k) => k + 1);
			} catch (err) {
				console.warn('ChatContainer: rename failed', err);
			}
		},
		[client, authToken, currentChat]
	);

	const handleDeleteChat = useCallback(
		async (chatId: string) => {
			if (!client || !authToken) return;
			try {
				const target = currentChat?.id === chatId ? currentChat : await Chat.open({ client, token: authToken, chatId });
				await target.delete();
				if (currentChat?.id === chatId) {
					setCurrentChat(null);
					setMessages([]);
				}
				setListRefreshKey((k) => k + 1);
			} catch (err) {
				console.warn('ChatContainer: delete failed', err);
			}
		},
		[client, authToken, currentChat, setMessages]
	);

	// Send message handler — creates a Chat lazily when persistence is on.
	const handleSendMessage = useCallback(
		async (text: string) => {
			if (!client || !authToken) {
				addSystemMessage('Not connected. Please wait...');
				return;
			}
			let chat = currentChat;
			if (persistEnabled && pipelineId && !chat) {
				try {
					chat = await Chat.create({ client, token: authToken, pipelineId });
					setCurrentChat(chat);
				} catch (err) {
					console.warn('ChatContainer: Chat.create failed; falling back to non-persistent send', err);
					chat = null;
				}
			}
			await sendMessage(text, client, authToken, chat);
			if (chat) setListRefreshKey((k) => k + 1);
		},
		[client, authToken, sendMessage, addSystemMessage, persistEnabled, pipelineId, currentChat]
	);

	const handleClearChat = useCallback(() => {
		clearMessages();
		// When persistence is on, "clear" should start a fresh chat, not nuke the prior on-disk turns.
		if (persistEnabled) setCurrentChat(null);
	}, [clearMessages, persistEnabled]);

	// Show error panel when disconnected and we have an error (after 5 attempts) or a specific error message (e.g. auth failed)
	if (!isConnected && (statusMessage === 'CONNECTION_FAILED' || connectionErrorMessage)) {
		return (
			<div className="chatbot-container">
				<ChatHeader isConnected={isConnected} onClearChat={handleClearChat} />
				<div className="messages-container">
					<div className="messages-content">
						<div className="connection-error-panel">
							<div className="connection-error-icon">⚠️</div>
							<h2 className="connection-error-title">Having Trouble Connecting</h2>
							{connectionErrorMessage && <p className="connection-error-message">{connectionErrorMessage}</p>}
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

	const showSidebar = !!(persistEnabled && pipelineId && client);

	return (
		<div className="chatbot-container" style={showSidebar ? { display: 'flex', flexDirection: 'row' } : undefined}>
			{showSidebar && <ChatList client={client!} pipelineId={pipelineId!} currentChatId={currentChat?.id ?? null} onSelectChat={handleSelectChat} onNewChat={handleNewChat} onDeleteChat={handleDeleteChat} onRenameChat={handleRenameChat} refreshKey={listRefreshKey} />}
			<div style={showSidebar ? { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } : undefined}>
				<ChatHeader isConnected={isConnected} onClearChat={handleClearChat} />
				<ChatMessages messages={messages} isTyping={isTyping} statusMessage={statusMessage} />
				<ChatInput onSend={handleSendMessage} disabled={!isConnected} />
			</div>
		</div>
	);
};
