// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// APARAVI APP — Full-screen chat for Aparavi AQL queries
// =============================================================================
//
// On connect, starts the Aparavi pipeline via client.use() and obtains a
// pipeline token. User questions are sent via client.chat() through the
// shared ChatView component.
//
// Pipeline: Chat → CrewAI Agent → Aparavi AQL tool + LLM → Response
// =============================================================================

import React, { useCallback, useRef, useEffect, useState } from 'react';
import type { ShellAppProps } from 'shell-ui';
import { useShellConnection, useAuthUser } from 'shell-ui';
import { ChatView, useChatMessages } from 'shared';
import pipeline from './aparavi.pipe';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Main application component for Aparavi AQL Chat.
 *
 * On first connection, calls client.use() with the embedded pipeline definition
 * to start the CrewAI agent + Aparavi AQL pipeline. The returned token is then
 * used for all subsequent client.chat() calls via the shared useChatMessages hook.
 */
const AparaviApp: React.FC<ShellAppProps> = () => {
	// Shell connection — provides the RocketRide WebSocket client
	const { client, isConnected } = useShellConnection();

	// Auth identity — needed to confirm user is authenticated
	const identity = useAuthUser();

	// Pipeline token from client.use() — required for client.chat()
	const [pipelineToken, setPipelineToken] = useState<string | null>(null);

	// Chat state — messages, typing indicator, send/clear/system helpers
	const { messages, isTyping, sendMessage, addSystemMessage } = useChatMessages();

	// Track pipeline startup to avoid duplicate .use() calls
	const startedRef = useRef(false);

	// Start the pipeline when connected and authenticated
	useEffect(() => {
		if (!isConnected || !client || !identity || startedRef.current) return;
		startedRef.current = true;

		addSystemMessage('Starting Aparavi pipeline...');

		client
			.use({ pipeline, useExisting: true, name: 'Aparavi AQL Chat' })
			.then((result) => {
				setPipelineToken(result.token);
				addSystemMessage('Ready. Ask me anything about your Aparavi data.');
			})
			.catch((err) => {
				startedRef.current = false; // Allow retry on next connect
				addSystemMessage(`Failed to start pipeline: ${err instanceof Error ? err.message : String(err)}`);
			});
	}, [isConnected, client, identity, addSystemMessage]);

	// Send handler — passes client and pipeline token to the shared hook
	const handleSend = useCallback(
		(text: string) => {
			if (!client || !pipelineToken) return;
			sendMessage(text, client, pipelineToken);
		},
		[client, pipelineToken, sendMessage]
	);

	return (
		<ChatView
			messages={messages}
			isTyping={isTyping}
			isConnected={isConnected && !!pipelineToken}
			onSend={handleSend}
			placeholder="Ask about your Aparavi data..."
		/>
	);
};

export default AparaviApp;
