// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MessageBubble — renders a single message in the chat thread.
 *
 * Four shapes, all coloured from --rr-* tokens so they track every theme:
 *   - error   → an in-thread error Banner (isError messages)
 *   - user    → a filled brand bubble, right-aligned
 *   - status  → a compact dotted "thinking" row
 *   - bot/sys → a bordered assistant bubble with sanitized markdown, left-aligned
 *               (chart-bearing answers break out of the bubble to full width)
 */

import React, { type CSSProperties } from 'react';
import type { ChatMessage } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Banner } from '../../../components/banner/Banner';

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

interface MessageBubbleProps {
	message: ChatMessage;
}

/**
 * Renders one chat message according to its sender and error state.
 *
 * @param props - the {@link ChatMessage} to render.
 * @returns The message element.
 */
export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
	// Failed sends/responses surface in-thread as an error Banner (stock component).
	if (message.isError) {
		return (
			<div style={styles.errorRow}>
				<Banner variant="error">{message.text}</Banner>
			</div>
		);
	}

	// Status / thinking messages render as a compact dotted row.
	if (message.sender === 'status') {
		return (
			<div style={styles.statusRow}>
				<span style={styles.statusDot} />
				<span style={styles.statusText}>{message.text}</span>
			</div>
		);
	}

	// User messages render as a filled, right-aligned brand bubble.
	if (message.sender === 'user') {
		return (
			<div style={styles.userRow}>
				<div style={styles.userBubble}>
					<p style={styles.userText}>{message.text}</p>
					{message.meta && <div style={styles.userMeta}>{message.meta}</div>}
					<div style={styles.userTimestamp}>{message.timestamp}</div>
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
