// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MessageList — the scrollable chat thread.
 *
 * Renders each message (grouping consecutive "thinking" status messages into a
 * collapsible block) with the card a bot row carries under it, any "Needs
 * your OK" cards of the running turn (above the
 * indicator), the streaming TypingIndicator, the messages queued behind the
 * running turn (below the indicator), and a stock EmptyState for brand-new
 * conversations. Autoscroll is scroll-locked: the thread only follows new
 * messages while the user is already at/near the bottom.
 */

import React, { useEffect, useRef, useMemo, useState, type CSSProperties } from 'react';
import { ChatMessage, CHAT_COLUMN_MAX_WIDTH, type ChatAskAnswer, type ChatAskView, type ChatCard, type ChatCardAction, type ChatTurnView } from '../types';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';
import { Button } from '../../button/Button';
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

	askCard: {
		maxWidth: '72%',
		padding: '10px 14px',
		marginBottom: 12,
		borderRadius: '12px 12px 12px 4px',
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		color: 'var(--rr-text-primary)',
		fontSize: 13,
		lineHeight: 1.55,
		boxSizing: 'border-box',
	} as CSSProperties,

	askHeading: {
		fontSize: 11,
		color: 'var(--rr-text-caption)',
		marginBottom: 2,
	} as CSSProperties,

	askTitle: {
		fontWeight: 600,
	} as CSSProperties,

	askDetail: {
		marginTop: 2,
		color: 'var(--rr-text-caption)',
	} as CSSProperties,

	askButtons: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 6,
		marginTop: 8,
	} as CSSProperties,

	cardHeading: (tone: ChatCard['tone']): CSSProperties => ({
		fontWeight: 600,
		color: CARD_TONES[tone],
	}),
};

/** A row card's heading colour per tone. */
const CARD_TONES: Readonly<Record<ChatCard['tone'], string>> = {
	success: 'var(--rr-color-success)',
	danger: 'var(--rr-color-error)',
	info: 'var(--rr-color-info)',
	neutral: 'var(--rr-text-caption)',
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
// ASK CARD
// =============================================================================

/**
 * A "Needs your OK" card: what the request wants to do, Approve and Deny,
 * and "Always allow" when the request offers it. Once answered it leaves the
 * list, and the controller puts its one row in the thread.
 *
 * @param props.ask - The waiting card.
 * @param props.onAnswer - Called with the button pressed.
 * @returns The card.
 */
const AskCard: React.FC<{ ask: ChatAskView; onAnswer: (answer: Exclude<ChatAskAnswer, 'stopped'>) => void }> = ({ ask, onAnswer }) => (
	<div style={styles.askCard} role="group" aria-label="Needs your OK">
		<div style={styles.askHeading}>Needs your OK</div>
		<div style={styles.askTitle}>{ask.card.title}</div>
		{ask.card.detail && <div style={styles.askDetail}>{ask.card.detail}</div>}
		<div style={styles.askButtons}>
			<Button variant="primary" small onClick={() => onAnswer('approve')}>
				Approve
			</Button>
			<Button variant="secondary" small onClick={() => onAnswer('deny')}>
				Deny
			</Button>
			{ask.card.alwaysLabel && (
				<Button variant="ghost" small onClick={() => onAnswer('always')}>
					{ask.card.alwaysLabel}
				</Button>
			)}
		</div>
	</div>
);

// =============================================================================
// ROW CARD
// =============================================================================

/**
 * The card a bot row carries, drawn like a "Needs your OK" card: its heading
 * in the tone's colour, its lines, its files as links and its buttons. With
 * no handler, or for a disabled button, nothing can be pressed.
 *
 * @param props.card - The row's card.
 * @param props.messageId - The row's id, passed to the handler.
 * @param props.onAction - The host's handler, if any.
 * @returns The card.
 */
const RowCard: React.FC<{ card: ChatCard; messageId: number; onAction?: (messageId: number, action: ChatCardAction) => void }> = ({ card, messageId, onAction }) => (
	<div style={styles.askCard} role="group" aria-label={`Turn result: ${card.title}`}>
		<div style={styles.cardHeading(card.tone)}>{card.title}</div>
		{card.lines?.map((line, i) => (
			<div key={`l-${i}`} style={styles.askDetail}>
				{line}
			</div>
		))}
		{(card.files?.length ?? 0) + (card.actions?.length ?? 0) > 0 && (
			<div style={styles.askButtons}>
				{card.files?.map((path) => (
					<Button key={`f-${path}`} variant="ghost" small disabled={!onAction} title={`Open ${path}`} onClick={() => onAction?.(messageId, { kind: 'file', path })}>
						{path}
					</Button>
				))}
				{card.actions?.map((action) => (
					<Button key={`a-${action.id}`} variant="secondary" small disabled={!onAction || action.disabled} onClick={() => onAction?.(messageId, { kind: 'action', id: action.id })}>
						{action.label}
					</Button>
				))}
			</div>
		)}
	</div>
);

/** The typing indicator's caption, read from the turn, so no new phase is needed and Esc and Stop work as before. */
function typingLabel(turn: ChatTurnView | undefined): string | undefined {
	if (turn?.asks.length) return 'Waiting for your OK';
	return turn?.phase === 'stopping' ? 'Stopping…' : undefined;
}

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
	/** Rich replacement for the stock EmptyState (e.g. example-prompt cards). */
	emptySlot?: React.ReactNode;
	/** Turn controls, for the queued messages' Edit and Remove and the typing label. */
	turn?: ChatTurnView;
	/** Handles a press on a row's card. */
	onCardAction?: (messageId: number, action: ChatCardAction) => void;
}

/**
 * Renders the scrollable message thread with scroll-locked autoscroll.
 *
 * @param props - {@link MessageListProps}.
 * @returns The thread element (or an EmptyState when empty).
 */
export const MessageList: React.FC<MessageListProps> = ({ messages, isTyping, emptyTitle, emptyDescription, emptySlot, turn, onCardAction }) => {
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
	}, [messages, isTyping, turn?.asks]);

	// Fold consecutive "thinking" status messages into a single collapsible group.
	// Queued messages are always the last rows; they render apart, below the indicator.
	const { items, queued } = useMemo((): { items: RenderItem[]; queued: ChatMessage[] } => {
		const out: RenderItem[] = [];
		let group: ChatMessage[] | null = null;
		const firstQueued = messages.findIndex((m) => m.queued);
		const thread = firstQueued < 0 ? messages : messages.slice(0, firstQueued);

		for (const msg of thread) {
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
		return { items: out, queued: firstQueued < 0 ? [] : messages.slice(firstQueued) };
	}, [messages]);

	// A brand-new conversation shows the host's rich empty slot when provided,
	// else the stock EmptyState — never a blank area.
	if (messages.length === 0 && !isTyping) {
		return <div style={styles.emptyWrap}>{emptySlot ?? <EmptyState title={emptyTitle ?? 'No messages yet'} description={emptyDescription ?? 'Start the conversation below.'} />}</div>;
	}

	return (
		<div style={styles.scroll} ref={scrollRef} onScroll={handleScroll}>
			{/* Inner column mirrors the entry bar width so thread and input align. */}
			<div style={styles.column}>
				{items.map((item) =>
					item.kind === 'thinking-group' ? (
						<ThinkingGroup key={`tg-${item.id}`} messages={item.messages} />
					) : (
						<React.Fragment key={item.message.id}>
							<MessageBubble message={item.message} />
							{item.message.card && <RowCard card={item.message.card} messageId={item.message.id} onAction={onCardAction} />}
						</React.Fragment>
					)
				)}
				{turn?.asks.map((ask) => (
					<AskCard key={`ask-${ask.id}`} ask={ask} onAnswer={(answer) => turn.answerAsk(ask.id, answer)} />
				))}
				{isTyping && <TypingIndicator label={typingLabel(turn)} />}
				{queued.map((m) => (
					<MessageBubble key={m.id} message={m} turn={turn} />
				))}
				<div ref={endRef} />
			</div>
		</div>
	);
};
