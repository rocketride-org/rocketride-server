// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { type CSSProperties } from 'react';

// Keyframe injected once per session
const KF_ID = 'rr-chat-typing-kf';
function injectKeyframe() {
	if (typeof document === 'undefined' || document.getElementById(KF_ID)) return;
	const el = document.createElement('style');
	el.id = KF_ID;
	el.textContent = '@keyframes rr-chat-dot{0%,80%,100%{transform:scale(0.6);opacity:0.4}40%{transform:scale(1);opacity:1}}';
	document.head.appendChild(el);
}

const S = {
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		padding: '6px 0',
	} as CSSProperties,

	dot: (delay: number) =>
		({
			width: 7,
			height: 7,
			borderRadius: '50%',
			backgroundColor: 'var(--rr-text-secondary)',
			animation: 'rr-chat-dot 1.2s ease-in-out infinite',
			animationDelay: `${delay}s`,
		}) as CSSProperties,

	label: {
		fontSize: 12,
		color: 'var(--rr-text-caption)',
		fontStyle: 'italic',
		marginLeft: 4,
	} as CSSProperties,
};

interface TypingIndicatorProps {
	label?: string;
}

export const TypingIndicator: React.FC<TypingIndicatorProps> = ({ label }) => {
	injectKeyframe();
	return (
		<div style={S.row}>
			<span style={S.dot(0)} />
			<span style={S.dot(0.16)} />
			<span style={S.dot(0.32)} />
			{label && <span style={S.label}>{label}</span>}
		</div>
	);
};
