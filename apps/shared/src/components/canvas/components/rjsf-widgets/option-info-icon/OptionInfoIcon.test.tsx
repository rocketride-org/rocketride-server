// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { Children, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import OptionInfoIcon from './OptionInfoIcon';

const DESCRIPTION = 'Deals and everything hanging off them.';
const DESCRIPTION_ID = 'root_toolGroups__option_0__description';

const renderIcon = () => renderToStaticMarkup(<OptionInfoIcon description={DESCRIPTION} descriptionId={DESCRIPTION_ID} />);

test('option help renders an icon that assistive technology ignores', () => {
	const markup = renderIcon();

	assert.match(markup, /<svg[^>]*aria-hidden="true"/);
	assert.doesNotMatch(markup, /role="button"/);
});

test('option help stays out of the tab order so menu arrow keys keep working', () => {
	// A focusable descendant makes MenuList resolve the next option from the
	// focused element rather than the option row, which kills arrow navigation.
	assert.doesNotMatch(renderIcon(), /tabindex="0"/);
});

test('option help mirrors its text into the node the option describes itself with', () => {
	const markup = renderIcon();

	assert.match(markup, new RegExp(`id="${DESCRIPTION_ID}"`));
	assert.match(markup, new RegExp(DESCRIPTION));
});

test('the hidden node carries what the tooltip carries, not the raw source text', () => {
	// The hidden node is the ONLY copy assistive technology reads — the tooltip
	// is pointer-only and aria-hidden. Rendered as raw text, a description
	// carrying `<code>` or `<br>` was announced with its tag names spoken: the
	// markup a sighted user never sees, read aloud to the one user who cannot
	// see the tooltip it was written for.
	//
	// Asserted as ONE value feeding both renderings rather than by rendering
	// markup: `sanitizeAndParseHtmlToReact` sanitizes with dompurify, which
	// needs a real DOM, and this suite runs in plain node with none.
	const icon = OptionInfoIcon({ description: DESCRIPTION, descriptionId: DESCRIPTION_ID }) as ReactElement<Record<string, unknown>>;
	const [tooltip, hidden] = Children.toArray(icon.props.children) as ReactElement<Record<string, unknown>>[];

	assert.equal(hidden.props.id, DESCRIPTION_ID);
	assert.strictEqual(hidden.props.children, tooltip.props.title);
});

test('reading option help does not toggle the option it sits on', () => {
	const icon = OptionInfoIcon({ description: DESCRIPTION, descriptionId: DESCRIPTION_ID }) as ReactElement<Record<string, unknown>>;
	const tooltip = Children.toArray(icon.props.children)[0] as ReactElement<Record<string, unknown>>;
	const trigger = tooltip.props.children as ReactElement<Record<string, unknown>>;

	for (const handlerName of ['onMouseDown', 'onClick']) {
		let defaultPrevented = false;
		let propagationStopped = false;

		(trigger.props[handlerName] as (event: Record<string, unknown>) => void)({
			preventDefault: () => (defaultPrevented = true),
			stopPropagation: () => (propagationStopped = true),
		});

		assert.equal(defaultPrevented, true, `${handlerName} did not prevent the default`);
		assert.equal(propagationStopped, true, `${handlerName} reached the MenuItem`);
	}
});
