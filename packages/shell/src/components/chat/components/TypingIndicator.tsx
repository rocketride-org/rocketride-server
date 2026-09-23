// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TypingIndicator — three animated dots inside an assistant bubble, shown while
 * a response streams. The opacity keyframe is injected once per document and
 * guarded so repeat mounts never re-inject it.
 */

import React, { type CSSProperties } from 'react';

// =============================================================================
// KEYFRAME INJECTION
// =============================================================================

/** Id of the injected keyframe <style>; guarantees a single insertion. */
const KF_ID = 'rr-chat-typing-kf';

/**
 * Injects the dot opacity keyframe exactly once.
 *
 * Guarded against non-DOM environments and repeated insertion (repeat mounts
 * find the existing element by id and skip).
 */
function injectKeyframe(): void {
	if (typeof document === 'undefined' || document.getElementById(KF_ID)) return;
	const el = document.createElement('style');
	el.id = KF_ID;
	el.textContent = '@keyframes rr-chat-dot{0%,80%,100%{opacity:0.4}40%{opacity:1}}';
	document.head.appendChild(el);
}

// Inject once at module load (safe no-op outside the DOM). Calling this from
// the render body would violate render purity under concurrent rendering;
// module scope also beats a mount effect, which would start the animation one
// frame late. Matches the InputField placeholder-rule pattern.
injectKeyframe();

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	row: {
		display: 'flex',
		justifyContent: 'flex-start',
		marginBottom: 16,
	} as CSSProperties,

	bubble: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 4,
		padding: '10px 14px',
		borderRadius: '12px 12px 12px 4px',
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
	} as CSSProperties,

	dot: (delay: number): CSSProperties => ({
		width: 6,
		height: 6,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-text-disabled)',
		animation: 'rr-chat-dot 1.2s ease-in-out infinite',
		animationDelay: `${delay}s`,
	}),

	label: {
		fontSize: 12,
		color: 'var(--rr-text-caption)',
		fontStyle: 'italic',
		marginLeft: 4,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

export interface TypingIndicatorProps {
	label?: string;
}

/**
 * Renders the streaming/typing indicator as an assistant bubble of three dots.
 *
 * @param props.label - optional caption shown after the dots.
 * @returns The indicator element.
 */
export const TypingIndicator: React.FC<TypingIndicatorProps> = ({ label }) => {
	return (
		<div style={styles.row}>
			<div style={styles.bubble}>
				<span style={styles.dot(0)} />
				<span style={styles.dot(0.16)} />
				<span style={styles.dot(0.32)} />
				{label && <span style={styles.label}>{label}</span>}
			</div>
		</div>
	);
};
