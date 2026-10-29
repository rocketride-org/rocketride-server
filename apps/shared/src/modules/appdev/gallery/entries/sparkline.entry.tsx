// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Sparkline. */

import React from 'react';
import { Sparkline } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';
import { LATENCY, RUNS_BY_PIPELINE } from './dashboard-demo-data';

/** Live demo: sparklines in list rows beside their current value. */
const SparklineDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const rows = [...RUNS_BY_PIPELINE.series.map((series) => ({ name: series.label, values: series.values.filter((value): value is number => value !== null), unit: ' runs' })), { name: 'p95 latency', values: LATENCY, unit: ' ms' }];
	return (
		<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 140px 80px', gap: '10px 16px', alignItems: 'center', maxWidth: 420, fontSize: 13 }}>
			{rows.map((row) => (
				<React.Fragment key={row.name}>
					<span>{row.name}</span>
					<Sparkline values={row.values} label={`${row.name}, last 14 days`} area={Boolean(knobs.area)} height={Number(knobs.height)} />
					<span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
						{row.values[row.values.length - 1].toLocaleString('en-US')}
						{row.unit}
					</span>
				</React.Fragment>
			))}
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let extra = '';
	if (knobs.area) extra += ' area';
	if (Number(knobs.height) !== 32) extra += ` height={${Number(knobs.height)}}`;
	return `import { Sparkline } from 'shell';

<Sparkline values={dailyRuns} label="rag-pipeline, last 14 days"${extra} />`;
}

/** The Sparkline gallery entry. */
export const sparklineEntry: IGalleryEntry = {
	id: 'sparkline',
	name: 'Sparkline',
	group: 'dashboards',
	blurb: 'A word-sized trend with no axes, for a stat tile, a table cell or a list row. Stretches to its container; the latest point is accented.',
	doc: 'The line is de-emphasized and only the latest point wears the accent, so the eye lands on "now". To screen readers it is one image whose name is your `label` plus a generated summary ("10 to 14, low 10, high 14"). Use LineChart when readers need axes or values.',
	knobs: [
		{ id: 'area', label: 'Area', kind: 'boolean', defaultValue: false },
		{ id: 'height', label: 'Height', kind: 'number', defaultValue: 32 },
	],
	demo: SparklineDemo,
	code: buildCode,
	props: [
		{ name: 'values', type: 'number[]', dir: 'in', required: true, note: 'Oldest first.' },
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'What the trend is of; the summary is appended.' },
		{ name: 'height', type: 'number', dir: 'in', note: 'Default 32.' },
		{ name: 'area', type: 'boolean', dir: 'in', note: 'Wash under the line.' },
		{ name: 'formatValue', type: '(value: number) => string', dir: 'in', note: 'For the spoken summary.' },
	],
};
