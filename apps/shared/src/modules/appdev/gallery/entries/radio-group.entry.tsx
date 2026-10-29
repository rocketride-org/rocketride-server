// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for RadioGroup. */

import React, { useState } from 'react';
import { Field, RadioGroup } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** The demo's fixed options. */
const REGIONS = [
	{ value: 'us', label: 'United States', description: 'us-east-1' },
	{ value: 'eu', label: 'Europe', description: 'eu-central-1' },
	{ value: 'ap', label: 'Asia Pacific', description: 'ap-southeast-2', disabled: true },
];

/** Live demo: a region picker inside a Field. */
const RadioGroupDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [region, setRegion] = useState<string | null>('us');
	return (
		<Field label="Region">
			<RadioGroup options={REGIONS} value={region} onChange={setRegion} horizontal={Boolean(knobs.horizontal)} disabled={Boolean(knobs.disabled)} />
		</Field>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let attrs = '';
	if (knobs.horizontal) attrs += ' horizontal';
	if (knobs.disabled) attrs += ' disabled';
	return `import { Field, RadioGroup } from 'shell';

<Field label="Region">
	<RadioGroup
		options={[{ value: 'us', label: 'United States' }, { value: 'eu', label: 'Europe' }]}
		value={region}
		onChange={setRegion}${attrs}
	/>
</Field>`;
}

/** The RadioGroup gallery entry. */
export const radioGroupEntry: IGalleryEntry = {
	id: 'radio-group',
	name: 'RadioGroup',
	group: 'content',
	blurb: 'One choice from a short, always-visible set (2-5 options). Native radios: arrow keys move the selection. Use Select for longer lists.',
	knobs: [
		{ id: 'horizontal', label: 'Horizontal', kind: 'boolean', defaultValue: false },
		{ id: 'disabled', label: 'Disabled', kind: 'boolean', defaultValue: false },
	],
	demo: RadioGroupDemo,
	code: buildCode,
	props: [
		{ name: 'options', type: '{ value: T; label; description?; disabled? }[]', dir: 'in', required: true, note: 'The options, in display order.' },
		{ name: 'value', type: 'T | null', dir: 'in', required: true, note: 'The selected value.' },
		{ name: 'horizontal', type: 'boolean', dir: 'in', note: 'Lay options out in a row.' },
		{ name: 'disabled', type: 'boolean', dir: 'in', note: 'Disable every option.' },
		{ name: 'name', type: 'string', dir: 'in', note: 'Form field name; generated when omitted.' },
		{ name: 'ariaLabel', type: 'string', dir: 'in', note: 'Accessible name when not inside a Field.' },
		{ name: 'onChange', type: '(value: T) => void', dir: 'out', required: true, note: 'Fired with the newly selected value.' },
	],
};
