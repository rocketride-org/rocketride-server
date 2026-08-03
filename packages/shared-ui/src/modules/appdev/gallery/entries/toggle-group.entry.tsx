// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// TOGGLE GROUP — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock ToggleGroup segmented control. */

import React, { useState } from 'react';
import { ToggleGroup } from '../../../../components/toggle-group/ToggleGroup';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** The demo's fixed option set - a typical time-range switch. */
const DEMO_OPTIONS = [
	{ id: 'hour', label: 'Hour' },
	{ id: 'day', label: 'Day' },
	{ id: 'week', label: 'Week' },
];

/** Live demo: single- or multi-select ToggleGroup with local selection state. */
const ToggleGroupDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	// Both modes keep their own selection so flipping the knob preserves each
	const [value, setValue] = useState('day');
	const [values, setValues] = useState<string[]>(['hour', 'day']);

	if (knobs.multi) {
		return (
			<ToggleGroup
				multi
				options={DEMO_OPTIONS}
				values={values}
				onToggle={(id) => setValues((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]))}
				disabled={Boolean(knobs.disabled)}
			/>
		);
	}
	return (
		<ToggleGroup
			options={DEMO_OPTIONS}
			value={value}
			onChange={setValue}
			disabled={Boolean(knobs.disabled)}
		/>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const disabledAttr = knobs.disabled ? '\n\tdisabled' : '';
	if (knobs.multi) {
		return `import { ToggleGroup } from 'shell';

<ToggleGroup
	multi
	options={[{ id: 'hour', label: 'Hour' }, { id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }]}
	values={ranges}
	onToggle={toggleRange}${disabledAttr}
/>`;
	}
	return `import { ToggleGroup } from 'shell';

<ToggleGroup
	options={[{ id: 'hour', label: 'Hour' }, { id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }]}
	value={range}
	onChange={setRange}${disabledAttr}
/>`;
};

/** The ToggleGroup gallery entry. */
export const toggleGroupEntry: IGalleryEntry = {
	id: 'toggle-group',
	name: 'ToggleGroup',
	group: 'content',
	blurb: 'Segmented control for time ranges and mode switches - single-select by default, multi-select via the discriminated multi prop. Built on the stock small Button.',
	knobs: [
		{ id: 'multi', label: 'Multi-select', kind: 'boolean', defaultValue: false },
		{ id: 'disabled', label: 'Disabled', kind: 'boolean', defaultValue: false },
	],
	demo: ToggleGroupDemo,
	code: buildCode,
	props: [
		{ name: 'options', type: '{ id: T; label: string }[]', dir: 'in', required: true, note: 'Ordered list of options.' },
		{ name: 'value', type: 'T', dir: 'in', required: true, note: 'Single-select mode - currently selected option id.' },
		{ name: 'multi', type: 'true', dir: 'in', note: 'Opt into multi-select (switches the prop set to values/onToggle).' },
		{ name: 'values', type: 'T[]', dir: 'in', required: true, note: 'Multi-select mode - currently active option ids.' },
		{ name: 'wrap', type: 'boolean', dir: 'in', note: 'Flow options onto multiple rows when they exceed the available width.' },
		{ name: 'disabled', type: 'boolean', dir: 'in', note: 'Disable the entire group - every option renders dimmed and inert.' },
		{ name: 'onChange', type: '(id: T) => void', dir: 'out', required: true, note: 'Single-select mode - fired with the newly selected option id.' },
		{ name: 'onToggle', type: '(id: T) => void', dir: 'out', required: true, note: 'Multi-select mode - fired with the option id whose active state the click flips.' },
	],
};
