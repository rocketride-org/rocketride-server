// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Chat module — host-agnostic conversational chat surface.
 *
 * Typical usage:
 *   const { messages, isTyping, sendMessage } = useChatMessages();
 *   const { client, isConnected } = useRocketRideClient();
 *
 *   <ChatView
 *     messages={messages}
 *     isTyping={isTyping}
 *     isConnected={isConnected}
 *     onSend={(text) => sendMessage(text, client, userToken)}
 *   />
 */

// ── View ─────────────────────────────────────────────────────────────────────
export { default as ChatView } from './ChatView';
export type { IChatViewProps } from './types';

// ── Sub-components ────────────────────────────────────────────────────────────
export { MessageList } from './components/MessageList';
export { MessageBubble } from './components/MessageBubble';
export { ChatInputField } from './components/ChatInputField';
export { MarkdownRenderer } from './components/MarkdownRenderer';
export { ChartRenderer } from './components/ChartRenderer';
export { TypingIndicator } from './components/TypingIndicator';

// ── Hooks ─────────────────────────────────────────────────────────────────────
export { useChatMessages } from './hooks/useChatMessages';
export type { UseChatMessagesReturn } from './hooks/useChatMessages';

// ── Types ─────────────────────────────────────────────────────────────────────
export type { ChatMessage, IChatViewProps as ChatViewProps, UseChatMessagesOptions, TextResult } from './types';
