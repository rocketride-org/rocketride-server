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
// VECTOR-UI — SearchPanel (the Query tab's Search and Compare)
// =============================================================================
//
// A search box with Semantic, Keyword, Hybrid (fused in the browser) and Auto
// modes (each offered only when the store and the embedding node can serve
// it, otherwise disabled with the reason), top k, a table choice sent as
// `filter.isTable`, the console's scope (read-only here; "Edit in Documents"
// changes it) and Run. A "Will run" line under the form says what Run sends
// before it is pressed. The results table shows rank, document, chunk, the
// score (its scale in the column's heading, a bar where the store reports a
// range), the status at the threshold slider and a 120-character preview,
// with open / map / ask; a document's name shows it in the Documents tab's
// drawer. Every row is one line however narrow the panel (History open
// beside it): the columns have set widths, Document and Text share what is
// left, and each cell cuts its text with an ellipsis and keeps it whole in
// its title; the score's scale is said once above the table. The slider runs over the store's score
// range from the node's own setting and re-classifies the rows in place (it
// never searches again): its line names the count of passing rows beside
// what today's setting passes, the count is announced once each time the
// slider is let go, and "Copy as node setting" copies the value for the
// pipeline editor (Vector Explorer never changes node settings). In Compare
// (the Query tab's second mode, the same panel) a second question runs beside
// the first and they show side by side (QueryCompare), with two stars on the
// map.
//
// Questions are handed in once each (SearchHandoff, by its nonce): "Open in
// Search" from an answer, whose first run is the search "Why these?" made
// (Semantic, the same k, the documents the question was asked about, every
// table choice), so both list the same rows; a history entry's Load or Rerun
// (its mode and k, the console's scope as it is now); "Use as query"; "New
// query". The "cited" marks and the "From the chat" line belong to a run of
// the brought question only. The boxes take 1,000 characters; a longer
// question handed in is cut, and the panel says so.
//
// Each finished run is recorded in the Query tab's History (onRecord): a
// Search run with its mode, k and row count, a Compare once with both
// questions and the results they share, a failure with its sentence; a run a
// newer one replaced is not.
//
// The model is src/vector/searchWorkbench.ts. Calls go through
// chat/toolCalls' callTool only: `embed` on the embedding node and `search`
// on the store node. The query vector lives in the run's closure for those
// two calls; nothing here keeps it in state. All state is this panel's and
// goes with it; the Query tab keys the panel by connection.
// =============================================================================

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, commonStyles } from 'shell';
import type { SearchPanelProps as ContractSearchPanelProps, IScoreInfo } from '../contract/types';
import { callTool, toolChannelFor } from '../chat/toolCalls';
import { showCompareOnMap } from '../adapters/consoleActions';
import { DATA_BAR_TOKEN } from '../vector/colors';
import { compareRuns, compareSentence, rowKey } from '../vector/compare';
import { CALL_TIMEOUT_MS, DEFAULT_TOP_K, KEYWORD_FALLBACK_SENTENCE, MODEL_MISMATCH_SENTENCE, MODE_HINTS, NODE_SETTING_FIELD, NODE_SETTING_NOTE, NODE_SETTING_RANGE, QUESTION_CUT_SENTENCE, SEARCH_QUESTION_MAX_CHARS, STATUS_SHORT, STATUS_WORDS, TABLE_FILTERS, TABLE_FILTER_LABELS, applyHandoff, classifyAt, createCommitAnnouncer, defaultMode, fromChatLine, initialThreshold, isTableOf, keywordCaption, modeLabel, modeOptions, noResultsSentence, nodeSettingText, onGrid, questionEscape, rateLimitSentence, runCaption, runWorkbench, scopeChipText, scoreBar, scoreHeading, scoreTitle, searchExportItems, searchScope, secondsLeft, showSearchOnMap, sliderRange, sliderValueText, thresholdSentence, topKChoices, topKOptions, willRunText } from '../vector/searchWorkbench';
import type { ChatPrefill, Classification, ModeOption, SearchHandoff, SearchMode, SliderRange, TableFilter, WorkbenchDeps, WorkbenchOutcome, WorkbenchRow, WorkbenchRun } from '../vector/searchWorkbench';
import { compareRecord, searchRecord } from '../vector/queryHistory';
import type { QueryRunRecord } from '../vector/queryHistory';
import { ExportMenu } from './ExportMenu';
import { QueryCompare } from './QueryCompare';
import { ScoreHistogram } from './ScoreHistogram';

/** The contract props, with the Query tab's mode and the questions it hands in. */
export interface SearchPanelProps extends ContractSearchPanelProps {
	/** Compare: a second question (B) runs beside the first (the Query tab's Compare mode). */
	comparing?: boolean;
	/** A question handed in ("Open in Search", a history entry, "Use as query", "New query"), applied once by its nonce. */
	handoff?: SearchHandoff | null;
	/** Record each finished run (the Query tab's History): a Search run per mode, a Compare once. Absent: nothing is recorded. */
	onRecord?(record: QueryRunRecord): void;
	/** Show a result's document in the Documents tab's drawer. Absent: its name is plain text. */
	onShowDocument?(objectId: string): void;
}

const S = {
	root: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--rr-text-primary)' } as CSSProperties,
	head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } as CSSProperties,
	note: { margin: 0, fontSize: 12, color: 'var(--rr-text-primary)' } as CSSProperties,
	form: { display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
	row: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } as CSSProperties,
	input: { flex: '1 1 200px', minWidth: 0, fontSize: 13, padding: '5px 8px', borderRadius: 4, border: '1px solid var(--rr-border-input)', background: 'var(--rr-bg-input)', color: 'var(--rr-text-primary)', fontFamily: 'inherit' } as CSSProperties,
	fieldset: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', border: 'none', margin: 0, padding: 0 } as CSSProperties,
	legend: { float: 'left', marginRight: 6, padding: 0, color: 'var(--rr-text-primary)' } as CSSProperties,
	radio: { display: 'inline-flex', gap: 4, alignItems: 'center' } as CSSProperties,
	select: { fontSize: 12, padding: '3px 4px', borderRadius: 4, border: '1px solid var(--rr-border-input)', background: 'var(--rr-bg-input)', color: 'var(--rr-text-primary)' } as CSSProperties,
	button: { ...commonStyles.buttonSecondary, padding: '1px 8px', fontSize: 11 } as CSSProperties,
	run: { ...commonStyles.buttonPrimary, minWidth: '9em' } as CSSProperties,
	off: { opacity: 0.55, cursor: 'not-allowed' } as CSSProperties,
	chip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', border: '1px solid var(--rr-border)', borderRadius: 10, overflowWrap: 'anywhere' } as CSSProperties,
	scroll: { overflowX: 'auto' } as CSSProperties,
	table: { width: '100%', borderCollapse: 'collapse', marginTop: 4, tableLayout: 'fixed' } as CSSProperties,
	caption: { textAlign: 'left', color: 'var(--rr-text-primary)', padding: '2px 0' } as CSSProperties,
	th: { textAlign: 'left', fontWeight: 600, color: 'var(--rr-text-primary)', padding: '2px 4px', borderBottom: '1px solid var(--rr-border)', verticalAlign: 'bottom' } as CSSProperties,
	td: { padding: '3px 4px', borderBottom: '1px solid var(--rr-border)', verticalAlign: 'top', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as CSSProperties,
	link: { background: 'none', border: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit', textAlign: 'left', textDecoration: 'underline', cursor: 'pointer', display: 'block', maxWidth: '100%' } as CSSProperties,
	path: { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as CSSProperties,
	text: { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as CSSProperties,
	actions: { display: 'flex', gap: 4, flexWrap: 'nowrap' } as CSSProperties,
	barTrack: { display: 'inline-block', width: 48, height: 6, marginLeft: 6, verticalAlign: 'middle' } as CSSProperties,
	bar: { display: 'block', height: '100%', minWidth: 2, background: `var(${DATA_BAR_TOKEN})`, boxShadow: 'inset 0 0 0 1px var(--rr-text-primary)' } as CSSProperties,
	threshold: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' } as CSSProperties,
	thresholdLeft: { flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } as CSSProperties,
	thresholdRight: { flex: '0 1 300px', minWidth: 0 } as CSSProperties,
	slider: { flex: '1 1 160px', minWidth: 0 } as CSSProperties,
	code: { fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 11, padding: '0 4px', border: '1px solid var(--rr-border)', borderRadius: 4 } as CSSProperties,
};

// ── The threshold slider ────────────────────────────────────────────────────

/** Props of {@link ThresholdControls}. */
interface ThresholdControlsProps {
	/** Words before the line (Compare: 'A — '), or none. */
	lead?: string;
	rows: readonly WorkbenchRow[];
	view: Classification;
	score: IScoreInfo | null;
	range: SliderRange;
	onThreshold(at: number): void;
	/** The slider was let go (its native change event): its count is announced once. */
	onCommit?(): void;
	onCopySetting(text: string): void;
	/** The text last copied, or null. */
	copied: string | null;
}

/**
 * The slider, its line beside the node's setting, "Copy as node setting" and
 * the histogram. Moving the slider re-classifies the rows the run has (no
 * search) and redraws the line, which is no live region: the count is
 * announced once when the slider is let go (onCommit).
 *
 * @param props - {@link ThresholdControlsProps}.
 * @returns The controls.
 */
function ThresholdControls({ lead = '', rows, view, score, range, onThreshold, onCommit, onCopySetting, copied }: ThresholdControlsProps): React.ReactElement {
	const setting = nodeSettingText(view.at);
	const scores = view.rows.map((row) => row.score).filter((value): value is number => value !== null);
	const slider = useRef<HTMLInputElement>(null);
	const commit = useRef(onCommit);
	commit.current = onCommit;
	// React's onChange is every step of a drag; the slider's own change event is its commit: the pointer or the
	// finger let go anywhere, or a key that moved it (the announcer folds a held key into one announcement).
	useEffect(() => {
		const element = slider.current;
		if (element === null) return undefined;
		const committed = (): void => commit.current?.();
		element.addEventListener('change', committed);
		return () => element.removeEventListener('change', committed);
	}, []);
	return (
		<div data-threshold="" style={S.threshold}>
			<div style={S.thresholdLeft}>
				<div style={S.row}>
					<input ref={slider} type="range" aria-label="Threshold" min={range.min} max={range.max} step={range.step} value={view.at} aria-valuetext={sliderValueText(view)} style={S.slider} onChange={(event) => onThreshold(onGrid(Number(event.currentTarget.value)))} />
				</div>
				<p style={S.note} data-threshold-line="">
					{`${lead}${thresholdSentence(rows, view.at, score)}`}
				</p>
				<div style={S.row}>
					<button type="button" style={S.button} disabled={setting === null} title={setting === null ? NODE_SETTING_RANGE : NODE_SETTING_FIELD} onClick={() => setting !== null && onCopySetting(setting)}>
						Copy as node setting
					</button>
					{setting !== null && <code style={S.code}>{setting}</code>}
					{copied !== null && copied === setting && <span style={S.note}>Copied.</span>}
					<span style={S.note}>{NODE_SETTING_NOTE}</span>
				</div>
			</div>
			<div style={S.thresholdRight}>
				<ScoreHistogram scores={scores} range={score?.range ?? null} threshold={view.at} floor={score !== null && Number.isFinite(score.floor) ? score.floor : null} setting={score?.threshold ?? null} />
			</div>
		</div>
	);
}

// ── One run's results ───────────────────────────────────────────────────────

/** Props of {@link SearchResults}. */
export interface SearchResultsProps {
	run: WorkbenchRun;
	/** The run's rows at the slider. */
	view: Classification;
	score: IScoreInfo | null;
	range: SliderRange;
	onThreshold(at: number): void;
	/** The slider was let go: announce its count once. */
	onCommit?(): void;
	onCopySetting(text: string): void;
	copied: string | null;
	onOpen(row: WorkbenchRow): void;
	onMap(row: WorkbenchRow): void;
	onAsk(row: WorkbenchRow): void;
	/** False when the chat cannot take a question (its reason is the button's title). */
	canAsk: boolean;
	askReason?: string | null;
	/** Show every row on the map. */
	onShowAll?(): void;
	/** Run searches within the console's scope (for the "From the chat" line). */
	scopeOn?: boolean;
	/** Show a row's document in the Documents tab's drawer. Absent: its name is plain text. */
	onShowDocument?(row: WorkbenchRow): void;
}

/**
 * The ranks a fused row came from.
 *
 * @param row - The row.
 * @returns "semantic #2 · keyword #1", or null outside Hybrid.
 */
function fusedFrom(row: WorkbenchRow): string | null {
	if (row.fused === null) return null;
	return [row.semanticRank !== null ? `semantic #${row.semanticRank}` : null, row.keywordRank !== null ? `keyword #${row.keywordRank}` : null].filter(Boolean).join(' · ');
}

/**
 * One run: its warnings, the slider (when its rows carry similarities) and its table.
 *
 * @param props - {@link SearchResultsProps}.
 * @returns The results.
 */
export function SearchResults({ run, view, score, range, onThreshold, onCommit, onCopySetting, copied, onOpen, onMap, onAsk, canAsk, askReason = null, onShowAll, scopeOn = false, onShowDocument }: SearchResultsProps): React.ReactElement {
	const fromChat = fromChatLine(run, scopeOn);
	const heading = scoreHeading(score, run.rows);
	const scaleId = useId();
	// The score's scale and why a row has no bar, said once above the table (the column heading stays one line).
	const scaleLine = [heading.scale !== null ? `Score: ${heading.scale}.` : null, heading.noBars].filter((part): part is string => part !== null).join(' ');
	// Hybrid lists where each row came from (its semantic and keyword ranks) in a column of its own.
	const fused = run.modeUsed === 'hybrid';
	return (
		<div data-results="" data-mode-used={run.modeUsed}>
			{fromChat !== null && (
				<p style={S.note} data-from-chat="">
					{fromChat}
				</p>
			)}
			{run.modelMismatch && <Banner variant="warning">{MODEL_MISMATCH_SENTENCE}</Banner>}
			{run.keywordFallback && <p style={S.note}>{KEYWORD_FALLBACK_SENTENCE}</p>}
			{run.rows.length === 0 ? null : run.rated ? (
				<ThresholdControls rows={run.rows} view={view} score={score} range={range} onThreshold={onThreshold} onCommit={onCommit} onCopySetting={onCopySetting} copied={copied} />
			) : (
				<p style={S.note}>{thresholdSentence(run.rows, view.at, score)}</p>
			)}
			{run.rows.length === 0 ? (
				<p style={S.note}>{noResultsSentence(run)}</p>
			) : (
				<>
					{onShowAll && (
						<div style={S.row}>
							<button type="button" style={S.button} onClick={onShowAll}>
								Show these on the map
							</button>
						</div>
					)}
					{!canAsk && askReason !== null && (
						<p style={S.note} data-ask-off="">
							{`"ask" is off: ${askReason}`}
						</p>
					)}
					{scaleLine !== '' && (
						<p style={S.note} id={scaleId} data-score-scale="">
							{scaleLine}
						</p>
					)}
					<div style={S.scroll}>
						<table style={S.table}>
							<caption style={S.caption}>{runCaption(run)}</caption>
							<colgroup>
								<col style={{ width: 32 }} />
								<col />
								<col style={{ width: 80 }} />
								<col style={{ width: 104 }} />
								<col style={{ width: 96 }} />
								{fused && <col style={{ width: 168 }} />}
								<col />
								{/* open, map and ask (125 px in Figtree) with room for a focus ring and a wider fallback font. */}
								<col style={{ width: 144 }} />
							</colgroup>
							<thead>
								<tr>
									<th scope="col" style={S.th}>
										#
									</th>
									<th scope="col" style={S.th}>
										Document
									</th>
									<th scope="col" style={S.th}>
										Chunk
									</th>
									<th scope="col" style={S.th} aria-describedby={scaleLine !== '' ? scaleId : undefined}>
										Score
									</th>
									<th scope="col" style={S.th}>
										Status
									</th>
									{fused && (
										<th scope="col" style={S.th}>
											Found by
										</th>
									)}
									<th scope="col" style={S.th}>
										Text
									</th>
									<th scope="col" style={S.th}>
										Actions
									</th>
								</tr>
							</thead>
							<tbody>
								{view.rows.map((row, index) => {
									const path = row.path || row.objectId;
									const from = fusedFrom(row);
									const bar = scoreBar(score, row.score);
									const chunk = `#${row.chunkId}${row.cited ? ' · cited' : ''}`;
									return (
										<tr key={rowKey(row.key, index)} data-status={row.status} data-key={`${row.objectId}#${row.chunkId}`}>
											<td style={S.td}>{row.rank}</td>
											<td style={S.td} title={path}>
												{onShowDocument ? (
													<button type="button" style={S.link} aria-label={`Show ${path} in Documents`} onClick={() => onShowDocument(row)}>
														<span style={S.path}>{path}</span>
													</button>
												) : (
													<span style={S.path}>{path}</span>
												)}
											</td>
											<td style={S.td} title={chunk}>
												{chunk}
											</td>
											<td style={S.td} title={scoreTitle(row, score)}>
												{row.score !== null ? row.score.toFixed(3) : 'match'}
												{bar !== null && (
													<span aria-hidden="true" style={S.barTrack} data-bar={bar.toFixed(2)}>
														<span style={{ ...S.bar, width: `${Math.round(bar * 100)}%` }} />
													</span>
												)}
											</td>
											<td style={S.td} title={STATUS_WORDS[row.status]}>
												{STATUS_SHORT[row.status]}
											</td>
											{fused && (
												<td style={S.td} title={from ?? undefined}>
													{from ?? ''}
												</td>
											)}
											<td style={S.td} title={row.preview}>
												<span style={S.text}>{row.preview}</span>
											</td>
											<td style={S.td}>
												<span style={S.actions}>
													<button type="button" style={S.button} aria-label={`Open ${path} at chunk ${row.chunkId}`} onClick={() => onOpen(row)}>
														open
													</button>
													<button type="button" style={S.button} aria-label={`Show chunk ${row.chunkId} of ${path} on the map`} onClick={() => onMap(row)}>
														map
													</button>
													<button
														type="button"
														style={canAsk ? S.button : { ...S.button, ...S.off }}
														aria-label={`Ask about ${path}`}
														aria-disabled={!canAsk}
														title={canAsk ? undefined : (askReason ?? undefined)}
														onClick={() => {
															if (canAsk) onAsk(row);
														}}
													>
														ask
													</button>
												</span>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</>
			)}
		</div>
	);
}

// ── The panel ───────────────────────────────────────────────────────────────

/** Where the panel is. Never holds a vector. */
type Phase = { kind: 'idle' } | { kind: 'embedding'; side: 'A' | 'B' } | { kind: 'searching'; side: 'A' | 'B' } | { kind: 'error'; side: 'A' | 'B'; message: string } | { kind: 'done' };

/** What a run is asked to do. */
interface RunPlan {
	question: string;
	questionB: string | null;
	mode: SearchMode;
	topK: number;
	/** The documents to search, or null for the whole collection. */
	objectIds: readonly string[] | null;
	/** Tables only (true), no tables (false), or either (null). */
	isTable: boolean | null;
	/** What "Open in Search" brought; a run of another question carries none of it. */
	chat: ChatPrefill | null;
}

/**
 * The disabled modes' reasons, one line per reason: "Semantic, Hybrid, Auto: <why>".
 *
 * @param options - The modes.
 * @returns The lines.
 */
function reasonLines(options: readonly ModeOption[]): string[] {
	const byReason = new Map<string, string[]>();
	for (const option of options) {
		if (option.enabled || option.reason === null) continue;
		byReason.set(option.reason, [...(byReason.get(option.reason) ?? []), option.label]);
	}
	return [...byReason.entries()].map(([reason, labels]) => `${labels.join(', ')}: ${reason}`);
}

/**
 * Search the collection without the LLM; in Compare, two questions side by side.
 *
 * @param props - {@link SearchPanelProps}.
 * @returns The panel.
 */
export function SearchPanel({ model, channels, selection, actions, comparing = false, handoff = null, onRecord, onShowDocument }: SearchPanelProps): React.ReactElement {
	const dialect = model.connection.dialect;
	const score = dialect?.score ?? null;
	const options = useMemo(() => modeOptions(model), [model]);
	const ks = useMemo(() => topKOptions(model.limits), [model.limits]);
	const range = useMemo(() => sliderRange(score), [score]);
	const gate = searchScope(model.scope ?? null, model.limits);
	const chipText = scopeChipText(model.scope ?? null, gate);
	const radioName = useId();

	const [question, setQuestion] = useState('');
	const [questionB, setQuestionB] = useState('');
	const [chosenMode, setMode] = useState<SearchMode | null>(() => defaultMode(options));
	const [topK, setTopK] = useState(() => (ks.includes(DEFAULT_TOP_K) ? DEFAULT_TOP_K : (ks[ks.length - 1] ?? DEFAULT_TOP_K)));
	const [tables, setTables] = useState<TableFilter>('any');
	// null follows the node's setting (the dialect may answer after the panel mounted); a number is the user's.
	const [chosenAt, setAt] = useState<number | null>(null);
	// What "Open in Search" brought: kept with its question, so only a run of that question is marked.
	const [chat, setChat] = useState<ChatPrefill | null>(null);
	const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
	const [runs, setRuns] = useState<{ a: WorkbenchRun | null; b: WorkbenchRun | null }>({ a: null, b: null });
	const [limitedUntil, setLimitedUntil] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [copied, setCopied] = useState<string | null>(null);
	// A handed-in question was longer than the box takes, and was cut.
	const [cut, setCut] = useState(false);
	const runId = useRef(0);
	const lastHandoff = useRef<string | null>(null);
	const sentence = useRef('');

	const mode = chosenMode !== null && options.find((o) => o.mode === chosenMode)?.enabled ? chosenMode : defaultMode(options);
	const at = Math.max(range.min, Math.min(range.max, chosenAt ?? initialThreshold(score)));
	const keywordOffered = options.find((o) => o.mode === 'keyword')?.enabled === true;
	const running = phase.kind === 'embedding' || phase.kind === 'searching';
	const limited = limitedUntil !== null && limitedUntil > now;
	const showB = comparing && runs.a !== null && runs.b !== null;

	// A run that finishes after the panel went away is dropped.
	useEffect(
		() => () => {
			runId.current += 1;
		},
		[]
	);

	// While the embedding node refuses new questions, count down once a second.
	useEffect(() => {
		if (limitedUntil === null) return undefined;
		const timer = setInterval(() => {
			const t = Date.now();
			setNow(t);
			if (t >= limitedUntil) setLimitedUntil(null);
		}, 1000);
		return () => clearInterval(timer);
	}, [limitedUntil]);

	const viewA = useMemo(() => (runs.a !== null ? classifyAt(runs.a.rows, at, score) : null), [runs.a, at, score]);
	const viewB = useMemo(() => (runs.b !== null ? classifyAt(runs.b.rows, at, score) : null), [runs.b, at, score]);

	// The slider's count, announced once each time it is let go (never on every step of a drag).
	const announcer = useMemo(() => createCommitAnnouncer({ announce: (text) => actions.announce(text) }), [actions]);
	useEffect(() => () => announcer.cancel(), [announcer]);
	useEffect(() => {
		sentence.current = runs.a === null ? '' : showB && runs.b !== null ? `A: ${thresholdSentence(runs.a.rows, at, score)} B: ${thresholdSentence(runs.b.rows, at, score)}` : thresholdSentence(runs.a.rows, at, score);
	});
	const commitThreshold = (): void => announcer.commit(() => sentence.current);

	const blockedBy = ((): string | null => {
		if (mode === null) return 'Search is not available on this connection.';
		if (gate.blocked !== null) return gate.blocked;
		if (limited) return rateLimitSentence(secondsLeft(limitedUntil as number, now));
		if (question.trim() === '') return 'Type a question to search for.';
		if (comparing && questionB.trim() === '') return 'Type question B to compare.';
		return null;
	})();

	/**
	 * Say why a run stopped (and start the countdown when the embedding node is busy).
	 *
	 * @param outcome - The failed run.
	 * @param side - Which question.
	 */
	const failed = (outcome: Extract<WorkbenchOutcome, { ok: false }>, side: 'A' | 'B'): void => {
		actions.announce(outcome.message);
		if (outcome.code === 'RATE_LIMITED' && outcome.retryAfterS !== null) {
			// The countdown line says it, and goes away when Run is possible again.
			const t = Date.now();
			setNow(t);
			setLimitedUntil(t + outcome.retryAfterS * 1000);
			setPhase({ kind: 'idle' });
			return;
		}
		setPhase({ kind: 'error', side, message: outcome.message });
	};

	/**
	 * Run A (and B when comparing). Every call goes through callTool; the vector stays inside runWorkbench.
	 *
	 * @param request - What to run.
	 */
	const run = async (request: RunPlan): Promise<void> => {
		const id = ++runId.current;
		const startedAt = Date.now();
		const tools = toolChannelFor(model, channels);
		/**
		 * Record the run in History (once it ended and no newer run replaced it).
		 *
		 * @param outcome - The rows found (A's, or the count A and B share) or why it stopped.
		 * @param outcome.results - The count.
		 * @param outcome.error - The sentence shown, when it failed.
		 */
		const record = (outcome: { results: number | null; error?: string }): void => {
			const ms = Date.now() - startedAt;
			if (request.questionB === null) onRecord?.(searchRecord({ question: request.question, mode: request.mode, topK: request.topK, ...outcome }, startedAt, ms));
			else onRecord?.(compareRecord({ a: request.question, b: request.questionB, topK: request.topK, shared: outcome.results, ...(outcome.error === undefined ? {} : { error: outcome.error }) }, startedAt, ms));
		};
		/**
		 * The calls of one side.
		 *
		 * @param side - Which question.
		 * @returns The deps.
		 */
		const deps = (side: 'A' | 'B'): WorkbenchDeps => ({
			call: (tool, input, nodeId) => callTool(tools, tool, input, nodeId, { timeoutMs: CALL_TIMEOUT_MS }),
			onPhase: (step) => {
				if (runId.current === id) setPhase({ kind: step, side });
			},
		});
		const base = { mode: request.mode, topK: request.topK, limits: model.limits, storeNode: model.nodes.store, embedNode: model.nodes.embed, objectIds: request.objectIds, isTable: request.isTable, chat: request.chat };
		setRuns({ a: null, b: null });
		setPhase({ kind: request.mode === 'keyword' ? 'searching' : 'embedding', side: 'A' });
		const a = await runWorkbench(deps('A'), { ...base, question: request.question });
		if (runId.current !== id) return;
		if (!a.ok) {
			record({ results: null, error: request.questionB === null ? a.message : `A: ${a.message}` });
			return failed(a, 'A');
		}
		if (request.questionB === null) {
			record({ results: a.run.rows.length });
			setRuns({ a: a.run, b: null });
			setPhase({ kind: 'done' });
			actions.announce(`${runCaption(a.run)}. ${thresholdSentence(a.run.rows, at, score)}`);
			return;
		}
		const b = await runWorkbench(deps('B'), { ...base, question: request.questionB });
		if (runId.current !== id) return;
		if (!b.ok) {
			record({ results: null, error: `B: ${b.message}` });
			setRuns({ a: a.run, b: null });
			return failed(b, 'B');
		}
		const summary = compareRuns(a.run.rows, b.run.rows);
		record({ results: summary.shared });
		setRuns({ a: a.run, b: b.run });
		setPhase({ kind: 'done' });
		actions.announce(compareSentence(summary));
	};

	// A question handed in, once per nonce: "Open in Search" runs the search "Why these?" made; a history entry's
	// Rerun runs with its mode and k in the scope as it is now; Load, "Use as query" and "New query" fill the form.
	useEffect(() => {
		if (handoff === null || handoff.nonce === lastHandoff.current) return;
		// One made for another connection (this panel remounted on a change of key) is not this panel's.
		if (handoff.connectionKey !== undefined && handoff.connectionKey !== model.connectionKey) return;
		lastHandoff.current = handoff.nonce;
		if (handoff.clear) {
			runId.current += 1;
			setQuestion('');
			setQuestionB('');
			setChat(null);
			setRuns({ a: null, b: null });
			setPhase({ kind: 'idle' });
			setCut(false);
			return;
		}
		const next = applyHandoff(handoff, { mode, topK }, options, ks);
		setQuestion(next.question);
		if (next.questionB !== null) setQuestionB(next.questionB);
		setChat(next.chat);
		setMode(next.mode);
		setTopK(next.topK);
		if (next.tables !== null) setTables(next.tables);
		setCut(next.cut);
		if (!next.run) return;
		// A run asked for that cannot start now says why (the form is filled; Run is there when it can).
		const blocked = next.mode === null ? 'Search is not available on this connection.' : limited ? rateLimitSentence(secondsLeft(limitedUntil as number, now)) : next.objectIds === 'scope' ? gate.blocked : null;
		if (blocked !== null || next.mode === null) {
			if (blocked !== null) actions.announce(`Not run: ${blocked}`);
			return;
		}
		// Its own documents (the question's), not the console's scope, so the console's gate does not stop a chat handoff.
		const objectIds = next.objectIds === 'scope' ? gate.objectIds : next.objectIds;
		// A Compare handoff carries its B (a Search one none), so what runs never hangs on the mode having rendered first.
		void run({ question: next.question, questionB: next.questionB !== null && next.questionB.trim() !== '' ? next.questionB : null, mode: next.mode, topK: next.topK, objectIds, isTable: isTableOf(next.tables ?? tables), chat: next.chat });
		// Runs once per handoff; the rest of the panel's state does not restart it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [handoff]);

	/**
	 * Copy the node setting.
	 *
	 * @param text - `threshold_search: 0.42`.
	 */
	const copySetting = (text: string): void => {
		if (typeof navigator === 'undefined' || !navigator.clipboard) return;
		void navigator.clipboard.writeText(text).then(
			() => {
				setCopied(text);
				actions.announce(`Copied ${text}. ${NODE_SETTING_NOTE}`);
			},
			() => setCopied(null)
		);
	};

	/**
	 * Escape in a question box: a box with text clears it (this handler acted); an empty one leaves the key to the
	 * handlers around it.
	 *
	 * @param event - The key event.
	 * @param value - The box's text.
	 * @param clear - Empty the box.
	 */
	const escapeClears = (event: React.KeyboardEvent<HTMLInputElement>, value: string, clear: () => void): void => {
		if (event.key !== 'Escape' || questionEscape(value, event.defaultPrevented) !== 'clear') return;
		event.preventDefault();
		clear();
	};

	const handlers = {
		onThreshold: setAt,
		onCommit: commitThreshold,
		onCopySetting: copySetting,
		copied,
		onOpen: (row: WorkbenchRow) => actions.openDocument(row.objectId, row.chunkId),
		canAsk: model.chat.enabled,
		askReason: model.chat.reason,
		// The Query tab shows Ask with the next question scoped to the row's document.
		onAsk: (row: WorkbenchRow) => actions.askAbout([row.objectId]),
	};
	const busyLabel = `${phase.kind === 'embedding' ? 'Embedding' : 'Searching'}${comparing && running ? ` ${phase.side}` : ''}…`;
	const reasons = reasonLines(options);
	const willRun = willRunText({ mode, comparing, topK, at, gate, tables });
	const off = blockedBy !== null || running;
	// Dimmed only while it cannot run: while a run is on its way its label ("Searching A…") is the progress.
	const dimmed = blockedBy !== null && !running;

	return (
		<section aria-label={comparing ? 'Compare' : 'Search'} data-component="SearchPanel" data-comparing={comparing ? 'true' : 'false'} style={S.root}>
			<div style={S.head}>
				<p style={S.note}>{comparing ? 'Run two questions over the stored chunks and see where their results agree.' : 'Search the stored chunks directly, without the LLM.'}</p>
				<ExportMenu items={searchExportItems(viewA, comparing ? viewB : null)} collection={model.collection} onExported={(fileName) => actions.announce(`Saved ${fileName}.`)} />
			</div>
			<form
				style={S.form}
				onSubmit={(event) => {
					event.preventDefault();
					if (off || mode === null) return;
					void run({ question, questionB: comparing ? questionB : null, mode, topK, objectIds: gate.objectIds, isTable: isTableOf(tables), chat });
				}}
			>
				<div style={S.row}>
					<input
						type="search"
						aria-label={comparing ? 'Question A' : 'Search question'}
						placeholder={comparing ? 'Question A…' : 'Search the documents…'}
						data-query-focus="question"
						value={question}
						maxLength={SEARCH_QUESTION_MAX_CHARS}
						style={S.input}
						onChange={(event) => {
							setQuestion(event.currentTarget.value);
							setCut(false);
						}}
						onKeyDown={(event) => escapeClears(event, question, () => setQuestion(''))}
					/>
				</div>
				{comparing && (
					<div style={S.row}>
						<input
							type="search"
							aria-label="Question B"
							placeholder="Compare with… (B)"
							value={questionB}
							maxLength={SEARCH_QUESTION_MAX_CHARS}
							style={S.input}
							onChange={(event) => {
								setQuestionB(event.currentTarget.value);
								setCut(false);
							}}
							onKeyDown={(event) => escapeClears(event, questionB, () => setQuestionB(''))}
						/>
					</div>
				)}
				{cut && <p style={S.note}>{QUESTION_CUT_SENTENCE}</p>}
				<fieldset style={S.fieldset}>
					<legend style={S.legend}>Mode</legend>
					{options.map((option) => (
						<label key={option.mode} style={S.radio} title={option.reason ?? MODE_HINTS[option.mode]}>
							<input type="radio" name={radioName} checked={mode === option.mode} disabled={!option.enabled} value={option.mode} onChange={() => setMode(option.mode)} />
							{modeLabel(option.mode)}
						</label>
					))}
				</fieldset>
				{reasons.map((line) => (
					<p key={line} style={S.note}>
						{line}
					</p>
				))}
				{keywordOffered && <p style={S.note}>{keywordCaption(dialect?.keyword_match)}</p>}
				<div style={S.row}>
					<select aria-label="Results to show (top k)" value={topK} style={S.select} onChange={(event) => setTopK(Number(event.currentTarget.value))}>
						{topKChoices(ks, topK).map((k) => (
							<option key={k} value={k}>
								{k}
							</option>
						))}
					</select>
					<select aria-label="Tables (sent to the store as isTable)" value={tables} style={S.select} onChange={(event) => setTables(event.currentTarget.value as TableFilter)}>
						{TABLE_FILTERS.map((choice) => (
							<option key={choice} value={choice}>
								{TABLE_FILTER_LABELS[choice]}
							</option>
						))}
					</select>
					<button type="submit" style={dimmed ? { ...S.run, ...S.off } : S.run} aria-disabled={off} title={blockedBy ?? undefined}>
						{running ? busyLabel : comparing ? 'Run A and B' : 'Run'}
					</button>
				</div>
				{chipText !== null && (
					<div style={S.row} data-scope-chip="">
						<span style={S.chip}>{chipText}</span>
						{actions.openTab && (
							<button type="button" style={S.button} onClick={() => actions.openTab?.('documents')}>
								Edit in Documents
							</button>
						)}
					</div>
				)}
				{willRun !== null && (
					<p style={S.note} data-will-run="">
						{willRun}
					</p>
				)}
			</form>
			{limited && (
				<p style={S.note} role="timer">
					{rateLimitSentence(secondsLeft(limitedUntil as number, now))}
				</p>
			)}
			{phase.kind === 'error' && !limited && <Banner variant="error">{comparing ? `${phase.side}: ${phase.message}` : phase.message}</Banner>}
			{!comparing && runs.a !== null && viewA !== null && (
				<SearchResults
					run={runs.a}
					view={viewA}
					score={score}
					range={range}
					{...handlers}
					scopeOn={gate.objectIds !== null}
					onShowDocument={onShowDocument ? (row) => onShowDocument(row.objectId) : undefined}
					onMap={(row) => showSearchOnMap(selection, actions, (runs.a as WorkbenchRun).question, [row.key])}
					onShowAll={() =>
						showSearchOnMap(
							selection,
							actions,
							(runs.a as WorkbenchRun).question,
							(runs.a as WorkbenchRun).rows.map((row) => row.key)
						)
					}
				/>
			)}
			{showB && runs.a !== null && viewA !== null && runs.b !== null && viewB !== null && (
				<>
					{runs.a.rated && runs.a.rows.length > 0 && <ThresholdControls lead="A — " rows={runs.a.rows} view={viewA} score={score} range={range} onThreshold={setAt} onCommit={commitThreshold} onCopySetting={copySetting} copied={copied} />}
					<QueryCompare
						a={{ run: runs.a, view: viewA }}
						b={{ run: runs.b, view: viewB }}
						score={score}
						scopeOn={gate.objectIds !== null}
						onOpen={handlers.onOpen}
						onShowBoth={() =>
							showCompareOnMap(
								selection,
								actions,
								(runs.a as WorkbenchRun).question,
								(runs.b as WorkbenchRun).question,
								(runs.a as WorkbenchRun).rows.map((row) => row.key),
								(runs.b as WorkbenchRun).rows.map((row) => row.key)
							)
						}
					/>
				</>
			)}
		</section>
	);
}

export default SearchPanel;
