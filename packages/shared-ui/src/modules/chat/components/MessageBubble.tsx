// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useEffect, useState, type CSSProperties } from 'react';
import type { ChatMessage } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

const S = {
	// ── User bubble ────────────────────────────────────────────────────────────
	userRow: {
		display: 'flex',
		justifyContent: 'flex-end',
		marginBottom: 12,
	} as CSSProperties,

	userBubble: {
		maxWidth: '78%',
		padding: '9px 14px',
		borderRadius: '14px 14px 4px 14px',
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		color: 'var(--rr-text-primary)',
		fontSize: 13,
		lineHeight: 1.5,
	} as CSSProperties,

	// ── Bot / system bubble ─────────────────────────────────────────────────────
	botRow: {
		marginBottom: 16,
	} as CSSProperties,

	// ── Status dot row ──────────────────────────────────────────────────────────
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

	// ── Shared ──────────────────────────────────────────────────────────────────
	timestamp: {
		fontSize: 10,
		color: 'var(--rr-text-caption)',
		marginTop: 4,
	} as CSSProperties,

	resultKey: {
		fontSize: 10,
		color: 'var(--rr-text-caption)',
		fontStyle: 'italic',
		marginLeft: 6,
	} as CSSProperties,

	reasoningGroup: {
		marginBottom: 8,
	} as CSSProperties,

	reasoningToggle: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: '2px 0',
		color: 'var(--rr-text-caption)',
		fontSize: 11,
		fontStyle: 'italic',
	} as CSSProperties,

	reasoningChevron: (open: boolean): CSSProperties => ({
		width: 0,
		height: 0,
		borderLeft: '4px solid transparent',
		borderRight: '4px solid transparent',
		borderTop: '5px solid currentColor',
		transition: 'transform 0.15s',
		transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
	}),

	reasoningBody: {
		paddingLeft: 12,
		borderLeft: '2px solid var(--rr-border)',
		marginLeft: 2,
		marginTop: 4,
		marginBottom: 6,
	} as CSSProperties,
};

/** Collapsible panel for streamed model reasoning (matches chat-ui behavior). */
const ReasoningPanel: React.FC<{ reasoning: string; streaming?: boolean; hasContent: boolean }> = ({
	reasoning,
	streaming,
	hasContent,
}) => {
	const [open, setOpen] = useState(true);
	const [userToggled, setUserToggled] = useState(false);

	useEffect(() => {
		if (userToggled) return;
		if (!streaming && hasContent) setOpen(false);
	}, [streaming, hasContent, userToggled]);

	return (
		<div style={S.reasoningGroup}>
			<button
				type="button"
				style={S.reasoningToggle}
				onClick={() => {
					setUserToggled(true);
					setOpen((o) => !o);
				}}
			>
				<span style={S.reasoningChevron(open)} />
				{streaming ? 'Thinking…' : 'Thought process'}
			</button>
			{open && (
				<div style={S.reasoningBody}>
					<MarkdownRenderer content={reasoning} />
				</div>
			)}
		</div>
	);
};

interface MessageBubbleProps {
	message: ChatMessage;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
	if (message.sender === 'status') {
		return (
			<div style={S.statusRow}>
				<span style={S.statusDot} />
				<span style={S.statusText}>{message.text}</span>
			</div>
		);
	}

	if (message.sender === 'user') {
		return (
			<div style={S.userRow}>
				<div style={S.userBubble}>
					<p style={{ margin: 0 }}>{message.text}</p>
					<div style={{ ...S.timestamp, textAlign: 'right' }}>{message.timestamp}</div>
				</div>
			</div>
		);
	}

	// bot / system — use markdown renderer
	const hasChart = /^```chartjs/m.test(message.text);
	const hasReasoning = !!(message.reasoning && message.reasoning.length > 0);
	return (
		<div style={{ ...S.botRow, maxWidth: hasChart ? '100%' : '85%' }}>
			{hasReasoning && (
				<ReasoningPanel
					reasoning={message.reasoning!}
					streaming={!!message.reasoningStreaming}
					hasContent={message.text.length > 0}
				/>
			)}
			<MarkdownRenderer content={message.text} />
			<div style={S.timestamp}>
				{message.timestamp}
				{message.resultKey && <span style={S.resultKey}>{message.resultKey}</span>}
			</div>
		</div>
	);
};
