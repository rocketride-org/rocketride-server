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
// VECTOR-UI — RetrievalDebugger ("Why these?")
// =============================================================================
//
// Re-runs the retrieval behind an answer so the user can see why these chunks
// were cited and what nearly was: it embeds the question on the pipeline's
// embedding node (`embed`, through the Tools source), searches the store with
// exactly that vector for k + 10 rows including the ones below the threshold
// and the floor, within the documents the question was asked about when the
// chat was scoped (src/vector/retrieval.ts), and lays them out against both
// lines with a 100-bin histogram. The vector lives only for the two calls;
// it is never kept in state or shown. Hidden when `embed` is not reachable.
// Its rows go to the ExportMenu in the search columns (src/vector/
// searchWorkbench.ts), and "Open in Search" hands the question, the
// answer's cited chunks, this k and these documents to the Search surface,
// whose first run is therefore the same search and lists the same rows; there
// the threshold can be tried at other values.
//
// The debugger still makes its two calls here rather than through Search's
// runWorkbench: the chat's wiring rules read them in this file. The search
// it sends and the one Search's first run sends are held equal by the
// workbench's tests instead.
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, commonStyles } from 'shell';
import type { IChatSource, IExportItem, ISearchResult, RetrievalDebuggerProps as ContractRetrievalDebuggerProps } from '../contract/types';
import { callTool, toolChannelFor } from '../chat/toolCalls';
import { rowKey } from '../vector/compare';
import { classifyRetrieval, debuggerScopeSentence, debuggerSearchInput, embedErrorSentence, embedInput, retrievalErrorSentence, withScope } from '../vector/retrieval';
import type { RetrievalStatus, RetrievalView } from '../vector/retrieval';
import { openInSearchPrefill, retrievalExportRows } from '../vector/searchWorkbench';
import type { ChatPrefill } from '../vector/searchWorkbench';
import { ExportMenu } from './ExportMenu';
import { ScoreHistogram } from './ScoreHistogram';

/** The contract props plus the answer's citations (marked in the table), the documents it was asked about, and the way into Search. */
export interface RetrievalDebuggerProps extends ContractRetrievalDebuggerProps {
	answerSources?: readonly IChatSource[];
	/** The documents the question was asked about (the chat sent them as its filter); null or absent: the whole collection. */
	scope?: readonly string[] | null;
	/** "Open in Search": the question, the keys the answer cited, and the k and documents searched here. Absent: no button. */
	onOpenInSearch?(prefill: ChatPrefill): void;
}

/** How long each of the two calls may take. */
const CALL_TIMEOUT_MS = 60_000;

/** Words for each row status (the colour only repeats them). */
const STATUS_WORDS: Record<RetrievalStatus, string> = {
	used: 'passed the threshold',
	near_miss: 'near miss: below the threshold',
	below_floor: 'below the floor',
};

const S = {
	root: { border: '1px solid var(--rr-border)', borderRadius: 6, padding: '8px 10px', margin: '6px 0', background: 'var(--rr-bg-paper)', fontSize: 12 } as CSSProperties,
	head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } as CSSProperties,
	title: { margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--rr-text-primary)' } as CSSProperties,
	line: { margin: '4px 0', color: 'var(--rr-text-secondary)' } as CSSProperties,
	table: { width: '100%', borderCollapse: 'collapse', marginTop: 6 } as CSSProperties,
	th: { textAlign: 'left', fontWeight: 600, color: 'var(--rr-text-secondary)', padding: '2px 4px', borderBottom: '1px solid var(--rr-border)' } as CSSProperties,
	td: { padding: '2px 4px', borderBottom: '1px solid var(--rr-border)', verticalAlign: 'top', overflowWrap: 'anywhere' } as CSSProperties,
	muted: { color: 'var(--rr-text-secondary)' } as CSSProperties,
};

/** Where the debugger is. */
type Phase = { kind: 'embedding' } | { kind: 'searching' } | { kind: 'error'; message: string } | { kind: 'done'; view: RetrievalView };

/**
 * The debugger's table: every row of its search, including those under the
 * threshold and the floor.
 *
 * @param props - The view of the search.
 * @returns The table.
 */
export function RetrievalTable({ view }: { view: RetrievalView }): React.ReactElement {
	return (
		<table style={S.table}>
			<caption style={{ ...S.line, textAlign: 'left' }}>{`Top ${view.rows.length} chunks for the question, including those under the threshold and the floor`}</caption>
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
				{view.rows.map((row, index) => (
					<tr key={rowKey(row.key, index)} data-status={row.status} style={row.status === 'used' ? undefined : S.muted}>
						<td style={S.td}>{row.rank}</td>
						<td style={S.td} title={row.preview}>
							{`${row.path || row.objectId} #${row.chunkId}`}
							{row.inAnswer ? ' · cited' : ''}
						</td>
						<td style={S.td} title={row.rawScore !== null ? `raw score ${row.rawScore}` : undefined}>
							{row.score !== null ? row.score.toFixed(3) : '—'}
						</td>
						<td style={S.td}>{STATUS_WORDS[row.status]}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/**
 * "Why these?" for one answer.
 *
 * @param props - {@link RetrievalDebuggerProps}.
 * @returns The debugger.
 */
export function RetrievalDebugger({ model, channels, question, topK, onClose, answerSources, scope = null, onOpenInSearch }: RetrievalDebuggerProps): React.ReactElement | null {
	const [phase, setPhase] = useState<Phase>({ kind: 'embedding' });
	const embedNode = model.nodes.embed;
	const enabled = model.embed.enabled && embedNode !== null;
	const scopeKey = (scope ?? []).join('\n');

	useEffect(() => {
		if (!enabled) return undefined;
		let current = true;
		const tools = toolChannelFor(model, channels);
		const run = async (): Promise<void> => {
			setPhase({ kind: 'embedding' });
			const embedded = await callTool(tools, 'embed', { ...embedInput(question) }, embedNode, { timeoutMs: CALL_TIMEOUT_MS });
			if (!current) return;
			if (!embedded.ok) {
				setPhase({ kind: 'error', message: embedErrorSentence(embedded.error ?? embedded) });
				return;
			}
			const vectors = embedded.value.vectors;
			const vector = Array.isArray(vectors) && Array.isArray(vectors[0]) ? (vectors[0] as number[]) : null;
			if (vector === null) {
				setPhase({ kind: 'error', message: 'The embedding node answered without a vector.' });
				return;
			}
			setPhase({ kind: 'searching' });
			const embeddingModel = typeof embedded.value.model === 'string' ? embedded.value.model : null;
			const searched = await callTool(tools, 'search', { ...withScope(debuggerSearchInput(vector, embeddingModel, topK, model.limits), scope) }, model.nodes.store, { timeoutMs: CALL_TIMEOUT_MS });
			if (!current) return;
			if (!searched.ok) {
				setPhase({ kind: 'error', message: retrievalErrorSentence(searched.error ?? searched) });
				return;
			}
			setPhase({ kind: 'done', view: classifyRetrieval(searched.value as unknown as ISearchResult, model.connection.dialect?.score ?? null, answerSources ?? []) });
		};
		void run();
		return () => {
			current = false;
		};
		// One run per question (and the documents it was asked about) on this connection; the model's other fields do not restart it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [question, topK, scopeKey, model.connectionKey, enabled]);

	if (!enabled) return null;
	const range = model.connection.dialect?.score?.range ?? null;
	const scopeLine = debuggerScopeSentence(scope);
	const exportItems: IExportItem[] = phase.kind === 'done' ? [{ id: 'retrieval', label: `"Why these?" rows (${phase.view.rows.length})`, kind: 'retrieval', disabled: null, rows: () => retrievalExportRows(phase.view, STATUS_WORDS) }] : [{ id: 'retrieval', label: '"Why these?" rows', kind: 'retrieval', disabled: phase.kind === 'error' ? 'The search did not run' : 'Nothing to export yet' }];
	return (
		<section style={S.root} aria-label="Why these sources">
			<div style={S.head}>
				<h3 style={S.title}>Why these sources?</h3>
				<ExportMenu items={exportItems} collection={model.collection} />
				{onOpenInSearch && (
					<button type="button" style={commonStyles.buttonSecondary} title="Try other thresholds, modes and questions on these results" onClick={() => onOpenInSearch(openInSearchPrefill(question, answerSources ?? [], topK, model.limits, scope))}>
						Open in Search
					</button>
				)}
				<button type="button" style={commonStyles.buttonSecondary} onClick={onClose}>
					Close
				</button>
			</div>
			{scopeLine !== null && <p style={S.line}>{scopeLine}</p>}
			{phase.kind === 'embedding' && <p style={S.line}>Embedding…</p>}
			{phase.kind === 'searching' && <p style={S.line}>Searching…</p>}
			{phase.kind === 'error' && <p style={{ ...S.line, color: 'var(--rr-color-error)' }}>{phase.message}</p>}
			{phase.kind === 'done' && (
				<>
					{phase.view.modelMismatchSentence !== null && <Banner variant="warning">{phase.view.modelMismatchSentence}</Banner>}
					{phase.view.keywordFallback && <p style={S.line}>The store fell back to a keyword search, so these scores are not similarities.</p>}
					<p style={S.line}>
						{phase.view.summary}
						{phase.view.floor !== null ? ` · floor ${phase.view.floor.toFixed(2)}` : ''}
					</p>
					<ScoreHistogram scores={phase.view.rows.map((row) => row.score).filter((score): score is number => score !== null)} range={range} threshold={phase.view.threshold} floor={phase.view.floor} />
					<RetrievalTable view={phase.view} />
				</>
			)}
		</section>
	);
}

export default RetrievalDebugger;
