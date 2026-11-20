// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// RENDERED COMPONENTS: THE BANNER, THE EXPORT MENU AND THE OVERVIEW
// =============================================================================
//
// Rendered to static markup (no DOM). The shell is a runtime stand-in in tests (scripts/stub-shell.cjs), so the few
// shell components these views use are given plain stand-ins first; what is checked is what graph-ui puts in the markup.
// =============================================================================

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let inVsCode = false;
Object.assign(createRequire(__filename)('shell') as Record<string, unknown>, {
	Banner: ({ variant, children }: { variant: string; children: React.ReactNode }) => <div role="alert" data-variant={variant}>{children}</div>,
	Button: ({ children, disabled, title }: { children: React.ReactNode; disabled?: boolean; title?: string }) => <button disabled={disabled} title={title}>{children}</button>,
	AnchoredPopup: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? null : <div data-popup>{children}</div>),
	isInVSCode: () => inVsCode,
	Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
});

import { ExportMenu, handleMenuKey } from '../src/components/ExportMenu';
import { GraphFailureBanner } from '../src/components/GraphFailureBanner';
import { OverviewPanel } from '../src/components/OverviewPanel';
import { GraphEnvProvider } from '../src/env';
import type { IGraphEnv } from '../src/env';
import { parseDialect } from '../src/graph/dialect';
import { parseSchema } from '../src/graph/schema';
import type { ISchemaView } from '../src/graph/schema';
import { EMPTY_STYLE, createMemoryUserData } from '../src/graph/userData';
import type { IGraphUserData } from '../src/graph/userData';
import type { ReadQueryResult } from '../src/graph/types';
import { fixture } from './support/builders';

const failure = (index = 2) => ({ notice: { headline: 'Query failed', verbatim: 'Invalid input RETURNN expected RETURN (line 1, column 11 (offset: 10))', generic: false }, index, lines: 'line 3', prior: 'Statements 1–2 already ran.' });

test('the banner has the database text in the markup, the place, what ran and what did not, and Copy error', () => {
	const html = renderToStaticMarkup(<GraphFailureBanner failure={failure()} genericText="withheld" total={4} position={{ line: 3, column: 11 }} />);
	assert.match(html, /<pre[^>]*>Invalid input RETURNN expected RETURN \(line 1, column 11 \(offset: 10\)\)<\/pre>/);
	assert.match(html, /Query failed/);
	assert.match(html, /Statement 3 failed \(line 3, column 11\)\./);
	assert.match(html, /Statements 1–2 already ran\./);
	assert.match(html, /Statement 4 was not run\./);
	assert.match(html, /Copy error/);
	assert.match(html, /data-variant="error"/);
	assert.doesNotMatch(html, /Database said/);
});

test('Run from statement N appears only with the callback and more than one statement', () => {
	const run = (props: Partial<React.ComponentProps<typeof GraphFailureBanner>>): string => renderToStaticMarkup(<GraphFailureBanner failure={failure()} genericText="x" {...props} />);
	assert.match(run({ total: 4, onRunFrom: () => undefined }), /Run from statement 3/);
	assert.doesNotMatch(run({ total: 4 }), /Run from statement/);
	assert.doesNotMatch(run({ total: 1, onRunFrom: () => undefined }), /Run from statement/);
	assert.doesNotMatch(run({ onRunFrom: () => undefined }), /Run from statement/, 'without the batch size it is not offered');
});

test('a node that withheld its text shows the generic line and no text block', () => {
	const html = renderToStaticMarkup(<GraphFailureBanner failure={{ ...failure(), notice: { headline: 'Query failed', verbatim: '', generic: true } }} genericText="The node's message was not returned." total={1} />);
	assert.match(html, /The node&#x27;s message was not returned\./);
	assert.doesNotMatch(html, /<pre/);
});

const result: ReadQueryResult = { columns: ['a'], rows: [[1], [2]], row_limit: 1000, truncated: true, truncated_by: 'rows', element_limit: 1, elements: 0, value_limit: 1, values: 0 };

test('the export menu says Download in a browser and Copy in VS Code, with the row count and the cut', () => {
	inVsCode = false;
	const browser = renderToStaticMarkup(<ExportMenu result={result} />);
	assert.match(browser, /Download CSV/);
	assert.match(browser, /Download JSON/);
	assert.match(browser, /The 2 rows returned \(limit 1,000\), not the whole result: the limit was reached\./);
	assert.match(browser, /leading &#x27; so spreadsheets do not run it/);
	inVsCode = true;
	const vscode = renderToStaticMarkup(<ExportMenu result={result} />);
	inVsCode = false;
	assert.match(vscode, /Copy as CSV/);
	assert.match(vscode, /Copy as JSON/);
	assert.doesNotMatch(vscode, /Download/);
});

/** An env that has only what the Overview reads: any other reach into it throws, so a request cannot go unnoticed. */
function envWith(view: ISchemaView | null, styled?: IGraphUserData): IGraphEnv {
	const probes = { k1: { ok: true, info: fixture<Record<string, unknown>>('dialect_neo4j'), dialect: 'neo4j' } };
	const only = { schemaView: { get: () => view, subscribe: () => () => undefined }, endpoints: { get: () => ({ probes }), subscribe: () => () => undefined }, userData: styled ?? createMemoryUserData('test') };
	return new Proxy(only, { get: (target, prop) => { if (prop in target) return (target as Record<string | symbol, unknown>)[prop]; throw new Error(`the Overview touched env.${String(prop)}`); } }) as unknown as IGraphEnv;
}

const endpoint = { key: 'k1', nodeName: 'Neo4j', pipelineName: 'Customer Graph' } as never;
const noop = (): void => undefined;

/** User data whose style is loaded and holds the slots the schema's own realm gave. */
const styled = (): IGraphUserData => ({ ...createMemoryUserData('test'), style: () => ({ get: () => ({ ready: true, style: { ...EMPTY_STYLE, assigned: { Company: 0, Person: 1 } } }), subscribe: () => () => undefined }) });

test('the Overview from the schema fixture: about, not reported, colours, patterns, and nothing requested', () => {
	const dialect = parseDialect(fixture('dialect_neo4j'));
	const html = renderToStaticMarkup(
		<GraphEnvProvider value={envWith(parseSchema(fixture('schema_v2')), styled())}>
			<OverviewPanel endpoint={endpoint} dialect={dialect} onPreview={noop} onNewQuery={noop} onExplore={noop} onRefreshSchema={noop} />
		</GraphEnvProvider>
	);
	assert.match(html, /about 3/);
	assert.match(html, /Supported \(Cypher\)/, 'the chips are the cards\'');
	assert.match(html, /not reported/);
	assert.match(html, /var\(--rr-chart-blue\)/);
	assert.match(html, /Person → Company/);
	assert.match(html, /Employee → Company \(inferred\)/);
	assert.match(html, /role STRING/);
	assert.match(html, /<svg[^>]*role="img"/);
	assert.doesNotMatch(html, />Explore<|>New query<[^]*>Explore</, 'the header actions belong to the workbench');
});

test('two Overviews in one page do not share an arrowhead id', () => {
	const dialect = parseDialect(fixture('dialect_neo4j'));
	const panel = (key: string): React.ReactElement => <OverviewPanel key={key} endpoint={endpoint} dialect={dialect} onPreview={noop} onNewQuery={noop} onExplore={noop} onRefreshSchema={noop} />;
	const html = renderToStaticMarkup(<GraphEnvProvider value={envWith(parseSchema(fixture('schema_v2')))}><div>{panel('a')}{panel('b')}</div></GraphEnvProvider>);
	const ids = [...html.matchAll(/<marker id="([^"]+)"/g)].map((m) => m[1]);
	assert.equal(ids.length, 2);
	assert.notEqual(ids[0], ids[1]);
	for (const id of ids) assert.ok(html.includes(`url(#${id})`));
});

test('the Overview before a load, and for an empty graph', () => {
	const loading = renderToStaticMarkup(<GraphEnvProvider value={envWith(null)}><OverviewPanel endpoint={endpoint} dialect={null} onPreview={noop} onNewQuery={noop} onExplore={noop} onRefreshSchema={noop} /></GraphEnvProvider>);
	assert.match(loading, /The schema has not been loaded/);
	assert.match(loading, /Refresh schema/);
	const empty = renderToStaticMarkup(<GraphEnvProvider value={envWith(parseSchema({ schema: { version: 2, labels: [], relationship_types: [], sampled: true, truncated: false, refreshed_at: '2026-10-04T15:00:00Z', source: 'refresh', stale: false, error: null, capable: true } }))}><OverviewPanel endpoint={endpoint} dialect={parseDialect(fixture('dialect_falkordb'))} onPreview={noop} onNewQuery={noop} onExplore={noop} onRefreshSchema={noop} /></GraphEnvProvider>);
	assert.match(empty, /This graph is empty/);
	assert.match(empty, />Explore</);
});

test('Escape in the export menu is claimed, closes it and returns focus to the Export button; other keys only move', () => {
	const calls: string[] = [];
	const actions = { close: () => calls.push('close'), focusButton: () => calls.push('focus'), move: () => calls.push('move') };
	let prevented = 0;
	handleMenuKey({ key: 'Escape', preventDefault: () => { prevented += 1; } }, actions);
	assert.equal(prevented, 1, 'preventDefault, so the Escape does not also act above the portal');
	assert.deepEqual(calls, ['close', 'focus']);
	calls.length = 0;
	handleMenuKey({ key: 'ArrowDown', preventDefault: () => { prevented += 1; } }, actions);
	assert.equal(prevented, 1, 'a key the menu does not claim is left alone here (moveFocus decides its own)');
	assert.deepEqual(calls, ['move']);
});
