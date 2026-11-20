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
 * The version card's action row both DEPLOY screens draw: one button per
 * verb the card offers, nothing when it offers none, each wired to its verb.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { VersionCardActions } from './VersionCardActions';
import type { IVersionCardActionsProps } from './VersionCardActions';

/** The row's props with every verb recorded by name. */
function propsOf(calls: string[], overrides: Partial<IVersionCardActionsProps> = {}): IVersionCardActionsProps {
	return {
		actions: { publish: true, submit: true, withdraw: true },
		onPublish: () => calls.push('publish'),
		onSubmit: () => calls.push('submit'),
		onWithdraw: () => calls.push('withdraw'),
		...overrides,
	};
}

test('a card that offers no verb draws no row', () => {
	assert.equal(renderToStaticMarkup(<VersionCardActions {...propsOf([], { actions: { publish: false, submit: false, withdraw: false } })} />), '');
});

test('each offered verb draws its button, Publish to… first', () => {
	const markup = renderToStaticMarkup(<VersionCardActions {...propsOf([])} />);
	assert.match(markup, />Publish to…<\/button>.*>Submit for review<\/button>.*>Withdraw<\/button>/);
	const draft = renderToStaticMarkup(<VersionCardActions {...propsOf([], { actions: { publish: true, submit: true, withdraw: false } })} />);
	assert.doesNotMatch(draft, /Withdraw/);
	const inReview = renderToStaticMarkup(<VersionCardActions {...propsOf([], { actions: { publish: true, submit: false, withdraw: true } })} />);
	assert.doesNotMatch(inReview, /Submit for review/);
});

test('every button is disabled while the screen is busy', () => {
	const markup = renderToStaticMarkup(<VersionCardActions {...propsOf([], { disabled: true })} />);
	assert.equal(markup.match(/disabled=""/g)?.length, 3);
});

test('each button runs its own verb', () => {
	const calls: string[] = [];
	const row = VersionCardActions(propsOf(calls)) as React.ReactElement<{ children: Array<React.ReactElement<{ onClick: () => void }> | false> }>;
	for (const button of row.props.children) if (button) button.props.onClick();
	assert.deepEqual(calls, ['publish', 'submit', 'withdraw']);
});
