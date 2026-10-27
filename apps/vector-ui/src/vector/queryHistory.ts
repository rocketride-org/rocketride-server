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
// VECTOR - THE QUERY TAB'S HISTORY (pure): what a run records, how an entry
// reads, and what Load and Rerun do with it
// =============================================================================
//
// Every finished run of the Query tab is recorded through `env.queryHistory`
// (env.ts): a Search run per mode, a Compare once (question A, with B beside
// it as `compareWith`), an Ask question when its answer ends. The full app
// keeps the history in the workspace preferences; a dev-tool mount keeps it
// for the document's life. A run is handed over whole: the history keeps the
// first 200 characters of its question and marks a longer one `truncated`
// (adapters/queryHistory.ts), so a chunk's text used as the query never lands
// in the workspace file whole, and two long questions that share their start
// stay two entries. A run that repeats the newest entry's whole question is
// that entry run again: the entry keeps its id, pin and note, takes the run's
// facts, and History says "Ran again" (no entry is added). A Compare's
// question B is kept for the session only, so after a reload its entry says
// "Question B isn't saved."
//
//   - Load fills the form (or Ask's box) and runs nothing; a cut question
//     says only the first 200 characters were kept;
//   - Rerun runs again with the entry's mode and k, and the threshold, the
//     scope and the table choice as they are NOW, and its title says so; it
//     is off, with the reason, when the mode cannot run now, when the
//     question was cut, or when a Compare's B is not there.
// =============================================================================

import type { ChatTurn } from '../chat/chatSession';
import type { IQueryHistoryEntry, QueryHistoryKind } from '../env';
import type { AskHandoff, ModeOption, SearchHandoff, SearchMode } from './searchWorkbench';
import type { QueryMode } from './workbench';

/** Said of an entry whose question was longer than History keeps (adapters/queryHistory.ts QUERY_HISTORY_TEXT_MAX). */
export const ONLY_FIRST_KEPT = 'Only the first 200 characters were kept.';

/** Said on the entry a run landed on when it repeated the newest entry's question (no entry was added). */
export const RAN_AGAIN = 'Ran again: this entry shows the latest run.';

/** Said of a Compare entry whose question B is not there (it is kept for the session only). */
export const COMPARE_B_NOT_SAVED = "Question B isn't saved.";

/** A run as the Query tab records it: the whole question (History cuts it), and a Compare's question B for the session. */
export type QueryRunRecord = Omit<IQueryHistoryEntry, 'id' | 'truncated'>;

/** An entry as History shows it (a Compare's question B when the session still has it). */
export type QueryHistoryItem = IQueryHistoryEntry;

/**
 * The entry a run lands on when it repeats the newest entry's whole question
 * (the history updates that entry instead of adding one); an entry History
 * already cut never takes a run.
 *
 * @param entries - The connection's entries, newest first.
 * @param question - The run's whole question (a Compare's A).
 * @returns The newest entry's id, or null when the run adds an entry.
 */
export function landsOn(entries: readonly Pick<IQueryHistoryEntry, 'id' | 'question' | 'truncated'>[], question: string): string | null {
	const newest = entries[0];
	return newest !== undefined && newest.truncated !== true && newest.question === question ? newest.id : null;
}

/**
 * The record of one Search run.
 *
 * @param run - The question, the mode asked for (an Auto that fell back stays Auto), k, and the rows or the error.
 * @param at - When it started.
 * @param ms - How long it took.
 * @returns The record.
 */
export function searchRecord(run: { question: string; mode: SearchMode; topK: number; results: number | null; error?: string }, at: number, ms: number): QueryRunRecord {
	return { question: run.question, kind: run.mode, at, ms, topK: run.topK, results: run.error === undefined ? run.results : null, outcome: run.error === undefined ? 'rows' : 'error', ...(run.error === undefined ? {} : { error: run.error }) };
}

/**
 * The record of one Compare (A and B, recorded once): its count is the chunks both found.
 *
 * @param run - Both questions, k, and the shared count or the error ("A: …" or "B: …").
 * @param at - When it started.
 * @param ms - How long both took.
 * @returns The record.
 */
export function compareRecord(run: { a: string; b: string; topK: number; shared: number | null; error?: string }, at: number, ms: number): QueryRunRecord {
	return { question: run.a, compareWith: run.b, kind: 'compare', at, ms, topK: run.topK, results: run.error === undefined ? run.shared : null, outcome: run.error === undefined ? 'rows' : 'error', ...(run.error === undefined ? {} : { error: run.error }) };
}

/**
 * The record of one Ask question, once its answer ended.
 *
 * @param turn - The question and what came of it.
 * @returns The record, or null while it is still being answered.
 */
export function askRecord(turn: ChatTurn): QueryRunRecord | null {
	if (turn.status === 'asking') return null;
	const ms = turn.answeredAt !== null ? Math.max(0, turn.answeredAt - turn.askedAt) : 0;
	const base = { question: turn.question, kind: 'ask' as const, at: turn.askedAt, ms, topK: null };
	if (turn.status === 'answered') return { ...base, results: turn.answer?.sources.length ?? 0, outcome: 'rows' };
	return { ...base, results: null, outcome: 'error', error: turn.error?.message ?? 'The question was not answered.' };
}

// ── How an entry reads ──────────────────────────────────────────────────────

/** The words of each kind. */
export const KIND_LABELS: Readonly<Record<QueryHistoryKind, string>> = { semantic: 'Semantic', keyword: 'Keyword', hybrid: 'Hybrid', auto: 'Auto', ask: 'Ask', compare: 'Compare' };

/** Which entries History shows. */
export type HistoryFilter = 'all' | 'search' | 'compare' | 'ask' | 'pinned';

/** The filters, in the order the select offers them. */
export const HISTORY_FILTERS: ReadonlyArray<{ id: HistoryFilter; label: string }> = [
	{ id: 'all', label: 'All runs' },
	{ id: 'search', label: 'Search' },
	{ id: 'compare', label: 'Compare' },
	{ id: 'ask', label: 'Ask' },
	{ id: 'pinned', label: 'Pinned' },
];

/**
 * The Query tab mode an entry's kind belongs to.
 *
 * @param kind - The kind.
 * @returns 'search', 'compare' or 'ask'.
 */
export function modeOfKind(kind: QueryHistoryKind): QueryMode {
	return kind === 'ask' || kind === 'compare' ? kind : 'search';
}

/**
 * The entries a filter shows: pinned first, then the rest, each newest first (as stored).
 *
 * @param entries - The connection's entries, newest first.
 * @param filter - The filter.
 * @returns The entries in the order shown.
 */
export function shownEntries<T extends Pick<IQueryHistoryEntry, 'kind' | 'pinned'>>(entries: readonly T[], filter: HistoryFilter): T[] {
	const kept = entries.filter((entry) => (filter === 'all' ? true : filter === 'pinned' ? entry.pinned === true : modeOfKind(entry.kind) === filter));
	return [...kept.filter((entry) => entry.pinned === true), ...kept.filter((entry) => entry.pinned !== true)];
}

/** The longest question an entry shows: the history's own cut, which question B (held whole for Rerun) follows on screen. */
const SHOWN_CHARS = 200;

/**
 * Question B as an entry shows it: whole for Load and Rerun, but on screen cut like A.
 *
 * @param b - Question B.
 * @returns At most 200 characters, and "…" when it was longer.
 */
function shownB(b: string): string {
	return b.length > SHOWN_CHARS ? `${b.slice(0, SHOWN_CHARS)}…` : b;
}

/**
 * An entry's question as History shows it: "…" after a cut question, and a
 * Compare as "A: …" and "B: …" (B cut to 200 characters on screen like A; it
 * is held whole, for the session, so Load and Rerun restore it).
 *
 * @param entry - The entry.
 * @returns The text.
 */
export function shownQuestion(entry: Pick<QueryHistoryItem, 'question' | 'truncated' | 'kind' | 'compareWith'>): string {
	const a = entry.truncated === true ? `${entry.question}…` : entry.question;
	if (entry.kind !== 'compare') return a;
	return `A: ${a}\nB: ${entry.compareWith === undefined ? COMPARE_B_NOT_SAVED : shownB(entry.compareWith)}`;
}

/**
 * How long a run took.
 *
 * @param ms - Milliseconds.
 * @returns "420 ms" or "1.3 s".
 */
export function msText(ms: number): string {
	return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * When a run started: the time today, else the day and the time.
 *
 * @param at - When it started.
 * @param now - Now.
 * @returns The words.
 */
export function entryTime(at: number, now: number): string {
	const when = new Date(at);
	const time = when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
	return when.toDateString() === new Date(now).toDateString() ? time : `${when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * What a run came to.
 *
 * @param entry - The entry.
 * @returns "12 results", "A and B shared 6", "4 sources", or the error.
 */
export function outcomeText(entry: Pick<IQueryHistoryEntry, 'kind' | 'results' | 'outcome' | 'error'>): string {
	if (entry.outcome === 'error') return `failed: ${entry.error ?? 'no reason given'}`;
	const n = entry.results ?? 0;
	if (entry.kind === 'compare') return `A and B shared ${n}`;
	if (entry.kind === 'ask') return n === 1 ? '1 source' : `${n} sources`;
	return n === 1 ? '1 result' : `${n} results`;
}

/**
 * The line under an entry's question.
 *
 * @param entry - The entry.
 * @param now - Now.
 * @returns "Semantic · top 10 · 12 results · 02:41 PM · 420 ms", with what History did not keep.
 */
export function entryMeta(entry: QueryHistoryItem, now: number): string {
	const parts = [KIND_LABELS[entry.kind], entry.topK !== null ? `top ${entry.topK}` : null, outcomeText(entry), entryTime(entry.at, now), msText(entry.ms)];
	if (entry.truncated === true || (entry.compareWith !== undefined && entry.compareWith.length > SHOWN_CHARS)) parts.push('first 200 characters kept');
	return parts.filter(Boolean).join(' · ');
}

// ── Load and Rerun ──────────────────────────────────────────────────────────

/** What Load and Rerun need to know about the tab now. */
export interface HistoryContext {
	/** The Search modes and whether each can run now. */
	options: readonly ModeOption[];
	/** The store's largest k (`limits.top_k_max`): a stored k above it is sent as this. */
	topKMax: number;
	nonce: string;
}

/**
 * An entry's k as the store takes it now.
 *
 * @param topK - The stored k, or null.
 * @param max - The store's largest k.
 * @returns The k, or null.
 */
function kNow(topK: number | null, max: number): number | null {
	return topK === null ? null : Math.max(1, Math.min(topK, max));
}

/** What Load does: the mode to show and the form it fills (nothing runs). */
export interface LoadPlan {
	mode: QueryMode;
	search: SearchHandoff | null;
	ask: AskHandoff | null;
	/** What Load must say (a cut question, a Compare's missing B), or none. */
	notes: string[];
}

/**
 * Load an entry into the Query tab: its question, mode and k in the form, or
 * its question in Ask's box; nothing runs. A mode that cannot run now leaves
 * the form's own, and Load says so.
 *
 * @param entry - The entry.
 * @param context - The modes offered now, the store's largest k, the handoff's nonce.
 * @returns The plan.
 */
export function loadPlan(entry: QueryHistoryItem, context: HistoryContext): LoadPlan {
	const { nonce } = context;
	const topK = kNow(entry.topK, context.topKMax);
	const notes = entry.truncated === true ? [ONLY_FIRST_KEPT] : [];
	if (entry.kind === 'ask') return { mode: 'ask', search: null, ask: { nonce, question: entry.question, run: false }, notes };
	if (entry.kind === 'compare') {
		const b = entry.compareWith;
		return { mode: 'compare', search: { nonce, question: entry.question, questionB: b ?? '', topK, run: false, chat: null }, ask: null, notes: b === undefined ? [...notes, COMPARE_B_NOT_SAVED] : notes };
	}
	const offered = context.options.find((o) => o.mode === entry.kind)?.enabled === true;
	return { mode: 'search', search: { nonce, question: entry.question, mode: entry.kind, topK, run: false, chat: null }, ask: null, notes: offered ? notes : [...notes, `${KIND_LABELS[entry.kind]} cannot run now; the form keeps its mode.`] };
}

/** What Rerun does, or why it cannot. */
export type RerunPlan = { ok: true; mode: QueryMode; search: SearchHandoff | null; ask: AskHandoff | null; title: string } | { ok: false; reason: string };

/** What Rerun needs to know about the tab now. */
export interface RerunContext extends HistoryContext {
	/** Whether Ask can ask now, and if not why. */
	chat: { enabled: boolean; reason: string | null };
}

/**
 * Rerun an entry: its mode and k, with the threshold, the scope and the table
 * choice as they are now (Compare keeps no mode, so it runs in the mode
 * chosen now); an Ask question is asked again about the documents Ask is set
 * to now.
 *
 * @param entry - The entry.
 * @param context - The tab now.
 * @returns The plan, or why it cannot run.
 */
export function rerunPlan(entry: QueryHistoryItem, context: RerunContext): RerunPlan {
	if (entry.truncated === true) return { ok: false, reason: `${ONLY_FIRST_KEPT} Load it to edit and run.` };
	if (entry.kind === 'ask') {
		if (!context.chat.enabled) return { ok: false, reason: context.chat.reason ?? 'The chat cannot ask here.' };
		return { ok: true, mode: 'ask', search: null, ask: { nonce: context.nonce, question: entry.question, run: true }, title: 'Ask this again, about the documents Ask is set to now' };
	}
	const topK = kNow(entry.topK, context.topKMax);
	const k = topK !== null ? `top ${topK}` : 'the k chosen now';
	if (entry.kind === 'compare') {
		if (entry.compareWith === undefined) return { ok: false, reason: COMPARE_B_NOT_SAVED };
		if (!context.options.some((option) => option.enabled)) return { ok: false, reason: 'Search is not available on this connection.' };
		return { ok: true, mode: 'compare', search: { nonce: context.nonce, question: entry.question, questionB: entry.compareWith, topK, run: true, chat: null }, ask: null, title: `Run A and B again with ${k}, and the mode, threshold, scope and table filter chosen now` };
	}
	const option = context.options.find((o) => o.mode === entry.kind);
	if (!option?.enabled) return { ok: false, reason: `${KIND_LABELS[entry.kind]} cannot run now: ${option?.reason ?? 'this connection does not offer it'}` };
	return { ok: true, mode: 'search', search: { nonce: context.nonce, question: entry.question, mode: entry.kind, topK, run: true, chat: null }, ask: null, title: `Run again with ${KIND_LABELS[entry.kind]} and ${k}, and the threshold, scope and table filter chosen now` };
}
