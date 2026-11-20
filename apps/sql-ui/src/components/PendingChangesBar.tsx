// =============================================================================
// MIT License
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
// SQL-UI — PENDING CHANGES BAR ("3 pending changes · Discard · Review SQL · Apply")
// =============================================================================
//
// Sits above the data grid while row edits are staged (sql/rowEdits.ts).
// It also says that closing the tab discards them: neither mount lets the
// app ask before a tab closes (every SQL Explorer document is static, which
// the shell never treats as dirty, and a dev-tool frame cannot veto its
// close), so the bar says it instead.
// Presentational: the counts and every action come from props, and it owns
// no dialog. Discard asks first only when two or more changes would go
// (discardNeedsConfirm, discardConfirmText); the parent shows that question
// and the Apply confirmation (ReviewSqlDialog.tsx ApplyConfirmDialog).
//
// The action is "Apply", never "Commit": without a transaction each change
// commits on its own, and "Commit" would promise one.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { Button } from 'shell';

// =============================================================================
// WORDING
// =============================================================================

/** Rows per kind of change, as sql/rowEdits.ts rowEditCounts reports them. */
export interface PendingCounts {
	/** Existing rows with changed fields. */
	edited: number;
	/** New rows. */
	inserted: number;
	/** Rows to delete. */
	deleted: number;
	/** All changes. */
	total: number;
}

/**
 * A count of something, singular or plural.
 *
 * @param n - The count.
 * @param one - The singular noun phrase.
 * @param many - The plural.
 * @returns `1 change`, `3 changes`.
 */
function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * The bar's headline.
 *
 * @param total - How many changes are staged.
 * @returns `3 pending changes`.
 */
export function pendingCountText(total: number): string {
	return count(total, 'pending change', 'pending changes');
}

/**
 * What the changes are, after the headline.
 *
 * @param table - The table.
 * @param counts - The staged rows per kind.
 * @returns `to orders: 1 edited row, 1 new row, 1 deleted row. Nothing is saved yet, and closing this tab discards them.`
 */
export function pendingDetailText(table: string, counts: PendingCounts): string {
	const parts = [
		counts.edited > 0 ? count(counts.edited, 'edited row', 'edited rows') : '',
		counts.inserted > 0 ? count(counts.inserted, 'new row', 'new rows') : '',
		counts.deleted > 0 ? count(counts.deleted, 'deleted row', 'deleted rows') : '',
	].filter((part) => part !== '');
	return `to ${table}: ${parts.join(', ')}. Nothing is saved yet, and closing this tab discards ${counts.total === 1 ? 'it' : 'them'}.`;
}

/**
 * The Apply button's label.
 *
 * @param total - How many changes are staged.
 * @returns `Apply 3 changes`.
 */
export function applyButtonLabel(total: number): string {
	return `Apply ${count(total, 'change', 'changes')}`;
}

/**
 * Whether Discard asks first: only when two or more changes would be lost.
 *
 * @param total - How many changes are staged.
 * @returns True to ask.
 */
export function discardNeedsConfirm(total: number): boolean {
	return total >= 2;
}

/**
 * The Discard question.
 *
 * @param total - How many changes are staged.
 * @returns `Discard 3 pending changes? This cannot be undone.`
 */
export function discardConfirmText(total: number): string {
	return `Discard ${pendingCountText(total)}? This cannot be undone.`;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	bar: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '8px 12px',
		borderBottom: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-widget)',
		fontSize: 12.5,
		flexWrap: 'wrap',
	} as CSSProperties,

	// A non-colour marker beside the tint: the dot is decoration, the words carry it.
	marker: {
		width: 8,
		height: 8,
		borderRadius: '50%',
		background: 'var(--rr-brand)',
		flexShrink: 0,
	} as CSSProperties,

	text: {
		flex: 1,
		minWidth: 200,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	count: {
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	actions: {
		display: 'flex',
		gap: 8,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for the {@link PendingChangesBar} component. */
export interface PendingChangesBarProps {
	/** The table the changes are staged for. */
	table: string;
	/** The staged rows per kind (sql/rowEdits.ts rowEditCounts). */
	counts: PendingCounts;
	/** An apply is running: every action waits for it. */
	busy?: boolean;
	/** The Apply button's words while busy (default "Applying..."). */
	busyLabel?: string;
	/** Why Apply cannot run now (statements are off, the engine is not reachable), or null. */
	applyDisabledReason?: string | null;
	/** Discard was chosen (the parent asks first when {@link discardNeedsConfirm}). */
	onDiscard: () => void;
	/** Review SQL was chosen. */
	onReview: () => void;
	/** Apply was chosen (the parent confirms first). */
	onApply: () => void;
}

/**
 * The pending-changes bar. Renders nothing while no change is staged.
 *
 * @param props - {@link PendingChangesBarProps}.
 * @returns The bar, or null.
 */
export const PendingChangesBar: React.FC<PendingChangesBarProps> = ({ table, counts, busy = false, busyLabel = 'Applying...', applyDisabledReason = null, onDiscard, onReview, onApply }) => {
	if (counts.total === 0) return null;
	return (
		<div role="region" aria-label="Pending changes" style={styles.bar}>
			<span style={styles.marker} aria-hidden="true" />
			<span style={styles.text}>
				<span style={styles.count}>{pendingCountText(counts.total)}</span> {pendingDetailText(table, counts)}
			</span>
			<span style={styles.actions}>
				<Button variant="ghost" small onClick={onDiscard} disabled={busy}>Discard</Button>
				<Button variant="secondary" small onClick={onReview} disabled={busy}>Review SQL</Button>
				<Button
					variant="primary"
					small
					onClick={onApply}
					disabled={busy || applyDisabledReason !== null}
					{...(applyDisabledReason !== null ? { title: applyDisabledReason } : {})}
				>
					{busy ? busyLabel : applyButtonLabel(counts.total)}
				</Button>
			</span>
		</div>
	);
};

export default PendingChangesBar;
