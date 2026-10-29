// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Meter. */

import React from 'react';
import { Meter } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: plan usage with the knob driving the token meter. */
const MeterDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const used = Number(knobs.used);
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 360 }}>
			<Meter label="Tokens this month" value={used * 100000} max={10000000} hint="Resets Nov 1" />
			<Meter label="Concurrent runs" value={3} max={10} />
			<Meter label="Seats" value={20} max={20} hint="Upgrade for more seats" />
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	return `import { Meter } from 'shell';

<Meter label="Tokens this month" value={${Number(knobs.used) * 100000}} max={10_000_000} hint="Resets Nov 1" />`;
}

/** The Meter gallery entry. */
export const meterEntry: IGalleryEntry = {
	id: 'meter',
	name: 'Meter',
	group: 'dashboards',
	blurb: 'An amount against a limit: plan quota, tokens this month, seats. The fill turns warning at 80% and error at 95%, with a status line so severity is never color alone.',
	doc: 'Use ProgressBar for work that completes; use a Meter for a level that can sit anywhere. Thresholds are fractions of `max` (`warningAt`, `dangerAt`). The track is a tint of the fill color, so the state reads across the whole bar. `role="meter"` with a spoken value ("8.2M of 10M, near limit").',
	knobs: [{ id: 'used', label: 'Percent used', kind: 'number', defaultValue: 62 }],
	demo: MeterDemo,
	code: buildCode,
	props: [
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'What is measured.' },
		{ name: 'value', type: 'number', dir: 'in', required: true, note: 'Current amount.' },
		{ name: 'max', type: 'number', dir: 'in', required: true, note: 'The limit.' },
		{ name: 'formatValue', type: '(value: number) => string', dir: 'in', note: 'Default formatCompact.' },
		{ name: 'warningAt / dangerAt', type: 'number', dir: 'in', note: 'Fractions of max. Default 0.8 / 0.95.' },
		{ name: 'hint', type: 'ReactNode', dir: 'in', note: 'Line under the bar.' },
	],
};
