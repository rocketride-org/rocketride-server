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
// FORMATTERS — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock formatBytes / formatDate / formatDuration. */

import React from 'react';
import { formatBytes, formatDate, formatDuration } from 'shell';
import { commonStyles } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Row layout: input expression on the left, formatted output on the right. */
const ROW_STYLE: React.CSSProperties = {
	display: 'flex',
	alignItems: 'baseline',
	gap: 16,
	padding: '4px 0',
};

/** Live demo: all three formatters over the knob-driven number. */
const FormattersDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const value = Number(knobs.value);
	// One fixed ISO instant so formatDate output is stable while knobs change
	const iso = new Date().toISOString();
	return (
		<div>
			<div style={ROW_STYLE}>
				<span style={commonStyles.fontMono}>formatBytes({value})</span>
				<span>{formatBytes(value)}</span>
			</div>
			<div style={ROW_STYLE}>
				<span style={commonStyles.fontMono}>formatDuration({value})</span>
				<span>{formatDuration(value)}</span>
			</div>
			<div style={ROW_STYLE}>
				<span style={commonStyles.fontMono}>formatDate(now)</span>
				<span>{formatDate(iso)}</span>
			</div>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => `import { formatBytes, formatDate, formatDuration } from 'shell';

formatBytes(${Number(knobs.value)});      // '${formatBytes(Number(knobs.value))}'
formatDuration(${Number(knobs.value)});   // '${formatDuration(Number(knobs.value))}'
formatDate(run.finishedAt);   // 'Jun 12, 4:02 PM'`;

/** The Formatters gallery entry. */
export const formattersEntry: IGalleryEntry = {
	id: 'formatters',
	name: 'Formatters',
	group: 'utils',
	blurb: 'The stock display formatters: human byte sizes, short localized datetimes, and compact durations - the one vocabulary for numbers across every view.',
	doc: `Use these instead of hand-rolled \`toFixed\`/\`toLocaleString\` calls so sizes, dates, and durations read identically everywhere — grids (\`autoFormatter\` uses the same treatments), tiles, detail panels, and status lines.`,
	knobs: [
		{ id: 'value', label: 'Value (bytes / ms)', kind: 'number', defaultValue: 1536000 },
	],
	demo: FormattersDemo,
	code: buildCode,
	propsLabel: 'Functions',
	props: [
		{ name: 'formatBytes', type: '(bytes: number) => string', dir: 'in', note: "Human byte size, e.g. 2048 -> '2.0 KB'." },
		{ name: 'formatDate', type: '(iso: string) => string', dir: 'in', note: "Short localized datetime, e.g. 'Jun 12, 4:02 PM'." },
		{ name: 'formatDuration', type: '(ms: number) => string', dir: 'in', note: "Compact duration, e.g. 90000 -> '1m 30s'." },
	],
};
