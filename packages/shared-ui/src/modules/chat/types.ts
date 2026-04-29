// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Type definitions for the chat module.
 */

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
}

// =============================================================================
// HOOK OPTIONS
// =============================================================================

/** Options for useChatMessages. */
export interface UseChatMessagesOptions {
	/** System message shown after clearMessages(). */
	welcomeMessage?: string;
}

// =============================================================================
// PIPELINE RESULT (from rocketride SDK)
// =============================================================================

export interface TextResult {
	text: string;
	key: string;
}
