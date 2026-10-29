// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Combobox. */

import React, { useState } from 'react';
import { Combobox, Field } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** The demo's suggestion set - env-var names. */
const ENV_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PINECONE_API_KEY', 'PINECONE_ENVIRONMENT', 'SLACK_BOT_TOKEN', 'DATABASE_URL'].map((name) => ({ value: name, label: name }));

/** Live demo: env-var name field, free-text or pick mode from the knob. */
const ComboboxDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [value, setValue] = useState<string | null>('OPENAI_API_KEY');
	let help = 'Pick one of the configured variables.';
	if (knobs.allowCustomValue) help = 'Pick a suggestion or type any name.';
	return (
		<div style={{ maxWidth: 320 }}>
			<Field label="API key variable" help={help}>
				<Combobox options={ENV_VARS} value={value} onChange={setValue} allowCustomValue={Boolean(knobs.allowCustomValue)} clearable={Boolean(knobs.clearable)} mono placeholder="Search variables" />
			</Field>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let attrs = '';
	if (knobs.allowCustomValue) attrs += '\n\t\tallowCustomValue';
	if (knobs.clearable) attrs += '\n\t\tclearable';
	return `import { Combobox, Field } from 'shell';

<Field label="API key variable">
	<Combobox
		options={envVars.map((name) => ({ value: name, label: name }))}
		value={variable}
		onChange={setVariable}${attrs}
		mono
	/>
</Field>`;
}

/** The Combobox gallery entry. */
export const comboboxEntry: IGalleryEntry = {
	id: 'combobox',
	name: 'Combobox',
	group: 'content',
	blurb: 'Text input with a filtered suggestion list. Pick mode for searchable pickers; free-text mode (allowCustomValue) for suggest-as-you-type fields like env-var names.',
	doc: 'Prefix matches rank first. Arrow keys open and move through the list, Enter chooses, Escape closes (or restores the committed text when already closed). Free-text mode commits whatever is typed on Enter or blur; pick mode reverts unmatched text.',
	knobs: [
		{ id: 'allowCustomValue', label: 'Free text', kind: 'boolean', defaultValue: true },
		{ id: 'clearable', label: 'Clearable', kind: 'boolean', defaultValue: true },
	],
	demo: ComboboxDemo,
	code: buildCode,
	props: [
		{ name: 'options', type: 'ISelectOption[]', dir: 'in', required: true, note: 'Options (pick mode) or suggestions (free-text mode).' },
		{ name: 'value', type: 'string | null', dir: 'in', required: true, note: 'The committed value.' },
		{ name: 'allowCustomValue', type: 'boolean', dir: 'in', note: 'Accept text that matches no option.' },
		{ name: 'clearable', type: 'boolean', dir: 'in', note: 'Show a clear button while there is a value.' },
		{ name: 'emptyText', type: 'string', dir: 'in', note: "Shown when nothing matches (pick mode). Default 'No matches'." },
		{ name: 'mono / small / placeholder / disabled / invalid / name / ariaLabel', type: '...', dir: 'in', note: 'Same as Select / InputField.' },
		{ name: 'onChange', type: '(value: string | null) => void', dir: 'out', required: true, note: 'Fired with the committed value; null when cleared.' },
		{ name: 'onInputChange', type: '(text: string) => void', dir: 'out', note: 'Every keystroke - e.g. fetch suggestions from a server.' },
	],
};
