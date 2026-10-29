// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Popover. */

import React, { useRef, useState } from 'react';
import { Button, Checkbox, Popover } from 'shell';
import type { OverlayPlacement } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a filter panel anchored to a button. */
const PopoverDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [isOpen, setIsOpen] = useState(false);
	const [filters, setFilters] = useState({ failed: true, running: false });
	const anchorRef = useRef<HTMLSpanElement>(null);

	return (
		<>
			<span ref={anchorRef} style={{ display: 'inline-block' }}>
				<Button variant="ghost" onClick={() => setIsOpen(!isOpen)} ariaExpanded={isOpen}>
					Filters
				</Button>
			</span>
			<Popover open={isOpen} anchorRef={anchorRef} onClose={() => setIsOpen(false)} placement={knobs.placement as OverlayPlacement} ariaLabel="Run filters" style={{ padding: 12, width: 220 }}>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<span className="rr-text-label">Show runs</span>
					<Checkbox label="Failed" checked={filters.failed} onChange={(checked) => setFilters({ ...filters, failed: checked })} />
					<Checkbox label="Running" checked={filters.running} onChange={(checked) => setFilters({ ...filters, running: checked })} />
				</div>
			</Popover>
		</>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	return `import { Popover } from 'shell';

const anchorRef = useRef<HTMLButtonElement>(null);

<button ref={anchorRef} onClick={() => setOpen(!open)} aria-expanded={open}>Filters</button>
<Popover open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} placement="${String(knobs.placement)}" ariaLabel="Run filters">
	{/* panel content */}
</Popover>`;
}

/** The Popover gallery entry. */
export const popoverEntry: IGalleryEntry = {
	id: 'popover',
	name: 'Popover',
	group: 'content',
	blurb: 'Floating panel anchored to an element - filter panels, pickers, anything richer than a Menu. Flips and shifts to stay on screen.',
	doc: 'Controlled: you own `open`; `onClose` fires on Escape (top layer only) and on a press outside the panel and its anchor. It joins the same overlay stack as Modal and DetailPanel, so Escape inside a Modal closes the popover first. Focus moves in on open and back to the anchor on close.',
	knobs: [{ id: 'placement', label: 'Placement', kind: 'select', options: ['bottom-start', 'bottom-end', 'top-start', 'right-start', 'left-start'], defaultValue: 'bottom-start' }],
	demo: PopoverDemo,
	code: buildCode,
	props: [
		{ name: 'open', type: 'boolean', dir: 'in', required: true, note: 'Whether the panel is open.' },
		{ name: 'anchorRef', type: 'RefObject<HTMLElement>', dir: 'in', required: true, note: 'The element the panel attaches to.' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'Panel content.' },
		{ name: 'placement', type: 'OverlayPlacement', dir: 'in', note: "Side and alignment. Default 'bottom-start'." },
		{ name: 'offset', type: 'number', dir: 'in', note: 'Gap to the anchor in px. Default 4.' },
		{ name: 'matchWidth', type: 'boolean', dir: 'in', note: 'At least as wide as the anchor.' },
		{ name: 'ariaLabel / ariaLabelledBy / role / id', type: 'string', dir: 'in', note: "Naming and role. Default role 'dialog'." },
		{ name: 'autoFocus / restoreFocus / closeOnOutsidePress', type: 'boolean', dir: 'in', note: 'Focus and dismissal behavior. All default true.' },
		{ name: 'className / style', type: '...', dir: 'in', note: 'Extra classes and inline style for the panel.' },
		{ name: 'onClose', type: '() => void', dir: 'out', required: true, note: 'The panel asks to close.' },
	],
};
