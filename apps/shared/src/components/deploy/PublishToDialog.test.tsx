// MIT License
//
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

/**
 * The "Publish vN to…" dialog both DEPLOY screens open (mockups 1.10 and
 * 2.14): one row per audience with its current state, a closed row that
 * stays visible and says why, and nothing choosable while the screen is busy.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PublishToDialog } from './PublishToDialog';
import type { IPublishTarget, IPublishToDialogProps } from './PublishToDialog';

/** Me, a team on an older version, and the store before approval. */
const TARGETS: IPublishTarget[] = [
	{ id: '@me', label: 'Me', note: 'not published yet' },
	{ id: 'team-prod', label: 'Production', note: 'upgrade from v4' },
	{ id: '@public', label: 'Public: the store', note: 'needs review approval', disabled: true, disabledTitle: 'The store needs an approved version' },
];

/** The dialog's props with a recording onChoose. */
function propsOf(chosen: string[], overrides: Partial<IPublishToDialogProps> = {}): IPublishToDialogProps {
	return { title: 'Publish v5 to…', hint: 'Points the chosen audience at v5.', targets: TARGETS, onChoose: (id) => chosen.push(id), onCancel: () => undefined, ...overrides };
}

/** Every element in a rendered tree whose props carry role="button" (the audience rows). */
function rowsOf(node: React.ReactNode): React.ReactElement<{ role?: string; onClick: (e: unknown) => void }>[] {
	if (Array.isArray(node)) return node.flatMap(rowsOf);
	if (!React.isValidElement(node)) return [];
	const element = node as React.ReactElement<{ role?: string; children?: React.ReactNode; onClick: (e: unknown) => void }>;
	return [...(element.props.role === 'button' ? [element] : []), ...rowsOf(element.props.children)];
}

test('one row per audience, each with its current state, under the title and hint', () => {
	const markup = renderToStaticMarkup(<PublishToDialog {...propsOf([])} />);
	assert.match(markup, /Publish v5 to…/);
	assert.match(markup, /Points the chosen audience at v5\./);
	assert.match(markup, />Me<span[^>]*>not published yet<\/span>/);
	assert.match(markup, />Production<span[^>]*>upgrade from v4<\/span>/);
	assert.match(markup, />Cancel<\/button>/);
});

test('a closed row stays visible, says why, and leaves the tab order', () => {
	const markup = renderToStaticMarkup(<PublishToDialog {...propsOf([])} />);
	assert.match(markup, /title="The store needs an approved version" role="button" tabindex="-1" aria-disabled="true">Public: the store<span[^>]*>needs review approval/);
});

test('choosing an open row is the choice; a closed row does nothing', () => {
	const chosen: string[] = [];
	const rows = rowsOf(PublishToDialog(propsOf(chosen)));
	assert.equal(rows.length, 3);
	for (const row of rows) row.props.onClick({});
	assert.deepEqual(chosen, ['@me', 'team-prod']);
});

test('while the screen is busy every row is inert and Cancel is disabled', () => {
	const chosen: string[] = [];
	const markup = renderToStaticMarkup(<PublishToDialog {...propsOf(chosen, { busy: true })} />);
	assert.doesNotMatch(markup, /aria-disabled="false"/);
	assert.match(markup, /disabled="">Cancel/);
	for (const row of rowsOf(PublishToDialog(propsOf(chosen, { busy: true })))) row.props.onClick({});
	assert.deepEqual(chosen, []);
});

test("the screen's failure shows under the rows", () => {
	const markup = renderToStaticMarkup(<PublishToDialog {...propsOf([], { error: 'Permission denied' })} />);
	assert.match(markup, /Permission denied/);
});
