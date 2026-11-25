// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AgentTile — an agent's icon: its listing's icon image, or its initial on a
 * colour picked from its name, at three sizes (row, header, empty thread).
 */

import React, { type CSSProperties } from 'react';

// =============================================================================
// STYLES
// =============================================================================

/** Tile sizes: a tree row, a header, an empty thread's centre. */
const SIZES = {
	s: { box: 22, font: 11, radius: 6 },
	m: { box: 34, font: 15, radius: 8 },
	xl: { box: 64, font: 28, radius: 16 },
} as const;

/** Grounds for letter tiles — the theme's chart palette, so every theme tints them. */
const GROUNDS = ['var(--rr-chart-blue)', 'var(--rr-chart-green)', 'var(--rr-chart-purple)', 'var(--rr-chart-orange)', 'var(--rr-chart-red)', 'var(--rr-chart-yellow)'];

const styles = {
	letter: (size: keyof typeof SIZES, ground: string): CSSProperties => ({
		width: SIZES[size].box,
		height: SIZES[size].box,
		borderRadius: SIZES[size].radius,
		backgroundColor: ground,
		color: 'var(--rr-fg-button)',
		fontSize: SIZES[size].font,
		fontWeight: 800,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		flexShrink: 0,
	}),
	image: (size: keyof typeof SIZES): CSSProperties => ({
		width: SIZES[size].box,
		height: SIZES[size].box,
		borderRadius: SIZES[size].radius,
		objectFit: 'contain',
		flexShrink: 0,
	}),
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link AgentTile}. */
export interface IAgentTileProps {
	/** The agent's name (its initial, and the colour's seed). */
	name: string;
	/** The listing's icon URL, when it has one. */
	icon?: string;
	/** Row, header or empty-thread size. */
	size: keyof typeof SIZES;
}

/**
 * A stable colour for a name.
 *
 * @param name - The name.
 * @returns One of the theme's chart colours.
 */
function groundFor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	return GROUNDS[hash % GROUNDS.length];
}

/**
 * Renders an agent's icon tile.
 *
 * @param props - {@link IAgentTileProps}.
 * @returns The tile.
 */
export const AgentTile: React.FC<IAgentTileProps> = ({ name, icon, size }) => {
	// A listing icon is an <img>, which the shell has no control for.
	if (icon) return <img src={icon} alt="" style={styles.image(size)} />;
	// A custom tile (no shell control): the initial on the name's colour.
	return <span style={styles.letter(size, groundFor(name))}>{(name.trim().charAt(0) || '?').toUpperCase()}</span>;
};
