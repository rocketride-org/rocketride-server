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
// VECTOR-UI — RecommendPanel (the map's Recommend tab)
// =============================================================================
//
// Chunks like the positive examples and unlike the negative ones, from the
// whole collection: the examples as removable chips, "+ current query", the
// strategy (Average vector; Best score where the store ranks natively), k,
// Run, and the results with a map button each and "Pin results on the map".
// The map runs the call (it holds the query vector and the scope); the panel
// never sees a vector. A read-only connection can recommend: nothing is
// written. A node without the tool says to update the node.
// =============================================================================

import React, { useMemo, useRef, useState } from 'react';
import type { IRecommendExamples, RecommendPanelProps, RecommendStrategy, VectorKey } from '../contract/types';
import { keyIndex, keyString } from '../map/model';
import { RECOMMEND_BUSY, RECOMMEND_K_DEFAULT, RECOMMEND_K_OPTIONS, RECOMMEND_UNSUPPORTED_NODE, exampleLabel, notFoundLine, outsideKeys, recommendAvailable, recommendBlocker, recommendFailure, recommendNote, recommendRows, removeExample, resolvedLine, setWithQuery, toRequest } from '../map/recommend';
import type { IRecommendRow } from '../map/recommend';
import { MAP_STYLES } from '../map/styles';

export type { RecommendPanelProps };

/** What the last run gave. */
export type RecommendOutcome = { kind: 'rows'; rows: readonly IRecommendRow[]; resolved: string; notFound: string | null; stale: boolean } | { kind: 'error'; message: string };

/** What the panel's body is drawn from. */
export interface RecommendBodyProps {
	/** The node has the tool. */
	available: boolean;
	examples: IRecommendExamples;
	labelOf(key: VectorKey): string;
	strategy: RecommendStrategy;
	k: number;
	/** The store ranks Best score itself. */
	bestScore: boolean;
	queryText: string | null;
	/** Why Run is disabled, or null. */
	blocker: string | null;
	note: string | null;
	busy: boolean;
	outcome: RecommendOutcome | null;
	/** The node's project_keys_max (pins per click). */
	pinMax: number;
	onStrategy(strategy: RecommendStrategy): void;
	onK(k: number): void;
	onWithQuery(on: boolean): void;
	onRemoveExample(key: VectorKey): void;
	onClear(): void;
	onRun(): void;
	onSelect(key: VectorKey): void;
	onPin(keys: readonly VectorKey[]): void;
}

/** How to add examples. */
const HOW_TO_ADD = 'Chunks of the whole collection like the positive examples and unlike the negative ones. Add examples from a point on the map: Add as example (+) or (−) in its inspector.';

/**
 * One side's chips.
 *
 * @param props - The body's props.
 * @param side - Positive or negative.
 * @returns The chips, or "None yet."
 */
function chips(props: RecommendBodyProps, side: 'positive' | 'negative'): React.ReactElement {
	const keys = side === 'positive' ? props.examples.positive : props.examples.negative;
	return (
		<div style={{ margin: '4px 0' }}>
			<div style={MAP_STYLES.label}>{side === 'positive' ? 'Like these (+)' : 'Unlike these (−)'}</div>
			{keys.length === 0 ? (
				<p style={MAP_STYLES.note}>None yet.</p>
			) : (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
					{keys.map((key) => {
						const label = props.labelOf(key);
						return (
							<button key={keyString(key[0], key[1])} type="button" style={{ ...MAP_STYLES.button, height: 24, fontWeight: 500, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }} aria-label={`Remove ${side} example: ${label}`} title={`Remove ${side} example: ${label}`} onClick={() => props.onRemoveExample(key)}>
								{side === 'positive' ? '+ ' : '− '}
								{label} ✕
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

/**
 * The results.
 *
 * @param props - The body's props.
 * @param outcome - The rows of the last run.
 * @returns The list and its actions.
 */
function results(props: RecommendBodyProps, outcome: Extract<RecommendOutcome, { kind: 'rows' }>): React.ReactElement {
	const outside = outsideKeys(outcome.rows, props.pinMax);
	const outsideCount = outcome.rows.filter((r) => !r.inSample).length;
	return (
		<div style={{ marginTop: 8 }}>
			{outcome.resolved ? <p style={MAP_STYLES.note}>{outcome.resolved}</p> : null}
			{outcome.notFound ? <p style={MAP_STYLES.note}>{outcome.notFound}</p> : null}
			{outcome.stale ? <p style={MAP_STYLES.note}>These results are for the examples before your last change; run again.</p> : null}
			{outcome.rows.length === 0 ? (
				<p style={MAP_STYLES.note}>The store returned no chunk for these examples.</p>
			) : (
				<>
					<ol aria-label="Recommended chunks" style={MAP_STYLES.list}>
						{outcome.rows.map((row, rank) => (
							<li key={keyString(row.key[0], row.key[1])} style={MAP_STYLES.row}>
								<button type="button" style={MAP_STYLES.linkButton} title="Select it on the map" onClick={() => props.onSelect(row.key)}>
									{rank + 1}. {row.label}
								</button>
								<div style={MAP_STYLES.small}>
									similarity {row.sim.toFixed(3)}
									{row.score !== null && row.score !== row.sim ? ` · score ${row.score.toFixed(3)}` : ''}
									{row.inSample ? null : <span style={MAP_STYLES.tag}>outside the sample</span>}
									{row.below_floor ? <span style={MAP_STYLES.tag}>below floor</span> : null}
								</div>
								{row.preview ? <div style={{ ...MAP_STYLES.small, marginTop: 2 }}>{row.preview}</div> : null}
							</li>
						))}
					</ol>
					{outsideCount > 0 ? (
						<button type="button" style={{ ...MAP_STYLES.button, marginTop: 6 }} onClick={() => props.onPin(outside.keys)}>
							{outside.capped ? `Pin results on the map (the first ${outside.keys.length} of ${outsideCount} outside the sample)` : `Pin results on the map (${outsideCount} outside the sample)`}
						</button>
					) : null}
				</>
			)}
		</div>
	);
}

/**
 * The panel's body: a plain function of its state (no hooks), so the tests
 * can call it and press its buttons.
 *
 * @param props - The examples, choices, outcome and handlers.
 * @returns The body.
 */
export function RecommendBody(props: RecommendBodyProps): React.ReactElement {
	if (!props.available) {
		return (
			<section aria-label="Recommend" data-component="RecommendPanel" data-available="false">
				<p style={MAP_STYLES.note}>{RECOMMEND_UNSUPPORTED_NODE}</p>
			</section>
		);
	}
	const hasExamples = props.examples.positive.length + props.examples.negative.length > 0;
	return (
		<section aria-label="Recommend" data-component="RecommendPanel" data-available="true" data-busy={props.busy ? 'true' : 'false'}>
			<p style={MAP_STYLES.note}>{HOW_TO_ADD}</p>
			{chips(props, 'positive')}
			{chips(props, 'negative')}
			<label style={{ ...MAP_STYLES.small, display: 'flex', gap: 6, alignItems: 'baseline', margin: '4px 0' }}>
				<input type="checkbox" checked={props.examples.withQuery && props.queryText !== null} disabled={props.queryText === null} onChange={(event) => props.onWithQuery(event.currentTarget.checked)} />
				<span>{props.queryText === null ? '+ current query (run a text query on the map to count it as a positive)' : `+ current query “${props.queryText}” as a positive`}</span>
			</label>
			<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, margin: '6px 0' }}>
				<label style={{ ...MAP_STYLES.label, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
					<span>Strategy</span>
					<select style={{ ...MAP_STYLES.select, maxWidth: 200 }} value={props.strategy} aria-label="How the examples are combined" onChange={(event) => props.onStrategy(event.currentTarget.value as RecommendStrategy)}>
						<option value="average_vector">Average vector</option>
						<option value="best_score" disabled={!props.bestScore}>
							{props.bestScore ? 'Best score (ranked by the store)' : 'Best score (only where the store ranks examples itself)'}
						</option>
					</select>
				</label>
				<label style={{ ...MAP_STYLES.label, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
					<span>Results</span>
					<select style={MAP_STYLES.select} value={String(props.k)} aria-label="How many chunks to find" onChange={(event) => props.onK(Number(event.currentTarget.value))}>
						{RECOMMEND_K_OPTIONS.map((k) => (
							<option key={k} value={String(k)}>
								{k}
							</option>
						))}
					</select>
				</label>
				<button type="button" style={MAP_STYLES.button} disabled={props.blocker !== null || props.busy} title={props.blocker ?? undefined} onClick={() => props.onRun()}>
					Run
				</button>
				<button type="button" style={MAP_STYLES.button} disabled={!hasExamples && !props.examples.withQuery} onClick={() => props.onClear()}>
					Clear examples
				</button>
			</div>
			{props.blocker ? <p style={MAP_STYLES.note}>{props.blocker}</p> : null}
			{props.note ? <p style={MAP_STYLES.note}>{props.note}</p> : null}
			{props.busy ? (
				<p style={MAP_STYLES.note} role="status">
					{RECOMMEND_BUSY}
				</p>
			) : null}
			{props.outcome?.kind === 'error' ? <p style={MAP_STYLES.note}>{props.outcome.message}</p> : null}
			{props.outcome?.kind === 'rows' ? results(props, props.outcome) : null}
		</section>
	);
}

/** The words of a request, to tell whether results still match the examples. */
function signature(examples: IRecommendExamples, strategy: RecommendStrategy, k: number, queryText: string | null): string {
	return JSON.stringify([examples.positive, examples.negative, examples.withQuery ? queryText : null, strategy, k]);
}

/**
 * The Recommend tab.
 *
 * @param props - The frozen props: sample, limits, capabilities, examples, query text, the run and the map handlers.
 * @returns The panel.
 */
export function RecommendPanel(props: RecommendPanelProps): React.ReactElement {
	const [strategy, setStrategy] = useState<RecommendStrategy>('average_vector');
	const [k, setK] = useState<number>(RECOMMEND_K_DEFAULT);
	const [busy, setBusy] = useState(false);
	const [last, setLast] = useState<{ outcome: RecommendOutcome; signature: string } | null>(null);
	const seq = useRef(0);
	const sample = props.sample;
	const index = useMemo(() => (sample ? keyIndex(sample.result) : null), [sample]);
	const labelOf = (key: VectorKey): string => exampleLabel(sample, key);
	const blocker = recommendBlocker({ examples: props.examples, strategy, capabilities: props.capabilities, limits: props.limits, queryText: props.queryText });
	const now = signature(props.examples, strategy, k, props.queryText);

	const onRun = async (): Promise<void> => {
		if (blocker !== null || busy) return;
		const ran = now;
		const usedStrategy = strategy;
		const mine = ++seq.current;
		setBusy(true);
		try {
			const outcome = await props.onRun(toRequest(props.examples, k, strategy, props.queryText));
			if (mine !== seq.current) return;
			if (outcome.ok) {
				const result = outcome.value;
				const rows = recommendRows(result, (key) => index?.has(keyString(key[0], key[1])) ?? false);
				setLast({ outcome: { kind: 'rows', rows, resolved: resolvedLine(result), notFound: notFoundLine(result.not_found, labelOf), stale: false }, signature: ran });
			} else setLast({ outcome: { kind: 'error', message: recommendFailure(outcome.code, outcome.message, usedStrategy) }, signature: ran });
		} catch (error) {
			if (mine === seq.current) setLast({ outcome: { kind: 'error', message: recommendFailure(undefined, error instanceof Error ? error.message : String(error), usedStrategy) }, signature: ran });
		} finally {
			if (mine === seq.current) setBusy(false);
		}
	};

	const outcome: RecommendOutcome | null = last === null ? null : last.outcome.kind === 'rows' ? { ...last.outcome, stale: last.signature !== now } : last.outcome;
	return <RecommendBody available={recommendAvailable(props.limits)} examples={props.examples} labelOf={labelOf} strategy={strategy} k={k} bestScore={props.capabilities.recommend_best_score === true} queryText={props.queryText} blocker={blocker} note={recommendNote(props.examples, strategy, props.queryText)} busy={busy} outcome={outcome} pinMax={props.limits.project_keys_max} onStrategy={setStrategy} onK={setK} onWithQuery={(on) => props.onExamplesChange(setWithQuery(props.examples, on))} onRemoveExample={(key) => props.onExamplesChange(removeExample(props.examples, key))} onClear={() => props.onExamplesChange({ positive: [], negative: [], withQuery: false })} onRun={() => void onRun()} onSelect={(key) => props.onSelect(key)} onPin={(keys) => props.onPin(keys)} />;
}

export default RecommendPanel;
