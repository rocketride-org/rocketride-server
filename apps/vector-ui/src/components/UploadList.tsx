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
// VECTOR-UI — UploadList (one row per dropped file)
// =============================================================================
//
// Each row: the path, a progress bar while bytes are sent, and the row's
// words (uploads.ts uploadLabel) — "Uploading… 40%", "Processing…",
// "7 chunks added", or a sentence saying why it was not added. The words
// carry the whole message; the colour of the status mark only repeats it.
// What the engine said about a failure is one click away, not in the row.
//
// Above the rows, the summary of each drop (IngestSummary): the latest drop
// first, earlier ones under a disclosure — "Drop of 12 files: 9 added
// (341 chunks) · 2 replaced (19 chunks) · 1 not added · 00:48", live while
// it runs (the clock ticks once a second, the line is not a live region:
// the queue announces a finished drop once). A finished drop that stored
// counted chunks offers "Show new chunks on the map", disabled with the
// reason when the store cannot place them; once used, a drop cut at the
// map's pin limit says how many of how many were placed.
// =============================================================================

import React, { useEffect, useId, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';
import { FINISHED, REPLACED_PLACE_SENTENCE, SHOW_NEW_LABEL, UNCOUNTED_SENTENCE, dropSummaryParts, placedSentence, summariseDrop, uploadLabel } from '../vector/uploads';
import type { IngestDrop, UploadRow, UploadStatus } from '../vector/uploads';

/** Props of {@link UploadList}. */
export interface UploadListProps {
	rows: readonly UploadRow[];
	/** Sentences about the latest drop. */
	notes: readonly string[];
	onClearFinished(): void;
	/** The connection's drops, oldest first (the queue's state); absent: no summary is shown. */
	drops?: readonly IngestDrop[];
	/** "Show new chunks on the map" under a finished drop; absent: the button is not offered. */
	onShowNew?(dropId: string): void;
	/** Why this store's map cannot show new chunks (no map, or no placing outside the sample); null when it can. */
	showNewReason?: string | null;
	/** Most chunks the map pins outside its sample (limits.project_keys_max), for "N of M new chunks placed". */
	pinLimit?: number;
	/** The clock in ms since the epoch (tests); absent: the real clock, ticking each second while a drop runs. */
	now?: number;
}

/** Props of {@link IngestSummary}. */
export interface IngestSummaryProps {
	/** The drops, oldest first. */
	drops: readonly IngestDrop[];
	/** The rows still listed (the drops' running rows are read from here). */
	rows: readonly UploadRow[];
	now: number;
	onShowNew?(dropId: string): void;
	showNewReason: string | null;
	pinLimit: number;
}

const S = {
	list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' } as CSSProperties,
	row: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 8, rowGap: 2, alignItems: 'center', fontSize: 12, padding: '3px 4px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	path: { color: 'var(--rr-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	label: { color: 'var(--rr-text-secondary)', textAlign: 'right', maxWidth: 320, overflowWrap: 'anywhere' } as CSSProperties,
	bar: { gridColumn: '1 / span 2', height: 4, borderRadius: 2, background: 'var(--rr-bg-widget)', overflow: 'hidden' } as CSSProperties,
	fill: { height: '100%', background: 'var(--rr-border-focus)' } as CSSProperties,
	detail: { gridColumn: '1 / span 2', fontSize: 11, color: 'var(--rr-text-secondary)' } as CSSProperties,
	notes: { margin: '0 0 4px', paddingLeft: 16, fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
	footer: { display: 'flex', justifyContent: 'flex-end', marginTop: 4 } as CSSProperties,
	summary: { display: 'flex', flexDirection: 'column', gap: 6, margin: '0 0 6px', padding: '6px 8px', borderRadius: 4, background: 'var(--rr-bg-widget)', fontSize: 12 } as CSSProperties,
	drop: { display: 'flex', flexDirection: 'column', gap: 4 } as CSSProperties,
	line: { margin: 0, color: 'var(--rr-text-primary)', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' } as CSSProperties,
	segment: { whiteSpace: 'nowrap' } as CSSProperties,
	actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as CSSProperties,
	reason: { fontSize: 11, color: 'var(--rr-text-secondary)', overflowWrap: 'anywhere' } as CSSProperties,
	note: { margin: 0, fontSize: 11, color: 'var(--rr-text-secondary)', overflowWrap: 'anywhere' } as CSSProperties,
	earlier: { fontSize: 11, color: 'var(--rr-text-secondary)' } as CSSProperties,
	earlierList: { listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
};

/** The pin limit the contract documents, for hosts that do not pass one. */
const DEFAULT_PIN_LIMIT = 200;

/**
 * The time: `fixed` when given, else the real clock, ticking once a second while `running`.
 *
 * @param fixed - A fixed time (tests), or undefined.
 * @param running - Whether a drop is running.
 * @returns Milliseconds since the epoch.
 */
function useNow(fixed: number | undefined, running: boolean): number {
	const [tick, setTick] = useState(() => Date.now());
	useEffect(() => {
		if (fixed !== undefined || !running) return undefined;
		setTick(Date.now());
		const timer = setInterval(() => setTick(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [fixed, running]);
	return fixed ?? tick;
}

/**
 * One drop's line, its "Show new chunks on the map", and what it placed.
 *
 * @param props - The drop and the summary's props.
 * @returns The drop.
 */
function DropLine({ drop, rows, now, onShowNew, showNewReason, pinLimit }: Omit<IngestSummaryProps, 'drops'> & { drop: IngestDrop }): React.ReactElement {
	const reasonId = useId();
	const summary = summariseDrop(drop, rows, now);
	const stored = summary.added + summary.replaced;
	// Offered once the drop has finished and stored something; disabled when its chunks cannot be found or placed.
	const offer = onShowNew !== undefined && summary.finished && (summary.newChunks > 0 || (stored > 0 && summary.uncounted > 0));
	const reason = summary.newChunks > 0 ? showNewReason : UNCOUNTED_SENTENCE;
	const shown = summary.shown;
	const placed = shown === null ? null : placedSentence(shown.placed, shown.total, pinLimit);
	const n = (value: number): string => value.toLocaleString('en-US');
	const line = dropSummaryParts(summary);
	const disabled = reason !== null;
	return (
		<div
			style={S.drop}
			data-drop={drop.id}
			data-finished={String(summary.finished)}
			data-files={summary.files}
			data-added={summary.added}
			data-replaced={summary.replaced}
			data-not-added={summary.notAdded}
			data-cancelled={summary.cancelled}
			data-waiting={summary.waiting}
			data-in-progress={summary.inProgress}
			data-new-chunks={summary.newChunks}
			data-placed={shown?.placed}
			data-total={shown?.total}
		>
			<p style={S.line}>
				{`${line.head} `}
				{line.parts.map((part, index) => (
					<React.Fragment key={index}>
						{index > 0 ? ' · ' : null}
						<span style={S.segment}>{part}</span>
					</React.Fragment>
				))}
			</p>
			{offer && (
				<div style={S.actions}>
					<button type="button" style={disabled ? { ...commonStyles.buttonSecondary, ...commonStyles.buttonDisabled } : commonStyles.buttonSecondary} disabled={disabled} aria-describedby={disabled ? reasonId : undefined} onClick={() => onShowNew?.(drop.id)}>
						{SHOW_NEW_LABEL}
					</button>
					{disabled && (
						<span id={reasonId} style={S.reason}>
							{reason}
						</span>
					)}
				</div>
			)}
			{offer && summary.newChunks > 0 && summary.uncounted > 0 && <p style={S.note}>{summary.uncounted === 1 ? '1 document without a chunk count is not shown on the map.' : `${n(summary.uncounted)} documents without a chunk count are not shown on the map.`}</p>}
			{placed !== null && <p style={S.note}>{placed}</p>}
			{shown !== null && summary.replaced > 0 && <p style={S.note}>{REPLACED_PLACE_SENTENCE}</p>}
		</div>
	);
}

/**
 * The summary of the drops above the upload rows: the latest drop first,
 * earlier ones under a disclosure.
 *
 * @param props - {@link IngestSummaryProps}.
 * @returns The summary, or null without a drop.
 */
export function IngestSummary({ drops, ...rest }: IngestSummaryProps): React.ReactElement | null {
	if (drops.length === 0) return null;
	const latest = drops[drops.length - 1] as IngestDrop;
	const earlier = drops.slice(0, -1).reverse();
	return (
		<div role="group" aria-label="Drop summary" data-component="IngestSummary" style={S.summary}>
			<DropLine drop={latest} {...rest} />
			{earlier.length > 0 && (
				<details style={S.earlier}>
					<summary>{`Earlier drops (${earlier.length.toLocaleString('en-US')})`}</summary>
					<ul style={S.earlierList} aria-label="Earlier drops">
						{earlier.map((drop) => (
							<li key={drop.id}>
								<DropLine drop={drop} {...rest} />
							</li>
						))}
					</ul>
				</details>
			)}
		</div>
	);
}

/** The status mark's colour (the label says the same in words). */
const MARK: Partial<Record<UploadStatus, string>> = {
	done: 'var(--rr-color-success)',
	failed: 'var(--rr-color-error)',
	refused: 'var(--rr-color-warning)',
	cancelled: 'var(--rr-text-secondary)',
};

/**
 * The upload list.
 *
 * @param props - {@link UploadListProps}.
 * @returns The list, or null when empty.
 */
export function UploadList({ rows, notes, onClearFinished, drops, onShowNew, showNewReason = null, pinLimit = DEFAULT_PIN_LIMIT, now }: UploadListProps): React.ReactElement | null {
	const clock = useNow(now, drops?.some((drop) => drop.finishedAt === null) ?? false);
	if (rows.length === 0 && notes.length === 0 && (drops?.length ?? 0) === 0) return null;
	const finished = rows.filter((row) => FINISHED.has(row.status)).length;
	return (
		<div>
			{drops !== undefined && <IngestSummary drops={drops} rows={rows} now={clock} onShowNew={onShowNew} showNewReason={showNewReason} pinLimit={pinLimit} />}
			{notes.length > 0 && (
				<ul style={S.notes} aria-label="About the last drop">
					{notes.map((note, index) => (
						<li key={index}>{note}</li>
					))}
				</ul>
			)}
			<ul style={S.list} aria-label="Uploads">
				{rows.map((row) => {
					const label = uploadLabel(row);
					const sending = row.status === 'uploading';
					const percent = row.fileSize > 0 ? Math.min(100, Math.round((row.bytesSent / row.fileSize) * 100)) : 0;
					return (
						<li key={row.id} style={S.row} data-status={row.status}>
							<span style={S.path} title={row.path}>
								<span aria-hidden="true" style={{ color: MARK[row.status] ?? 'var(--rr-border-focus)', marginRight: 6 }}>
									●
								</span>
								{row.path}
							</span>
							<span style={S.label}>{label}</span>
							{sending && (
								<div role="progressbar" aria-label={`Uploading ${row.path}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} style={S.bar}>
									<div style={{ ...S.fill, width: `${percent}%` }} />
								</div>
							)}
							{row.detail !== null && (
								<details style={S.detail}>
									<summary>What the engine said</summary>
									{row.detail}
								</details>
							)}
						</li>
					);
				})}
			</ul>
			{finished > 0 && (
				<div style={S.footer}>
					<button type="button" style={commonStyles.buttonSecondary} onClick={onClearFinished}>
						Clear finished
					</button>
				</div>
			)}
		</div>
	);
}

export default UploadList;
