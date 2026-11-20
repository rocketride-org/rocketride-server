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
// DELETE VERSION MARK — the card's top-right delete, present only when deletable
// =============================================================================

/**
 * The delete mark of a deployed-version card (plan 2.3, `deploy delete`),
 * shared by both DEPLOY screens so the rule lives once:
 *
 * - It renders ONLY while the server says the version is deletable (no rung
 *   pins it, it is not in review, its build is not running) AND the host can
 *   delete. Otherwise nothing renders — no greyed control, no reason text
 *   (decided 2026-11-16).
 * - It is confirmed before it runs: the dialog says what goes (the version's
 *   storage), what stays (the history) and that the number is never reused.
 * - It sits at the card's top-right corner: the host card is positioned
 *   relative, this mark is absolute. Clicks never reach the card (a card may
 *   open a drawer on click).
 *
 * Errors are the screen's: `onDelete` rejects with the server's sentence
 * and the screen shows it where its other verbs show theirs.
 */

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, ConfirmDialog } from 'shell';

// =============================================================================
// PROPS
// =============================================================================

/** Props for {@link DeleteVersionMark}. */
export interface IDeleteVersionMarkProps {
	/** The registry version the mark deletes. */
	version: number;
	/** The server's own check: whether `deploy delete` would take the version now. */
	deletable: boolean | undefined;
	/** What the confirmation calls the thing ('this pipeline', the app name). */
	subject: string;
	/** Runs the delete; rejects with the server's refusal sentence. */
	onDelete: ((version: number) => Promise<void>) | undefined;
	/** The screen is busy with another verb. */
	disabled?: boolean;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	// Top-right corner of a relatively positioned card; above the card's
	// own click target so the mark is never swallowed by it.
	corner: {
		position: 'absolute',
		top: 4,
		right: 4,
		zIndex: 1,
		lineHeight: 1,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the card's delete mark when, and only when, the version is deletable.
 *
 * @param props - See {@link IDeleteVersionMarkProps}.
 */
export const DeleteVersionMark: React.FC<IDeleteVersionMarkProps> = ({ version, deletable, subject, onDelete, disabled = false }) => {
	const [confirming, setConfirming] = useState(false);

	// step: no mark at all unless the server says so and the host can act
	if (!deletable || !onDelete) return null;

	return (
		<div
			style={S.corner}
			// The card around the mark may be a button of its own (opens a
			// drawer): neither the click nor Enter/Space may reach it.
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<Button variant="ghost" mini disabled={disabled} ariaLabel={`Delete v${version}`} title={`Delete v${version} from the server`} onClick={() => setConfirming(true)}>
				&#10005;
			</Button>
			{confirming && (
				<ConfirmDialog
					title={`Delete v${version} of ${subject}?`}
					message={`Removes v${version} from the server: its deployed files and build are deleted and cannot be recovered. The history keeps the record, and v${version} is never reused. Nothing is serving this version.`}
					confirmLabel="Delete"
					cancelLabel="Cancel"
					destructive
					onConfirm={() => {
						setConfirming(false);
						void onDelete(version);
					}}
					onCancel={() => setConfirming(false)}
				/>
			)}
		</div>
	);
};
