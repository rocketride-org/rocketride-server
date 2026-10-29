// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Slider. */

import React, { useState } from 'react';
import { Field, Slider } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Formats a temperature to one decimal. */
function formatTemperature(value: number): string {
	return value.toFixed(1);
}

/** Live demo: a temperature slider inside a Field. */
const SliderDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [temperature, setTemperature] = useState(0.7);
	return (
		<div style={{ maxWidth: 320 }}>
			<Field label="Temperature" help="Lower is more deterministic.">
				<Slider value={temperature} onChange={setTemperature} min={0} max={2} step={0.1} formatValue={formatTemperature} showValue={Boolean(knobs.showValue)} disabled={Boolean(knobs.disabled)} />
			</Field>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let attrs = '';
	if (!knobs.showValue) attrs += ' showValue={false}';
	if (knobs.disabled) attrs += ' disabled';
	return `import { Field, Slider } from 'shell';

<Field label="Temperature">
	<Slider value={temperature} onChange={setTemperature} min={0} max={2} step={0.1} formatValue={(v) => v.toFixed(1)}${attrs} />
</Field>`;
}

/** The Slider gallery entry. */
export const sliderEntry: IGalleryEntry = {
	id: 'slider',
	name: 'Slider',
	group: 'content',
	blurb: 'Number from a bounded range - temperature, top-k, overlap. Native range input (full keyboard and touch support) with an optional value readout.',
	knobs: [
		{ id: 'showValue', label: 'Show value', kind: 'boolean', defaultValue: true },
		{ id: 'disabled', label: 'Disabled', kind: 'boolean', defaultValue: false },
	],
	demo: SliderDemo,
	code: buildCode,
	props: [
		{ name: 'value', type: 'number', dir: 'in', required: true, note: 'Current value.' },
		{ name: 'min / max / step', type: 'number', dir: 'in', note: 'Range and step. Defaults 0 / 100 / 1.' },
		{ name: 'showValue', type: 'boolean', dir: 'in', note: 'Show the value beside the track. Default true.' },
		{ name: 'formatValue', type: '(value: number) => string', dir: 'in', note: 'Formats the readout and the screen-reader value text.' },
		{ name: 'disabled', type: 'boolean', dir: 'in', note: 'Disable the slider.' },
		{ name: 'ariaLabel', type: 'string', dir: 'in', note: 'Accessible name when not inside a Field.' },
		{ name: 'onChange', type: '(value: number) => void', dir: 'out', required: true, note: 'Fired while dragging and on key presses.' },
	],
};
