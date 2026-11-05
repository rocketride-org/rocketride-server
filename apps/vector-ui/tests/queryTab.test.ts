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
// THE QUERY TAB: its tab row's keys, where the focus goes, which Escape acts,
// and how a question handed in is taken (vector/queryFocus.ts and the wiring
// of components/QueryTab.tsx and components/ChatPanel.tsx)
// =============================================================================
//
// The suites render on the server only, so the decisions are pure functions
// tested here, and the components' call sites are pinned to them. The live
// checklist (PLAN-MAP M16, M18, M33, M34) proves the behaviour in a browser.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QUERY_MODES, QUERY_MODE_LABELS, escapeLayer, focusAfterClear, focusAfterPin, focusAfterRemove, needsFocusRescue, nextQueryTab, primaryTarget } from '../src/vector/queryFocus';

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

test('the tab row: Search, Compare, Ask; Left and Right move (and wrap), Home and End jump, other keys are left alone', () => {
	assert.deepEqual(QUERY_MODES.map((mode) => QUERY_MODE_LABELS[mode]), ['Search', 'Compare', 'Ask']);
	assert.equal(nextQueryTab('search', 'ArrowRight'), 'compare');
	assert.equal(nextQueryTab('ask', 'ArrowRight'), 'search');
	assert.equal(nextQueryTab('search', 'ArrowLeft'), 'ask');
	assert.equal(nextQueryTab('compare', 'Home'), 'search');
	assert.equal(nextQueryTab('search', 'End'), 'ask');
	for (const key of ['Enter', ' ', 'Tab', 'ArrowDown', 'Escape']) assert.equal(nextQueryTab('compare', key), null, key);
});

test('focus: it is moved when it fell to <body> or sits on a control a hidden mode took off the screen, never when it is on screen', () => {
	assert.equal(needsFocusRescue('body'), true);
	assert.equal(needsFocusRescue('hidden'), true);
	assert.equal(needsFocusRescue('shown'), false, 'a tab button the user pressed keeps it');
	assert.equal(primaryTarget('search', { chatAvailable: true, searchable: true }), 'question');
	assert.equal(primaryTarget('compare', { chatAvailable: false, searchable: false }), 'question');
	assert.equal(primaryTarget('ask', { chatAvailable: true, searchable: true }), 'composer');
	assert.equal(primaryTarget('ask', { chatAvailable: false, searchable: true }), 'use-search', 'a dev-tool mount: Ask offers Search');
	assert.equal(primaryTarget('ask', { chatAvailable: false, searchable: false }), 'tab', 'nothing in Ask takes the focus: its tab does');
});

test('focus in History: a removed entry hands it to the next one, else the previous, else the heading; Clear… to the heading, Cancel back to its opener', () => {
	assert.deepEqual(focusAfterRemove(['a', 'b', 'c'], 'b'), { entry: 'c' });
	assert.deepEqual(focusAfterRemove(['a', 'b', 'c'], 'c'), { entry: 'b' });
	assert.equal(focusAfterRemove(['a'], 'a'), 'history-heading');
	assert.equal(focusAfterRemove([], 'x'), 'history-heading');
	// Pin keeps the focus on its button (the entry moves to the top and back); unpinned under "Pinned" the entry leaves
	// the list, and the focus goes where a removed entry's would.
	assert.deepEqual(focusAfterPin(false, ['a', 'b'], 'b', true), { entry: 'b', control: 'pin' });
	assert.deepEqual(focusAfterPin(true, ['a', 'b'], 'b', false), { entry: 'b', control: 'pin' }, 'pinning under "Pinned" cannot happen, and keeps it');
	assert.deepEqual(focusAfterPin(true, ['a', 'b', 'c'], 'b', true), { entry: 'c', control: 'load' });
	assert.deepEqual(focusAfterPin(true, ['a', 'b'], 'b', true), { entry: 'a', control: 'load' });
	assert.equal(focusAfterPin(true, ['a'], 'a', true), 'history-heading');
	assert.equal(focusAfterClear(true), 'history-heading');
	assert.equal(focusAfterClear(false), 'history-clear');
});

test('Escape: the innermost layer that acts handles it; an outer one skips a key already handled (no stopPropagation)', () => {
	assert.equal(escapeLayer(false), 'act');
	assert.equal(escapeLayer(true), 'pass');
});

test('wiring: a question handed in through the connection is taken once and cleared, so a tab mounted later still gets it and a remount does not take it again', () => {
	const tab = code(path.join('components', 'QueryTab.tsx'));
	assert.match(tab, /const taken = takePrefill\(prefill, mode\);\s*onMode\(taken\.mode\);[\s\S]*?onPrefillTaken\(\);/);
	assert.match(tab, /onPrefillTaken=\{\(\) => entry\.queryPrefill\.set\(null\)\}/);
	assert.match(tab, /const mode = useValueStore\(entry\.queryMode\);/);
	assert.match(tab, /onMode=\{\(next\) => entry\.queryMode\.set\(next\)\}/);
	// "Open in Search" runs the search "Why these?" made, on Search.
	assert.match(tab, /setSearch\(\{ nonce: nonce\(\), question: brought\.question, run: true, chat: brought \}\);\s*onMode\('search'\);/);
	// A handoff is applied by the panel's effect, once per nonce, and only on the connection it was made for: a panel
	// remounted for another connection (key={connectionKey}) replays nothing.
	const search = code(path.join('components', 'SearchPanel.tsx'));
	assert.doesNotMatch(search, /useState\(\(\) => \(handoff/, 'no form is taken from a handoff at mount');
	assert.match(search, /if \(handoff\.connectionKey !== undefined && handoff\.connectionKey !== model\.connectionKey\) return;/);
	assert.match(tab, /const setSearch = \(handoff: SearchHandoff\): void => setSearchHandoff\(\{ \.\.\.handoff, connectionKey: surfaceModel\.connectionKey \}\);/);
	// A question longer than the box is cut when it is applied, and the panel says so under the box until it is edited.
	assert.match(search, /setCut\(next\.cut\);/);
	assert.match(search, /\{cut && <p style=\{S\.note\}>\{QUESTION_CUT_SENTENCE\}<\/p>\}/);
	assert.equal((search.match(/setCut\(false\);/g) ?? []).length, 3, 'editing A or B, or "New query", takes the line away');
	// A Compare handoff runs A and B from its own B, whatever mode has rendered.
	assert.match(search, /questionB: next\.questionB !== null && next\.questionB\.trim\(\) !== '' \? next\.questionB : null,/);
	// A run asked for that cannot start says why.
	assert.match(search, /if \(blocked !== null\) actions\.announce\(`Not run: \$\{blocked\}`\);/);
	assert.match(code(path.join('components', 'ChatPanel.tsx')), /if \(handoff\.run && available\) actions\.announce\('Not asked: wait for the answer to the current question\. The question is in the box\.'\);/);
});

test('wiring: the focus never falls to <body> in the Query tab — a mode change that hides it, the tab row, and the chat\'s controls that go away', () => {
	const tab = code(path.join('components', 'QueryTab.tsx'));
	assert.match(tab, /if \(needsFocusRescue\(activeFocus\(\)\)\) focusIn\(root\.current, primaryTarget\(mode, asking\)\);/);
	assert.match(tab, /\}, \[mode, visible\]\);/, 'on a change of mode or of visibility');
	assert.match(tab, /return active\.getClientRects\(\)\.length === 0 \? 'hidden' : 'shown';/);
	assert.match(tab, /const next = nextQueryTab\(mode, event\.key\);[\s\S]*?event\.preventDefault\(\);\s*onMode\(next\);\s*tabRefs\.current\[next\]\?\.focus\(\);/);
	assert.match(tab, /tabIndex=\{mode === id \? 0 : -1\}/);
	for (const target of ['question', 'composer', 'use-search']) {
		const owner = target === 'question' ? 'SearchPanel.tsx' : 'ChatPanel.tsx';
		assert.match(code(path.join('components', owner)), new RegExp(`data-query-focus="${target}"`), `${owner} marks ${target}`);
	}
	const chat = code(path.join('components', 'ChatPanel.tsx'));
	assert.match(chat, /chat\.send\(draft\);\s*setDraft\(''\);\s*setRecall\(-1\);\s*composer\.current\?\.focus\(\);/, 'asking turns the button off: the box keeps the focus');
	assert.match(chat, /chat\.stopWaiting\(\);\s*composer\.current\?\.focus\(\);/, '"Stop waiting" goes away');
	assert.match(chat, /onClearScope\(\);\s*composer\.current\?\.focus\(\);/, '"Ask about all documents" goes away');
	assert.match(chat, /onDebug\(false\);[\s\S]*?why\.current\?\.focus\(\);/, 'closing "Why these?" returns to its button');
	const search = code(path.join('components', 'SearchPanel.tsx'));
	assert.match(search, /aria-disabled=\{off\}/, 'Run turns off without leaving the tab order');
	assert.doesNotMatch(search, /type="submit"[^>]*\sdisabled=/);
	assert.match(search, /if \(event\.key !== 'Escape' \|\| questionEscape\(value, event\.defaultPrevented\) !== 'clear'\) return;\s*event\.preventDefault\(\);/);
});

test('wiring: the Query tab\'s files insert no HTML, stop no propagation, listen for no keys on the page, keep nothing in browser storage and hold no token', () => {
	for (const file of [path.join('components', 'QueryTab.tsx'), path.join('vector', 'queryFocus.ts')]) {
		const text = code(file);
		assert.doesNotMatch(text, /dangerouslySetInnerHTML|\.innerHTML|insertAdjacentHTML|\beval\s*\(/, file);
		assert.doesNotMatch(text, /stopPropagation|stopImmediatePropagation|(window|document)\s*\.\s*addEventListener/, file);
		assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.(log|info|debug|warn|error)/, file);
		assert.doesNotMatch(text, /\.token\b|\btoken\s*:|getToken/, file);
	}
	const focus = code(path.join('vector', 'queryFocus.ts'));
	for (const line of focus.split('\n').filter((l) => /^import /.test(l))) assert.match(line, /^import type /, `queryFocus.ts is pure: ${line}`);
});

test('layout: narrow (a split, a VS Code group), History wraps under the modes and the tab\'s body scrolls to it; side by side it stretches to the row', () => {
	const tab = code(path.join('components', 'QueryTab.tsx'));
	assert.match(tab, /body: \{ flex: 1, minHeight: 0, display: 'flex', flexWrap: 'wrap', gap: 12, overflowY: 'auto' \}/);
	const aside = code(path.join('components', 'HistoryAside.tsx'));
	assert.match(aside, /root: \{ flex: '1 1 300px', minWidth: 0, minHeight: 0, maxHeight: '100%', overflowY: 'auto',/);
	assert.doesNotMatch(aside, /root: \{[^}]*\bheight: '100%'/, 'a fixed height would start a wrapped aside below the body\'s edge');
});
