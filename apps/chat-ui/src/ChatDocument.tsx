// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ChatDocument — one conversation with one pipe (plan 3.6).
 *
 * Bound to ONE address (`developerId.pipelineId[.source]`). Messages go in
 * through the pipe's chat source with the SDK's `chat()`; the address is the
 * token slot, so the server resolves the publication that answers THIS
 * caller (their `@me` row, their teams in team order, else `@public`) and
 * starts its engine when it is dormant. The app has no model and no
 * conversation logic of its own — the shell's ChatView and useChatMessages
 * carry the transcript, the SSE status lines and the answer extraction.
 *
 * The same component serves both mounts: the shell app (browser, `pipe=`)
 * and the dev-tool frame (workbench, the document key is the address).
 */

import React, { useCallback } from 'react';
import { ChatView, useChatMessages, useShellConnection } from 'shell';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	column: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
		background: 'var(--rr-bg-primary)',
	},
	header: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 10,
		padding: '10px 16px',
		borderBottom: '1px solid var(--rr-border)',
		fontFamily: 'var(--rr-font-family, system-ui)',
	},
	headerLabel: {
		fontSize: 11,
		textTransform: 'uppercase',
		letterSpacing: 0.6,
		color: 'var(--rr-text-secondary)',
	},
	headerAddress: {
		fontSize: 13,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-primary)',
	},
	body: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link ChatDocument}. */
export interface IChatDocumentProps {
	/** The pipe address this conversation is bound to. */
	address: string;
}

/**
 * One conversation with the pipe at `address`.
 *
 * @param props - {@link IChatDocumentProps}.
 */
export const ChatDocument: React.FC<IChatDocumentProps> = ({ address }) => {
	// Step 1: this realm's client — the root client in the browser app, the
	// realm client whose requests ride the shell bus in a dev-tool frame
	const { client, isConnected } = useShellConnection();

	// Step 2: the transcript. The hook builds the Question with the recent
	// history, calls client.chat() with the address in the token slot and
	// turns SSE status messages into status lines
	const { messages, isTyping, sendMessage } = useChatMessages({
		welcomeMessage: `Connected to ${address}. Ask away.`,
	});

	// Step 3: send through the pipe; a dormant engine starts on the first message
	const handleSend = useCallback(
		(text: string) => {
			if (!client) return;
			void sendMessage(text, client, address);
		},
		[client, address, sendMessage]
	);

	return (
		<div style={styles.column}>
			<div style={styles.header}>
				<span style={styles.headerLabel}>Chat</span>
				<span style={styles.headerAddress}>{address}</span>
			</div>
			<div style={styles.body}>
				<ChatView
					messages={messages}
					isTyping={isTyping}
					isConnected={isConnected && client !== null}
					onSend={handleSend}
					placeholder="Ask the pipeline…"
					emptyTitle="Start the conversation"
					emptyDescription="Your first message starts the pipeline's engine if nobody has used it recently."
				/>
			</div>
		</div>
	);
};

export default ChatDocument;
