/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

/**
 * Confetti — a short burst of falling confetti over the whole window, for a
 * real milestone (setup finished, first deploy). Pieces take the chart series
 * colours, so they follow the theme. Never takes clicks, is hidden from
 * assistive tech, and draws nothing under `prefers-reduced-motion`. Mount it
 * for as long as the burst should run; each piece falls once.
 *
 * Built on `.rr-confetti` from components.css; portalled to the document body.
 */

import React, { useMemo } from 'react';
import { createPortal } from 'react-dom';

/** Props for the {@link Confetti} component. */
export interface IConfettiProps {
	/** How many pieces fall. Defaults to 140. */
	pieceCount?: number;
}

/** The series colours the pieces cycle through. */
const PIECE_COLORS = ['var(--rr-chart-series-1)', 'var(--rr-chart-series-2)', 'var(--rr-chart-series-3)', 'var(--rr-chart-series-4)', 'var(--rr-chart-series-5)', 'var(--rr-accent)'];

/** One piece's place and timing. */
type Piece = { left: number; delay: number; duration: number; drift: number; spin: number; width: number; color: string };

/**
 * Renders the burst.
 *
 * @param props - {@link IConfettiProps}.
 * @returns The confetti layer, or nothing under reduced motion.
 */
export function Confetti({ pieceCount = 140 }: IConfettiProps): React.ReactElement | null {
	const pieces = useMemo(() => buildPieces(pieceCount), [pieceCount]);
	if (prefersReducedMotion()) return null;
	return createPortal(
		<div className="rr-confetti" aria-hidden="true">
			{pieces.map((piece, index) => (
				<span key={index} className="rr-confetti__piece" style={pieceStyle(piece)} />
			))}
		</div>,
		document.body
	);
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Scatters the pieces across the top of the window.
 *
 * @param count - How many pieces.
 * @returns Each piece's place and timing.
 */
function buildPieces(count: number): Piece[] {
	const pieces: Piece[] = [];
	for (let index = 0; index < count; index += 1) {
		pieces.push({
			left: Math.random() * 100,
			delay: Math.random() * 900,
			duration: 2600 + Math.random() * 1800,
			drift: (Math.random() - 0.5) * 240,
			spin: 360 + Math.random() * 720,
			width: 6 + Math.random() * 6,
			color: PIECE_COLORS[index % PIECE_COLORS.length],
		});
	}
	return pieces;
}

/**
 * A piece's inline style: its place, colour and the custom properties its
 * fall animation reads.
 *
 * @param piece - The piece.
 * @returns The style.
 */
function pieceStyle(piece: Piece): React.CSSProperties {
	return {
		left: `${piece.left}%`,
		width: piece.width,
		height: piece.width * 0.45,
		background: piece.color,
		animationDelay: `${piece.delay}ms`,
		animationDuration: `${piece.duration}ms`,
		['--rr-confetti-drift' as string]: `${piece.drift}px`,
		['--rr-confetti-spin' as string]: `${piece.spin}deg`,
	};
}

/**
 * Whether the person asked the system for less motion.
 *
 * @returns True under `prefers-reduced-motion: reduce`.
 */
function prefersReducedMotion(): boolean {
	if (typeof window === 'undefined' || !window.matchMedia) return false;
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
