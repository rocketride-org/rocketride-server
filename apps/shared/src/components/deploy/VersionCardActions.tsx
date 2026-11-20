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
// VERSION CARD ACTIONS — Publish to… / Submit for review / Withdraw
// =============================================================================

/**
 * The action row of a deployed-version card, shared by both DEPLOY screens
 * (mockups 1.9 and 2.13): pinned to the card's bottom under the chips, one
 * button per verb the card offers. Which verbs a card offers is decided by
 * `versionCardActionsOf` (reviewRules); this only draws them.
 *
 * Clicks never reach the card: a card may open a drawer of its own.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import { Button } from 'shell';
import type { IVersionCardActions } from './reviewRules';

// =============================================================================
// PROPS
// =============================================================================

/** Props for {@link VersionCardActions}. */
export interface IVersionCardActionsProps {
	/** The verbs this card offers (`versionCardActionsOf`). */
	actions: IVersionCardActions;
	/** Opens the audience choice ("Publish to…"). */
	onPublish: () => void;
	/** Submits the version for review. */
	onSubmit: () => void;
	/** Withdraws the pending review. */
	onWithdraw: () => void;
	/** The screen is running a verb. */
	disabled?: boolean;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	// Follows the bottom-pinned chip row, which carries the auto margin.
	row: {
		paddingTop: 10,
		display: 'flex',
		gap: 6,
		flexWrap: 'wrap',
		alignItems: 'center',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a version card's verbs; nothing when it offers none.
 *
 * @param props - See {@link IVersionCardActionsProps}.
 */
export const VersionCardActions: React.FC<IVersionCardActionsProps> = ({ actions, onPublish, onSubmit, onWithdraw, disabled = false }) => {
	if (!actions.publish && !actions.submit && !actions.withdraw) return null;
	return (
		// Nested real buttons: keep both event paths from bubbling into a
		// card that is a button of its own.
		<div style={S.row} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
			{actions.publish && (
				<Button variant="secondary" small disabled={disabled} onClick={onPublish}>
					Publish to…
				</Button>
			)}
			{actions.submit && (
				<Button variant="secondary" small disabled={disabled} onClick={onSubmit}>
					Submit for review
				</Button>
			)}
			{actions.withdraw && (
				<Button variant="secondary" small disabled={disabled} onClick={onWithdraw}>
					Withdraw
				</Button>
			)}
		</div>
	);
};
