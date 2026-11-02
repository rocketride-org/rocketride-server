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
import React, { type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ApiKeyWidget from './ApiKeyWidget';

const WidgetForTest = ApiKeyWidget as ComponentType<Record<string, unknown>>;

const baseProps = {
	id: 'root_apiKey',
	name: 'apiKey',
	label: 'API Key',
	required: false,
	disabled: false,
	readonly: false,
	autofocus: false,
	rawErrors: [],
	onChange: () => undefined,
	onBlur: () => undefined,
	onFocus: () => undefined,
	formContext: {},
	schema: { type: 'string' },
	uiSchema: {},
	options: {},
	registry: {},
};

test('a fresh (unsaved) API key field masks input by default instead of showing it as plain text', () => {
	const markup = renderToStaticMarkup(<WidgetForTest {...baseProps} value="" />);
	assert.match(markup, /type="password"/);
	assert.doesNotMatch(markup, /type="text"/);
});

test('an already-saved API key keeps its existing masked read-only display', () => {
	const markup = renderToStaticMarkup(<WidgetForTest {...baseProps} value="sk-abc123xyz" />);
	assert.match(markup, /type="text"/);
	assert.doesNotMatch(markup, /type="password"/);
});
