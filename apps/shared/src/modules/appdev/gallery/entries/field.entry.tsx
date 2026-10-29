// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Field, the label / control / help-or-error form row. */

import React, { useState } from 'react';
import { Field, InputField } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: one Field around an InputField, error and required driven by knobs. */
const FieldDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [endpoint, setEndpoint] = useState('https://api.example.com');
	let error: string | undefined;
	if (knobs.error) error = 'Must start with https://';

	return (
		<div style={{ maxWidth: 360 }}>
			<Field label={String(knobs.label)} help="The full URL of the service." error={error} required={Boolean(knobs.required)} disabled={Boolean(knobs.disabled)}>
				<InputField value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
			</Field>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let attrs = '';
	if (knobs.required) attrs += ' required';
	if (knobs.error) attrs += ' error={endpointError}';
	if (knobs.disabled) attrs += ' disabled';
	return `import { Field, InputField } from 'shell';

<Field label="${String(knobs.label)}" help="The full URL of the service."${attrs}>
	<InputField value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
</Field>`;
}

/** The Field gallery entry. */
export const fieldEntry: IGalleryEntry = {
	id: 'field',
	name: 'Field / useField',
	group: 'content',
	blurb: 'Labelled form row. Wires the id, description and invalid/required state into the stock control inside it - no manual aria wiring.',
	doc: 'Every stock control (InputField, TextArea, Select, Combobox, Slider, RadioGroup) reads the enclosing Field through context. Passing `error` marks the control invalid and swaps the help text for the message. Custom controls call `useFieldControl(props)`-style wiring through `useField()`.',
	knobs: [
		{ id: 'label', label: 'Label', kind: 'text', defaultValue: 'Endpoint' },
		{ id: 'required', label: 'Required', kind: 'boolean', defaultValue: true },
		{ id: 'error', label: 'Show error', kind: 'boolean', defaultValue: false },
		{ id: 'disabled', label: 'Disabled', kind: 'boolean', defaultValue: false },
	],
	demo: FieldDemo,
	code: buildCode,
	props: [
		{ name: 'label', type: 'ReactNode', dir: 'in', required: true, note: 'Visible label.' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'The control.' },
		{ name: 'help', type: 'ReactNode', dir: 'in', note: 'Hint under the control; hidden while an error shows.' },
		{ name: 'error', type: 'ReactNode', dir: 'in', note: 'Error message; present = the control is marked invalid.' },
		{ name: 'required', type: 'boolean', dir: 'in', note: 'Adds the asterisk and required / aria-required.' },
		{ name: 'disabled', type: 'boolean', dir: 'in', note: 'Disables the control.' },
		{ name: 'id', type: 'string', dir: 'in', note: 'Control id; generated when omitted.' },
	],
	sections: [
		{
			label: 'Hooks',
			rows: [{ name: 'useField()', type: 'IFieldContext | null', dir: 'out', note: 'The enclosing Field: controlId, labelId, describedBy, isInvalid, isRequired, isDisabled.' }],
		},
	],
};
