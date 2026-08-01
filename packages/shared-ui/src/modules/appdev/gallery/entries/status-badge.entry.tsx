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
// STATUS BADGE — GALLERY ENTRY
// =============================================================================

/** Gallery entry for StatusBadge / StatusDot semantic state indicators. */

import React from 'react';
import { StatusBadge, StatusDot } from '../../../../components/status-badge/StatusBadge';
import type { StatusVariant } from '../../../../components/status-badge/StatusBadge';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: the knob-driven badge + dot beside the full variant row. */
const StatusBadgeDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
		<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
			<StatusBadge variant={knobs.variant as StatusVariant}>{String(knobs.label)}</StatusBadge>
			<StatusDot variant={knobs.variant as StatusVariant} />
		</div>
		{/* All five variants for reference, independent of the knobs */}
		<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
			<StatusBadge variant="success">Connected</StatusBadge>
			<StatusBadge variant="info">Queued</StatusBadge>
			<StatusBadge variant="warning">Degraded</StatusBadge>
			<StatusBadge variant="error">Failed</StatusBadge>
			<StatusBadge variant="muted">Idle</StatusBadge>
		</div>
	</div>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => `import { StatusBadge, StatusDot } from 'shared';

<StatusBadge variant="${String(knobs.variant)}">${String(knobs.label)}</StatusBadge>
<StatusDot variant="${String(knobs.variant)}" />`;

/** The StatusBadge / StatusDot gallery entry. */
export const statusBadgeEntry: IGalleryEntry = {
	id: 'status-badge',
	name: 'StatusBadge / StatusDot',
	group: 'content',
	blurb: 'Dot + label pill in five semantic variants (success / info / warning / error / muted), plus the bare StatusDot for inline state.',
	knobs: [
		{ id: 'variant', label: 'Variant', kind: 'select', options: ['success', 'info', 'warning', 'error', 'muted'], defaultValue: 'success' },
		{ id: 'label', label: 'Label', kind: 'text', defaultValue: 'Connected' },
	],
	demo: StatusBadgeDemo,
	code: buildCode,
	props: [
		{ name: 'variant', type: "'success' | 'info' | 'warning' | 'error' | 'muted'", dir: 'in', required: true, note: 'Semantic state variant - selects the palette for dot, text, and tinted pill.' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'StatusBadge only - label content.' },
	],
};
