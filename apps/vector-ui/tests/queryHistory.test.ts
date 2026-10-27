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
// THE QUERY TAB'S HISTORY: what a run records (a question kept to 200
// characters, in both mounts), how an entry reads, what Load and Rerun do,
// and that a dev-tool mount's history records at once
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatTurn } from '../src/chat/chatSession';
import { DEVTOOL_HISTORY_NOTE } from '../src/env';
import { QUERY_HISTORY_TEXT_MAX, sessionQueryHistory } from '../src/adapters/queryHistory';
import { COMPARE_B_NOT_SAVED, ONLY_FIRST_KEPT, askRecord, compareRecord, entryMeta, entryTime, loadPlan, modeOfKind, msText, outcomeText, rerunPlan, searchRecord, shownEntries } from '../src/vector/queryHistory';
import type { QueryHistoryItem, RerunContext } from '../src/vector/queryHistory';
import type { ModeOption } from '../src/vector/searchWorkbench';

const SRC = path.join(__dirname, '..', 'src');

/**
 * A source file without its comments.
 *
 * @param relative - The path under src/.
 * @returns The code.
 */
function code(relative: string): string {
	return readFileSync(path.join(SRC, relative), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** An entry as History shows it. */
function item(fields: Partial<QueryHistoryItem>): QueryHistoryItem {
	return { id: 'e1', question: 'kestrel survey', kind: 'semantic', at: 0, ms: 420, topK: 10, results: 12, outcome: 'rows', ...fields };
}

/** Every Search mode offered, or the ones named off with a reason. */
function modes(off: Partial<Record<ModeOption['mode'], string>> = {}): ModeOption[] {
	return (['semantic', 'keyword', 'hybrid', 'auto'] as const).map((mode) => ({ mode, label: mode[0].toUpperCase() + mode.slice(1), enabled: off[mode] === undefined, reason: off[mode] ?? null }));
}

const CONTEXT: RerunContext = { options: modes(), chat: { enabled: true, reason: null }, nonce: 'n1' };

/** A chat turn. */
function turn(fields: Partial<ChatTurn>): ChatTurn {
	return { id: 1, question: 'Where is the water?', scope: null, status: 'answered', answer: null, error: null, askedAt: 1000, answeredAt: 1900, ...fields };
}

test('a run is handed over whole and History keeps its first 200 characters, marked cut, in both mounts: a chunk used as the query never lands whole in the workspace file, and two long questions sharing their start stay two entries', () => {
	assert.equal(QUERY_HISTORY_TEXT_MAX, 200);
	assert.match(ONLY_FIRST_KEPT, /first 200 characters/);
	const chunk = 'The cistern under Falcon Station holds rainwater. '.repeat(100);
	assert.equal(searchRecord({ question: chunk, mode: 'semantic', topK: 10, results: 3 }, 0, 1).question, chunk, 'the record carries the whole question; the history cuts it');
	const history = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	history.record('k', searchRecord({ question: chunk, mode: 'semantic', topK: 10, results: 3 }, 1, 1));
	history.record('k', searchRecord({ question: `${chunk} and the well`, mode: 'semantic', topK: 10, results: 2 }, 2, 1));
	const [second, first] = history.entries('k').get();
	assert.equal(first.question, chunk.slice(0, 200));
	assert.equal(first.truncated, true);
	assert.ok(second !== undefined && second.id !== first.id, 'two long questions that share their first 200 characters stay two entries');
	history.record('k', compareRecord({ a: 'water', b: 'falcon', topK: 10, shared: 4 }, 3, 1));
	assert.equal(history.entries('k').get()[0].compareWith, 'falcon', "a Compare's B is held for the session");
	history.record('k', askRecord(turn({ question: chunk })) as never);
	assert.deepEqual([history.entries('k').get()[0].question.length, history.entries('k').get()[0].truncated], [200, true], 'an Ask question too');
});

test('records: a Search run per mode, a Compare once with B beside A and the results both found, an Ask question once its answer ended', () => {
	assert.deepEqual(searchRecord({ question: 'water', mode: 'auto', topK: 25, results: 7 }, 100, 420), { question: 'water', kind: 'auto', at: 100, ms: 420, topK: 25, results: 7, outcome: 'rows' });
	assert.deepEqual(searchRecord({ question: 'water', mode: 'hybrid', topK: 10, results: null, error: 'The store refused the search: x' }, 100, 5), { question: 'water', kind: 'hybrid', at: 100, ms: 5, topK: 10, results: null, outcome: 'error', error: 'The store refused the search: x' });
	assert.deepEqual(compareRecord({ a: 'water', b: 'falcon', topK: 10, shared: 6 }, 100, 900), { question: 'water', compareWith: 'falcon', kind: 'compare', at: 100, ms: 900, topK: 10, results: 6, outcome: 'rows' });
	assert.equal(compareRecord({ a: 'water', b: 'falcon', topK: 10, shared: null, error: 'B: The store did not answer in time. Try again.' }, 100, 900).error, 'B: The store did not answer in time. Try again.');
	assert.equal(askRecord(turn({ status: 'asking', answeredAt: null })), null, 'not until it ends');
	const answered = askRecord(turn({ answer: { sources: [{}, {}, {}] } as never }));
	assert.deepEqual(answered, { question: 'Where is the water?', kind: 'ask', at: 1000, ms: 900, topK: null, results: 3, outcome: 'rows' });
	for (const status of ['failed', 'timeout', 'stopped'] as const) {
		const ended = askRecord(turn({ status, error: { kind: 'failed', message: `the ${status} sentence` } as never }));
		assert.deepEqual([ended?.outcome, ended?.error, ended?.results], ['error', `the ${status} sentence`, null], status);
	}
});

test('how an entry reads: its kind, k, what it came to, when and how long, and what History did not keep', () => {
	assert.equal(outcomeText(item({})), '12 results');
	assert.equal(outcomeText(item({ results: 1 })), '1 result');
	assert.equal(outcomeText(item({ kind: 'compare', results: 6 })), 'A and B shared 6');
	assert.equal(outcomeText(item({ kind: 'ask', results: 1 })), '1 source');
	assert.equal(outcomeText(item({ outcome: 'error', error: 'no vector' })), 'failed: no vector');
	assert.equal(msText(420), '420 ms');
	assert.equal(msText(1300), '1.3 s');
	const at = new Date(2026, 9, 27, 14, 37).getTime();
	assert.equal(entryTime(at, at + 3_600_000), '02:37 PM');
	assert.equal(entryTime(at, at + 3 * 86_400_000), 'Oct 27, 02:37 PM', 'another day names it');
	assert.equal(entryMeta(item({ at }), at), 'Semantic · top 10 · 12 results · 02:37 PM · 420 ms');
	assert.equal(entryMeta(item({ kind: 'ask', topK: null, results: 4, at }), at), 'Ask · 4 sources · 02:37 PM · 420 ms');
	assert.match(entryMeta(item({ question: 'q'.repeat(200), truncated: true, at }), at), / · first 200 characters kept$/);
});

test('the list: pinned first, then newest first; a filter by mode (Search holds every Search mode) or pinned', () => {
	const entries = [item({ id: 'a', kind: 'ask' }), item({ id: 'b', kind: 'keyword', pinned: true }), item({ id: 'c', kind: 'compare' }), item({ id: 'd', kind: 'hybrid' }), item({ id: 'e', kind: 'semantic', pinned: true })];
	assert.deepEqual(shownEntries(entries, 'all').map((e) => e.id), ['b', 'e', 'a', 'c', 'd']);
	assert.deepEqual(shownEntries(entries, 'search').map((e) => e.id), ['b', 'e', 'd']);
	assert.deepEqual(shownEntries(entries, 'compare').map((e) => e.id), ['c']);
	assert.deepEqual(shownEntries(entries, 'ask').map((e) => e.id), ['a']);
	assert.deepEqual(shownEntries(entries, 'pinned').map((e) => e.id), ['b', 'e']);
	assert.deepEqual((['semantic', 'keyword', 'hybrid', 'auto', 'compare', 'ask'] as const).map(modeOfKind), ['search', 'search', 'search', 'search', 'compare', 'ask']);
});

test('Load: the form gets the question, mode and k back (Ask its box), nothing runs; a cut question says so; a Compare without B says B is not saved', () => {
	assert.deepEqual(loadPlan(item({ kind: 'hybrid', topK: 25 }), 'n'), { mode: 'search', search: { nonce: 'n', question: 'kestrel survey', mode: 'hybrid', topK: 25, run: false, chat: null }, ask: null, notes: [] });
	assert.deepEqual(loadPlan(item({ kind: 'ask', topK: null }), 'n'), { mode: 'ask', search: null, ask: { nonce: 'n', question: 'kestrel survey', run: false }, notes: [] });
	assert.deepEqual(loadPlan(item({ kind: 'compare', compareWith: 'falcon' }), 'n').search, { nonce: 'n', question: 'kestrel survey', questionB: 'falcon', topK: 10, run: false, chat: null });
	const noB = loadPlan(item({ kind: 'compare' }), 'n');
	assert.deepEqual([noB.mode, noB.search?.question, noB.search?.questionB, noB.notes], ['compare', 'kestrel survey', '', [COMPARE_B_NOT_SAVED]]);
	const cut = loadPlan(item({ question: 'w'.repeat(200), truncated: true }), 'n');
	assert.equal(cut.search?.question, 'w'.repeat(200), 'what History kept, to edit');
	assert.deepEqual(cut.notes, [ONLY_FIRST_KEPT]);
	assert.equal(COMPARE_B_NOT_SAVED, "Question B isn't saved.");
});

test('Rerun: the entry\'s mode and k with the threshold, scope and table filter chosen now, and its title says so; off with the reason when it cannot run', () => {
	const plan = rerunPlan(item({ kind: 'hybrid', topK: 25 }), CONTEXT);
	assert.ok(plan.ok);
	assert.deepEqual(plan.search, { nonce: 'n1', question: 'kestrel survey', mode: 'hybrid', topK: 25, run: true, chat: null });
	assert.equal(plan.title, 'Run again with Hybrid and top 25, and the threshold, scope and table filter chosen now');
	const compare = rerunPlan(item({ kind: 'compare', compareWith: 'falcon' }), CONTEXT);
	assert.ok(compare.ok);
	assert.deepEqual([compare.mode, compare.search?.questionB, compare.search?.mode, compare.search?.run], ['compare', 'falcon', undefined, true], 'Compare keeps no mode: it runs in the mode chosen now');
	assert.equal(compare.title, 'Run A and B again with top 10, and the mode, threshold, scope and table filter chosen now');
	assert.deepEqual(rerunPlan(item({ kind: 'compare' }), CONTEXT), { ok: false, reason: COMPARE_B_NOT_SAVED });
	assert.deepEqual(rerunPlan(item({ kind: 'keyword' }), { ...CONTEXT, options: modes({ keyword: 'This store cannot search by keyword' }) }), { ok: false, reason: 'Keyword cannot run now: This store cannot search by keyword' });
	assert.deepEqual(rerunPlan(item({ question: 'w'.repeat(200), truncated: true }), CONTEXT), { ok: false, reason: `${ONLY_FIRST_KEPT} Load it to edit and run.` });
	const ask = rerunPlan(item({ kind: 'ask', topK: null }), CONTEXT);
	assert.ok(ask.ok);
	assert.deepEqual(ask.ask, { nonce: 'n1', question: 'kestrel survey', run: true });
	assert.deepEqual(rerunPlan(item({ kind: 'ask', topK: null }), { ...CONTEXT, chat: { enabled: false, reason: 'Chat is not available in the dev-tool mount.' } }), { ok: false, reason: 'Chat is not available in the dev-tool mount.' });
});

test('a dev-tool mount\'s history records each run at once, with what the Query tab records, and nothing while recording is off', () => {
	const history = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	assert.equal(history.persisted, false);
	assert.equal(history.note, DEVTOOL_HISTORY_NOTE);
	history.record('k', searchRecord({ question: 'water', mode: 'semantic', topK: 10, results: 4 }, 100, 420));
	const [entry] = history.entries('k').get();
	assert.deepEqual({ ...entry, id: 'x' }, { id: 'x', question: 'water', kind: 'semantic', at: 100, ms: 420, topK: 10, results: 4, outcome: 'rows' });
	history.setRecording('k', false);
	history.record('k', searchRecord({ question: 'falcon', mode: 'keyword', topK: 10, results: 1 }, 200, 1));
	assert.equal(history.entries('k').get().length, 1, 'recording off: nothing added, the entry kept');
});

test('wiring: every finished run goes to the mount\'s history, from Search, Compare and Ask; Load and Rerun hand the form an entry', () => {
	const tab = code(path.join('components', 'QueryTab.tsx'));
	assert.match(tab, /const record = \(run: QueryRunRecord\): void => history\.record\(historyKey, run\);/);
	assert.match(tab, /<SearchPanel [^\n]*onRecord=\{record\} onShowDocument=\{onShowDocument\} \/>/);
	assert.match(tab, /<ChatPanel [^\n]*onRecord=\{record\} \/>/);
	assert.match(tab, /history=\{env\.queryHistory\}\s*historyKey=\{entry\.key\}/, 'the mount\'s own history, per connection');
	assert.match(tab, /entry\.openDocument\.set\(\{ nonce: `query-\$\{requests\.current\}`, objectId \}\);\s*actions\.openTab\?\.\('documents'\);/, "a result's name asks Documents for its drawer (I23)");
	assert.match(tab, /const plan = loadPlan\(entry, nonce\(\)\);/);
	assert.match(tab, /const plan = rerunOf\(entry, nonce\(\)\);\s*if \(!plan\.ok\) return;/);
	assert.match(tab, /setHistoryOpen\(false\);\s*setFocusNext\('history-toggle'\);/, 'closing the aside returns the focus to its button');
	const search = code(path.join('components', 'SearchPanel.tsx'));
	assert.match(search, /if \(runId\.current !== id\) return;\s*if \(!a\.ok\) \{\s*record\(/, 'a run a newer one replaced is not recorded');
	assert.match(search, /onRecord\?\.\(searchRecord\(/);
	assert.match(search, /onRecord\?\.\(compareRecord\(/);
	const chat = code(path.join('components', 'ChatPanel.tsx'));
	assert.match(chat, /onSettled: \(turn\) => \{\s*const record = askRecord\(turn\);\s*if \(record !== null\) onRecord\?\.\(record\);/);
	assert.match(code(path.join('chat', 'registry.ts')), /onSettled: \(turn\) => live\.current\.onSettled\?\.\(turn\),/, 'the session hears the panel of the moment');
});

test('wiring: the History aside asks inline, keeps the focus, and handles Escape innermost first', () => {
	const aside = code(path.join('components', 'HistoryAside.tsx'));
	assert.doesNotMatch(aside, /<(Modal|ConfirmDialog|DetailPanel)\b/);
	assert.match(aside, /if \(confirming\) root\.current\?\.querySelector<HTMLElement>\('\[data-history-confirm\] \[data-history-control="cancel"\]'\)\?\.focus\(\);/, 'Clear… opens on Cancel: it cannot be undone');
	assert.match(aside, /setFocusNext\(focusAfterClear\(confirmed\)\);/);
	assert.match(aside, /const next = focusAfterRemove\(/);
	assert.match(aside, /setFocusNext\(\{ entry: entryId, control: 'note' \}\);/);
	assert.equal((aside.match(/escapeLayer\(event\.defaultPrevented\)/g) ?? []).length, 3, 'the note box, the confirmation and the aside');
	assert.equal((aside.match(/event\.preventDefault\(\);/g) ?? []).length, 4, 'each Escape that acts, and Enter in the note box');
	for (const file of [path.join('components', 'HistoryAside.tsx'), path.join('vector', 'queryHistory.ts')]) {
		const text = code(file);
		assert.doesNotMatch(text, /stopPropagation|(window|document)\s*\.\s*addEventListener|localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML|console\.(log|warn|error)/, file);
	}
	for (const line of code(path.join('vector', 'queryHistory.ts')).split('\n').filter((l) => /^import /.test(l))) assert.match(line, /^import type /, `queryHistory.ts is pure: ${line}`);
});
