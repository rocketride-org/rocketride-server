// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useState, type CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';

const S = {
	container: {
		flexShrink: 0,
		borderTop: '1px solid var(--rr-border)',
		padding: '10px 16px',
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,

	inner: {
		display: 'flex',
		alignItems: 'flex-end',
		gap: 8,
		maxWidth: 720,
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

	sendBtn: (disabled: boolean, hovered: boolean): CSSProperties => ({
		...commonStyles.buttonPrimary,
		flexShrink: 0,
		padding: '7px 14px',
		...(disabled ? commonStyles.buttonDisabled : {}),
		...(hovered && !disabled ? { opacity: 0.85 } : {}),
	}),
};

interface ChatInputFieldProps {
	onSend: (text: string) => void;
	disabled?: boolean;
	placeholder?: string;
}

export const ChatInputField: React.FC<ChatInputFieldProps> = ({ onSend, disabled = false, placeholder = 'Ask anything…' }) => {
	const [value, setValue] = useState('');
	const [focused, setFocused] = useState(false);
	const [hovered, setHovered] = useState(false);

	const submit = () => {
		if (!value.trim() || disabled) return;
		onSend(value.trim());
		setValue('');
	};

	return (
		<div style={S.container}>
			<div style={S.inner}>
				<textarea
					rows={1}
					style={S.textarea(focused, disabled)}
					value={value}
					disabled={disabled}
					placeholder={disabled ? 'Connecting…' : placeholder}
					onChange={(e) => {
						setValue(e.target.value);
						e.target.style.height = 'auto';
						e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
					}}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
				/>
				<button type="button" style={S.sendBtn(disabled || !value.trim(), hovered)} disabled={disabled || !value.trim()} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onClick={submit}>
					Send
				</button>
			</div>
		</div>
	);
};
