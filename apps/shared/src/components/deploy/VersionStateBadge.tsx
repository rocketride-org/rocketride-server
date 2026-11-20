// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// VERSION STATE BADGE — the card's review (or build) state
// =============================================================================

/**
 * The state badge of a deployed-version card, shared by both DEPLOY screens:
 * the review state ('draft', 'in review', 'ready', 'rejected', 'failed') or,
 * on an app whose build has not finished, the build word. The screen picks
 * the badge with `versionBadgeOf`; a failed build's badge is a door to the
 * build log when the screen can open one. Pipes never build, so their badge
 * is always the review state.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import { StatusBadge } from 'shell';
import { buttonize } from '../../utils/buttonize';

// =============================================================================
// PROPS
// =============================================================================

/** The badge a card shows (the shape `versionBadgeOf` returns). */
export interface IVersionStateBadge {
	/** The StatusBadge variant. */
	variant: 'muted' | 'info' | 'success' | 'warning' | 'error';
	/** The word on the badge. */
	label: string;
	/** The badge opens the version's build log (a failed build). */
	opensBuildLog: boolean;
}

/** Props for {@link VersionStateBadge}. */
export interface IVersionStateBadgeProps {
	/** The badge, or null when there is nothing to show (no known state). */
	badge: IVersionStateBadge | null;
	/** Opens the build log; without it a failed build's badge is a plain badge. */
	onOpenBuildLog?: () => void;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	// The failed badge is a DOOR (click opens the build log): cursor and
	// title carry the affordance; the badge itself stays the stock chip.
	door: {
		cursor: 'pointer',
		display: 'inline-flex',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a version card's state badge.
 *
 * @param props - See {@link IVersionStateBadgeProps}.
 */
export const VersionStateBadge: React.FC<IVersionStateBadgeProps> = ({ badge, onOpenBuildLog }) => {
	if (!badge) return null;
	const pill = <StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>;
	if (!badge.opensBuildLog || !onOpenBuildLog) return pill;
	return (
		<span
			style={S.door}
			title="Show the build log"
			{...buttonize((e) => {
				// A card may open a drawer of its own on click.
				e.stopPropagation();
				onOpenBuildLog();
			})}
		>
			{pill}
		</span>
	);
};
