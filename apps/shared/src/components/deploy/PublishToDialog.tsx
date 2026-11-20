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
// PUBLISH TO DIALOG — "Publish vN to…", one row per audience
// =============================================================================

/**
 * The "Publish vN to…" dialog both DEPLOY screens open from a version card
 * (mockups 1.10 and 2.14): one row per audience (Me, each team, the store),
 * the audience's current state on the right, and choosing a row IS the
 * choice; the screen then confirms the pointer move.
 *
 * The rows are the screen's: it decides what each says and whether it can be
 * chosen (the store before approval, the audience already on this version).
 * A row that cannot be chosen stays visible and says why, so the ladder is
 * learnable. Everything is inert while the screen is busy; Cancel stays.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import { Button, Modal } from 'shell';
import { buttonize } from '../../utils/buttonize';

// =============================================================================
// PROPS
// =============================================================================

/** One audience row of the dialog. */
export interface IPublishTarget {
	/** What the screen publishes to when the row is chosen ('@me', a team, '@public'). */
	id: string;
	/** Row label ('Me', a team name, 'Public: the store'). */
	label: string;
	/** The audience's current state, right-aligned ('not published yet', 'already on v4', ...). */
	note: string;
	/** Visible but not choosable. */
	disabled?: boolean;
	/** Why the row cannot be chosen (its tooltip). */
	disabledTitle?: string;
}

/** Props for {@link PublishToDialog}. */
export interface IPublishToDialogProps {
	/** Dialog title ('Publish v5 to…'). */
	title: string;
	/** The one-line explanation under the title. */
	hint: string;
	/** The audience rows, in display order. */
	targets: readonly IPublishTarget[];
	/** A row was chosen. */
	onChoose: (id: string) => void;
	/** The dialog was dismissed. */
	onCancel: () => void;
	/** The screen is running a verb: every row is inert. */
	busy?: boolean;
	/** The screen's last failure, shown under the rows. */
	error?: string;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	hint: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		marginBottom: 10,
		lineHeight: 1.5,
	} as CSSProperties,
	// A full-width option row: label left, current state right.
	row: (enabled: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '10px 14px',
		marginBottom: 8,
		fontSize: 12.5,
		fontWeight: 600,
		background: 'var(--rr-bg-input)',
		color: enabled ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		cursor: enabled ? 'pointer' : 'not-allowed',
		opacity: enabled ? 1 : 0.55,
	}),
	note: {
		marginLeft: 'auto',
		fontSize: 11.5,
		fontWeight: 400,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
	} as CSSProperties,
	error: {
		color: 'var(--rr-color-error)',
		fontSize: 12.5,
		marginTop: 8,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the audience picker of a version.
 *
 * @param props - See {@link IPublishToDialogProps}.
 */
export const PublishToDialog: React.FC<IPublishToDialogProps> = ({ title, hint, targets, onChoose, onCancel, busy = false, error }) => (
	<Modal
		title={title}
		onClose={onCancel}
		footer={
			<Button variant="secondary" disabled={busy} onClick={onCancel}>
				Cancel
			</Button>
		}
	>
		<div style={S.hint}>{hint}</div>
		{targets.map((target) => {
			const enabled = !target.disabled && !busy;
			return (
				// Raw option row: the shell has no selectable list-row control (label left, state right).
				<div key={target.id} style={S.row(enabled)} title={target.disabled ? target.disabledTitle : undefined} {...buttonize(() => onChoose(target.id), enabled)}>
					{target.label}
					<span style={S.note}>{target.note}</span>
				</div>
			);
		})}
		{error ? <div style={S.error}>{error}</div> : null}
	</Modal>
);
