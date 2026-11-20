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
// VECTOR-UI — DuplicatesPanel (the map's duplicates review queue)
// =============================================================================
//
// Near-duplicate chunks of the sample, grouped by the documents they join,
// as a review queue: a similarity slider (0.90 to 0.995, applied in the
// browser over the sample's own pairs, so moving it sends nothing), a keep
// policy (oldest ingest, shortest path, most chunks, or by hand), one
// fieldset per group with a Keep radio per document (the first 20 and the
// kept one; the rest counted, with how many of them are queued) and the
// pairs that make it, and Show group, Mark reviewed, Move the others to the
// trash and Move all queued to the trash. What the sample shows about each group is worked out
// once per view and documents, never on every render.
// A group inside one document is listed apart with Open only.
//
// Moving to the trash is the console's: the queued objectIds go to the host's
// batched move, which confirms (nothing to type: the Trash restores them) and
// sends `soft_delete` at most `write_ids_max` at a time, stopping at the first
// error. Without writes the radios and every button that moves documents are
// disabled with the reason as text.
// The reviewed documents are the connection's 'reviewed documents' cache.
// =============================================================================

import React, { useCallback, useMemo, useReducer, useState, useSyncExternalStore } from 'react';
import type { Availability, DuplicatesPanelProps as ContractDuplicatesPanelProps, IDocumentItem, IDocumentRowsSource, ISampleModel } from '../contract/types';
import { reviewedDocuments } from '../adapters/connections';
import { DOCS_SHOWN_MAX, GROUPS_SHOWN_MAX, KEEP_POLICIES, PAIRS_SHOWN_MAX, THRESHOLD_MAX, THRESHOLD_MIN, THRESHOLD_STEP, copyVerdict, dedupeView, docInfo, isReviewed, keepOf, markReviewed, policyChooses, queueInit, queueReducer, queued, reviewedOf, unmarkReviewed } from '../map/dedupe';
import type { ContainmentVerdict, CopyVerdict, IDedupeView, IDocInfo, IDocumentGroup, IQueueState, IQueued, KeepPolicy, ReviewedCache } from '../map/dedupe';
import { formatSize } from '../vector/fileType';
import { MAP_STYLES } from '../map/styles';
import { BY_HAND_NOT_SHOWN, BY_HAND_OWN_TEXT, CHOOSE_KEEP_FIRST, HELD_NOT_SHOWN, HELD_OWN_TEXT, KEPT_ELSEWHERE, NOTHING_SHOWN_HELD, NOT_WHOLE_COPIES_NOTE, NO_BULK_REMOVE, PARTLY_MATCHED_NOTE, POLICY_LEAVES_GROUP, SHARED_PASSAGES_NOTE, POLICY_LABELS, POLICY_UNAVAILABLE, REPEATED_HEADING, REPEATED_NOTE, TOO_FEW_SAMPLED_NOTE, UNEVEN_SAMPLE_NOTE, UNSIZED_NOTE, duplicatesKnnCaveat, duplicatesNone, duplicatesSampleCaveat, groupLegend, groupsCappedLine, moreDocumentsLine, morePairsLine, num, plural, queuedLine, removeAllLabel, removeOthersLabel, removedLine, reviewedGroupsHeading, sharedLine, simText, thresholdValueText } from '../map/reviewWording';

/** Props: the frozen ones, plus the queue's starting choices and the reviewed cache. */
export interface DuplicatesPanelProps extends ContractDuplicatesPanelProps {
	/** The queue's starting choices (a host restoring them; the tests). */
	initial?: Partial<IQueueState> & { requested?: readonly string[] };
	/** The reviewed documents per connection (default: the registry's 'reviewed documents'). */
	reviewedCache?: ReviewedCache;
}

/** What the queue's body is drawn from. */
export interface DuplicatesBodyProps {
	sample: ISampleModel;
	writes: Availability;
	view: IDedupeView;
	info: ReadonlyMap<string, IDocInfo>;
	state: IQueueState;
	reviewed: ReadonlySet<string>;
	queue: IQueued;
	/** The removal outcome line, or null. */
	done: string | null;
	/** Whether the host can remove several documents in one confirmed batch. */
	bulk: boolean;
	/** What the sample shows about each group, by group key (worked out once per view and documents; else per group as drawn). */
	verdicts?: ReadonlyMap<string, CopyVerdict>;
	onThreshold(value: number): void;
	onPolicy(policy: KeepPolicy): void;
	onKeep(group: string, objectId: string): void;
	onShow(points: readonly number[]): void;
	onReview(group: IDocumentGroup, reviewed: boolean): void;
	onRemove(objectIds: readonly string[]): void;
	onOpenDocument?(objectId: string, chunkId: number): void;
}

/** Why a policy leaves a group alone, by what the sample shows about it. */
const NOT_COPIES_NOTES: Readonly<Record<Exclude<CopyVerdict, 'copies'>, string>> = {
	passages: SHARED_PASSAGES_NOTE,
	mixed: NOT_WHOLE_COPIES_NOTE,
	partial: PARTLY_MATCHED_NOTE,
	sparse: TOO_FEW_SAMPLED_NOTE,
	unsized: UNSIZED_NOTE,
	uneven: UNEVEN_SAMPLE_NOTE,
};

/**
 * The words under a document the keep does not queue, or queues only by hand.
 *
 * @param verdict - What the sample shows about the kept document holding it.
 * @param byHand - True when a hand-picked keep queues it anyway.
 * @returns The phrase.
 */
function heldWords(verdict: ContainmentVerdict, byHand: boolean): string {
	if (verdict === 'out') return byHand ? BY_HAND_OWN_TEXT : HELD_OWN_TEXT;
	return byHand ? BY_HAND_NOT_SHOWN : HELD_NOT_SHOWN;
}

/** The last path segment. */
function base(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * Hand documents to the host's removal: several only through the batched,
 * typed-count dialog; one through it when the host has it, else the single
 * dialog. Never one dialog per document.
 *
 * @param objectIds - The documents.
 * @param host - The host's remove handlers.
 * @returns True when the host was asked.
 */
export function requestRemoval(objectIds: readonly string[], host: Pick<ContractDuplicatesPanelProps, 'onRemoveDocument' | 'onRemoveDocuments'>): boolean {
	if (objectIds.length === 0) return false;
	if (host.onRemoveDocuments) {
		host.onRemoveDocuments([...objectIds]);
		return true;
	}
	if (objectIds.length === 1) {
		host.onRemoveDocument(objectIds[0] as string);
		return true;
	}
	return false;
}

/**
 * The words under a document of a group: chunk count, ingest day, size, and
 * how many of its sampled chunks are in the group.
 *
 * @param doc - The document.
 * @param shared - Its points in the group.
 * @returns The line.
 */
function docLine(doc: IDocInfo | undefined, shared: number): string {
	const parts: string[] = [];
	if (doc?.chunks !== null && doc?.chunks !== undefined) parts.push(plural(doc.chunks, 'chunk'));
	if (doc?.ingestedAt) parts.push(`ingested ${doc.ingestedAt.slice(0, 10)}`);
	if (doc?.size !== null && doc?.size !== undefined) parts.push(formatSize(doc.size));
	parts.push(sharedLine(shared, doc?.inSample ?? shared));
	return parts.join(' · ');
}

/**
 * Why a document that is not kept is or is not queued, after the doc line.
 *
 * @param objectId - The document.
 * @param conflicts - Documents another group keeps.
 * @param held - The group's documents a policy leaves in place, and why.
 * @param unshown - The group's documents queued by hand that the sample does not show held, and why.
 * @returns The phrase with its separator, or ''.
 */
function docState(objectId: string, conflicts: ReadonlySet<string>, held: ReadonlyMap<string, ContainmentVerdict> | undefined, unshown: ReadonlyMap<string, ContainmentVerdict> | undefined): string {
	const notHeld = held?.get(objectId);
	if (notHeld !== undefined) return ` · ${heldWords(notHeld, false)}`;
	if (conflicts.has(objectId)) return ` · ${KEPT_ELSEWHERE}`;
	const byHand = unshown?.get(objectId);
	return byHand !== undefined ? ` · ${heldWords(byHand, true)}` : '';
}

/**
 * The pairs of a group as list rows.
 *
 * @param props - The body's props.
 * @param group - The group.
 * @returns The list.
 */
function pairList(props: DuplicatesBodyProps, group: IDocumentGroup): React.ReactElement {
	const result = props.sample.result;
	const label = (i: number): string => `${result.docs[result.points.doc[i] as number]?.path ?? '?'} #${result.points.chunk[i]}`;
	const shown = group.pairs.slice(0, PAIRS_SHOWN_MAX);
	return (
		<>
			<ul aria-label={`Pairs in group ${num(group.id + 1)}`} style={{ ...MAP_STYLES.list, margin: '4px 0' }}>
				{shown.map((pair) => (
					<li key={`${pair.a}-${pair.b}`} style={{ ...MAP_STYLES.small, padding: '2px 0' }}>
						{label(pair.a)} ↔ {label(pair.b)} · similarity {pair.sim.toFixed(4)}
					</li>
				))}
			</ul>
			{group.pairs.length > shown.length ? <p style={MAP_STYLES.note}>{morePairsLine(group.pairs.length - shown.length)}</p> : null}
		</>
	);
}

/**
 * The documents listed under a group: the first DOCS_SHOWN_MAX, the kept one
 * always among them.
 *
 * @param group - The group.
 * @param keep - Its kept document, or null.
 * @returns The listed objectIds, in the group's order.
 */
function listedDocuments(group: IDocumentGroup, keep: string | null): readonly string[] {
	if (group.objectIds.length <= DOCS_SHOWN_MAX) return group.objectIds;
	const first = group.objectIds.slice(0, DOCS_SHOWN_MAX);
	if (keep === null || first.includes(keep)) return first;
	return [...group.objectIds.slice(0, DOCS_SHOWN_MAX - 1), keep];
}

/**
 * One group across documents.
 *
 * @param props - The body's props.
 * @param group - The group.
 * @param reviewed - Whether it was marked reviewed.
 * @param conflicts - Documents another group keeps.
 * @returns Its fieldset.
 */
function groupFieldset(props: DuplicatesBodyProps, group: IDocumentGroup, reviewed: boolean, conflicts: ReadonlySet<string>): React.ReactElement {
	const keep = keepOf(group, props.state, props.info);
	const mine = props.queue.byGroup.get(group.key) ?? [];
	const queuedHere = new Set(mine);
	const writesOff = !props.writes.enabled;
	const reason = props.writes.reason ?? undefined;
	const cannotBulk = mine.length > 1 && !props.bulk;
	const removeWhy = writesOff ? reason : keep === null ? CHOOSE_KEEP_FIRST : cannotBulk ? NO_BULK_REMOVE : mine.length === 0 ? NOTHING_SHOWN_HELD : undefined;
	// Not copies: a policy queues only the documents the sample shows the kept one holds, and the panel says why.
	const verdict = props.verdicts?.get(group.key) ?? copyVerdict(group, props.info);
	const held = props.queue.held.get(group.key);
	const unshown = props.queue.unshown.get(group.key);
	const listed = listedDocuments(group, keep);
	const left = group.objectIds.length - listed.length;
	let leftQueued = 0;
	let leftUnshown = 0;
	if (left > 0 && !reviewed) {
		const shown = new Set(listed);
		for (const id of group.objectIds) {
			if (shown.has(id) || !queuedHere.has(id)) continue;
			leftQueued += 1;
			if (unshown?.has(id)) leftUnshown += 1;
		}
	}
	return (
		<fieldset key={group.key} data-group={group.id} style={{ border: '1px solid var(--rr-border)', borderRadius: 6, margin: '8px 0', padding: '6px 8px', opacity: reviewed ? 0.8 : 1 }}>
			<legend style={MAP_STYLES.label}>{groupLegend(group.id, group.objectIds.length, group.simMin, group.simMax)}</legend>
			{listed.map((objectId) => {
				const doc = props.info.get(objectId);
				const path = doc?.path || objectId;
				const isKept = keep === objectId;
				const isQueued = !reviewed && queuedHere.has(objectId);
				return (
					<div key={objectId} style={{ padding: '3px 0' }}>
						<label style={{ ...MAP_STYLES.small, display: 'flex', gap: 6, alignItems: 'baseline' }}>
							<input type="radio" name={`vector-dedupe-keep-${group.id}`} aria-label={`Keep ${path}`} checked={isKept} disabled={writesOff || reviewed} onChange={() => props.onKeep(group.key, objectId)} />
							<span style={{ wordBreak: 'break-all' }}>{path}</span>
							{isKept ? <span style={MAP_STYLES.tag}>kept</span> : null}
							{isQueued ? <span style={MAP_STYLES.tag}>queued</span> : null}
						</label>
						<div style={{ ...MAP_STYLES.small, marginLeft: 22 }}>
							{docLine(doc, group.shared[objectId] ?? 0)}
							{!isKept && keep !== null && !reviewed ? docState(objectId, conflicts, held, unshown) : ''}
						</div>
					</div>
				);
			})}
			{left > 0 ? <p style={MAP_STYLES.note}>{moreDocumentsLine(left, leftQueued, leftUnshown)}</p> : null}
			{pairList(props, group)}
			{verdict === 'copies' ? null : (
				<p style={MAP_STYLES.note}>
					{NOT_COPIES_NOTES[verdict]} {POLICY_LEAVES_GROUP}
				</p>
			)}
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
				<button type="button" style={MAP_STYLES.button} onClick={() => props.onShow(group.points)}>
					Show group
				</button>
				<button type="button" style={MAP_STYLES.button} onClick={() => props.onReview(group, !reviewed)}>
					{reviewed ? 'Review again' : 'Mark reviewed'}
				</button>
				{reviewed ? null : (
					<button type="button" style={MAP_STYLES.button} disabled={writesOff || mine.length === 0 || cannotBulk} title={removeWhy} onClick={() => props.onRemove(mine)}>
						{removeOthersLabel(mine.length)}
					</button>
				)}
			</div>
		</fieldset>
	);
}

/**
 * One group inside one document: Show and Open only.
 *
 * @param props - The body's props.
 * @param group - The group.
 * @returns Its fieldset.
 */
function repeatedFieldset(props: DuplicatesBodyProps, group: IDocumentGroup): React.ReactElement {
	const objectId = group.objectIds[0] as string;
	const path = props.info.get(objectId)?.path || objectId;
	const chunks = group.points.map((i) => props.sample.result.points.chunk[i] as number);
	return (
		<fieldset key={group.key} data-group={group.id} style={{ border: '1px solid var(--rr-border)', borderRadius: 6, margin: '8px 0', padding: '6px 8px' }}>
			<legend style={MAP_STYLES.label}>
				{base(path)} · chunks {chunks.map((c) => `#${c}`).join(', ')} · similarity {group.simMin === group.simMax ? simText(group.simMin) : `${simText(group.simMin)}–${simText(group.simMax)}`}
			</legend>
			<div style={{ ...MAP_STYLES.small, wordBreak: 'break-all' }}>{path}</div>
			{pairList(props, group)}
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
				<button type="button" style={MAP_STYLES.button} onClick={() => props.onShow(group.points)}>
					Show
				</button>
				{props.onOpenDocument ? (
					<button type="button" style={MAP_STYLES.button} onClick={() => props.onOpenDocument?.(objectId, Math.min(...chunks))}>
						Open
					</button>
				) : null}
			</div>
		</fieldset>
	);
}

/**
 * The queue's body: a plain function of its state (no hooks), so the tests
 * can call it and press its buttons.
 *
 * @param props - The computed queue and the handlers.
 * @returns The body.
 */
export function DuplicatesBody(props: DuplicatesBodyProps): React.ReactElement {
	const { view, state, writes, queue } = props;
	const result = props.sample.result;
	const open = view.groups.filter((g) => !isReviewed(g, props.reviewed));
	const done = view.groups.filter((g) => isReviewed(g, props.reviewed));
	const shown = open.slice(0, GROUPS_SHOWN_MAX);
	const total = queue.objectIds.length;
	const bulkBlocked = total > 1 && !props.bulk;
	const policies = KEEP_POLICIES.map((p) => ({ p, ok: p === 'manual' || p === 'shortest-path' || policyChooses(view.groups, p, props.info) }));
	const conflicts = new Set(queue.conflicts);
	return (
		<section aria-label="Near-duplicate review" data-component="DuplicatesPanel" data-threshold={state.threshold} data-queued={total}>
			<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
				<label style={{ ...MAP_STYLES.label, display: 'flex', flexDirection: 'column', gap: 4 }}>
					<span>Similarity at least {simText(state.threshold)}</span>
					<input type="range" min={THRESHOLD_MIN} max={THRESHOLD_MAX} step={THRESHOLD_STEP} value={state.threshold} aria-label="Near-duplicate similarity threshold" aria-valuetext={thresholdValueText(state.threshold)} onChange={(event) => props.onThreshold(Number(event.currentTarget.value))} />
				</label>
				<p style={MAP_STYLES.note}>{duplicatesKnnCaveat(result.knn.k)}</p>
				<p style={MAP_STYLES.note}>{duplicatesSampleCaveat(result.n)}</p>
			</div>
			{/* Outside the groups: a removal that resolves the last group still says what it did. */}
			{props.done ? <p style={MAP_STYLES.note}>{props.done}</p> : null}
			{view.groups.length === 0 && view.repeated.length === 0 ? (
				<p style={MAP_STYLES.note}>{duplicatesNone(state.threshold)}</p>
			) : (
				<>
					<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, margin: '6px 0' }}>
						<label style={{ ...MAP_STYLES.label, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
							<span>Keep</span>
							<select style={{ ...MAP_STYLES.select, maxWidth: 200 }} value={state.policy} disabled={!writes.enabled} aria-label="Which document each group keeps" onChange={(event) => props.onPolicy(event.currentTarget.value as KeepPolicy)}>
								{policies.map(({ p, ok }) => (
									<option key={p} value={p} disabled={!ok}>
										{ok ? POLICY_LABELS[p] : `${POLICY_LABELS[p]} (${POLICY_UNAVAILABLE[p as 'oldest' | 'most-chunks']})`}
									</option>
								))}
							</select>
						</label>
						<button type="button" style={MAP_STYLES.button} disabled={!writes.enabled || total === 0 || bulkBlocked} title={!writes.enabled ? (writes.reason ?? undefined) : bulkBlocked ? NO_BULK_REMOVE : undefined} onClick={() => props.onRemove(queue.objectIds)}>
							{removeAllLabel(total)}
						</button>
					</div>
					<p style={MAP_STYLES.note} role="status">
						{queuedLine(total, state.policy !== 'manual' && view.groups.some((g) => keepOf(g, state, props.info) !== null))}
					</p>
					{!writes.enabled && writes.reason ? <p style={MAP_STYLES.note}>{writes.reason}</p> : null}
					{shown.map((g) => groupFieldset(props, g, false, conflicts))}
					{open.length > shown.length ? <p style={MAP_STYLES.note}>{groupsCappedLine(shown.length, open.length)}</p> : null}
					{view.repeated.length > 0 ? (
						<section aria-label={REPEATED_HEADING} data-repeated="">
							<h4 style={{ ...MAP_STYLES.heading, fontSize: 12, marginTop: 10 }}>{REPEATED_HEADING}</h4>
							<p style={MAP_STYLES.note}>{REPEATED_NOTE}</p>
							{view.repeated.slice(0, GROUPS_SHOWN_MAX).map((g) => repeatedFieldset(props, g))}
						</section>
					) : null}
					{done.length > 0 ? (
						<section aria-label="Reviewed groups">
							<h4 style={{ ...MAP_STYLES.heading, fontSize: 12, marginTop: 10 }}>{reviewedGroupsHeading(done.length)}</h4>
							{done.slice(0, GROUPS_SHOWN_MAX).map((g) => groupFieldset(props, g, true, conflicts))}
						</section>
					) : null}
				</>
			)}
		</section>
	);
}

/** A stand-in rows source when the host gives none. */
const NO_ROWS: readonly IDocumentItem[] = [];
const noSubscribe = (): (() => void) => () => undefined;

/**
 * The duplicates queue of one connection.
 *
 * @param props - Sample, write availability, the console's rows and handlers.
 * @returns The panel.
 */
function DuplicatesQueue(props: DuplicatesPanelProps): React.ReactElement {
	const source: IDocumentRowsSource | null = props.documents ?? null;
	const subscribe = useCallback((listener: () => void) => (source ? source.subscribe(listener) : noSubscribe()), [source]);
	const getRows = useCallback(() => (source ? source.getRows() : NO_ROWS), [source]);
	const rows = useSyncExternalStore(subscribe, getRows, getRows);
	const [state, dispatch] = useReducer(queueReducer, props.initial, (initial) => {
		const start = queueInit();
		let s: IQueueState = { ...start, policy: initial?.policy ?? start.policy, overrides: initial?.overrides ?? start.overrides };
		if (initial?.threshold !== undefined) s = queueReducer(s, { type: 'threshold', value: initial.threshold });
		return s;
	});
	const [requested, setRequested] = useState<readonly string[]>(props.initial?.requested ?? []);
	const cache = props.reviewedCache ?? reviewedDocuments;
	const [local, setLocal] = useState<ReadonlySet<string>>(() => new Set());
	const [, setTick] = useState(0);
	const reviewed = props.connectionKey ? reviewedOf(cache, props.connectionKey) : local;
	const result = props.sample.result;
	const removed = props.sample.removed;
	const view = useMemo(() => dedupeView(result, state.threshold, removed), [result, state.threshold, removed]);
	const info = useMemo(() => docInfo(result, rows), [result, rows]);
	const queue = useMemo(() => queued(view.groups, state, info, reviewed), [view, state, info, reviewed]);
	// What the sample shows about each group: once per view and documents, not on every render.
	const verdicts = useMemo(() => new Map(view.groups.map((g) => [g.key, copyVerdict(g, info)] as const)), [view, info]);

	const onReview = useCallback(
		(group: IDocumentGroup, value: boolean): void => {
			if (props.connectionKey) {
				if (value) markReviewed(cache, props.connectionKey, group.objectIds);
				else unmarkReviewed(cache, props.connectionKey, group.objectIds);
				setTick((t) => t + 1);
				return;
			}
			setLocal((prev) => {
				const next = new Set(prev);
				for (const id of group.objectIds) {
					if (value) next.add(id);
					else next.delete(id);
				}
				return next;
			});
		},
		[cache, props.connectionKey]
	);

	const onRemove = useCallback(
		(objectIds: readonly string[]): void => {
			if (requestRemoval(objectIds, props)) setRequested([...objectIds]);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[props.onRemoveDocument, props.onRemoveDocuments]
	);

	const gone = new Set(removed);
	const removedNow = requested.filter((id) => gone.has(id));
	let done: string | null = null;
	if (requested.length > 0 && removedNow.length > 0) {
		const counts = removedNow.map((id) => info.get(id)?.chunks ?? null);
		done = removedLine(removedNow.length, counts.every((c) => c !== null) ? counts.reduce<number>((sum, c) => sum + (c ?? 0), 0) : null);
	}

	return <DuplicatesBody sample={props.sample} writes={props.writes} view={view} info={info} state={state} reviewed={reviewed} queue={queue} done={done} bulk={props.onRemoveDocuments !== undefined} verdicts={verdicts} onThreshold={(value) => dispatch({ type: 'threshold', value })} onPolicy={(value) => dispatch({ type: 'policy', value })} onKeep={(group, objectId) => dispatch({ type: 'keep', group, objectId })} onShow={(points) => props.onSelect(points)} onReview={onReview} onRemove={onRemove} onOpenDocument={props.onOpenDocument} />;
}

/**
 * The duplicates queue. Its choices (threshold, policy, hand-picked keeps,
 * the removal it asked for) belong to one connection: another connection
 * starts a fresh queue.
 *
 * @param props - Sample, write availability, the console's rows and handlers.
 * @returns The panel.
 */
export function DuplicatesPanel(props: DuplicatesPanelProps): React.ReactElement {
	return <DuplicatesQueue key={props.connectionKey ?? ''} {...props} />;
}

export default DuplicatesPanel;
