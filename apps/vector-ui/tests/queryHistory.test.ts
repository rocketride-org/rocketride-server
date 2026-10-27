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
import { APP_HISTORY_NOTE, DEVTOOL_HISTORY_NOTE } from '../src/env';
import { QUERY_HISTORY_LIMITS, QUERY_HISTORY_TAG_CHARS, QUERY_HISTORY_TEXT_MAX, persistedQueryHistory, questionOf, sessionQueryHistory, storedText } from '../src/adapters/queryHistory';
import { makeVectorHistory } from '../src/adapters/explorer';
import { COMPARE_B_NOT_SAVED, ONLY_FIRST_KEPT, RAN_AGAIN, askRecord, shownQuestion, compareRecord, entryMeta, entryTime, loadPlan, modeOfKind, msText, outcomeText, rerunPlan, searchRecord, shownEntries } from '../src/vector/queryHistory';
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

const CONTEXT: RerunContext = { options: modes(), topKMax: 100, chat: { enabled: true, reason: null }, nonce: 'n1' };

/** Load's context: every mode offered, k up to 100. */
const LOAD = { options: modes(), topKMax: 100, nonce: 'n' };

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

test('a run of the same kind that repeats the newest entry\'s whole question is that entry run again: no entry is added, History says "Ran again"; another kind, or a cut entry, never takes a run', () => {
	assert.equal(RAN_AGAIN, 'Ran again: this entry shows the latest run.');
	// record() says what each run became: the entry it is now, and whether that entry was there already (run again).
	const history = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	const added = history.record('k', searchRecord({ question: 'water', mode: 'semantic', topK: 10, results: 4 }, 1, 1));
	const [first] = history.entries('k').get();
	assert.deepEqual(added, { id: first.id, again: false });
	history.togglePin('k', first.id);
	assert.deepEqual(history.record('k', searchRecord({ question: 'water', mode: 'semantic', topK: 10, results: 2 }, 2, 1)), { id: first.id, again: true }, 'the same kind, question and k: run again');
	const after = history.entries('k').get();
	assert.equal(after.length, 1, 'no entry added');
	assert.deepEqual([after[0].id, after[0].pinned, after[0].kind, after[0].topK, after[0].results], [first.id, true, 'semantic', 10, 2], 'its id and pin kept, the run\'s facts taken');
	assert.equal(history.record('k', searchRecord({ question: 'water', mode: 'keyword', topK: 10, results: 1 }, 3, 1))?.again, false, 'another kind of run is its own entry');
	assert.equal(history.record('k', searchRecord({ question: 'falcon', mode: 'keyword', topK: 10, results: 1 }, 4, 1))?.again, false, 'another question adds an entry');
	assert.equal(history.record('k', searchRecord({ question: 'water', mode: 'semantic', topK: 10, results: 1 }, 5, 1))?.again, false, 'only the newest entry can be run again');
	assert.equal(history.entries('k').get().length, 4);
	const long = 'w'.repeat(300);
	history.record('k', searchRecord({ question: long, mode: 'semantic', topK: 10, results: 1 }, 6, 1));
	assert.equal(history.record('k', searchRecord({ question: long, mode: 'semantic', topK: 10, results: 1 }, 7, 1))?.again, false, 'a cut entry never takes a run');
	history.setRecording('k', false);
	assert.equal(history.record('k', searchRecord({ question: 'water', mode: 'semantic', topK: 10, results: 1 }, 8, 1)), null, 'recording off: nothing recorded');
});

test('"Ran again" only for the same run (live N1): the same kind (the Search mode), question and top-k; another mode or k is a new entry, also after a reload', () => {
	const history = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	// The live round's sequence: one question in Keyword, then Hybrid, then Auto, is three entries.
	for (const mode of ['keyword', 'hybrid', 'auto'] as const) assert.equal(history.record('k', searchRecord({ question: 'vacation days', mode, topK: 10, results: 3 }, 1, 1))?.again, false, mode);
	assert.deepEqual(history.entries('k').get().map((e) => e.kind), ['auto', 'hybrid', 'keyword']);
	// Another k: a new entry, and the one before it keeps its k.
	assert.equal(history.record('k', searchRecord({ question: 'vacation days', mode: 'auto', topK: 25, results: 9 }, 2, 1))?.again, false, 'another k');
	assert.deepEqual(history.entries('k').get().slice(0, 2).map((e) => [e.kind, e.topK]), [['auto', 25], ['auto', 10]]);
	// The same mode, question and k: run again.
	const again = history.record('k', searchRecord({ question: 'vacation days', mode: 'auto', topK: 25, results: 8 }, 3, 1));
	assert.deepEqual(again, { id: history.entries('k').get()[0].id, again: true });
	assert.equal(history.entries('k').get().length, 4, 'keyword, hybrid, auto at 10, auto at 25');
	// Back to the first k after it: a new entry again (the kind's other tag), never the 25 one overwritten.
	assert.equal(history.record('k', searchRecord({ question: 'vacation days', mode: 'auto', topK: 10, results: 3 }, 4, 1))?.again, false);
	assert.deepEqual(history.entries('k').get().slice(0, 2).map((e) => e.topK), [10, 25]);
	// Ask has no k: the same question asked again is run again.
	history.record('k', askRecord(turn({ question: 'why?', askedAt: 5, answeredAt: 6, answer: { sources: [] } as never })) as never);
	assert.equal(history.record('k', askRecord(turn({ question: 'why?', askedAt: 7, answeredAt: 8, answer: { sources: [{}] } as never })) as never)?.again, true);

	// After a reload the stored k (and tag) still tell: the same k is run again, another k is new.
	const store = makeVectorHistory(0);
	const detach = store.attachPrefs({ getPref: () => undefined, setPref: () => undefined }, 'owner-1');
	persistedQueryHistory(store, APP_HISTORY_NOTE).record('k', searchRecord({ question: 'water', mode: 'semantic', topK: 10, results: 4 }, 1, 1));
	const reloaded = persistedQueryHistory(store, APP_HISTORY_NOTE);
	assert.equal(reloaded.record('k', searchRecord({ question: 'water', mode: 'semantic', topK: 10, results: 5 }, 2, 1))?.again, true);
	assert.equal(reloaded.record('k', searchRecord({ question: 'water', mode: 'semantic', topK: 50, results: 5 }, 3, 1))?.again, false);
	assert.deepEqual(reloaded.entries('k').get().map((e) => [e.question, e.topK]), [['water', 50], ['water', 10]], 'shown without a tag');
	detach();
});

test('runs of different kinds never merge (DA-R1 I2): a pinned Semantic entry survives an Ask of the same words, a Search and a Compare with that A stay two, and a Search after a Compare keeps its B', () => {
	const history = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	history.record('k', searchRecord({ question: 'foo', mode: 'semantic', topK: 10, results: 4 }, 1, 1));
	const [pinned] = history.entries('k').get();
	history.togglePin('k', pinned.id);
	history.record('k', askRecord(turn({ question: 'foo', askedAt: 2, answeredAt: 3, answer: { sources: [{}] } as never })) as never);
	const [ask, kept] = history.entries('k').get();
	assert.deepEqual([ask.kind, ask.question, ask.results], ['ask', 'foo', 1]);
	assert.deepEqual([kept.id, kept.kind, kept.topK, kept.results, kept.pinned], [pinned.id, 'semantic', 10, 4, true], 'the pinned Semantic entry keeps its mode, k and pin');

	const other = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	other.record('k', searchRecord({ question: 'foo', mode: 'keyword', topK: 10, results: 2 }, 1, 1));
	other.record('k', compareRecord({ a: 'foo', b: 'bar', topK: 10, shared: 3 }, 2, 1));
	assert.deepEqual(other.entries('k').get().map((e) => [e.kind, e.question, e.compareWith]), [['compare', 'foo', 'bar'], ['keyword', 'foo', undefined]], 'a Search, then a Compare with that A: two entries');
	other.record('k', searchRecord({ question: 'foo', mode: 'semantic', topK: 10, results: 2 }, 3, 1));
	const [search, compare] = other.entries('k').get();
	assert.deepEqual([search.kind, compare.kind, compare.compareWith], ['semantic', 'compare', 'bar'], 'a Search after a Compare keeps its B');

	// Displayed and loaded questions carry no tag.
	for (const entry of [...history.entries('k').get(), ...other.entries('k').get()]) {
		assert.doesNotMatch(entry.question, /␟/, entry.kind);
		assert.doesNotMatch(shownQuestion(entry), /␟/, entry.kind);
		const plan = loadPlan(entry, LOAD);
		assert.doesNotMatch(plan.search?.question ?? plan.ask?.question ?? '', /␟/, entry.kind);
	}
});

test('a Compare is one with its pair (DA-R1 F1): the same A with another B is a new entry and both keep their B; the same pair run again is "Ran again"; after a reload (B unknown) it is a new entry', () => {
	const history = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	assert.equal(history.record('k', compareRecord({ a: 'water', b: 'wells', topK: 10, shared: 3 }, 1, 1))?.again, false);
	assert.equal(history.record('k', compareRecord({ a: 'water', b: 'rivers', topK: 10, shared: 2 }, 2, 1))?.again, false, 'another B: not run again');
	assert.deepEqual(history.entries('k').get().map((e) => [e.question, e.compareWith]), [['water', 'rivers'], ['water', 'wells']], 'two pairs, two entries, both B kept');
	assert.deepEqual(history.record('k', compareRecord({ a: 'water', b: 'rivers', topK: 10, shared: 4 }, 3, 1)), { id: history.entries('k').get()[0].id, again: true }, 'the same pair and k: run again');
	assert.deepEqual(history.entries('k').get().map((e) => [e.compareWith, e.topK, e.results]), [['rivers', 10, 4], ['wells', 10, 3]], 'the same pair run again: one entry, the new run');
	history.record('k', compareRecord({ a: 'water', b: 'wells', topK: 10, shared: 3 }, 4, 1));
	assert.deepEqual(history.entries('k').get().map((e) => e.compareWith), ['wells', 'rivers', 'wells'], 'a third pair after it is new again (only the newest entry can merge)');

	// After a reload this page holds no B: a Compare of the same A is a new entry, never merged into one whose B is unknown.
	const writes: Array<[string, unknown]> = [];
	const store = makeVectorHistory(0);
	const detach = store.attachPrefs({ getPref: () => undefined, setPref: (key, value) => writes.push([key, value]) }, 'owner-1');
	persistedQueryHistory(store, APP_HISTORY_NOTE).record('k', compareRecord({ a: 'water', b: 'wells', topK: 10, shared: 3 }, 1, 1));
	const reloaded = persistedQueryHistory(store, APP_HISTORY_NOTE);
	assert.equal(reloaded.entries('k').get()[0].compareWith, undefined, 'the reloaded page does not know B');
	assert.equal(reloaded.record('k', compareRecord({ a: 'water', b: 'wells', topK: 10, shared: 3 }, 2, 1))?.again, false, 'B unknown: a new entry');
	assert.deepEqual(reloaded.entries('k').get().map((e) => e.compareWith), ['wells', undefined]);
	store.flush();
	detach();
	const json = JSON.stringify(writes.filter(([key]) => key === 'vector.history').pop()?.[1]);
	assert.deepEqual([...json.matchAll(/"question":"([^"]*)"/g)].map((m) => m[1]).sort(), ['cm2␟water', 'cmp␟water'], 'the file holds a Compare tag and A, never B');
	assert.doesNotMatch(json, /wells/);
});

test('the workspace file holds each question with its kind\'s four-character tag and its first 200 characters, never question B (APP_HISTORY_NOTE stays true)', () => {
	assert.deepEqual(QUERY_HISTORY_LIMITS.maxTextChars, QUERY_HISTORY_TEXT_MAX + QUERY_HISTORY_TAG_CHARS);
	const writes: Array<[string, unknown]> = [];
	const store = makeVectorHistory(0);
	const detach = store.attachPrefs({ getPref: () => undefined, setPref: (key, value) => writes.push([key, value]) }, 'owner-1');
	const history = persistedQueryHistory(store, APP_HISTORY_NOTE);
	const long = `Rotate the token ${'x'.repeat(400)}`;
	history.record('k', searchRecord({ question: long, mode: 'hybrid', topK: 10, results: 3 }, 1, 1));
	history.record('k', compareRecord({ a: 'foo', b: 'the secret question B', topK: 10, shared: 2 }, 2, 1));
	store.flush();
	detach();
	const saved = writes.filter(([key]) => key === 'vector.history').pop()?.[1] as Record<string, Array<{ question: string; kind: string; truncated?: boolean }>>;
	assert.ok(saved, 'the history was written');
	const json = JSON.stringify(saved);
	assert.doesNotMatch(json, /the secret question B/, 'question B never reaches the workspace file');
	const [compare, hybrid] = saved.k;
	assert.deepEqual([compare.kind, compare.question], ['compare', 'cmp␟foo']);
	assert.deepEqual([hybrid.kind, hybrid.question, hybrid.truncated], ['hybrid', `hyb␟${long.slice(0, 200)}`, true], 'the tag and exactly the first 200 characters of the question');
	assert.equal(questionOf('hybrid', hybrid.question), long.slice(0, 200));
	assert.equal(questionOf('semantic', 'an entry written before the tags'), 'an entry written before the tags', 'read as it is');
	assert.equal(storedText('ask', 'why?'), 'ask␟why?');
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
	// Question B is held whole (Load and Rerun restore it) but shown cut like A.
	assert.equal(shownQuestion(item({ question: 'q'.repeat(200), truncated: true })), `${'q'.repeat(200)}…`);
	assert.equal(shownQuestion(item({ question: 'water' })), 'water');
	assert.equal(shownQuestion(item({ kind: 'compare', question: 'water', compareWith: 'b'.repeat(600) })), `A: water\nB: ${'b'.repeat(200)}…`);
	assert.equal(shownQuestion(item({ kind: 'compare', question: 'water', compareWith: 'falcon' })), 'A: water\nB: falcon');
	assert.equal(shownQuestion(item({ kind: 'compare', question: 'water' })), `A: water\nB: ${COMPARE_B_NOT_SAVED}`);
	assert.match(entryMeta(item({ kind: 'compare', compareWith: 'b'.repeat(600), at }), at), / · first 200 characters kept$/);
	assert.doesNotMatch(entryMeta(item({ kind: 'compare', compareWith: 'falcon', at }), at), /kept/);
	assert.equal(loadPlan(item({ kind: 'compare', compareWith: 'b'.repeat(600) }), LOAD).search?.questionB, 'b'.repeat(600), 'Load restores B whole');
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
	assert.deepEqual(loadPlan(item({ kind: 'hybrid', topK: 25 }), LOAD), { mode: 'search', search: { nonce: 'n', question: 'kestrel survey', mode: 'hybrid', topK: 25, run: false, chat: null }, ask: null, notes: [] });
	assert.deepEqual(loadPlan(item({ kind: 'ask', topK: null }), LOAD), { mode: 'ask', search: null, ask: { nonce: 'n', question: 'kestrel survey', run: false }, notes: [] });
	assert.deepEqual(loadPlan(item({ kind: 'compare', compareWith: 'falcon' }), LOAD).search, { nonce: 'n', question: 'kestrel survey', questionB: 'falcon', topK: 10, run: false, chat: null });
	const noB = loadPlan(item({ kind: 'compare' }), LOAD);
	assert.deepEqual([noB.mode, noB.search?.question, noB.search?.questionB, noB.notes], ['compare', 'kestrel survey', '', [COMPARE_B_NOT_SAVED]]);
	const cut = loadPlan(item({ question: 'w'.repeat(200), truncated: true }), LOAD);
	assert.equal(cut.search?.question, 'w'.repeat(200), 'what History kept, to edit');
	assert.deepEqual(cut.notes, [ONLY_FIRST_KEPT]);
	assert.equal(COMPARE_B_NOT_SAVED, "Question B isn't saved.");
	// A mode that cannot run now: the form keeps its own, and Load says so.
	assert.deepEqual(loadPlan(item({ kind: 'keyword' }), { ...LOAD, options: modes({ keyword: 'This store cannot search by keyword' }) }).notes, ['Keyword cannot run now; the form keeps its mode.']);
	// A k above what the store takes now goes in as the store's largest.
	assert.equal(loadPlan(item({ topK: 100 }), { ...LOAD, topKMax: 50 }).search?.topK, 50);
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
	const capped = rerunPlan(item({ topK: 100 }), { ...CONTEXT, topKMax: 50 });
	assert.ok(capped.ok);
	assert.deepEqual([capped.search?.topK, capped.title], [50, 'Run again with Semantic and top 50, and the threshold, scope and table filter chosen now'], 'the title names the k that is sent');
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
	assert.match(tab, /const landed = history\.record\(historyKey, run\);\s*setRanAgain\(landed !== null && landed\.again \? landed\.id : null\);/, 'the entry the history says it ran again shows "Ran again" (no prediction)');
	assert.match(tab, /<SearchPanel [^\n]*onRecord=\{record\} onShowDocument=\{onShowDocument\} \/>/);
	assert.match(tab, /<ChatPanel [^\n]*onRecord=\{record\} \/>/);
	assert.match(tab, /history=\{env\.queryHistory\}\s*historyKey=\{entry\.key\}/, 'the mount\'s own history, per connection');
	assert.match(tab, /documentRequests \+= 1;\s*entry\.openDocument\.set\(\{ nonce: `query-\$\{documentRequests\}`, objectId \}\);\s*actions\.openTab\?\.\('documents'\);/, "a result's name asks Documents for its drawer (I23)");
	assert.match(tab, /^let documentRequests = 0;$/m, 'numbered across the page\'s life: a remounted tab never reuses a nonce');
	assert.match(tab, /const plan = loadPlan\(entry, \{ options, topKMax: surfaceModel\.limits\.top_k_max, nonce: nonce\(\) \}\);/, 'Load knows the modes offered now and the store\'s largest k');
	assert.match(tab, /rerunPlan\(entry, \{ options, topKMax: surfaceModel\.limits\.top_k_max,/);
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
	assert.match(aside, /firstFocusable\(\[find\(selector\), find\('\[data-history-control="filter"\]'\), find\('\[data-query-focus="history-heading"\]'\)\]\)\?\.focus\(\);/, 'the asked-for control, else the Show filter, else the heading');
	assert.match(aside, /<select [^>]*data-history-control="filter"/);
	assert.match(aside, /const next = focusAfterRemove\(/);
	assert.match(aside, /const next = focusAfterPin\(\s*filter === 'pinned',\s*shown\.map\(\(e\) => e\.id\),\s*entry\.id,\s*entry\.pinned === true\s*\);\s*onPin\(entry\.id\);\s*setFocusNext\(next\);/, 'unpinning under "Pinned" never drops the focus');
	assert.match(aside, /setFocusNext\(\{ entry: entryId, control: 'note' \}\);/);
	assert.equal((aside.match(/escapeLayer\(event\.defaultPrevented\)/g) ?? []).length, 3, 'the note box, the confirmation and the aside');
	assert.equal((aside.match(/event\.preventDefault\(\);/g) ?? []).length, 4, 'each Escape that acts, and Enter in the note box');
	for (const file of [path.join('components', 'HistoryAside.tsx'), path.join('vector', 'queryHistory.ts')]) {
		const text = code(file);
		assert.doesNotMatch(text, /stopPropagation|(window|document)\s*\.\s*addEventListener|localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML|console\.(log|warn|error)/, file);
	}
	for (const line of code(path.join('vector', 'queryHistory.ts')).split('\n').filter((l) => /^import /.test(l))) assert.match(line, /^import type /, `queryHistory.ts is pure: ${line}`);
});
