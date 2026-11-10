// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// REVEALTEXT — per-character left-to-right text reveal (desktop greeting)
// =============================================================================
//
// Copied from home-ui's components/ui/RevealText (home-ui keeps its own copy
// for other surfaces). Characters animate individually, but each WORD is
// wrapped in a nowrap inline-block so a word never splits across lines —
// line breaks only happen at the spaces between words. Honors
// prefers-reduced-motion by rendering statically.

import React, { useEffect } from 'react';

const KEYFRAME_ID = 'rr-desktop-reveal';

const REDUCE_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Inject the reveal keyframe once per document. */
function injectKeyframes(): void {
	if (document.getElementById(KEYFRAME_ID)) return;
	const el = document.createElement('style');
	el.id = KEYFRAME_ID;
	el.textContent = `
		@keyframes rr-desktop-word-in {
			from { opacity: 0; transform: translateX(-10px); }
			to   { opacity: 1; transform: translateX(0); }
		}
	`;
	document.head.appendChild(el);
}

/**
 * Renders text with a per-character LTR reveal cascade.
 *
 * @param props.text - The text to reveal. Re-key the element to replay.
 */
export const RevealText: React.FC<{ text: string }> = ({ text }) => {
	useEffect(() => { injectKeyframes(); }, []);

	if (REDUCE_MOTION) return <>{text}</>;

	const words = text.split(' ');
	let idx = 0; // global char index — keeps the LTR cascade continuous across words

	return (
		<>
			{words.map((word, wi) => {
				const chars = word.split('').map((char, ci) => {
					const delay = idx++ * 25;
					return (
						<span
							key={ci}
							style={{
								display: 'inline-block',
								opacity: 0,
								animation: 'rr-desktop-word-in 500ms cubic-bezier(0.22, 1, 0.36, 1) forwards',
								animationDelay: `${delay}ms`,
							}}
						>
							{char}
						</span>
					);
				});
				idx++; // count the following space so timing stays continuous
				return (
					<React.Fragment key={wi}>
						<span style={{ display: 'inline-block', whiteSpace: 'nowrap' }}>{chars}</span>
						{wi < words.length - 1 ? ' ' : null}
					</React.Fragment>
				);
			})}
		</>
	);
};
