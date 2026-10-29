// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for IconButton. */

import React, { useState } from 'react';
import { IconButton } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a small toolbar - two actions and a pin toggle. */
const IconButtonDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [isPinned, setIsPinned] = useState(false);
	const small = Boolean(knobs.small);
	let pinLabel = 'Pin';
	if (isPinned) pinLabel = 'Unpin';
	return (
		<div style={{ display: 'flex', gap: 4 }}>
			<IconButton label="Refresh" small={small} onClick={() => undefined}>
				↻
			</IconButton>
			<IconButton label="Duplicate" small={small} onClick={() => undefined}>
				⧉
			</IconButton>
			<IconButton label={pinLabel} small={small} pressed={isPinned} onClick={() => setIsPinned(!isPinned)}>
				★
			</IconButton>
			<IconButton label="Delete (no permission)" small={small} disabled>
				✕
			</IconButton>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let smallAttr = '';
	if (knobs.small) smallAttr = ' small';
	return `import { IconButton } from 'shell';

<IconButton label="Refresh"${smallAttr} onClick={reload}>
	<RefreshIcon />
</IconButton>
<IconButton label="Pin" pressed={isPinned}${smallAttr} onClick={togglePin}>
	<PinIcon />
</IconButton>`;
}

/** The IconButton gallery entry. */
export const iconButtonEntry: IGalleryEntry = {
	id: 'icon-button',
	name: 'IconButton',
	group: 'content',
	blurb: 'Square icon-only button for toolbars and row actions. `label` is required: it is both the accessible name and the tooltip.',
	docNote: 'Never ship an icon-only control without a label - the IconButton type makes it required for that reason.',
	knobs: [{ id: 'small', label: 'Small', kind: 'boolean', defaultValue: false }],
	demo: IconButtonDemo,
	code: buildCode,
	props: [
		{ name: 'label', type: 'string', dir: 'in', required: true, note: 'Accessible name and tooltip text.' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'The icon.' },
		{ name: 'small', type: 'boolean', dir: 'in', note: 'Compact 26px size.' },
		{ name: 'pressed', type: 'boolean', dir: 'in', note: 'Toggle state (aria-pressed).' },
		{ name: 'tooltip', type: 'boolean', dir: 'in', note: 'Show label as a tooltip. Default true.' },
		{ name: 'tooltipPlacement', type: 'OverlayPlacement', dir: 'in', note: "Default 'top'." },
		{ name: 'disabled / type / className', type: '...', dir: 'in', note: 'Native button attributes.' },
		{ name: 'onClick', type: '(event) => void', dir: 'out', note: 'Click handler.' },
	],
};
