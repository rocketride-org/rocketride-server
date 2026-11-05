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
// VECTOR-UI — DOCUMENT ROW (one document in the directory)
// =============================================================================
//
// Name, its health badges ('no first chunk', '1 deleted chunk' under "Needs
// attention"; a muted 'oversize' in a folder; two at most, then "+N"), chunk count ("—" when the store
// cannot count), a tables badge, a tooltip with size, type, ingest time, the
// health flags and the short objectId, a multi-select
// checkbox and the trash button (Move to trash). In the Trash view the row has
// Restore and Delete permanently instead. Every button is disabled with the
// reason whenever writing is not available; none sends anything itself: each
// asks the console, which confirms first where the write is permanent. Only
// the name selects the row, so no control inside it has to stop an event from
// reaching another.
// =============================================================================

import React from 'react';
import { BxTrash } from 'shell';
import type { Availability } from '../contract/types';
import type { IDirectoryRow } from '../vector/documents';
import { fileTypeOf, formatSize } from '../vector/fileType';
import { formatCount } from '../vector/stats';
import { TONE_EDGE } from '../vector/colors';
import { FOCUS_RING, styles } from '../styles';

/** Props for the {@link DocumentRow} component. */
export interface IDocumentRowProps {
	row: IDirectoryRow;
	selected: boolean;
	checked: boolean;
	writes: Availability;
	onSelect(): void;
	onToggleCheck(): void;
	/** Move to trash (the Documents view). */
	onRemove(): void;
	/** The Trash view: the row restores and deletes permanently instead. */
	mode?: 'active' | 'trash';
	onRestore?(): void;
	onDelete?(): void;
}

/**
 * The hover text of a row.
 *
 * @param row - The row.
 * @returns Path, type, size, ingest time and objectId.
 */
export function rowTooltip(row: IDirectoryRow): string {
	const { item } = row;
	const parts = [item.path || '(no path)', fileTypeOf(item.path)];
	if (item.size !== null) parts.push(formatSize(item.size));
	if (item.ingestedAt !== null) parts.push(`ingested ${item.ingestedAt.replace('T', ' ').replace('Z', ' UTC')}`);
	if (row.flags.length > 0) parts.push(row.attention ? `needs attention: ${row.flags.join(', ')}` : row.flags.join(', '));
	parts.push(`objectId ${item.objectId}`);
	return parts.join(' · ');
}

/**
 * One row.
 *
 * @param props - {@link IDocumentRowProps}.
 * @returns The row element.
 */
export function DocumentRow({ row, selected, checked, writes, onSelect, onToggleCheck, onRemove, mode = 'active', onRestore, onDelete }: IDocumentRowProps): React.ReactElement {
	const { item } = row;
	const label = item.path || item.objectId;
	const ring = {
		onFocus: (event: React.FocusEvent<HTMLButtonElement>) => (event.currentTarget.style.outline = FOCUS_RING),
		onBlur: (event: React.FocusEvent<HTMLButtonElement>) => (event.currentTarget.style.outline = 'none'),
	};
	const gated = { opacity: writes.enabled ? 1 : 0.55, cursor: writes.enabled ? 'pointer' : 'not-allowed' };
	// A defect is a warning; a badge on a row that stays in its folder (oversize) is a note.
	const badgeEdge = row.attention ? TONE_EDGE.warning : TONE_EDGE.muted;
	return (
		<div role="listitem" aria-current={selected ? 'true' : undefined} style={styles.row(selected)} title={rowTooltip(row)} data-object-id={item.objectId}>
			<input type="checkbox" checked={checked} aria-label={`Select ${label}`} onChange={onToggleCheck} style={{ margin: 0, outlineOffset: 2 }} disabled={!writes.enabled} />
			<button type="button" onClick={onSelect} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)} onBlur={(event) => (event.currentTarget.style.outline = 'none')}>
				{row.name}
				{row.duplicate ? ` (${row.shortId})` : ''}
			</button>
			{row.flags.slice(0, 2).map((flag) => (
				<span key={flag} style={styles.chip(badgeEdge)} data-flag="">
					{flag}
				</span>
			))}
			{row.flags.length > 2 && <span style={styles.chip(badgeEdge)}>{`+${row.flags.length - 2}`}</span>}
			{item.tables !== null && item.tables > 0 && <span style={styles.chip('var(--rr-border-input)')}>{`${formatCount(item.tables)} ${item.tables === 1 ? 'table' : 'tables'}`}</span>}
			<span style={{ ...styles.small, minWidth: 28, textAlign: 'right' }} aria-label={item.chunks === null ? 'chunk count unknown' : `${item.chunks} chunks`}>
				{item.chunks === null ? '—' : formatCount(item.chunks)}
			</span>
			{mode === 'trash' ? (
				<>
					<button
						type="button"
						style={{ ...styles.small, ...gated, background: 'none', border: '1px solid var(--rr-border-input)', borderRadius: 4, padding: '0 6px', color: 'inherit' }}
						aria-label={`Restore ${label}`}
						title={writes.enabled ? `Restore ${label}` : (writes.reason ?? undefined)}
						aria-disabled={!writes.enabled}
						disabled={!writes.enabled}
						onClick={() => {
							if (writes.enabled) onRestore?.();
						}}
						{...ring}
					>
						Restore
					</button>
					<button
						type="button"
						style={{ ...styles.iconButton, ...gated }}
						aria-label={`Delete ${label} permanently`}
						title={writes.enabled ? `Delete ${label} permanently` : (writes.reason ?? undefined)}
						aria-disabled={!writes.enabled}
						disabled={!writes.enabled}
						onClick={() => {
							if (writes.enabled) onDelete?.();
						}}
						{...ring}
					>
						<BxTrash />
					</button>
				</>
			) : (
				<button
					type="button"
					style={{ ...styles.iconButton, ...gated }}
					aria-label={`Move ${label} to the trash`}
					title={writes.enabled ? `Move ${label} to the trash` : (writes.reason ?? undefined)}
					aria-disabled={!writes.enabled}
					disabled={!writes.enabled}
					onClick={() => {
						if (writes.enabled) onRemove();
					}}
					{...ring}
				>
					<BxTrash />
				</button>
			)}
		</div>
	);
}

export default DocumentRow;
