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

// A closed MUI Select renders its Menu through a Modal that returns null, and
// react-dom/server cannot render a portal, so the option markup never reaches
// renderToStaticMarkup. These tests call the widget as a plain function and
// inspect the element tree instead.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Children, type ReactElement } from 'react';

import SelectWidget from './SelectWidget';

type ElementWithProps = ReactElement<Record<string, unknown>>;

const SelectForTest = SelectWidget as unknown as (props: Record<string, unknown>) => ElementWithProps;

const ENUM_OPTIONS = [
	{ value: 'deals', label: 'Deals (27)' },
	{ value: 'persons', label: 'Persons (18)' },
	{ value: 'notes', label: 'Notes (11)' },
];

// The middle option deliberately has no help text: the icon must be driven by
// the presence of a description, not by the field carrying any at all.
const ENUM_DESCRIPTIONS = ['Deals and their products.', '', 'Notes and their comments.'];

const renderWidget = (overrides: Record<string, unknown> = {}) =>
	SelectForTest({
		schema: { type: 'array', description: 'Which groups this node publishes.' },
		id: 'root_toolGroups',
		name: 'toolGroups',
		label: 'Tool groups',
		hideLabel: false,
		required: false,
		disabled: false,
		readonly: false,
		hideError: false,
		autofocus: false,
		multiple: true,
		value: ['deals', 'notes'],
		options: { enumOptions: ENUM_OPTIONS, enumDescriptions: ENUM_DESCRIPTIONS },
		onChange: () => undefined,
		onBlur: () => undefined,
		onFocus: () => undefined,
		rawErrors: [],
		errorSchema: {},
		uiSchema: {},
		registry: {},
		formContext: {},
		...overrides,
	});

const menuItemsOf = (widget: ElementWithProps) => Children.toArray(widget.props.children) as ElementWithProps[];

const renderValueOf = (widget: ElementWithProps) => (widget.props.SelectProps as { renderValue: (selected: unknown) => string }).renderValue;

test('the collapsed multi-select shows plain labels rather than the options themselves', () => {
	// Without an explicit renderValue MUI composes the closed display out of each
	// selected MenuItem's children, which would stamp an info icon into the field.
	assert.equal(renderValueOf(renderWidget())(['0', '2']), 'Deals (27), Notes (11)');
});

test('an unset select displays nothing rather than the first option', () => {
	const renderValue = renderValueOf(renderWidget({ multiple: false, value: undefined }));

	assert.equal(renderValue(''), '');
	assert.equal(renderValue([]), '');
});

test('the overflow title covers every selection, not just the first', () => {
	const slotProps = renderWidget().props.slotProps as { input: { title?: string } };

	assert.equal(slotProps.input.title, 'Deals (27), Notes (11)');
});

test('options carry their help text through aria-describedby', () => {
	const [deals, persons, notes] = menuItemsOf(renderWidget());

	assert.equal(deals.props['aria-describedby'], 'root_toolGroups__option_0__description');
	assert.equal(notes.props['aria-describedby'], 'root_toolGroups__option_2__description');
	assert.equal(persons.props['aria-describedby'], undefined);
});

test('an option names itself after its label so the hidden help cannot leak into it', () => {
	assert.equal(menuItemsOf(renderWidget())[0].props['aria-label'], 'Deals (27)');
});

test('only options that were given help text render an icon', () => {
	const [deals, persons] = menuItemsOf(renderWidget());

	assert.equal(Children.toArray(deals.props.children).length, 2);
	assert.equal(Children.toArray(persons.props.children).length, 1);
});

test('a field with no option help renders exactly as it did before', () => {
	const widget = renderWidget({ options: { enumOptions: ENUM_OPTIONS } });

	for (const option of menuItemsOf(widget)) {
		assert.equal(option.props['aria-describedby'], undefined);
		assert.equal(Children.toArray(option.props.children).length, 1);
	}
});
