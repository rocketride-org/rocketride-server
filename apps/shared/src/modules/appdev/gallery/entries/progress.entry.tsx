// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for ProgressBar and Spinner. */

import React from 'react';
import { ProgressBar, Spinner } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: determinate, indeterminate and spinner. */
const ProgressDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	let value: number | undefined = Number(knobs.value);
	if (knobs.indeterminate) value = undefined;
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 360 }}>
			<ProgressBar label="Uploading dataset.csv" value={value} showLabel tone={knobs.tone as 'accent' | 'success' | 'warning' | 'error'} />
			<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
				<Spinner label="Loading runs" size="sm" />
				<Spinner label="Loading runs" />
				<Spinner label="Loading runs" size="lg" />
			</div>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let valueAttr = ` value={${Number(knobs.value)}}`;
	if (knobs.indeterminate) valueAttr = '';
	return `import { ProgressBar, Spinner } from 'shell';

<ProgressBar label="Uploading dataset.csv"${valueAttr} showLabel />
<Spinner label="Loading runs" />`;
}

/** The progress gallery entry. */
export const progressEntry: IGalleryEntry = {
	id: 'progress',
	name: 'ProgressBar / Spinner',
	group: 'content',
	blurb: 'Work in progress. ProgressBar is determinate with a value and indeterminate without; Spinner is for short, unmeasured waits. Both are named progressbars.',
	knobs: [
		{ id: 'value', label: 'Value', kind: 'number', defaultValue: 62 },
		{ id: 'indeterminate', label: 'Indeterminate', kind: 'boolean', defaultValue: false },
		{ id: 'tone', label: 'Tone', kind: 'select', options: ['accent', 'success', 'warning', 'error'], defaultValue: 'accent' },
	],
	demo: ProgressDemo,
	code: buildCode,
	props: [
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'Accessible name; shown with showLabel.' },
		{ name: 'value', type: 'number', dir: 'in', note: 'Progress; omit for indeterminate.' },
		{ name: 'min / max', type: 'number', dir: 'in', note: 'Range. Default 0 / 100.' },
		{ name: 'showLabel', type: 'boolean', dir: 'in', note: 'Label and value above the bar.' },
		{ name: 'formatValue', type: '(value, percent) => string', dir: 'in', note: 'Shown and spoken value. Default whole percent.' },
		{ name: 'tone', type: "'accent' | 'success' | 'warning' | 'error'", dir: 'in', note: 'Bar color.' },
		{ name: 'Spinner: label / size', type: "string / 'sm' | 'md' | 'lg'", dir: 'in', note: "Default 'Loading' / md." },
	],
};
