// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppsIcon — the Apps rail/tab glyph: an app window (title bar + side panel).
 *
 * Shared by every host that surfaces the Apps mode (the rocket-ui workbench
 * rail and the VS Code sidebar mode tabs), so the same mode wears the same
 * glyph everywhere. Stroke-based, unlike the fill-based Codicon set, hence
 * its own component; the props mirror the shell's IconComponent contract so
 * it is interchangeable with any other icon.
 */

import React from 'react';
import type { CSSProperties } from 'react';

/** Props for {@link AppsIcon} — mirrors the shell's IconComponent contract. */
export interface AppsIconProps {
	size?: number;
	color?: string;
	className?: string;
	style?: CSSProperties;
}

/**
 * Renders the Apps window glyph.
 *
 * @param props - {@link AppsIconProps}.
 */
export const AppsIcon: React.FC<AppsIconProps> = ({ size = 20, color = 'currentColor', className, style }) => (
	<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
		<rect x="2" y="4" width="20" height="16" rx="2" />
		<path d="M2 9h20" />
		<path d="M8 9v11" />
	</svg>
);
