// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ResultView — an answer's results laid out by how many files and lanes
 * they hold:
 *   - one request, one lane      → that lane;
 *   - one request, several lanes → a tab per lane, each with its count;
 *   - several files, one lane    → one record per file as one table (a row
 *                                  per file, failed files in place), text and
 *                                  documents as a section per file, media
 *                                  as one gallery captioned by file;
 *   - several files and lanes    → a tab per lane, and a row of file toggles
 *                                  that narrows every tab to one file.
 */

import React, { useState, type CSSProperties } from 'react';
import { Button, DataGrid, TabControl, ToggleGroup, commonStyles } from 'shell';
import type { GridColumnDefinition, ViewMenu } from 'shell';
import { friendlyName } from '../../core/friendly';
import { cellText, firstRecord, lanesOf } from '../../core/results';
import type { ResultLane } from '../../core/results';
import type { AnswerFile, ResultBody } from '../../core/model';
import { LaneView, laneLabel } from './LaneView';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	tabs: {
		margin: '2px -14px 6px',
	} as CSSProperties,
	filter: {
		margin: '2px 0 8px',
	} as CSSProperties,
	section: {
		marginTop: 10,
	} as CSSProperties,
	sectionHead: {
		...commonStyles.textEllipsis,
		fontSize: 12,
		fontWeight: 700,
		marginBottom: 2,
	} as CSSProperties,
	empty: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	error: {
		color: 'var(--rr-color-error)',
	} as CSSProperties,
};

/** How many per-file sections show before the rest fold. */
const SECTIONS_OPEN = 3;

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link ResultView}. */
export interface IResultViewProps {
	/** A question's (or one request's) close body. */
	result?: ResultBody;
	/** Several files' parts. */
	files?: AnswerFile[];
	/** Simple view. */
	simple: boolean;
	/** The agent's name, for sentences. */
	agentName: string;
}

/** One lane across several files. */
interface FileLane {
	type: string;
	key: string;
	perFile: { file: AnswerFile; lane: ResultLane | null }[];
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The lanes of several files, by lane key in first-seen order, each with
 * every file's part (null for a file that has none).
 *
 * @param files - The files' parts.
 * @returns The lanes.
 */
function fileLanes(files: AnswerFile[]): FileLane[] {
	const order: string[] = [];
	const byKey = new Map<string, FileLane>();
	for (const file of files) {
		for (const lane of lanesOf(file.result)) {
			if (!byKey.has(lane.key)) {
				order.push(lane.key);
				byKey.set(lane.key, { type: lane.type, key: lane.key, perFile: [] });
			}
		}
	}
	for (const key of order) {
		const entry = byKey.get(key)!;
		entry.perFile = files.map((file) => ({ file, lane: lanesOf(file.result).find((l) => l.key === key) ?? null }));
	}
	return order.map((k) => byKey.get(k)!);
}

/**
 * The sentence for a file that could not be read.
 *
 * @param file - The failed file's part.
 * @returns The sentence, with the file's error.
 */
function couldNotRead(file: AnswerFile): string {
	return `Couldn't read ${file.name}: ${file.error ?? 'unknown error'}`;
}

// =============================================================================
// SEVERAL FILES, ONE LANE
// =============================================================================

/**
 * One lane across several files, by its several-files rule.
 *
 * @param props - The lane, the view and the agent's name.
 * @returns The layout.
 */
const FileLaneView: React.FC<{ lane: FileLane; simple: boolean; agentName: string }> = ({ lane, simple, agentName }) => {
	// ── Records: one table, a row per file ────────────────────────────────
	// step: only when every file sent exactly one record; a file with more goes to the sections, so no record is hidden
	const records = lane.type === 'answers' || lane.type === 'json' ? lane.perFile.map((p) => (p.lane?.items.length === 1 ? firstRecord(p.lane.items) : null)) : [];
	const tabular = records.length > 0 && records.some((r) => r !== null) && lane.perFile.every((p, i) => records[i] !== null || !p.lane);
	if (tabular) {
		// step: the columns are the first record's keys, later keys appended
		const keys: string[] = [];
		for (const r of records) for (const k of Object.keys(r ?? {})) if (!keys.includes(k)) keys.push(k);
		const columns: GridColumnDefinition[] = [{ title: 'File', field: '__file', rrDescription: 'The file this row came from' }, ...keys.map((k) => ({ title: simple ? friendlyName(k) : k, field: k, rrDescription: k }))];
		// step: a row per file; a failed file keeps its row with its error
		const rows = lane.perFile.map((p, i) => {
			const row: Record<string, unknown> = { __file: p.file.name };
			const record = records[i];
			if (record) for (const k of keys) row[k] = cellText(record[k]);
			else if (p.file.error && keys[0]) row[keys[0]] = `Couldn't read: ${p.file.error}`;
			return row;
		});
		return <DataGrid columns={columns} data={rows} noSearch noExport paginate={false} />;
	}

	// ── Media: one gallery, captioned by file ─────────────────────────────
	if (lane.type === 'image' || lane.type === 'audio' || lane.type === 'video') {
		return (
			<>
				{lane.perFile
					.filter((p) => p.lane)
					.map((p) => (
						<LaneView key={p.file.name} lane={p.lane!} simple={simple} agentName={agentName} caption={p.file.name} />
					))}
			</>
		);
	}

	// ── Everything else: a section per file ───────────────────────────────
	return <FileSections lane={lane} simple={simple} agentName={agentName} />;
};

/**
 * A section per file, the first few open.
 *
 * @param props - The lane, the view and the agent's name.
 * @returns The sections.
 */
const FileSections: React.FC<{ lane: FileLane; simple: boolean; agentName: string }> = ({ lane, simple, agentName }) => {
	const [showAll, setShowAll] = useState(false);
	const parts = lane.perFile.filter((p) => p.lane || p.file.error);
	const shown = showAll ? parts : parts.slice(0, SECTIONS_OPEN);
	return (
		<>
			{shown.map((p) => (
				<div key={p.file.name} style={styles.section}>
					<div style={styles.sectionHead}>{p.file.name}</div>
					{p.lane ? <LaneView lane={p.lane} simple={simple} agentName={agentName} /> : <div style={styles.error}>Couldn't read: {p.file.error}</div>}
				</div>
			))}
			{parts.length > shown.length && (
				<Button variant="ghost" mini onClick={() => setShowAll(true)}>
					{`${parts.length - shown.length} more`}
				</Button>
			)}
		</>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders an answer's results.
 *
 * @param props - {@link IResultViewProps}.
 * @returns The results.
 */
export const ResultView: React.FC<IResultViewProps> = ({ result, files, simple, agentName }) => {
	const [tab, setTab] = useState<string | null>(null);
	const [onlyFile, setOnlyFile] = useState<string>('__all');

	// ── Several files ─────────────────────────────────────────────────────
	if (files && files.length > 1) {
		// step: the file filter follows the whole batch, so narrowing to one file never hides the way back
		const batchLanes = fileLanes(files);
		if (batchLanes.length === 0) return <div style={styles.empty}>{files.every((f) => f.state === 'failed') ? 'None of these files could be read.' : `${agentName} sent back nothing to show.`}</div>;
		const shownFiles = onlyFile === '__all' ? files : files.filter((f) => f.name === onlyFile);
		const lanes = onlyFile === '__all' ? batchLanes : fileLanes(shownFiles);
		const active: FileLane | undefined = lanes.find((l) => l.key === tab) ?? lanes[0];
		const menu: ViewMenu = { entries: lanes.map((l) => ({ id: l.key, label: laneLabel(l.type), count: l.perFile.reduce((n, p) => n + (p.lane?.items.length ?? 0), 0) })) };
		const picked = shownFiles[0];
		return (
			<>
				{batchLanes.length > 1 && (
					<div style={styles.filter}>
						<ToggleGroup wrap small options={[{ id: '__all', label: 'All files' }, ...files.map((f) => ({ id: f.name, label: f.state === 'failed' ? `! ${f.name}` : f.name }))]} value={onlyFile} onChange={setOnlyFile} />
					</div>
				)}
				{lanes.length > 1 && active && (
					<div style={styles.tabs}>
						<TabControl menu={menu} activeId={active.key} onSelect={setTab} />
					</div>
				)}
				{active ? (
					<FileLaneView lane={active} simple={simple} agentName={agentName} />
				) : picked?.state === 'failed' ? (
					<div style={styles.error}>{couldNotRead(picked)}</div>
				) : (
					<div style={styles.empty}>{`${agentName} sent back nothing to show for ${picked?.name ?? 'this file'}.`}</div>
				)}
			</>
		);
	}

	// ── One request ───────────────────────────────────────────────────────
	// step: one file that could not be read says why, instead of "nothing to show"
	if (files?.length === 1 && files[0].state === 'failed') return <div style={styles.error}>{couldNotRead(files[0])}</div>;
	const single = files?.length === 1 ? files[0].result : result;
	const all = lanesOf(single);
	if (all.length === 0) return <div style={styles.empty}>{agentName} sent back nothing to show.</div>;

	// step: documents beside an answer are its sources — "From …" under it, not a tab of their own
	const answered = all.some((l) => l.type === 'answers' || l.type === 'text');
	const sources = answered ? all.filter((l) => l.type === 'documents') : [];
	const lanes = answered ? all.filter((l) => l.type !== 'documents') : all;
	const sourceViews = sources.map((l) => <LaneView key={l.key} lane={l} simple={simple} agentName={agentName} />);

	if (lanes.length === 1) {
		return (
			<>
				<LaneView lane={lanes[0]} simple={simple} agentName={agentName} />
				{sourceViews}
			</>
		);
	}
	const active = lanes.find((l) => l.key === tab) ?? lanes[0];
	const menu: ViewMenu = { entries: lanes.map((l) => ({ id: l.key, label: laneLabel(l.type), count: l.items.length })) };
	return (
		<>
			<div style={styles.tabs}>
				<TabControl menu={menu} activeId={active.key} onSelect={setTab} />
			</div>
			<LaneView lane={active} simple={simple} agentName={agentName} />
			{sourceViews}
		</>
	);
};
