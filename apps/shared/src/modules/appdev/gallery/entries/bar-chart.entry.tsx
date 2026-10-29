// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for BarChart. */

import React from 'react';
import { BarChart } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';
import { TOKENS_BY_MODEL } from './dashboard-demo-data';

/** Formats millions of tokens. */
function formatMillions(value: number): string {
	return `${value.toFixed(1)}M`;
}

/** Live demo: tokens per model per day, grouped or stacked. */
const BarChartDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ maxWidth: 560 }}>
		<BarChart data={TOKENS_BY_MODEL} label="Tokens per day by model" stacked={Boolean(knobs.stacked)} formatValue={formatMillions} formatTick={(value) => `${value}M`} />
	</div>
);

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let extra = '';
	if (knobs.stacked) extra = '\n\tstacked';
	return `import { BarChart } from 'shell';

<BarChart
	data={tokensByModel}
	label="Tokens per day by model"${extra}
	formatValue={(value) => \`\${value.toFixed(1)}M\`}
/>`;
}

/** The BarChart gallery entry. */
export const barChartEntry: IGalleryEntry = {
	id: 'bar-chart',
	name: 'BarChart',
	group: 'dashboards',
	blurb: 'Compare magnitudes across categories, grouped or stacked. Columns are capped at 24px with a rounded data end, a 2px gap between touching bars, and one zero baseline.',
	doc: 'Grouped bars compare series side by side; `stacked` shows parts of a total (positive values only). Hover or arrow-key a category to read every series. Same data shape and palette rules as LineChart.',
	knobs: [{ id: 'stacked', label: 'Stacked', kind: 'boolean', defaultValue: false }],
	demo: BarChartDemo,
	code: buildCode,
	props: [
		{ name: 'data', type: 'IChartData', dir: 'in', required: true, note: 'Same shape as LineChart.' },
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'Accessible name.' },
		{ name: 'stacked', type: 'boolean', dir: 'in', note: 'One column per category.' },
		{ name: 'height', type: 'number', dir: 'in', note: 'Default 220.' },
		{ name: 'showLegend', type: 'boolean', dir: 'in', note: 'Default: two or more series.' },
		{ name: 'formatValue / formatTick', type: '(value: number) => string', dir: 'in', note: 'Tooltip values / y-axis ticks.' },
	],
};
