// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useEffect, useRef, useMemo, useState, type CSSProperties } from 'react';
import type { ChatMessage } from '../types';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';

const S = {
	scroll: {
		flex: 1,
		overflowY: 'auto' as const,
		padding: '16px 20px',
		minHeight: 0,
		scrollbarWidth: 'thin' as const,
		scrollbarColor: 'var(--rr-bg-scrollbar-thumb) transparent',
	} as CSSProperties,

	thinkingGroup: {
		marginBottom: 8,
	} as CSSProperties,

	thinkingToggle: {
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
		type: 'button',
	} as CSSProperties,

	thinkingChevron: (open: boolean): CSSProperties => ({
		width: 0,
		height: 0,
		borderLeft: '4px solid transparent',
		borderRight: '4px solid transparent',
		borderTop: '5px solid currentColor',
		transition: 'transform 0.15s',
		transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
	}),

	thinkingBody: {
		paddingLeft: 12,
		borderLeft: '2px solid var(--rr-border)',
		marginLeft: 2,
		marginTop: 2,
	} as CSSProperties,
};

// Collapsible thinking group
const ThinkingGroup: React.FC<{ messages: ChatMessage[] }> = ({ messages }) => {
	const [open, setOpen] = useState(false);
	return (
		<div style={S.thinkingGroup}>
			<button type="button" style={S.thinkingToggle} onClick={() => setOpen((o) => !o)}>
				<span style={S.thinkingChevron(open)} />
				Thinking…
			</button>
			{open && (
				<div style={S.thinkingBody}>
					{messages.map((m) => (
						<MessageBubble key={m.id} message={m} />
					))}
				</div>
			)}
		</div>
	);
};

// RenderItem union
type RenderItem = { kind: 'message'; message: ChatMessage } | { kind: 'thinking-group'; id: number; messages: ChatMessage[] };

interface MessageListProps {
	messages: ChatMessage[];
	isTyping: boolean;
}

export const MessageList: React.FC<MessageListProps> = ({ messages, isTyping }) => {
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, isTyping]);

	const items = useMemo((): RenderItem[] => {
		const out: RenderItem[] = [];
		let group: ChatMessage[] | null = null;

		for (const msg of messages) {
			if (msg.sender === 'status' && msg.sseType === 'thinking') {
				if (!group) {
					group = [];
					out.push({ kind: 'thinking-group', id: msg.id, messages: group });
				}
				group.push(msg);
			} else {
				group = null;
				out.push({ kind: 'message', message: msg });
			}
		}
		return out;
	}, [messages]);

	return (
		<div style={S.scroll}>
			{items.map((item) => (item.kind === 'thinking-group' ? <ThinkingGroup key={`tg-${item.id}`} messages={item.messages} /> : <MessageBubble key={item.message.id} message={item.message} />))}
			{isTyping && <TypingIndicator />}
			<div ref={endRef} />
		</div>
	);
};
