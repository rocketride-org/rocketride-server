// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MessageList — the scrollable chat thread.
 *
 * Renders each message (grouping consecutive "thinking" status messages into a
 * collapsible block), the streaming TypingIndicator, and a stock EmptyState for
 * brand-new conversations. Autoscroll is scroll-locked: the thread only follows
 * new messages while the user is already at/near the bottom.
 */

import React, { useEffect, useRef, useMemo, useState, type CSSProperties } from 'react';
import { ChatMessage, CHAT_COLUMN_MAX_WIDTH } from '../types';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';
import { EmptyState } from '../../empty-state/EmptyState';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	scroll: {
		flex: 1,
		overflowY: 'auto' as const,
		padding: '16px 20px',
		minHeight: 0,
		scrollbarWidth: 'thin' as const,
		scrollbarColor: 'var(--rr-bg-scrollbar-thumb) transparent',
	} as CSSProperties,

	// Centered column shared with the input row: responses never render wider
	// than the chat entry bar (CHAT_COLUMN_MAX_WIDTH keeps the two in lockstep).
	column: {
		maxWidth: CHAT_COLUMN_MAX_WIDTH,
		width: '100%',
		margin: '0 auto',
	} as CSSProperties,

	emptyWrap: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '16px 20px',
		minHeight: 0,
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

// =============================================================================
// THINKING GROUP
// =============================================================================

/**
 * Collapsible group of consecutive "thinking" status messages.
 *
 * @param props.messages - the status messages folded into this group.
 * @returns The toggle + (when open) the grouped messages.
 */
const ThinkingGroup: React.FC<{ messages: ChatMessage[] }> = ({ messages }) => {
	const [open, setOpen] = useState(false);
	return (
		<div style={styles.thinkingGroup}>
			<button type="button" style={styles.thinkingToggle} onClick={() => setOpen((o) => !o)}>
				<span style={styles.thinkingChevron(open)} />
				Thinking…
			</button>
			{open && (
				<div style={styles.thinkingBody}>
					{messages.map((m) => (
						<MessageBubble key={m.id} message={m} />
					))}
				</div>
			)}
		</div>
	);
};

// =============================================================================
// MESSAGE LIST
// =============================================================================

/** A rendered thread item: a single message or a folded thinking group. */
type RenderItem = { kind: 'message'; message: ChatMessage } | { kind: 'thinking-group'; id: number; messages: ChatMessage[] };

export interface MessageListProps {
	messages: ChatMessage[];
	isTyping: boolean;
	/** Title for the EmptyState shown when there are no messages. */
	emptyTitle?: string;
	/** Description for the EmptyState shown when there are no messages. */
	emptyDescription?: string;
}

/**
 * Renders the scrollable message thread with scroll-locked autoscroll.
 *
 * @param props - {@link MessageListProps}.
 * @returns The thread element (or an EmptyState when empty).
 */
export const MessageList: React.FC<MessageListProps> = ({ messages, isTyping, emptyTitle, emptyDescription }) => {
	const scrollRef = useRef<HTMLDivElement>(null);
	const endRef = useRef<HTMLDivElement>(null);
	// Whether the user is pinned to the bottom (within 40px). Starts true so the
	// first paint scrolls to the latest message.
	const atBottomRef = useRef(true);

	// Recompute the pin state on every user scroll.
	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
	};

	// Autoscroll to the newest message only while pinned to the bottom; if the
	// user scrolled up to read history, leave their position untouched.
	useEffect(() => {
		if (atBottomRef.current) endRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, isTyping]);

	// Fold consecutive "thinking" status messages into a single collapsible group.
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

	// A brand-new conversation shows the stock EmptyState instead of a blank area.
	if (messages.length === 0 && !isTyping) {
		return (
			<div style={styles.emptyWrap}>
				<EmptyState title={emptyTitle ?? 'No messages yet'} description={emptyDescription ?? 'Start the conversation below.'} />
			</div>
		);
	}

	return (
		<div style={styles.scroll} ref={scrollRef} onScroll={handleScroll}>
			{/* Inner column mirrors the entry bar width so thread and input align. */}
			<div style={styles.column}>
				{items.map((item) => (item.kind === 'thinking-group' ? <ThinkingGroup key={`tg-${item.id}`} messages={item.messages} /> : <MessageBubble key={item.message.id} message={item.message} />))}
				{isTyping && <TypingIndicator />}
				<div ref={endRef} />
			</div>
		</div>
	);
};
