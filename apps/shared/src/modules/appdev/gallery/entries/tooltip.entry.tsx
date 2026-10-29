// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Tooltip. */

import React from 'react';
import { Button, Tooltip } from 'shell';
import type { OverlayPlacement } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a hint on a text button and on a status label. */
const TooltipDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const placement = knobs.placement as OverlayPlacement;
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
			<Tooltip content={String(knobs.content)} placement={placement}>
				<button type="button" className="rr-btn rr-btn--ghost">
					Run
				</button>
			</Tooltip>
			<Tooltip content="Last run 4 minutes ago" placement={placement}>
				<span tabIndex={0} className="rr-badge rr-badge--success">
					<span className="rr-dot rr-dot--success" />
					Healthy
				</span>
			</Tooltip>
			<Button variant="secondary" onClick={() => undefined}>
				No tooltip
			</Button>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	return `import { Tooltip } from 'shell';

<Tooltip content="${String(knobs.content)}" placement="${String(knobs.placement)}">
	<button type="button">Run</button>
</Tooltip>`;
}

/** The Tooltip gallery entry. */
export const tooltipEntry: IGalleryEntry = {
	id: 'tooltip',
	name: 'Tooltip',
	group: 'content',
	blurb: 'Short hint on hover (after a delay) and keyboard focus (at once), dismissed by Escape. Linked as the element description for screen readers.',
	docNote: 'The child must accept a ref (a DOM element or a forwardRef component). Tooltips hold plain text only - use a Popover for anything interactive.',
	knobs: [
		{ id: 'content', label: 'Content', kind: 'text', defaultValue: 'Run the pipeline (⌘R)' },
		{ id: 'placement', label: 'Placement', kind: 'select', options: ['top', 'bottom', 'left', 'right'], defaultValue: 'top' },
	],
	demo: TooltipDemo,
	code: buildCode,
	props: [
		{ name: 'content', type: 'ReactNode', dir: 'in', required: true, note: 'The hint text. Short, no interactive content.' },
		{ name: 'children', type: 'ReactElement', dir: 'in', required: true, note: 'The single element described. Must accept a ref.' },
		{ name: 'placement', type: 'OverlayPlacement', dir: 'in', note: "Default 'top'." },
		{ name: 'delay', type: 'number', dir: 'in', note: 'Hover delay in ms. Default 400.' },
		{ name: 'disabled', type: 'boolean', dir: 'in', note: 'Render the child untouched.' },
	],
};
