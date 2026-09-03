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
import React, { Children, type ComponentType, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import BaseInputTemplate from '../base-input-template/BaseInputTemplate';
import FieldLabelWithInfo from './FieldLabelWithInfo';

const InputForTest = BaseInputTemplate as ComponentType<Record<string, unknown>>;

const renderInput = (compactDescriptions: boolean) => renderToStaticMarkup(<InputForTest id="root_name" name="name" placeholder="" required={false} readonly={false} disabled={false} type="text" label="Name" hideLabel={false} hideError={false} value="" onChange={() => undefined} onBlur={() => undefined} onFocus={() => undefined} autofocus={false} options={{ emptyValue: '' }} schema={{ type: 'string', description: 'Shown only for opted-in forms.' }} uiSchema={{}} rawErrors={[]} errorSchema={{}} formContext={{ compactDescriptions }} registry={{}} />);

test('shared inputs keep ordinary labels unless compact descriptions are opted in', () => {
	const markup = renderInput(false);
	assert.doesNotMatch(markup, /More information about Name/);
});

test('opted-in inputs render one focusable info trigger outside the hidden notch', () => {
	const markup = renderInput(true);
	const fieldset = markup.slice(markup.indexOf('<fieldset'), markup.indexOf('</fieldset>'));

	assert.equal(markup.match(/role="button"/g)?.length, 1);
	assert.match(markup, /role="button"[^>]*tabindex="0"[^>]*aria-label="More information about Name"/);
	assert.doesNotMatch(fieldset, /role="button"/);
});

// Descriptions now go through sanitizeAndParseHtmlToReact so a service that
// writes <b> gets bold text rather than literal tags. Only the plain-text path
// is asserted here: the markup path calls DOMPurify, which needs a DOM this
// runner does not provide. Rendered markup is checked by hand in the panel.
test('a description without markup reaches the tooltip untouched', () => {
	const label = FieldLabelWithInfo({ label: 'Read-only mode', description: 'Prevents write operations.', fieldTitle: 'Read-only mode' }) as ReactElement<Record<string, unknown>>;
	const tooltip = Children.toArray(label.props.children)[1] as ReactElement<Record<string, unknown>>;

	assert.equal(tooltip.props.title, 'Prevents write operations.');
});

test('info trigger blocks Enter and Space from activating a parent label', () => {
	const label = FieldLabelWithInfo({ label: 'Read-only mode', description: 'Prevents write operations.', fieldTitle: 'Read-only mode' }) as ReactElement<Record<string, unknown>>;
	const tooltip = Children.toArray(label.props.children)[1] as ReactElement<Record<string, unknown>>;
	const trigger = tooltip.props.children as ReactElement<Record<string, unknown>>;
	const onKeyDown = trigger.props.onKeyDown as (event: Record<string, unknown>) => void;

	for (const key of ['Enter', ' ']) {
		let defaultPrevented = false;
		let propagationStopped = false;
		onKeyDown({
			type: 'keydown',
			key,
			preventDefault: () => (defaultPrevented = true),
			stopPropagation: () => (propagationStopped = true),
		});
		assert.equal(defaultPrevented, true);
		assert.equal(propagationStopped, true);
	}
});
