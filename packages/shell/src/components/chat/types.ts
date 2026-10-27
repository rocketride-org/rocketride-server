// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Type definitions for the chat module.
 */

import type { ReactNode } from 'react';

// =============================================================================
// MESSAGE
// =============================================================================

/** A single message in the conversation. */
export interface ChatMessage {
	/** Unique monotonic ID — never collides even within the same millisecond. */
	id: number;
	/** Raw text content (may contain markdown). */
	text: string;
	/** Who produced the message. */
	sender: 'user' | 'bot' | 'system' | 'status';
	/** Formatted time string, e.g. "14:32". */
	timestamp: string;
	/** Pipeline result key — shown as a small label below bot messages. */
	resultKey?: string;
	/** SSE event type — used to identify thinking-group status messages. */
	sseType?: string;
	/** Optional metadata line (e.g. "2,340 tokens · 1.8s") shown under the bubble content. */
	meta?: string;
	/** When true, the message renders as an in-thread error Banner instead of a bubble. */
	isError?: boolean;
	/**
	 * On a user row: sent while a turn was running, and not yet taken by it.
	 * Queued rows are always the last rows of the list. A load clears the flag.
	 */
	queued?: true;
	/** On a bot row: a card under the bubble, saved with the row. The view shows it; the host's onCardAction handles its links and buttons. */
	card?: ChatCard;
}

/** A card under a bot row: how the request that wrote it ended. The shell knows nothing of what it means. */
export interface ChatCard {
	/** The colour of its heading. */
	tone: 'success' | 'danger' | 'info' | 'neutral';
	/** The heading ("Done", "Needs you"). */
	title: string;
	/** Short lines under the heading. */
	lines?: string[];
	/** Workspace paths, shown as links. */
	files?: string[];
	/** Buttons; a disabled one shows but does nothing. */
	actions?: Array<{ id: string; label: string; disabled?: boolean }>;
}

/** A press on a card: one of its file links, or one of its buttons by id. */
export type ChatCardAction = { kind: 'file'; path: string } | { kind: 'action'; id: string };

// =============================================================================
// VIEW PROPS
// =============================================================================

/** Props for the top-level ChatView component. */
export interface IChatViewProps {
	/** Current message list managed by the host via useChatMessages. */
	messages: ChatMessage[];
	/** Whether the assistant is currently composing a response. */
	isTyping: boolean;
	/** Whether the underlying WebSocket client is connected. */
	isConnected: boolean;
	/** Called when the user submits a message. */
	onSend: (text: string) => void;
	/** Placeholder shown in the input when idle. Defaults to "Ask anything…". */
	placeholder?: string;
	/** Title for the EmptyState shown when the conversation has no messages. */
	emptyTitle?: string;
	/** Description for the EmptyState shown when the conversation has no messages. */
	emptyDescription?: string;
	/** Rich replacement for the stock EmptyState (e.g. example-prompt cards). */
	emptySlot?: ReactNode;
	/** Optional node rendered before the input field (reserved for future attachments). */
	leadingInputSlot?: ReactNode;
	/** Turn controls from `useChatMessages().turn`: Stop (and Esc) while a turn runs, and Edit and Remove on queued messages. Without it the view is v0's. */
	turn?: ChatTurnView;
	/** Handles a press on a row's card. Without it the card's links and buttons show disabled. */
	onCardAction?: (messageId: number, action: ChatCardAction) => void;
}

// =============================================================================
// HOOK OPTIONS
// =============================================================================

/** Options for useChatMessages. */
export interface UseChatMessagesOptions {
	/** System message shown after clearMessages(). */
	welcomeMessage?: string;
	/** Seed messages to restore a previous conversation (preserves sender, timestamp, etc.). */
	initialMessages?: ChatMessage[];
	/**
	 * Injected transport: when provided, sendMessage awaits this instead of the
	 * built-in chat API (the `client`/`authToken` arguments are then unused).
	 * Each returned TextResult renders as one bot message. The hook passes a
	 * status sink as the second argument: rows sent to it show up at once,
	 * while the request is still pending (see {@link ChatStatusSink}). The hook
	 * always passes the running turn as the third argument; it is typed optional
	 * only because v0 is frozen.
	 */
	request?: (text: string, onStatus?: ChatStatusSink, turn?: ChatTurn) => Promise<TextResult[]>;
}

/**
 * Live status sink handed to an injected `request` transport. Each call
 * appends a status row to the thread immediately, the same row the built-in
 * chat path appends for a server-sent event. Rows with type `thinking` fold
 * into the thread's collapsible "Thinking…" group.
 *
 * @param type - The row's event type (stored as `sseType`).
 * @param text - The row's text; line breaks are kept.
 */
export type ChatStatusSink = (type: string, text: string) => void;

// =============================================================================
// ASK — a "Needs your OK" card a request shows, and its answer
// =============================================================================

/** A question for the user's OK, as an injected request asks it. The shell knows nothing of what it means. */
export interface ChatAskCard {
	/** The action and its target, in the user's words ("Publish Daybook v3 to everyone"). The answered line repeats it. */
	readonly title: string;
	/** What happens, in a sentence or two, shown under the title while the card waits. */
	readonly detail?: string;
	/** The label of an "Always allow" button, when the request offers one ("Always allow schedule changes"). */
	readonly alwaysLabel?: string;
}

/** How a card ended. 'stopped': the turn ended first (Stop, the turn settling, a clear, an unmount), so nobody answered it. */
export type ChatAskAnswer = 'approve' | 'always' | 'deny' | 'stopped';

/** A card the request is waiting on. */
export interface ChatAsking {
	/** Settles once, with how the card ended. Never rejects. */
	readonly answer: Promise<ChatAskAnswer>;
	/**
	 * Answers approve for the user, when something the request reads changed so
	 * the card no longer needs asking (the user switched the agent to Auto). The
	 * card closes as approved. Does nothing once the card has ended.
	 */
	approve(): void;
}

/** A waiting card, as the view draws it. */
export interface ChatAskView {
	/** The card's id, for `answerAsk`. */
	readonly id: number;
	/** What it asks. */
	readonly card: ChatAskCard;
}

// =============================================================================
// TURN
// =============================================================================

/**
 * The running turn, as an injected `request` sees it. Once the turn settles
 * (its answer or error, or Stop's grace running out) it is inert: the status
 * sink drops rows and `takeQueued` returns [].
 */
export interface ChatTurn {
	/** The rows before this turn's opening user row: the conversation the turn answers in. */
	readonly history: readonly ChatMessage[];
	/** Aborted when the user stops the turn or the chat unmounts. */
	readonly signal: AbortSignal;
	/**
	 * Takes the messages the user sent since the turn began (or since the last
	 * take), oldest first. They then belong to this turn and never open one of
	 * their own. Returns [] once the turn is stopping.
	 */
	takeQueued(): string[];
	/**
	 * Shows a "Needs your OK" card at the bottom of the thread and waits for
	 * the user. The card is not a row: it lives on the turn, is never saved,
	 * and ends with the turn. Once answered, one status row records it
	 * ("Approved: …", "Denied: …", "Not answered: …"). Asked on a turn that is
	 * stopping or settled, it shows nothing and answers 'stopped' at once.
	 *
	 * @param card - What to ask.
	 * @returns The waiting card.
	 */
	ask(card: ChatAskCard): ChatAsking;
}

/** Where a chat's one turn slot stands. */
export type ChatTurnPhase = 'idle' | 'running' | 'stopping';

/** The turn controls ChatView shows; useChatMessages returns them as `turn`. */
export interface ChatTurnView {
	readonly phase: ChatTurnPhase;
	/** Text handed back to the composer by Stop (every queued message) or Edit (one); a new `id` each time. */
	readonly returned: { readonly id: number; readonly text: string } | null;
	stop(): void;
	editQueued(id: number): void;
	removeQueued(id: number): void;
	/** The cards waiting in the running turn, oldest first. While any waits the typing indicator reads "Waiting for your OK". */
	readonly asks: readonly ChatAskView[];
	/** Answers a waiting card (its buttons). An id that no longer waits does nothing, so a click after Stop is ignored. */
	answerAsk(id: number, answer: Exclude<ChatAskAnswer, 'stopped'>): void;
}

// =============================================================================
// PIPELINE RESULT (from rocketride SDK)
// =============================================================================

export interface TextResult {
	text: string;
	key: string;
}

// =============================================================================
// LAYOUT CONSTANTS
// =============================================================================

/**
 * Maximum width of the chat column. The message thread and the input row share
 * this single constant so the responses always align with the entry bar
 * (design-owner requirement: responses must not render wider than the input).
 */
export const CHAT_COLUMN_MAX_WIDTH = 720;
