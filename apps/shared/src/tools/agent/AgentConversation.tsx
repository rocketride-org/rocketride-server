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
// AGENT CONVERSATION — one agent conversation as a document tab
// =============================================================================
//
// The editor surface behind an `agent:<sessionId>` document: the standard
// shell chat (ChatView + useChatMessages) composed over one AgentSession.
// The session owns identity and persistence; the chat hook owns the message
// UI state (typing indicator, ids, timestamps); this provider is the thin
// seam between them:
//
//   send  → useChatMessages → session.execute (the injected request
//           transport, wrapping the agent() stub) → bot rows render
//   after → session.save(hook messages) persists the conversation and the
//           catalog row (announced on the shell bus; the sidebar re-lists)
//
// A brand-new conversation renders a welcome panel of example prompts in
// place of the empty thread — clicking one sends it as the first request.
//
// The session is loaded once per mount; Documents keeps open tabs mounted,
// so switching tabs never reloads, and reopening a closed tab re-reads disk.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChatView, useChatMessages, useShellConnection, commonStyles } from 'shell';
import type { DevToolProps } from 'shell';
import type { TextResult } from 'shell';
import { AgentSession } from '../../modules/agent/agent';
import { buttonize } from '../../utils/buttonize';
import { AgentIcon } from './AgentIcon';

// =============================================================================
// EXAMPLE PROMPTS
// =============================================================================

/** The welcome panel's example prompts — each sends verbatim on click. */
const EXAMPLE_PROMPTS: Array<{ heading: string; prompt: string }> = [
	{
		heading: 'Build a pipeline',
		prompt: 'Build a pipeline that watches my inbox folder, OCRs every PDF, and indexes the text for search.',
	},
	{
		heading: 'Fix a failure',
		prompt: 'My invoice-intake pipeline drops files on the error lane — find out why and add a retry lane through the OCR profile.',
	},
	{
		heading: 'Scaffold an app',
		prompt: 'Scaffold an app that shows my pipeline runs on a live dashboard with status and throughput charts.',
	},
	{
		heading: 'Create a node',
		prompt: 'Create a summarizer node that condenses long documents before they are indexed.',
	},
];

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	root: {
		...commonStyles.columnFill,
		background: 'var(--rr-bg-default)',
		minHeight: 0,
	},
	loading: {
		...commonStyles.textMuted,
		padding: 24,
		fontSize: 12,
		textAlign: 'center',
	},
	// Welcome panel — fills the empty thread area above the composer.
	welcome: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		height: '100%',
		padding: '24px 28px',
		textAlign: 'center',
	},
	// Header row: the agent glyph beside the title + lede block. The row is
	// left-aligned internally (an icon beside centered text reads lopsided)
	// but centered as a unit by the welcome column.
	welcomeHeader: {
		display: 'flex',
		alignItems: 'center',
		gap: 16,
		textAlign: 'left',
		marginBottom: 28,
	},
	welcomeIcon: {
		flexShrink: 0,
		display: 'flex',
		color: 'var(--rr-text-primary)',
	},
	welcomeTitle: {
		fontSize: 20,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		marginBottom: 8,
	},
	welcomeLede: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		maxWidth: 520,
		lineHeight: 1.5,
	},
	// Example prompt cards — two columns, clicking sends the prompt.
	exampleGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
		gap: 12,
		width: '100%',
		maxWidth: 680,
	},
	exampleCard: {
		textAlign: 'left',
		padding: '12px 14px',
		borderRadius: 8,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-widget)',
		cursor: 'pointer',
	},
	exampleHeading: {
		fontSize: 12,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		marginBottom: 4,
	},
	exampleText: {
		fontSize: 12,
		lineHeight: 1.45,
		color: 'var(--rr-text-secondary)',
	},
};

/** Hover treatment for an example card (plain handlers, no CSS classes). */
const CARD_HOVER_BG = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * One agent conversation tab. Loads its AgentSession, then renders the
 * standard shell chat with the session's transport injected.
 *
 * @param props.sessionId - The session GUID from the `agent:` document URI.
 */
/**
 * The agent tool's FRAME — one conversation document per session, opened by
 * the tool's controller through DevToolProps.documents (docKey = session
 * GUID). The same component in every host that serves the agent tool.
 */
export const AgentConversationTool: React.FC<DevToolProps> = ({ docKey }) => {
	const sessionId = docKey ?? '';
	const { isConnected } = useShellConnection();

	// step: load the session once per mount (reopen = re-read from disk)
	const [session, setSession] = useState<AgentSession | null>(null);
	useEffect(() => {
		if (!sessionId) return;
		let disposed = false;
		AgentSession.getSession(sessionId)
			.then((loaded) => {
				if (!disposed) setSession(loaded);
			})
			.catch((err) => {
				console.log('[AgentConversation] session load failed', err);
			});
		return () => {
			disposed = true;
		};
	}, [sessionId]);

	if (!sessionId) return <div style={styles.root}><div style={styles.loading}>No session selected.</div></div>;
	return session ? <AgentConversation session={session} isConnected={isConnected} /> : <div style={styles.root}><div style={styles.loading}>Loading session…</div></div>;
};

/**
 * One example-prompt card of the welcome panel.
 *
 * @param props.heading - Short card heading (the task family).
 * @param props.prompt - The full prompt sent verbatim on click.
 * @param props.onPick - Receives the prompt when the card is activated.
 */
const ExampleCard: React.FC<{ heading: string; prompt: string; onPick: (prompt: string) => void }> = ({ heading, prompt, onPick }) => {
	const [hovered, setHovered] = useState(false);
	return (
		<div style={{ ...styles.exampleCard, ...(hovered ? { background: CARD_HOVER_BG } : {}) }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} {...buttonize(() => onPick(prompt))}>
			<div style={styles.exampleHeading}>{heading}</div>
			<div style={styles.exampleText}>{prompt}</div>
		</div>
	);
};

/**
 * The loaded conversation — split from the loader so useChatMessages can
 * seed `initialMessages` exactly once from the hydrated session.
 *
 * @param props.session - The loaded agent session (owns identity + persistence).
 * @param props.isConnected - Shell connection state (gates the composer).
 */
const AgentConversation: React.FC<{ session: AgentSession; isConnected: boolean }> = ({ session, isConnected }) => {
	/** The injected chat transport: one request through the agent session. */
	const request = useCallback((text: string): Promise<TextResult[]> => session.execute(text), [session]);

	const { messages, isTyping, sendMessage } = useChatMessages({ initialMessages: session.messages, request });

	// step: persist after each completed exchange (bot reply landed). The
	// ref dodges saving on mount when a restored conversation ends idle.
	const lastSavedCount = useRef(messages.length);
	useEffect(() => {
		if (isTyping || messages.length === lastSavedCount.current) return;
		lastSavedCount.current = messages.length;
		session.save(messages).catch((err) => {
			console.log('[AgentConversation] session save failed', err);
		});
	}, [isTyping, messages, session]);

	/** Composer submit — the hook's built-in API path is bypassed by `request`. */
	const handleSend = useCallback(
		(text: string) => {
			void sendMessage(text, null, '');
		},
		[sendMessage]
	);

	// The welcome panel shown in place of an empty thread: what the agent is
	// for, plus example prompts that send on click.
	const welcome = (
		<div style={styles.welcome}>
			<div style={styles.welcomeHeader}>
				<div style={styles.welcomeIcon}><AgentIcon size={64} /></div>
				<div>
					<div style={styles.welcomeTitle}>What do you want me to build for you today?</div>
					<div style={styles.welcomeLede}>I work across your whole workspace — I can create and modify pipelines, apps, and nodes, run and validate them, and investigate failures. Try one of these, or describe your own task below.</div>
				</div>
			</div>
			<div style={styles.exampleGrid}>
				{EXAMPLE_PROMPTS.map((example) => (
					<ExampleCard key={example.heading} heading={example.heading} prompt={example.prompt} onPick={handleSend} />
				))}
			</div>
		</div>
	);

	return (
		<div style={styles.root}>
			<ChatView messages={messages} isTyping={isTyping} isConnected={isConnected} onSend={handleSend} placeholder="Reply to the agent..." emptySlot={welcome} />
		</div>
	);
};


