// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ChatInputField — the pinned composer row: an optional leading slot (reserved
 * for future attachments), an auto-growing textarea, and the stock primary Send
 * Button. Enter sends; Shift+Enter inserts a newline. The whole row is disabled
 * (input + Send) when `disabled` is true — callers pass the global connection
 * state; this component never imports shell. Send stays enabled during a turn: a send then queues.
 *
 * The textarea (rather than the stock single-line InputField) is required so
 * Shift+Enter can insert a newline; it is styled from the same
 * `commonStyles.inputField` base the InputField wraps.
 */

import { CHAT_COLUMN_MAX_WIDTH, type ChatTurnView } from '../types';
import React, { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { commonStyles } from '../../../themes/styles';
import { Button } from '../../button/Button';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		flexShrink: 0,
		borderTop: '1px solid var(--rr-border)',
		padding: '12px 16px',
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,

	inner: {
		display: 'flex',
		alignItems: 'flex-end',
		gap: 10,
		maxWidth: CHAT_COLUMN_MAX_WIDTH,
		margin: '0 auto',
	} as CSSProperties,

	textarea: (focused: boolean, disabled: boolean): CSSProperties => ({
		...commonStyles.inputField,
		resize: 'none' as const,
		minHeight: 36,
		maxHeight: 120,
		overflowY: 'auto' as const,
		lineHeight: 1.5,
		borderColor: focused ? 'var(--rr-border-focus)' : disabled ? 'var(--rr-border)' : 'var(--rr-border-input)',
		opacity: disabled ? 0.6 : 1,
		transition: 'border-color 0.15s',
	}),
};

// =============================================================================
// COMPONENT
// =============================================================================

export interface ChatInputFieldProps {
	onSend: (text: string) => void;
	disabled?: boolean;
	placeholder?: string;
	/** Optional node rendered before the input field (reserved for attachments). */
	leadingInputSlot?: ReactNode;
	/** Turn controls: a Stop button and Esc while a turn runs, and text handed back by Stop or Edit lands in the box. */
	turn?: ChatTurnView;
}

/**
 * Renders the composer row.
 *
 * @param props - {@link ChatInputFieldProps}.
 * @returns The composer element.
 */
export const ChatInputField: React.FC<ChatInputFieldProps> = ({ onSend, disabled = false, placeholder = 'Ask anything…', leadingInputSlot, turn }) => {
	const [value, setValue] = useState('');
	const [focused, setFocused] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// Starts at the current hand-back, so a remount doesn't paste it again.
	const applied = useRef(turn?.returned?.id ?? null);
	const returned = turn?.returned;

	// The textarea sizes itself from its value, so handed-back text grows it like typed text.
	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
	}, [value]);

	useEffect(() => {
		if (!returned || returned.id === applied.current) return;
		applied.current = returned.id;
		setValue((v) => (v ? `${returned.text}\n\n${v}` : returned.text));
		textareaRef.current?.focus();
	}, [returned]);

	const submit = () => {
		if (!value.trim() || disabled) return;
		onSend(value.trim());
		setValue('');
	};

	return (
		<div style={styles.container}>
			<div style={styles.inner}>
				{leadingInputSlot}
				<textarea
					ref={textareaRef}
					rows={1}
					style={styles.textarea(focused, disabled)}
					value={value}
					disabled={disabled}
					placeholder={disabled ? 'Connecting…' : placeholder}
					onChange={(e) => setValue(e.target.value)}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					onKeyDown={(e) => {
						// Enter sends; Shift+Enter inserts a newline. Guard against firing
						// mid-IME composition (CJK input methods).
						if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							submit();
						}
						if (e.key === 'Escape' && turn?.phase === 'running' && !e.nativeEvent.isComposing) {
							e.preventDefault();
							turn.stop();
						}
					}}
				/>
				{turn && turn.phase !== 'idle' && (
					<Button variant="secondary" disabled={turn.phase === 'stopping'} onClick={() => turn.stop()}>
						{turn.phase === 'stopping' ? 'Stopping…' : 'Stop'}
					</Button>
				)}
				<Button variant="primary" disabled={disabled || !value.trim()} onClick={submit}>
					Send
				</Button>
			</div>
		</div>
	);
};
