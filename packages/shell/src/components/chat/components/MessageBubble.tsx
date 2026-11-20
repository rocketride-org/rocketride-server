// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MessageBubble — renders a single message in the chat thread.
 *
 * Four shapes, all coloured from --rr-* tokens so they track every theme:
 *   - error   → an in-thread error Banner (isError messages)
 *   - user    → a filled brand bubble, right-aligned; a queued one (sent while a
 *               turn runs) is faded, with a "Queued" caption and Edit and Remove
 *   - status  → a compact dotted "thinking" row (line breaks in its text show)
 *   - bot/sys → a bordered assistant bubble with sanitized markdown, left-aligned
 *               (chart-bearing answers break out of the bubble to full width)
 */

import React, { type CSSProperties } from 'react';
import type { ChatMessage, ChatTurnView } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Banner } from '../../banner/Banner';
import { Button } from '../../button/Button';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// ── User bubble ──────────────────────────────────────────────────────────────
	userRow: {
		display: 'flex',
		justifyContent: 'flex-end',
		marginBottom: 12,
	} as CSSProperties,

	userBubble: {
		maxWidth: '72%',
		padding: '10px 14px',
		borderRadius: '12px 12px 4px 12px',
		backgroundColor: 'var(--rr-brand)',
		color: 'var(--rr-fg-button)',
		fontSize: 13,
		lineHeight: 1.55,
	} as CSSProperties,

	userText: {
		margin: 0,
	} as CSSProperties,

	userMeta: {
		fontSize: 10.5,
		color: 'var(--rr-fg-button)',
		opacity: 0.75,
		marginTop: 4,
		textAlign: 'right',
	} as CSSProperties,

	userTimestamp: {
		fontSize: 10,
		color: 'var(--rr-fg-button)',
		opacity: 0.7,
		marginTop: 4,
		textAlign: 'right',
	} as CSSProperties,

	// ── Queued user bubble ───────────────────────────────────────────────────────
	queuedRow: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'flex-end',
		marginBottom: 12,
	} as CSSProperties,

	queuedBubble: {
		opacity: 0.6,
	} as CSSProperties,

	queuedControls: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		marginTop: 4,
	} as CSSProperties,

	queuedCaption: {
		fontSize: 11,
		color: 'var(--rr-text-caption)',
		fontStyle: 'italic',
	} as CSSProperties,

	// ── Assistant bubble (bot / system) ──────────────────────────────────────────
	botRow: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'flex-start',
		marginBottom: 16,
	} as CSSProperties,

	botBubble: {
		maxWidth: '72%',
		padding: '10px 14px',
		borderRadius: '12px 12px 12px 4px',
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		color: 'var(--rr-text-primary)',
		fontSize: 13,
		lineHeight: 1.55,
		boxSizing: 'border-box',
		overflowX: 'auto',
	} as CSSProperties,

	// Wide assistant content (charts) breaks out of the constrained bubble.
	botWide: {
		width: '100%',
		maxWidth: '100%',
	} as CSSProperties,

	botMeta: {
		fontSize: 10.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 4,
	} as CSSProperties,

	botTimestamp: {
		fontSize: 10,
		color: 'var(--rr-text-caption)',
		marginTop: 4,
	} as CSSProperties,

	// ── Error banner row ──────────────────────────────────────────────────────────
	errorRow: {
		marginBottom: 16,
	} as CSSProperties,

	// ── Status dot row (thinking / SSE) ───────────────────────────────────────────
	statusRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '2px 0',
		marginBottom: 4,
	} as CSSProperties,

	statusDot: {
		width: 5,
		height: 5,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-brand)',
		opacity: 0.5,
		flexShrink: 0,
	} as CSSProperties,

	statusText: {
		fontSize: 11,
		color: 'var(--rr-text-caption)',
		fontStyle: 'italic',
	} as CSSProperties,

	// A multi-line status row keeps its line breaks, with the dot level with the first line, not the middle.
	statusRowMulti: {
		alignItems: 'flex-start',
	} as CSSProperties,

	statusDotMulti: {
		marginTop: 4,
	} as CSSProperties,

	statusTextMulti: {
		whiteSpace: 'pre-wrap',
	} as CSSProperties,

	resultKey: {
		fontSize: 10,
		color: 'var(--rr-text-caption)',
		fontStyle: 'italic',
		marginLeft: 6,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

export interface MessageBubbleProps {
	message: ChatMessage;
	/** Turn controls: Edit and Remove on a queued message. */
	turn?: ChatTurnView;
}

/**
 * Renders one chat message according to its sender and error state.
 *
 * @param props - the {@link ChatMessage} to render.
 * @returns The message element.
 */
export const MessageBubble: React.FC<MessageBubbleProps> = ({ message, turn }) => {
	// Failed sends/responses surface in-thread as an error Banner (stock component).
	if (message.isError) {
		return (
			<div style={styles.errorRow}>
				<Banner variant="error">{message.text}</Banner>
			</div>
		);
	}

	// Status / thinking messages render as a compact dotted row. A row whose
	// text has line breaks keeps them (pre-wrap).
	if (message.sender === 'status') {
		const multi = message.text.includes('\n');
		return (
			<div style={multi ? { ...styles.statusRow, ...styles.statusRowMulti } : styles.statusRow}>
				<span style={multi ? { ...styles.statusDot, ...styles.statusDotMulti } : styles.statusDot} />
				<span style={multi ? { ...styles.statusText, ...styles.statusTextMulti } : styles.statusText}>{message.text}</span>
			</div>
		);
	}

	// User messages render as a filled, right-aligned brand bubble; a queued one
	// is faded, with its caption and controls under it.
	if (message.sender === 'user') {
		const bubble = (
			<div style={message.queued ? { ...styles.userBubble, ...styles.queuedBubble } : styles.userBubble}>
				<p style={styles.userText}>{message.text}</p>
				{message.meta && <div style={styles.userMeta}>{message.meta}</div>}
				<div style={styles.userTimestamp}>{message.timestamp}</div>
			</div>
		);
		if (!message.queued) return <div style={styles.userRow}>{bubble}</div>;
		return (
			<div style={styles.queuedRow}>
				{bubble}
				<div style={styles.queuedControls}>
					<span style={styles.queuedCaption}>Queued</span>
					{turn && (
						<>
							<Button variant="ghost" small onClick={() => turn.editQueued(message.id)}>
								Edit
							</Button>
							<Button variant="ghost" small onClick={() => turn.removeQueued(message.id)}>
								Remove
							</Button>
						</>
					)}
				</div>
			</div>
		);
	}

	// Assistant (bot / system) messages render sanitized markdown. Chart-bearing
	// answers break out to full width; everything else sits in a bordered bubble.
	const hasChart = /^```chartjs/m.test(message.text);
	return (
		<div style={styles.botRow}>
			<div style={hasChart ? styles.botWide : styles.botBubble}>
				<MarkdownRenderer content={message.text} />
				{message.meta && <div style={styles.botMeta}>{message.meta}</div>}
			</div>
			<div style={styles.botTimestamp}>
				{message.timestamp}
				{message.resultKey && <span style={styles.resultKey}>{message.resultKey}</span>}
			</div>
		</div>
	);
};
