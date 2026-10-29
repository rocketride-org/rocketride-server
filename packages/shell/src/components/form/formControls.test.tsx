// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Markup-level checks for the form controls: rendered on the server (no DOM
 * needed) and inspected for the labelling and ARIA wiring screen readers
 * depend on. Interaction is covered by the pure-helper tests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Field } from '../field/Field';
import { InputField } from '../input-field/InputField';
import { Checkbox, Switch } from './Checkbox';
import { Combobox, displayTextFor } from './Combobox';
import { RadioGroup } from './RadioGroup';
import { Select } from './Select';
import { Slider, sliderPercent } from './Slider';
import { TextArea } from './TextArea';
import { IconButton } from '../icon-button/IconButton';

/** Reads one attribute of the first tag matching a selector-ish prefix. */
function attr(html: string, tagStart: string, name: string): string | null {
	const tagIndex = html.indexOf(tagStart);
	if (tagIndex < 0) return null;
	const tag = html.slice(tagIndex, html.indexOf('>', tagIndex));
	const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
	if (!match) return null;
	return match[1];
}

const noop = (): void => undefined;
const options = [
	{ value: 'gpt', label: 'GPT' },
	{ value: 'claude', label: 'Claude' },
];

test('Field labels the control, links help text, and marks required', () => {
	const html = renderToStaticMarkup(
		<Field label="Endpoint" help="Full URL" required>
			<InputField />
		</Field>
	);
	const inputId = attr(html, '<input', 'id');
	assert.ok(inputId);
	assert.equal(attr(html, '<label', 'for'), inputId);
	const describedBy = attr(html, '<input', 'aria-describedby');
	assert.ok(describedBy && html.includes(`id="${describedBy}"`));
	assert.ok(html.includes('required=""'));
	assert.ok(html.includes('rr-field__label--required'));
});

test('Field error marks the control invalid and replaces the help text', () => {
	const html = renderToStaticMarkup(
		<Field label="Endpoint" help="Full URL" error="Not a URL">
			<InputField />
		</Field>
	);
	assert.equal(attr(html, '<input', 'aria-invalid'), 'true');
	assert.ok(html.includes('Not a URL'));
	assert.ok(!html.includes('Full URL'));
});

test('InputField outside a Field is unchanged', () => {
	const html = renderToStaticMarkup(<InputField placeholder="x" />);
	assert.equal(attr(html, '<input', 'id'), null);
	assert.equal(attr(html, '<input', 'aria-invalid'), null);
});

test('Select renders a closed select-only combobox labelled by its Field', () => {
	const html = renderToStaticMarkup(
		<Field label="Model">
			<Select options={options} value={null} onChange={noop} placeholder="Pick one" />
		</Field>
	);
	assert.equal(attr(html, '<button', 'role'), 'combobox');
	assert.equal(attr(html, '<button', 'aria-haspopup'), 'listbox');
	assert.equal(attr(html, '<button', 'aria-expanded'), 'false');
	assert.equal(attr(html, '<label', 'for'), attr(html, '<button', 'id'));
	assert.ok(html.includes('Pick one'));
});

test('Select shows the selected label and carries a hidden form value', () => {
	const html = renderToStaticMarkup(<Select options={options} value="claude" onChange={noop} name="model" ariaLabel="Model" />);
	assert.ok(html.includes('Claude'));
	assert.equal(attr(html, '<input type="hidden"', 'value'), 'claude');
});

test('Combobox is an editable combobox showing the selected label', () => {
	const html = renderToStaticMarkup(<Combobox options={options} value="gpt" onChange={noop} ariaLabel="Model" />);
	assert.equal(attr(html, '<input', 'role'), 'combobox');
	assert.equal(attr(html, '<input', 'aria-autocomplete'), 'list');
	assert.equal(attr(html, '<input', 'value'), 'GPT');
});

test('displayTextFor shows labels for options and raw text for custom values', () => {
	assert.equal(displayTextFor(options, 'claude'), 'Claude');
	assert.equal(displayTextFor(options, 'MY_VAR'), 'MY_VAR');
	assert.equal(displayTextFor(options, null), '');
});

test('Checkbox links its description; Switch has role="switch"', () => {
	const checkbox = renderToStaticMarkup(<Checkbox checked onChange={noop} label="Stream" description="Send tokens as they arrive" />);
	const describedBy = attr(checkbox, '<input', 'aria-describedby');
	assert.ok(describedBy && checkbox.includes(`id="${describedBy}"`));

	const toggle = renderToStaticMarkup(<Switch checked={false} onChange={noop} label="Auto-run" />);
	assert.equal(attr(toggle, '<input', 'role'), 'switch');
});

test('RadioGroup inside a Field is labelled by the Field label', () => {
	const html = renderToStaticMarkup(
		<Field label="Region">
			<RadioGroup
				options={[
					{ value: 'us', label: 'US' },
					{ value: 'eu', label: 'EU' },
				]}
				value="eu"
				onChange={noop}
			/>
		</Field>
	);
	assert.equal(attr(html, '<div role="radiogroup"', 'aria-labelledby'), attr(html, '<label', 'id'));
	assert.ok(html.includes('checked=""'));
});

test('Slider exposes its range and value text', () => {
	const html = renderToStaticMarkup(<Slider value={0.7} min={0} max={2} step={0.1} onChange={noop} ariaLabel="Temperature" formatValue={(value) => value.toFixed(1)} />);
	assert.equal(attr(html, '<input', 'type'), 'range');
	assert.equal(attr(html, '<input', 'aria-valuetext'), '0.7');
	assert.equal(sliderPercent(0.7, 0, 2), 35);
	assert.equal(sliderPercent(5, 0, 2), 100);
	assert.equal(sliderPercent(1, 1, 1), 0);
});

test('TextArea is Field-aware', () => {
	const html = renderToStaticMarkup(
		<Field label="Prompt" error="Required">
			<TextArea />
		</Field>
	);
	assert.equal(attr(html, '<textarea', 'aria-invalid'), 'true');
	assert.equal(attr(html, '<label', 'for'), attr(html, '<textarea', 'id'));
});

test('IconButton always has an accessible name', () => {
	const html = renderToStaticMarkup(
		<IconButton label="Delete pipeline" pressed={false}>
			<span>x</span>
		</IconButton>
	);
	assert.equal(attr(html, '<button', 'aria-label'), 'Delete pipeline');
	assert.equal(attr(html, '<button', 'aria-pressed'), 'false');
});
