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
}

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
	/** Optional node rendered before the input field (reserved for future attachments). */
	leadingInputSlot?: ReactNode;
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
