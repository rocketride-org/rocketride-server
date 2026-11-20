// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WHAT RUN SENDS
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { describeRun, describeSnapshot, targetsFromEditor, targetsToRun } from '../src/cypher/targets';
import type { IEditorSnapshot, ISnapshotSource } from '../src/cypher/targets';

const BUFFER = 'MATCH (n) RETURN n;\nMATCH (m)\nRETURN m;\n// note\nRETURN 3';

test('Run sends the statement the caret is in, with its lines in the buffer', () => {
	const t = targetsToRun(BUFFER, { start: 25, end: 25 }, 25, false);
	assert.equal(t.length, 1);
	assert.equal(t[0].text, 'MATCH (m)\nRETURN m');
	assert.deepEqual([t[0].startLine, t[0].endLine], [2, 3]);
	assert.equal(BUFFER.slice(t[0].start, t[0].end), t[0].text);
});

test('Run sends the selection, split into statements with buffer offsets; Run all sends everything', () => {
	const from = BUFFER.indexOf('MATCH (n)');
	const to = BUFFER.indexOf('// note');
	const sel = targetsToRun(BUFFER, { start: from, end: to }, from, false);
	assert.deepEqual(sel.map((s) => s.text), ['MATCH (n) RETURN n', 'MATCH (m)\nRETURN m']);
	for (const s of sel) assert.equal(BUFFER.slice(s.start, s.end), s.text);
	const all = targetsToRun(BUFFER, { start: 3, end: 3 }, 3, true);
	assert.deepEqual(all.map((s) => s.text), ['MATCH (n) RETURN n', 'MATCH (m)\nRETURN m', '// note\nRETURN 3']);
	assert.deepEqual(all.map((s) => s.startLine), [1, 2, 4]);
});

test('an empty buffer, or one holding only comments, sends nothing', () => {
	assert.deepEqual(targetsToRun('', { start: 0, end: 0 }, 0, false), []);
	assert.deepEqual(targetsToRun('// nothing', { start: 0, end: 0 }, 0, true), []);
	assert.equal(describeRun('', { start: 0, end: 0 }, 0), 'Nothing to run.');
});

test('the "Will run" sentence names the lines and says it stops at the first error when several are selected', () => {
	assert.equal(describeRun(BUFFER, { start: 25, end: 25 }, 25), 'Will run: the statement at lines 2–3.');
	assert.equal(describeRun(BUFFER, { start: 0, end: 5 }, 0), 'Will run: the selection at line 1.');
	const from = BUFFER.indexOf('MATCH (n)');
	const to = BUFFER.indexOf('// note');
	assert.equal(describeRun(BUFFER, { start: from, end: to }, from), 'Will run: 2 statements from the selection (lines 1–3), in order, stopping at the first error.');
});

// -----------------------------------------------------------------------------
// The buffer a run uses is the LIVE editor's, never a copy that lags one render behind
// -----------------------------------------------------------------------------

/** A fake editor holding `text` with the caret at `caret`: the live source. */
function editorWith(text: string, caret: number, selection?: { start: number; end: number }): ISnapshotSource {
	return { snapshot: (): IEditorSnapshot => ({ text, start: selection?.start ?? caret, end: selection?.end ?? caret, caret }) };
}

test('fast typing: the live caret against a text one keystroke behind would truncate the statement; the run reads text and caret from the editor together', () => {
	const LIVE = 'MATCH (n:Person) RETURN n LIMIT 25';
	const STALE = 'MATCH (n:Person) RETURN n LIMIT 2'; // what React state still holds one render later
	const caret = LIVE.length;
	// The bug shape: offsets taken from the live editor, text taken from the lagging copy.
	const mixed = targetsToRun(STALE, { start: caret, end: caret }, caret, false);
	assert.equal(mixed[0]?.text, 'MATCH (n:Person) RETURN n LIMIT 2', 'a stale copy sends a truncated statement (this is the failure the editor wiring must not have)');
	// The wiring: one read of the live editor.
	const live = targetsFromEditor(editorWith(LIVE, caret), false);
	assert.equal(live.length, 1);
	assert.equal(live[0].text, LIVE);
	assert.equal(LIVE.slice(live[0].start, live[0].end), LIVE);
});

test('targetsFromEditor takes everything from the one snapshot: a selection, the caret statement and Run all', () => {
	const text = 'RETURN 1;\nRETURN 2;\nRETURN 3';
	assert.deepEqual(targetsFromEditor(editorWith(text, 12), false).map((t) => t.text), ['RETURN 2']);
	assert.deepEqual(targetsFromEditor(editorWith(text, 0, { start: 0, end: 19 }), false).map((t) => t.text), ['RETURN 1', 'RETURN 2']);
	assert.deepEqual(targetsFromEditor(editorWith(text, 0), true).map((t) => t.text), ['RETURN 1', 'RETURN 2', 'RETURN 3']);
	assert.deepEqual(targetsFromEditor(editorWith('', 0), false), []);
});

test('the editor is read once per run, and what it says is used as given (no second source)', () => {
	let reads = 0;
	const source: ISnapshotSource = { snapshot: () => { reads += 1; return { text: 'RETURN 1', start: 8, end: 8, caret: 8 }; } };
	targetsFromEditor(source, false);
	assert.equal(reads, 1);
	assert.equal(describeSnapshot({ text: 'RETURN 1', start: 8, end: 8, caret: 8 }), 'Will run: the statement at line 1.');
});

test('a snapshot taken between keystrokes always describes a statement that exists in ITS OWN text (every prefix of a typed query)', () => {
	const typed = 'MATCH (a)-[r:KNOWS]->(b) WHERE a.name = \'Ada\' RETURN a, r, b LIMIT 25';
	for (let i = 1; i <= typed.length; i++) {
		const text = typed.slice(0, i);
		const [target] = targetsFromEditor(editorWith(text, i), false);
		assert.ok(target, `prefix ${i}`);
		assert.equal(text.slice(target.start, target.end), target.text);
		assert.equal(target.text, text.trim(), `the whole of what was typed so far is sent (prefix ${i})`);
	}
});

test('wiring guard: the run surface sends what targetsFromEditor reads from the editor, and the editor handle never reads the React `value` prop', () => {
	const surface = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'RunSurface.tsx'), 'utf8');
	assert.doesNotMatch(surface, /targetsToRun/, 'RunSurface must not build targets from its own text state');
	assert.match(surface, /targetsFromEditor\(handle, all\)/);
	const editorSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'QueryEditor.tsx'), 'utf8');
	const snapshot = editorSource
		.slice(editorSource.indexOf('snapshot: () => {'), editorSource.indexOf('getSelection: () => {'))
		.replace(/\/\/.*$/gm, '')
		.replace(/area\.value/g, '')
		.replace(/getValue/g, '');
	assert.ok(editorSource.includes('text: area.value') && editorSource.includes('model.getValue()'), 'the snapshot reads the textarea value or the Monaco model');
	assert.doesNotMatch(snapshot, /\bvalue\b/, 'the snapshot does not read the value prop');
});

// The editor is the platform's shared MonacoEditor ('shared/components/monaco'). Two things keep the pins above
// meaningful on it: the model the snapshot reads belongs to the editor instance the shared component hands to
// onMount, and the shared component is never given the React `value` prop. The shared component writes its `value`
// prop back into the model whenever the two differ, so passing the React state would make Monaco controlled again,
// and a render that is a keystroke behind fast typing could put old text back (the reason the editor is uncontrolled).
test('wiring guard: the snapshot reads the editor the shared MonacoEditor mounted, and the shared editor only ever gets the first text', () => {
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'QueryEditor.tsx'), 'utf8');
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	const at = code.indexOf('<MonacoEditor');
	assert.ok(at >= 0, 'the editor renders <MonacoEditor');
	const jsx = code.slice(at, code.indexOf('/>', at));
	assert.match(jsx, /\bonMount=\{handleMount\}/);
	assert.match(jsx, /\bvalue=\{initial\.current\}/, 'the first text (or text set before Monaco mounted), not the live prop');
	assert.doesNotMatch(jsx, /\bvalue=\{value\}/, 'never the React state');
	const mount = code.slice(code.indexOf('const handleMount = useCallback('), code.indexOf('if (status === \'failed\')'));
	assert.match(mount, /editorRef\.current = editor;/, 'the snapshot\'s editorRef is the instance the shared editor mounted');

	// The shared editor's side of that reasoning: a `value` that differs from the buffer is written back with setValue.
	const shared = fs.readFileSync(path.resolve(__dirname, '..', '..', 'shared', 'src', 'components', 'monaco', 'MonacoEditor.tsx'), 'utf8');
	assert.match(shared, /if \(editorInstance\.getValue\(\) !== value\) \{[\s\S]*?editorInstance\.setValue\(value\);[\s\S]*?\}, \[value, model\]\);/);
});

test('the shared editor brings Monaco\'s built-in cypher language: its loader imports editor.main, which registers basic-languages/cypher', () => {
	const sharedMonaco = path.resolve(__dirname, '..', '..', 'shared', 'src', 'components', 'monaco');
	const loader = fs.readFileSync(path.join(sharedMonaco, 'loader.ts'), 'utf8');
	assert.match(loader, /import\('monaco-editor\/esm\/vs\/editor\/editor\.main\.js'\)/);
	const pkg = require.resolve('monaco-editor/package.json', { paths: [sharedMonaco] });
	const main = fs.readFileSync(path.join(path.dirname(pkg), 'esm', 'vs', 'editor', 'editor.main.js'), 'utf8');
	assert.match(main, /import '\.\.\/basic-languages\/cypher\/cypher\.contribution\.js';/, 'nothing needs registering in beforeMount');
});
