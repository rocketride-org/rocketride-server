// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ChatView — host-agnostic conversational chat surface.
 *
 * Renders a full-height flex column: scrollable message list + pinned input bar.
 * All data flows in as props; all actions flow out via callbacks. The host is
 * responsible for wiring useChatMessages and the RocketRide client singleton.
 *
 * Styling uses only predefined --rr-* CSS custom property tokens so the view
 * automatically adapts to every RocketRide theme (light, dark, VS Code, etc.).
 * ChatView never imports shell: the disabled state arrives via `isConnected`.
 */

import React, { type CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import type { IChatViewProps } from './types';
import { MessageList } from './components/MessageList';
import { ChatInputField } from './components/ChatInputField';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Root — fills whatever container the host provides. */
	root: {
		...commonStyles.columnFill,
		backgroundColor: 'var(--rr-bg-default)',
		fontFamily: 'var(--rr-font-family-widget)',
		fontSize: 'var(--rr-font-size-widget)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the chat surface (message thread + composer).
 *
 * @param props - {@link IChatViewProps}. The composer is disabled whenever
 *   `isConnected` is false; `emptyTitle` / `emptyDescription` configure the
 *   EmptyState for new conversations; `leadingInputSlot` is rendered before the
 *   input (reserved for future attachments); `turn` adds Stop (and Esc) while
 *   a turn runs and Edit and Remove on queued messages; `onCardAction` handles
 *   the links and buttons of a row's card.
 * @returns The chat view element.
 */
export const ChatView: React.FC<IChatViewProps> = ({ messages, isTyping, isConnected, onSend, placeholder, emptyTitle, emptyDescription, emptySlot, leadingInputSlot, turn, onCardAction }) => (
	<div style={styles.root}>
		<MessageList messages={messages} isTyping={isTyping} emptyTitle={emptyTitle} emptyDescription={emptyDescription} emptySlot={emptySlot} turn={turn} onCardAction={onCardAction} />
		<ChatInputField onSend={onSend} disabled={!isConnected} placeholder={placeholder} leadingInputSlot={leadingInputSlot} turn={turn} />
	</div>
);

export type { IChatViewProps };
