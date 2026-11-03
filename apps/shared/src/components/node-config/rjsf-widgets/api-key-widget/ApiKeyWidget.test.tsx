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

import ApiKeyWidget, {
	ApiKeyWidgetView,
	createInitialApiKeyState,
	reduceApiKeyState,
	type ApiKeyWidgetAction,
	type ApiKeyWidgetViewProps,
} from './ApiKeyWidget';

const WidgetForTest = ApiKeyWidget as ComponentType<Record<string, unknown>>;

const baseProps: Record<string, unknown> = {
	id: 'root_apikey',
	name: 'apikey',
	label: 'API Key',
	required: false,
	readonly: false,
	disabled: false,
	autofocus: false,
	onChange: () => undefined,
	onBlur: () => undefined,
	onFocus: () => undefined,
	options: {},
	schema: { type: 'string', description: 'API key for authentication.' },
	uiSchema: {},
	rawErrors: undefined,
	formContext: {},
	registry: {},
};

const renderWidget = (value: string, overrides: Record<string, unknown> = {}) =>
	renderToStaticMarkup(<WidgetForTest {...baseProps} value={value} {...overrides} />);

const createHarness = (initialValue: string) => {
	let currentValue = initialValue;
	let state = createInitialApiKeyState(initialValue);
	let latestTextField: ReactElement<Record<string, unknown>> | null = null;
	const changes: string[] = [];

	const dispatch = (action: ApiKeyWidgetAction) => {
		state = reduceApiKeyState(state, action);
	};

	const onChange = (nextValue: string) => {
		currentValue = nextValue;
		changes.push(nextValue);
	};

	const Probe = () => {
		const viewProps = {
			...baseProps,
			value: currentValue,
			onChange,
			state,
			dispatch,
		} as unknown as ApiKeyWidgetViewProps;
		const tree = ApiKeyWidgetView(viewProps) as ReactElement<{ children: React.ReactNode }>;
		latestTextField = Children.toArray(tree.props.children)[0] as ReactElement<Record<string, unknown>>;
		return tree;
	};

	const render = () => renderToStaticMarkup(<Probe />);

	const getAdornmentChildren = () => {
		assert.ok(latestTextField, 'Expected TextField to be rendered');
		const slotProps = latestTextField.props.slotProps as { input: { endAdornment: ReactElement<{ children: React.ReactNode }> } };
		return Children.toArray(slotProps.input.endAdornment.props.children) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>[];
	};

	const clickToggle = () => {
		const [toggleTooltip] = getAdornmentChildren();
		const toggleButton = toggleTooltip.props.children;
		(toggleButton.props.onClick as () => void)();
		return render();
	};

	const clickDelete = () => {
		const [, deleteTooltip] = getAdornmentChildren();
		assert.ok(deleteTooltip, 'Expected Delete button to be rendered in masked mode');
		const deleteButton = deleteTooltip.props.children;
		(deleteButton.props.onClick as () => void)();
		return render();
	};

	const changeInput = (nextValue: string) => {
		assert.ok(latestTextField, 'Expected TextField to be rendered');
		const handleChange = latestTextField.props.onChange as (event: { target: { value: string; selectionStart: number } }) => void;
		handleChange({ target: { value: nextValue, selectionStart: nextValue.length } });
		return render();
	};

	return { render, clickToggle, clickDelete, changeInput, changes };
};

test('new API key input renders as password by default with autocomplete off and a show toggle button', () => {
	const markup = renderWidget('');

	assert.match(markup, /<input[^>]*autoComplete="off"[^>]*type="password"/);
	assert.match(markup, /<button[^>]*aria-label="Show API key"[^>]*aria-pressed="false"/);
});

test('saved API key renders masked trailing preview in read-only mode with show toggle', () => {
	const markup = renderWidget('sk-123456abcd');

	assert.match(markup, /<input[^>]*readonly=""[^>]*type="text"[^>]*value="•••••••••abcd"/);
	assert.match(markup, /<button[^>]*aria-label="Show API key"[^>]*aria-pressed="false"/);
});

test('saved API key show/hide toggle reveals and re-masks the key, and delete resets to empty password input', () => {
	const harness = createHarness('sk-123456abcd');

	let markup = harness.render();
	assert.match(markup, /<input[^>]*readonly=""[^>]*type="text"[^>]*value="•••••••••abcd"/);
	assert.match(markup, /<button[^>]*aria-label="Show API key"[^>]*aria-pressed="false"/);

	markup = harness.clickToggle();
	assert.match(markup, /<input[^>]*readonly=""[^>]*type="text"[^>]*value="sk-123456abcd"/);
	assert.match(markup, /<button[^>]*aria-label="Hide API key"[^>]*aria-pressed="true"/);

	markup = harness.clickToggle();
	assert.match(markup, /<input[^>]*readonly=""[^>]*type="text"[^>]*value="•••••••••abcd"/);
	assert.match(markup, /<button[^>]*aria-label="Show API key"[^>]*aria-pressed="false"/);

	harness.clickToggle();
	markup = harness.clickDelete();
	assert.deepEqual(harness.changes, ['']);
	assert.match(markup, /<input[^>]*type="password"[^>]*value=""/);
	assert.doesNotMatch(markup, /readonly=""/);
	assert.match(markup, /<button[^>]*aria-label="Show API key"[^>]*aria-pressed="false"/);
});

test('clearing an editable revealed API key via change resets visibility to password mode', () => {
	const harness = createHarness('');
	harness.render();

	let markup = harness.changeInput('sk-new-secret');
	assert.match(markup, /<input[^>]*type="password"[^>]*value="sk-new-secret"/);

	markup = harness.clickToggle();
	assert.match(markup, /<input[^>]*type="text"[^>]*value="sk-new-secret"/);
	assert.match(markup, /<button[^>]*aria-label="Hide API key"[^>]*aria-pressed="true"/);

	markup = harness.changeInput('');
	assert.deepEqual(harness.changes, ['sk-new-secret', '']);
	assert.match(markup, /<input[^>]*type="password"[^>]*value=""/);
	assert.match(markup, /<button[^>]*aria-label="Show API key"[^>]*aria-pressed="false"/);
});
