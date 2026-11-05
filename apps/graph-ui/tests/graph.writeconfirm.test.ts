// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WRITE CONSOLE CONFIRMATION
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { focusCancelIn } from 'shared/explorer/components/PatternConfirmDialog';
import { TEXT_CHECK_SENTENCE, WRITE_CANCEL_LABEL, WRITE_CONSOLE_BANNER, confirmationParagraphs, describeWrites, rerunAnnouncement } from '../src/graph/writeConfirm';
import { targetsToRun } from '../src/cypher/targets';

const all = (text: string) => targetsToRun(text, { start: 0, end: 0 }, 0, true);

test('the confirmation lists exactly the statements the text check marks, with position, lines and finding', () => {
	const c = describeWrites(all('MATCH (n) RETURN n;\nCREATE (a:P {name: "x"});\nMATCH (a) SET a.x = 1;\nCALL apoc.cypher.runWrite("x", {});'));
	assert.equal(c.total, 4);
	assert.equal(c.reads, 1);
	assert.equal(c.needed, true);
	assert.deepEqual(c.mutating.map((m) => [m.position, m.finding, m.lines]), [[2, 'CREATE', 'line 2'], [3, 'SET', 'line 3'], [4, 'CALL apoc.cypher.runWrite', 'line 4']]);
	assert.match(c.mutating[0].excerpt, /^CREATE \(a:P/);
});

test('a batch of reads needs no confirmation', () => {
	const c = describeWrites(all('MATCH (n) RETURN n; RETURN 1'));
	assert.equal(c.needed, false);
	assert.equal(c.mutating.length, 0);
	assert.equal(c.reads, 2);
	assert.equal(describeWrites([]).needed, false);
});

// A mid-statement GQL INSERT (Neo4j 5's synonym of CREATE) is a write, as the node's own read path counts it, so the
// write console confirms it before it is sent.
test('a mid-statement INSERT is confirmed before it is sent', () => {
	const c = describeWrites(all("MATCH (a:Person {name: 'Ada'}) INSERT (a)-[:KNOWS]->(:Person {name: 'Eve'})"));
	assert.equal(c.needed, true);
	assert.deepEqual(c.mutating.map((m) => m.finding), ['INSERT']);
});

test('unrecognised or malformed statements are listed as risky, never waved through', () => {
	const c = describeWrites(all("EXPLAIN MATCH (n) RETURN n; MATCH (n) RETURN 'open"));
	assert.equal(c.mutating.length, 2);
	assert.match(c.mutating[0].finding, /unrecognized statement \(EXPLAIN\)/);
	assert.match(c.mutating[1].finding, /unterminated string/);
});

test('every confirmation says it is a text check and that nothing is rolled back', () => {
	const c = describeWrites(all('CREATE (a);'));
	const text = confirmationParagraphs(c).join(' ');
	assert.ok(text.includes(TEXT_CHECK_SENTENCE));
	assert.equal(TEXT_CHECK_SENTENCE, 'This is a text check, not a database safeguard.');
	assert.match(text, /1 of 1 statement looks like it changes data or runs a command\./);
	assert.match(text, /A statement that has run is not undone if a later one fails\./);
	const many = confirmationParagraphs(describeWrites(all('CREATE (a); MATCH (n) RETURN n; DELETE x; SET y')));
	assert.match(many[0], /^3 of 4 statements look like they change data or run a command \(1 is a read\)\.$/);
});

test('long statements are excerpted to three lines in the list', () => {
	const c = describeWrites(all('CREATE (a)\nSET a.x = 1\nSET a.y = 2\nSET a.z = 3\nSET a.w = 4'));
	assert.equal(c.mutating[0].excerpt.split('\n').length, 3);
});

// A batch the text check does not flag is sent through execute with no dialog, so the banner never says "You are
// asked to confirm before anything is sent".
test('the write console banner says which statements are confirmed, not that every one is', () => {
	assert.doesNotMatch(WRITE_CONSOLE_BANNER, /You are asked to confirm before anything is sent/);
	assert.match(WRITE_CONSOLE_BANNER, /Statements that look like they change data are listed for you to confirm before anything is sent; anything else is sent when you press Execute\./);
	assert.ok(WRITE_CONSOLE_BANNER.endsWith(TEXT_CHECK_SENTENCE));
});

// The shell's ConfirmDialog focuses its confirm button when it opens, so an Enter right after Ctrl/Cmd+Enter (or a
// double Enter) would execute the write. WriteConfirmDialog moves focus to the dialog's Cancel button, which the focus
// step finds by its label. There is no DOM here: the dialog is a stand-in with the shell's footer order.
test('the write confirmation\'s focus step lands on Cancel, never on Execute', () => {
	assert.equal(WRITE_CANCEL_LABEL, 'Cancel');
	for (const confirmLabel of ['Execute statement', 'Execute statements']) {
		const focused: string[] = [];
		const footer = [WRITE_CANCEL_LABEL, confirmLabel].map((label) => ({ textContent: label, focus: () => { focused.push(label); } }));
		const dialog = { querySelectorAll: (selector: string) => (selector === 'button' ? footer : []) };
		const anchor = { closest: (selector: string) => (selector === '[role="dialog"]' ? dialog : null) } as unknown as Element;
		assert.equal(focusCancelIn(anchor, WRITE_CANCEL_LABEL), true);
		assert.deepEqual(focused, ['Cancel'], confirmLabel);
	}
});

// History's "Run again" in the write console says whether Execute will ask first: a statement the text check does not
// flag is sent by Execute with no dialog, and a screen-reader user relying on a blanket "you will be asked to confirm"
// would run it on the live database at once. The view uses this announcement.
test('the write console\'s Run again announcement says whether Execute will ask first', () => {
	const write = rerunAnnouncement("MATCH (a:Person {name: 'Ada'}) SET a.x = 1");
	assert.equal(write, 'The statement is in the editor. Press Execute to run it; you will be asked to confirm first.');
	for (const text of ['MATCH (n) RETURN n LIMIT 25', 'RETURN 1; MATCH (n) RETURN n']) {
		const read = rerunAnnouncement(text);
		assert.doesNotMatch(read, /you will be asked to confirm/, text);
		assert.equal(read, 'The statement is in the editor. The text check does not take it for a change to data, so Execute sends it without asking first.');
	}
	assert.match(rerunAnnouncement('MATCH (n) RETURN n; CREATE (m)'), /you will be asked to confirm first/, 'a batch with one flagged statement is confirmed');
	const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'WriteConsoleView.tsx'), 'utf8');
	assert.doesNotMatch(view, /you will be asked to confirm/, 'the view does not hard-code the promise');
	assert.match(view, /announcer\.announce\(rerunAnnouncement\(cypher\)\)/);
});

test('the confirmation module\'s header no longer says nothing is ever sent without confirming', () => {
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'graph', 'writeConfirm.ts'), 'utf8');
	assert.doesNotMatch(source, /Nothing is sent until\s*\n?\s*\/\/\s*the user confirms;/);
});
