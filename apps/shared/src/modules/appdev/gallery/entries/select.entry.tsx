// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Select. */

import React, { useState } from 'react';
import { Field, Select } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** The demo's fixed options. */
const MODELS = [
	{ value: 'claude-opus', label: 'Claude Opus', description: 'Most capable' },
	{ value: 'claude-sonnet', label: 'Claude Sonnet', description: 'Balanced' },
	{ value: 'claude-haiku', label: 'Claude Haiku', description: 'Fastest' },
	{ value: 'gpt', label: 'GPT', description: 'OpenAI' },
	{ value: 'gemini', label: 'Gemini', description: 'Google', disabled: true },
	{ value: 'llama', label: 'Llama', description: 'Self-hosted' },
];

/** Live demo: a model picker inside a Field. */
const SelectDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [model, setModel] = useState<string | null>(null);
	let error: string | undefined;
	if (knobs.error) error = 'Pick a model to continue.';

	return (
		<div style={{ maxWidth: 300 }}>
			<Field label="Model" error={error}>
				<Select options={MODELS} value={model} onChange={setModel} placeholder="Choose a model" small={Boolean(knobs.small)} disabled={Boolean(knobs.disabled)} />
			</Field>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let attrs = '';
	if (knobs.small) attrs += ' small';
	if (knobs.disabled) attrs += ' disabled';
	return `import { Field, Select } from 'shell';

<Field label="Model">
	<Select
		options={[{ value: 'claude-opus', label: 'Claude Opus', description: 'Most capable' }, ...]}
		value={model}
		onChange={setModel}
		placeholder="Choose a model"${attrs}
	/>
</Field>`;
}

/** The Select gallery entry. */
export const selectEntry: IGalleryEntry = {
	id: 'select',
	name: 'Select',
	group: 'content',
	blurb: 'Themed single-select dropdown with descriptions and icons. WAI-ARIA select-only combobox: arrows, Home/End, typeahead, Enter, Escape.',
	doc: 'Focus stays on the trigger; the open list is announced with aria-activedescendant. Typing while closed changes the value like a native select. Pass `name` to submit the value with a native form.',
	knobs: [
		{ id: 'small', label: 'Small', kind: 'boolean', defaultValue: false },
		{ id: 'error', label: 'Show error', kind: 'boolean', defaultValue: false },
		{ id: 'disabled', label: 'Disabled', kind: 'boolean', defaultValue: false },
	],
	demo: SelectDemo,
	code: buildCode,
	props: [
		{ name: 'options', type: 'ISelectOption<T>[]', dir: 'in', required: true, note: '{ value, label, description?, icon?, disabled? }.' },
		{ name: 'value', type: 'T | null', dir: 'in', required: true, note: 'The selected value.' },
		{ name: 'placeholder', type: 'string', dir: 'in', note: 'Shown while nothing is selected.' },
		{ name: 'small', type: 'boolean', dir: 'in', note: 'Compact 26px trigger.' },
		{ name: 'invalid', type: 'boolean', dir: 'in', note: 'Mark invalid (a Field error does this for you).' },
		{ name: 'disabled', type: 'boolean', dir: 'in', note: 'Disable the control.' },
		{ name: 'name', type: 'string', dir: 'in', note: 'Renders a hidden input carrying the value.' },
		{ name: 'ariaLabel', type: 'string', dir: 'in', note: 'Accessible name when not inside a Field.' },
		{ name: 'onChange', type: '(value: T) => void', dir: 'out', required: true, note: 'Fired with the newly chosen value.' },
	],
};
