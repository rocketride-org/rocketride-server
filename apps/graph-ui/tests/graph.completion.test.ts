// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// AUTOCOMPLETE: WHAT IS SUGGESTED AT THE CARET, AND THE ONE PROVIDER
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as MonacoNS from 'monaco-editor';
import { markersKey, applyMarkers, completionContextCount, ensureCypherCompletion, setCompletionContext } from '../src/components/completionProvider';
import { parseSchema } from '../src/graph/schema';
import { suggestAt } from '../src/cypher/completion';
import type { ICompletionModel } from '../src/cypher/completion';
import { fixture } from './support/builders';

const schema = parseSchema(fixture('schema_v2'));
const model: ICompletionModel = { schema, dialect: 'neo4j' };
const labels = (before: string, m: ICompletionModel = model): string[] => suggestAt(m, before).map((c) => c.label);

test('after (p: the labels, and only the labels', () => {
	const out = suggestAt(model, 'MATCH (p:');
	assert.deepEqual(out.map((c) => c.label), ['Company', 'Person']);
	assert.ok(out.every((c) => c.kind === 'label'));
	assert.equal(out[1].detail, 'label · about 2 nodes');
});

test('a label being typed is still a label position, and a second label after another is too', () => {
	assert.deepEqual(labels('MATCH (p:Pe'), ['Company', 'Person']);
	assert.deepEqual(labels('MATCH (p:Person:'), ['Company', 'Person']);
	assert.deepEqual(labels('MATCH (n) WHERE n:'), ['Company', 'Person']);
});

test('after -[: and [r: the relationship types', () => {
	for (const text of ['MATCH (a)-[:', 'MATCH (a)-[r:', 'MATCH (a)-[r:KNOWS|']) {
		assert.deepEqual(labels(text), ['KNOWS', 'LIKES', 'WORKS_AT'], text);
	}
	const works = suggestAt(model, 'MATCH (a)-[:').find((c) => c.label === 'WORKS_AT');
	assert.equal(works?.kind, 'type');
	assert.match(works?.detail ?? '', /Person -> Company/);
});

test('after p. the properties of p\'s label when (p:Person) is earlier in the statement, with their types and the word sampled', () => {
	const out = suggestAt(model, 'MATCH (p:Person) RETURN p.');
	assert.deepEqual(out.map((c) => c.label), ['age', 'born', 'name', 'score']);
	assert.ok(out.every((c) => c.kind === 'property'));
	assert.equal(out.find((c) => c.label === 'score')?.detail, 'float | integer · sampled');
	assert.equal(out[0].documentation, 'Person properties · p is (:Person) · sampled');
	assert.deepEqual(labels('MATCH (p:Person) RETURN p.na'), ['age', 'born', 'name', 'score'], 'the typed prefix does not change the context');
});

test('a variable bound to a label that is not in the schema, or to none, gets every property key once', () => {
	const every = ['age', 'born', 'name', 'role', 'score', 'since'];
	assert.deepEqual(labels('MATCH (x:Nope) RETURN x.'), every);
	assert.deepEqual(labels('MATCH (x) RETURN x.'), every);
	assert.equal(suggestAt(model, 'MATCH (x) RETURN x.').find((c) => c.label === 'name')?.detail, 'string · sampled');
});

test('a relationship variable gets its type\'s properties', () => {
	assert.deepEqual(labels('MATCH (a)-[r:KNOWS]->(b) RETURN r.'), ['since']);
});

test('the binding is read from the same statement only', () => {
	assert.deepEqual(labels('MATCH (p:Person) RETURN p; MATCH (p:Company) RETURN p.'), ['name']);
});

test('nothing inside a string, a comment, or a quoted name', () => {
	assert.deepEqual(suggestAt(model, "MATCH (p:Person) WHERE p.name = 'a (p:"), []);
	assert.deepEqual(suggestAt(model, 'MATCH (p:Person) // (q:'), []);
	assert.deepEqual(suggestAt(model, 'MATCH (p:Person) /* p.'), []);
	assert.deepEqual(suggestAt(model, 'MATCH (p:Person) RETURN `p.'), []);
	assert.deepEqual(labels('MATCH (p:Person) // note\nRETURN p.'), ['age', 'born', 'name', 'score'], 'a comment on an earlier line is not the caret\'s context');
});

test('a colon in a map or a slice is not a label position', () => {
	assert.deepEqual(suggestAt(model, 'RETURN {a:'), []);
	assert.deepEqual(suggestAt(model, 'MATCH (n) RETURN n.name[1:'), []);
});

test('a range dot is not a property position', () => {
	assert.deepEqual(suggestAt(model, 'MATCH (a)-[*1..'), []);
});

test('at the start of a statement: clause keywords and snippets, for a read workbench only', () => {
	const out = suggestAt(model, 'MA');
	const names = out.map((c) => c.label);
	assert.ok(names.includes('MATCH') && names.includes('RETURN') && names.includes('OPTIONAL MATCH'));
	assert.ok(out.some((c) => c.kind === 'snippet' && /LIMIT/.test(c.insertText)));
	assert.ok(!names.includes('CREATE') && !names.includes('DELETE'), 'writes are refused in the read workbench');
	assert.deepEqual(suggestAt(model, 'MATCH (n) RETURN n; ').map((c) => c.label), suggestAt(model, '').map((c) => c.label), 'a new statement starts again');
});

test('the write console is also offered the write clauses', () => {
	const names = suggestAt({ ...model, writes: true }, '').map((c) => c.label);
	assert.ok(names.includes('CREATE') && names.includes('MERGE'));
});

test('mid-statement, a typed word is offered the clauses that can follow; no word, no noise', () => {
	assert.ok(labels('MATCH (n) WH').includes('WHERE'));
	assert.ok(labels('MATCH (n) RETURN n OR').includes('ORDER BY'));
	assert.deepEqual(labels('MATCH (n) '), []);
});

test('no schema: label, type and property positions suggest nothing, keywords still work', () => {
	const bare: ICompletionModel = { schema: null, dialect: null };
	assert.deepEqual(suggestAt(bare, 'MATCH (p:'), []);
	assert.deepEqual(suggestAt(bare, 'MATCH (p) RETURN p.'), []);
	assert.ok(suggestAt(bare, 'MA').some((c) => c.label === 'MATCH'));
});

test('names that need quoting are inserted quoted, and AGE (which cannot take a quoted label) never offers them', () => {
	const odd = parseSchema({ ...(fixture<Record<string, unknown>>('schema_v2')), schema: { version: 2, labels: [{ name: 'Has Space', properties: [{ name: 'full name', types: ['string'] }] }, { name: 'Plain', properties: [] }], relationship_types: [], sampled: true, truncated: false, refreshed_at: '2026-10-04T15:00:00Z', source: 'refresh', stale: false, error: null, capable: true } });
	const neo = suggestAt({ schema: odd, dialect: 'neo4j' }, 'MATCH (p:');
	assert.equal(neo.find((c) => c.label === 'Has Space')?.insertText, '`Has Space`');
	assert.equal(neo.find((c) => c.label === 'Plain')?.insertText, 'Plain', 'a plain name needs no quotes');
	assert.deepEqual(suggestAt({ schema: odd, dialect: 'age' }, 'MATCH (p:').map((c) => c.label), ['Plain']);
	assert.equal(suggestAt({ schema: odd, dialect: 'neo4j' }, 'MATCH (p:`Has Space`) RETURN p.').find((c) => c.label === 'full name')?.insertText, '`full name`');
});

test('before the engine is known only names that need no quotes are offered', () => {
	const odd = parseSchema({ schema: { version: 2, labels: [{ name: 'Has Space', properties: [] }, { name: 'Plain', properties: [] }], relationship_types: [], sampled: true, truncated: false, refreshed_at: null, source: 'refresh', stale: false, error: null, capable: true } });
	assert.deepEqual(suggestAt({ schema: odd, dialect: null }, 'MATCH (p:').map((c) => c.label), ['Plain']);
});

test('counts say about when estimated and nothing when absent', () => {
	const view = parseSchema({ schema: { version: 2, labels: [{ name: 'A', properties: [], count: 5, count_estimated: false }, { name: 'B', properties: [], count: 7, count_estimated: true }, { name: 'C', properties: [] }], relationship_types: [], sampled: true, truncated: false, refreshed_at: null, source: 'refresh', stale: false, error: null, capable: true } });
	const out = suggestAt({ schema: view, dialect: 'neo4j' }, '(x:');
	assert.deepEqual(out.map((c) => c.detail), ['label · 5 nodes', 'label · about 7 nodes', 'label']);
});

// -----------------------------------------------------------------------------
// One provider, however many editors
// -----------------------------------------------------------------------------

interface IFakeProvider { triggerCharacters?: string[]; provideCompletionItems(model: unknown, position: unknown): { suggestions: Array<{ label: string; range: unknown }> } }

/** A stand-in for the Monaco namespace that records registrations and marks. */
function fakeMonaco(): { monaco: typeof MonacoNS; providers: Array<{ language: string; provider: IFakeProvider }>; marks: Array<{ owner: string; markers: Array<Record<string, number>> }> } {
	const providers: Array<{ language: string; provider: IFakeProvider }> = [];
	const marks: Array<{ owner: string; markers: Array<Record<string, number>> }> = [];
	const monaco = {
		languages: {
			registerCompletionItemProvider: (language: string, provider: IFakeProvider) => providers.push({ language, provider }),
			CompletionItemKind: { Struct: 1, Reference: 2, Field: 3, Keyword: 4, Snippet: 5 },
			CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
		},
		editor: { setModelMarkers: (_model: unknown, owner: string, markers: Array<Record<string, number>>) => marks.push({ owner, markers }) },
		MarkerSeverity: { Error: 8, Warning: 4 },
	} as unknown as typeof MonacoNS;
	return { monaco, providers, marks };
}

/** A stand-in for an editor model holding single-line text. */
function fakeModel(uri: string, text: string): MonacoNS.editor.ITextModel {
	return {
		uri: { toString: () => uri },
		getValue: () => text,
		getValueLength: () => text.length,
		getOffsetAt: (p: { column: number }) => p.column - 1,
		getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
		getWordUntilPosition: (p: { column: number }) => {
			const before = text.slice(0, p.column - 1);
			const typed = /[A-Za-z_]*$/.exec(before)?.[0] ?? '';
			return { word: typed, startColumn: p.column - typed.length, endColumn: p.column };
		},
	} as unknown as MonacoNS.editor.ITextModel;
}

test('one provider is registered however many editors mount, for the cypher language, triggered by : and .', () => {
	const { monaco, providers } = fakeMonaco();
	for (let i = 0; i < 5; i++) ensureCypherCompletion(monaco);
	assert.equal(providers.length, 1);
	assert.equal(providers[0].language, 'cypher');
	assert.deepEqual(providers[0].provider.triggerCharacters, [':', '.']);
});

test('the provider answers each editor from its own entry, by model URI, and from none after unmount', () => {
	const { monaco, providers } = fakeMonaco();
	ensureCypherCompletion(monaco);
	const provider = providers[0].provider;
	const text = 'MATCH (p:';
	setCompletionContext('inmemory://model/1', model);
	setCompletionContext('inmemory://model/2', { schema: null, dialect: null });
	const at = { lineNumber: 1, column: text.length + 1 };
	assert.deepEqual(provider.provideCompletionItems(fakeModel('inmemory://model/1', text), at).suggestions.map((s) => s.label), ['Company', 'Person']);
	assert.deepEqual(provider.provideCompletionItems(fakeModel('inmemory://model/2', text), at).suggestions, []);
	setCompletionContext('inmemory://model/1', null);
	setCompletionContext('inmemory://model/2', null);
	assert.deepEqual(provider.provideCompletionItems(fakeModel('inmemory://model/1', text), at).suggestions, []);
	assert.equal(completionContextCount(), 0, 'nothing is left behind');
});

test('accepting a suggestion replaces the word already typed', () => {
	const { monaco, providers } = fakeMonaco();
	ensureCypherCompletion(monaco);
	setCompletionContext('inmemory://model/3', model);
	const text = 'MATCH (p:Pe';
	const out = providers[0].provider.provideCompletionItems(fakeModel('inmemory://model/3', text), { lineNumber: 1, column: text.length + 1 });
	assert.deepEqual(out.suggestions[0].range, { startLineNumber: 1, endLineNumber: 1, startColumn: 10, endColumn: 12 });
	setCompletionContext('inmemory://model/3', null);
});

test('marks are set under this app\'s owner name, clamped into the text, and an empty list clears them', () => {
	const { monaco, marks } = fakeMonaco();
	const m = fakeModel('inmemory://model/4', 'MATCH (n RETURN n');
	applyMarkers(monaco, m, [{ start: 9, end: 15, message: 'bad', severity: 'error' }, { start: 100, end: 200, message: 'late', severity: 'warning' }]);
	assert.equal(marks[0].owner, 'graph-ui');
	assert.deepEqual(marks[0].markers[0], { severity: 8, message: 'bad', startLineNumber: 1, startColumn: 10, endLineNumber: 1, endColumn: 16 });
	assert.equal(marks[0].markers[1].severity, 4);
	applyMarkers(monaco, m, []);
	assert.deepEqual(marks[1].markers, []);
});

test('the marks key follows the marks\' content, not the array, so a fresh array does not bring a cleared mark back', () => {
	const a = [{ start: 1, end: 3, message: 'm', severity: 'error' as const }];
	assert.equal(markersKey(a), markersKey(a.map((m) => ({ ...m }))));
	assert.notEqual(markersKey(a), markersKey([{ ...a[0], start: 2 }]));
	assert.equal(markersKey(undefined), '');
	assert.equal(markersKey([]), '');
});
