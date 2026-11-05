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
// VECTOR-UI — SearchPanel (Search without the LLM, behind the chat panel's toggle)
// =============================================================================
//
// A search box with Semantic, Keyword, Hybrid and Auto modes (each offered
// only when the store and the embedding node can serve it, otherwise
// disabled with the reason), top k, and Run. The results table shows rank,
// path #chunk, the score (its formula on hover), the status at the
// threshold slider and a 120-character preview, with open / map / ask about
// this. The slider runs over the store's score range from the node's own
// setting and re-classifies the rows in place: its line names the count of
// passing rows beside what today's setting passes, and "Copy as node
// setting" copies the value for the pipeline editor (this console never
// changes node settings). Compare runs a second question beside the first
// and shows them side by side (QueryCompare), with two stars on the map.
//
// "Open in Search" brings the chat's question and the chunks its answer
// cited. Its first run is the search "Why these?" made (Semantic, the same
// k, the documents the question was asked about), so both list the same
// rows; later runs use the panel's own k and the console's scope. The
// "cited" marks and the "From the chat" line belong to a run of that
// question only: another question on the same panel carries neither.
//
// The model is src/vector/searchWorkbench.ts. Calls go through
// chat/toolCalls' callTool only: `embed` on the embedding node and `search`
// on the store node. The query vector lives in the run's closure for those
// two calls; nothing here keeps it in state. All state is this panel's and
// goes with it; the chat panel keys the panel by connection.
// =============================================================================

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, commonStyles } from 'shell';
import type { SearchPanelProps as ContractSearchPanelProps, IScoreInfo } from '../contract/types';
import { callTool, toolChannelFor } from '../chat/toolCalls';
import { showCompareOnMap } from '../adapters/consoleActions';
import { compareRuns, compareSentence, rowKey } from '../vector/compare';
import { CALL_TIMEOUT_MS, DEFAULT_TOP_K, KEYWORD_FALLBACK_SENTENCE, MODEL_MISMATCH_SENTENCE, MODE_HINTS, NODE_SETTING_FIELD, NODE_SETTING_NOTE, NODE_SETTING_RANGE, STATUS_WORDS, classifyAt, defaultMode, fromChatLine, initialThreshold, keywordCaption, modeOptions, noResultsSentence, nodeSettingText, onGrid, prefillRun, rateLimitSentence, runCaption, runWorkbench, scoreTitle, searchExportItems, searchScope, secondsLeft, showSearchOnMap, sliderRange, sliderValueText, thresholdSentence, topKChoices, topKOptions } from '../vector/searchWorkbench';
import type { ChatPrefill, Classification, ModeOption, SearchMode, SliderRange, WorkbenchDeps, WorkbenchOutcome, WorkbenchRow, WorkbenchRun } from '../vector/searchWorkbench';
import { ExportMenu } from './ExportMenu';
import { QueryCompare } from './QueryCompare';
import { ScoreHistogram } from './ScoreHistogram';

/** The chat panel's line while Search is shown in its place. */
export const SHOWING_SEARCH = 'Showing Search; the chat is one click away';

/** The contract props, with how "Why these?" searched in the prefill, and a way back to the chat (after "ask about this"). */
export interface SearchPanelProps extends ContractSearchPanelProps {
	/** Filled by "Open in Search": the question, the chunks its answer cited, and the k and documents "Why these?" searched. */
	prefill?: ChatPrefill | null;
	/** Show the chat again: "ask about this" scoped its next question. */
	onShowChat?(): void;
}

const S = {
	root: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--rr-text-primary)' } as CSSProperties,
	head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } as CSSProperties,
	note: { margin: 0, fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
	form: { display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
	row: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } as CSSProperties,
	input: { flex: '1 1 200px', minWidth: 0, fontSize: 13, padding: '5px 8px', borderRadius: 4, border: '1px solid var(--rr-border-input)', background: 'var(--rr-bg-input)', color: 'var(--rr-text-primary)', fontFamily: 'inherit' } as CSSProperties,
	fieldset: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', border: 'none', margin: 0, padding: 0 } as CSSProperties,
	legend: { float: 'left', marginRight: 6, padding: 0, color: 'var(--rr-text-secondary)' } as CSSProperties,
	radio: { display: 'inline-flex', gap: 4, alignItems: 'center' } as CSSProperties,
	select: { fontSize: 12, padding: '3px 4px', borderRadius: 4, border: '1px solid var(--rr-border-input)', background: 'var(--rr-bg-input)', color: 'var(--rr-text-primary)' } as CSSProperties,
	button: { ...commonStyles.buttonSecondary, padding: '1px 8px', fontSize: 11 } as CSSProperties,
	error: { margin: 0, fontSize: 12, color: 'var(--rr-color-error)' } as CSSProperties,
	table: { width: '100%', borderCollapse: 'collapse', marginTop: 4 } as CSSProperties,
	caption: { textAlign: 'left', color: 'var(--rr-text-secondary)', padding: '2px 0' } as CSSProperties,
	th: { textAlign: 'left', fontWeight: 600, color: 'var(--rr-text-secondary)', padding: '2px 4px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	td: { padding: '3px 4px', borderBottom: '1px solid var(--rr-border)', verticalAlign: 'top', overflowWrap: 'anywhere' } as CSSProperties,
	muted: { color: 'var(--rr-text-secondary)' } as CSSProperties,
	meta: { display: 'block', color: 'var(--rr-text-secondary)' } as CSSProperties,
	actions: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 } as CSSProperties,
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
	onCopySetting(text: string): void;
	/** The text last copied, or null. */
	copied: string | null;
}

/**
 * The slider, its line beside the node's setting, "Copy as node setting" and the histogram.
 *
 * @param props - {@link ThresholdControlsProps}.
 * @returns The controls.
 */
function ThresholdControls({ lead = '', rows, view, score, range, onThreshold, onCopySetting, copied }: ThresholdControlsProps): React.ReactElement {
	const setting = nodeSettingText(view.at);
	const scores = view.rows.map((row) => row.score).filter((value): value is number => value !== null);
	return (
		<div data-threshold="">
			<div style={S.row}>
				<input type="range" aria-label="Threshold" min={range.min} max={range.max} step={range.step} value={view.at} aria-valuetext={sliderValueText(view)} style={S.slider} onChange={(event) => onThreshold(onGrid(Number(event.currentTarget.value)))} />
				<output role="status" style={S.note}>
					{`${lead}${thresholdSentence(rows, view.at, score)}`}
				</output>
			</div>
			<div style={S.row}>
				<button type="button" style={S.button} disabled={setting === null} title={setting === null ? NODE_SETTING_RANGE : NODE_SETTING_FIELD} onClick={() => setting !== null && onCopySetting(setting)}>
					Copy as node setting
				</button>
				{setting !== null && <code style={S.code}>{setting}</code>}
				{copied !== null && copied === setting && <span style={S.note}>Copied.</span>}
			</div>
			<p style={S.note}>{NODE_SETTING_NOTE}</p>
			<ScoreHistogram scores={scores} range={score?.range ?? null} threshold={view.at} floor={score !== null && Number.isFinite(score.floor) ? score.floor : null} setting={score?.threshold ?? null} />
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
export function SearchResults({ run, view, score, range, onThreshold, onCopySetting, copied, onOpen, onMap, onAsk, canAsk, askReason = null, onShowAll, scopeOn = false }: SearchResultsProps): React.ReactElement {
	const fromChat = fromChatLine(run, scopeOn);
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
				<ThresholdControls rows={run.rows} view={view} score={score} range={range} onThreshold={onThreshold} onCopySetting={onCopySetting} copied={copied} />
			) : (
				<p style={S.note} role="status">
					{thresholdSentence(run.rows, view.at, score)}
				</p>
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
					<table style={S.table}>
						<caption style={S.caption}>{runCaption(run)}</caption>
						<thead>
							<tr>
								<th scope="col" style={S.th}>
									#
								</th>
								<th scope="col" style={S.th}>
									Document
								</th>
								<th scope="col" style={S.th}>
									Score
								</th>
								<th scope="col" style={S.th}>
									Status
								</th>
							</tr>
						</thead>
						<tbody>
							{view.rows.map((row, index) => {
								const path = row.path || row.objectId;
								const from = fusedFrom(row);
								return (
									<tr key={rowKey(row.key, index)} data-status={row.status} data-key={`${row.objectId}#${row.chunkId}`} style={row.status === 'used' || row.status === 'keyword' ? undefined : S.muted}>
										<td style={S.td}>{row.rank}</td>
										<td style={S.td}>
											<span>{`${path} #${row.chunkId}${row.cited ? ' · cited' : ''}`}</span>
											{from !== null && <span style={S.meta}>{from}</span>}
											{row.preview !== '' && <span style={S.meta}>{row.preview}</span>}
											<span style={S.actions}>
												<button type="button" style={S.button} aria-label={`Open ${path} at chunk ${row.chunkId}`} onClick={() => onOpen(row)}>
													open
												</button>
												<button type="button" style={S.button} aria-label={`Show chunk ${row.chunkId} of ${path} on the map`} onClick={() => onMap(row)}>
													map
												</button>
												<button type="button" style={S.button} aria-label={`Ask about ${path}`} disabled={!canAsk} title={canAsk ? undefined : (askReason ?? undefined)} onClick={() => onAsk(row)}>
													ask about this
												</button>
											</span>
										</td>
										<td style={S.td} title={scoreTitle(row, score)}>
											{row.score !== null ? row.score.toFixed(3) : 'match'}
										</td>
										<td style={S.td}>{STATUS_WORDS[row.status]}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
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
 * Search the collection without the LLM.
 *
 * @param props - {@link SearchPanelProps}.
 * @returns The panel.
 */
export function SearchPanel({ model, channels, selection, actions, prefill = null, onShowChat }: SearchPanelProps): React.ReactElement {
	const dialect = model.connection.dialect;
	const score = dialect?.score ?? null;
	const options = useMemo(() => modeOptions(model), [model]);
	const ks = useMemo(() => topKOptions(model.limits), [model.limits]);
	const range = useMemo(() => sliderRange(score), [score]);
	const gate = searchScope(model.scope ?? null, model.limits);
	const radioName = useId();

	const [question, setQuestion] = useState(prefill?.question ?? '');
	const [questionB, setQuestionB] = useState('');
	const [comparing, setComparing] = useState(false);
	const [chosenMode, setMode] = useState<SearchMode | null>(() => defaultMode(options));
	const [topK, setTopK] = useState(() => (prefill !== null ? prefillRun(prefill, options, ks).topK : ks.includes(DEFAULT_TOP_K) ? DEFAULT_TOP_K : (ks[ks.length - 1] ?? DEFAULT_TOP_K)));
	// null follows the node's setting (the dialect may answer after the panel mounted); a number is the user's.
	const [chosenAt, setAt] = useState<number | null>(null);
	// What "Open in Search" brought: kept with its question, so only a run of that question is marked.
	const [chat, setChat] = useState<ChatPrefill | null>(prefill);
	const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
	const [runs, setRuns] = useState<{ a: WorkbenchRun | null; b: WorkbenchRun | null }>({ a: null, b: null });
	const [limitedUntil, setLimitedUntil] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [copied, setCopied] = useState<string | null>(null);
	const runId = useRef(0);
	const lastPrefill = useRef(prefill);

	const mode = chosenMode !== null && options.find((o) => o.mode === chosenMode)?.enabled ? chosenMode : defaultMode(options);
	const at = Math.max(range.min, Math.min(range.max, chosenAt ?? initialThreshold(score)));
	const keywordOffered = options.find((o) => o.mode === 'keyword')?.enabled === true;
	const running = phase.kind === 'embedding' || phase.kind === 'searching';
	const limited = limitedUntil !== null && limitedUntil > now;

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

	const blockedBy = ((): string | null => {
		if (mode === null) return 'Search is not available on this connection.';
		if (gate.blocked !== null) return gate.blocked;
		if (limited) return rateLimitSentence(secondsLeft(limitedUntil as number, now));
		if (question.trim() === '') return 'Type a question to search for.';
		if (comparing && questionB.trim() === '') return 'Type question B to compare, or turn Compare off.';
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
		const tools = toolChannelFor(model, channels);
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
		const base = { mode: request.mode, topK: request.topK, limits: model.limits, storeNode: model.nodes.store, embedNode: model.nodes.embed, objectIds: request.objectIds, chat: request.chat };
		setRuns({ a: null, b: null });
		setPhase({ kind: request.mode === 'keyword' ? 'searching' : 'embedding', side: 'A' });
		const a = await runWorkbench(deps('A'), { ...base, question: request.question });
		if (runId.current !== id) return;
		if (!a.ok) return failed(a, 'A');
		if (request.questionB === null) {
			setRuns({ a: a.run, b: null });
			setPhase({ kind: 'done' });
			actions.announce(`${runCaption(a.run)}. ${thresholdSentence(a.run.rows, at, score)}`);
			return;
		}
		const b = await runWorkbench(deps('B'), { ...base, question: request.questionB });
		if (runId.current !== id) return;
		if (!b.ok) {
			setRuns({ a: a.run, b: null });
			return failed(b, 'B');
		}
		setRuns({ a: a.run, b: b.run });
		setPhase({ kind: 'done' });
		actions.announce(compareSentence(compareRuns(a.run.rows, b.run.rows)));
	};

	// "Open in Search" from the chat: take the question and its cited chunks, and run once the search "Why these?" made.
	useEffect(() => {
		if (prefill === null || prefill === lastPrefill.current) return;
		lastPrefill.current = prefill;
		const next = prefillRun(prefill, options, ks);
		setQuestion(next.question);
		setChat(prefill);
		setComparing(false);
		setMode(next.mode);
		setTopK(next.topK);
		// Its own documents (the question's), not the console's scope, so the console's gate does not stop it.
		if (next.mode !== null && !limited && next.question.trim() !== '') void run({ question: next.question, questionB: null, mode: next.mode, topK: next.topK, objectIds: next.objectIds, chat: prefill });
		// Runs once per prefill; the rest of the panel's state does not restart it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [prefill]);

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
	 * "Ask about this": scope the chat's next question to the row's document and show the chat.
	 *
	 * @param row - The row.
	 */
	const askAbout = (row: WorkbenchRow): void => {
		actions.askAbout([row.objectId]);
		onShowChat?.();
	};

	const handlers = {
		onThreshold: setAt,
		onCopySetting: copySetting,
		copied,
		onOpen: (row: WorkbenchRow) => actions.openDocument(row.objectId, row.chunkId),
		canAsk: model.chat.enabled,
		askReason: model.chat.reason,
		onAsk: askAbout,
	};
	const busyLabel = `${phase.kind === 'embedding' ? 'Embedding' : 'Searching'}${comparing && running ? ` ${phase.side}` : ''}…`;
	const reasons = reasonLines(options);

	return (
		<section aria-label="Search" data-component="SearchPanel" style={S.root}>
			<div style={S.head}>
				<p style={S.note}>Search the stored chunks directly, without the LLM.</p>
				<ExportMenu items={searchExportItems(viewA, viewB)} collection={model.collection} onExported={(fileName) => actions.announce(`Saved ${fileName}.`)} />
			</div>
			<form
				style={S.form}
				onSubmit={(event) => {
					event.preventDefault();
					if (blockedBy !== null || running || mode === null) return;
					void run({ question, questionB: comparing ? questionB : null, mode, topK, objectIds: gate.objectIds, chat });
				}}
			>
				<div style={S.row}>
					<input type="search" aria-label="Search question" placeholder="Search the documents…" value={question} maxLength={8000} style={S.input} onChange={(event) => setQuestion(event.currentTarget.value)} />
				</div>
				{comparing && (
					<div style={S.row}>
						<input type="search" aria-label="Second question (B)" placeholder="Compare with… (B)" value={questionB} maxLength={8000} style={S.input} onChange={(event) => setQuestionB(event.currentTarget.value)} />
					</div>
				)}
				<fieldset style={S.fieldset}>
					<legend style={S.legend}>Mode</legend>
					{options.map((option) => (
						<label key={option.mode} style={S.radio} title={option.reason ?? MODE_HINTS[option.mode]}>
							<input type="radio" name={radioName} checked={mode === option.mode} disabled={!option.enabled} value={option.mode} onChange={() => setMode(option.mode)} />
							{option.label}
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
					<button type="button" style={S.button} aria-pressed={comparing} onClick={() => setComparing((on) => !on)}>
						Compare
					</button>
					<button type="submit" style={commonStyles.buttonPrimary} disabled={blockedBy !== null || running} title={blockedBy ?? undefined}>
						{running ? busyLabel : comparing ? 'Run A and B' : 'Run'}
					</button>
				</div>
			</form>
			{gate.line !== null && <p style={S.note}>{gate.line}</p>}
			{gate.blocked !== null && <p style={S.note}>{gate.blocked}</p>}
			{limited && (
				<p style={S.note} role="timer">
					{rateLimitSentence(secondsLeft(limitedUntil as number, now))}
				</p>
			)}
			{phase.kind === 'error' && !limited && (
				<p style={S.error} role="alert">
					{comparing ? `${phase.side}: ${phase.message}` : phase.message}
				</p>
			)}
			{runs.a !== null && viewA !== null && runs.b === null && (
				<SearchResults
					run={runs.a}
					view={viewA}
					score={score}
					range={range}
					{...handlers}
					scopeOn={gate.objectIds !== null}
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
			{runs.a !== null && viewA !== null && runs.b !== null && viewB !== null && (
				<>
					{runs.a.rated && runs.a.rows.length > 0 && <ThresholdControls lead="A — " rows={runs.a.rows} view={viewA} score={score} range={range} onThreshold={setAt} onCopySetting={copySetting} copied={copied} />}
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
