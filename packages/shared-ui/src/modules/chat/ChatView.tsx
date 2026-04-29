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
 */

import React, { type CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import type { IChatViewProps } from './types';
import { MessageList } from './components/MessageList';
import { ChatInputField } from './components/ChatInputField';

// =============================================================================
// STYLES
// =============================================================================

const S = {
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

const ChatView: React.FC<IChatViewProps> = ({ messages, isTyping, isConnected, onSend, placeholder }) => (
	<div style={S.root}>
		<MessageList messages={messages} isTyping={isTyping} />
		<ChatInputField onSend={onSend} disabled={!isConnected} placeholder={placeholder} />
	</div>
);

export default ChatView;
export type { IChatViewProps };
