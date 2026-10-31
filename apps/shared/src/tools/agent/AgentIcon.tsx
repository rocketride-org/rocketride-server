// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AgentIcon — the Agent rail icon: a chat-bubble robot that blinks, sways its
 * antenna, and bobs a waving hand.
 *
 * Inline SVG so it inherits `currentColor` from the rail like every other
 * glyph. The <style> block rides inside the SVG but its rules are
 * DOCUMENT-GLOBAL once inlined in HTML, so every class and keyframe carries
 * the `rr-agent-` prefix to keep them collision-proof. Motion respects
 * `prefers-reduced-motion`.
 */

import React from 'react';

/** Props for {@link AgentIcon}. */
export interface AgentIconProps {
	/** Square size in px (the rail standard is 20). */
	size?: number;
}

/**
 * Renders the animated Agent glyph.
 *
 * @param props - {@link AgentIconProps}.
 */
export const AgentIcon: React.FC<AgentIconProps> = ({ size = 20 }) => (
	<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round">
		<style>{`
			.rr-agent-eye  { transform-box: fill-box; transform-origin: center;    animation: rr-agent-blink 4s infinite; }
			.rr-agent-ant  { transform-box: fill-box; transform-origin: 100% 100%; animation: rr-agent-sway 3s ease-in-out infinite; }
			.rr-agent-hand { transform-box: fill-box; transform-origin: 30% 100%;  animation: rr-agent-bob 2s ease-in-out infinite; }
			@keyframes rr-agent-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(.1); } }
			@keyframes rr-agent-sway  { 0%, 100% { transform: rotate(0); } 50% { transform: rotate(12deg); } }
			@keyframes rr-agent-bob   { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-.6px); } }
			@media (prefers-reduced-motion: reduce) { .rr-agent-eye, .rr-agent-ant, .rr-agent-hand { animation: none; } }
		`}</style>
		<g transform="translate(-2.3 0)">
			<path d="M12 6c4.4 0 8 3.1 8 7s-3.6 7-8 7c-1 0-2-.15-2.9-.45L5 21l.9-3.3C4.7 16.4 4 14.8 4 13c0-3.9 3.6-7 8-7z" />
			<g className="rr-agent-ant">
				<path d="M12 6V4.5l-1.2-1.2" />
				<circle cx="10.2" cy="2.6" r="1.1" fill="currentColor" stroke="none" />
			</g>
			<circle className="rr-agent-eye" cx="9.5" cy="12.5" r="1.4" fill="currentColor" stroke="none" />
			<circle className="rr-agent-eye" cx="14.5" cy="12.5" r="1.4" fill="currentColor" stroke="none" />
			<path d="M8.2 10.2l2-.7M15.8 10.2l-2-.7" />
		</g>
		<g transform="translate(-0.8 0)">
			<path d="M18.6 14.6l2.4.6.4-3" />
			<g className="rr-agent-hand">
				<rect x="20.3" y="9.8" width="3.8" height="2.4" rx="1" fill="currentColor" stroke="none" />
				<circle cx="21.95" cy="9.9" r=".65" fill="currentColor" stroke="none" />
				<circle cx="22.85" cy="9.9" r=".65" fill="currentColor" stroke="none" />
				<circle cx="23.65" cy="10.1" r=".6" fill="currentColor" stroke="none" />
				<path d="M20.95 10.2V6.6" />
			</g>
		</g>
	</svg>
);
