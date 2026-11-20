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
// ANCHORED POPUP — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the AnchoredPopup positioning container. */

import React from 'react';
import { AnchoredPopup, Button, PopupRow } from 'shell';
import type { AnchoredPopupProps } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Menu chrome for the demo popup - AnchoredPopup itself is purely positional. */
const MENU_STYLE: React.CSSProperties = {
	width: 180,
	padding: 4,
	border: '1px solid var(--rr-border)',
	borderRadius: 6,
	background: 'var(--rr-bg-surface-alt)',
};

/** Live demo: a trigger button toggling a real portal-rendered popup. */
const AnchoredPopupDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const anchorRef = React.useRef<HTMLDivElement>(null);
	const [open, setOpen] = React.useState(false);
	return (
		<div ref={anchorRef} style={{ display: 'inline-block' }}>
			<Button onClick={() => setOpen((v) => !v)} pressed={open}>Actions</Button>
			<AnchoredPopup
				anchorRef={anchorRef}
				open={open}
				onClose={() => setOpen(false)}
				placement={String(knobs.placement) as AnchoredPopupProps['placement']}
				align={String(knobs.align) as AnchoredPopupProps['align']}
				matchAnchorWidth={Boolean(knobs.matchAnchorWidth)}
				style={MENU_STYLE}
			>
				<PopupRow onClick={() => setOpen(false)}>Settings</PopupRow>
				<PopupRow onClick={() => setOpen(false)}>Delete</PopupRow>
			</AnchoredPopup>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const placementAttr = knobs.placement === 'below' ? '' : `\n\tplacement="${String(knobs.placement)}"`;
	const alignAttr = knobs.align === 'start' ? '' : `\n\talign="${String(knobs.align)}"`;
	const matchAttr = knobs.matchAnchorWidth ? '\n\tmatchAnchorWidth' : '';
	return `import { AnchoredPopup, PopupRow, Button } from 'shell';

const anchorRef = useRef<HTMLDivElement>(null);
const [open, setOpen] = useState(false);

<div ref={anchorRef} style={{ display: 'inline-block' }}>
	<Button onClick={() => setOpen((v) => !v)} pressed={open}>Actions</Button>
</div>
<AnchoredPopup
	anchorRef={anchorRef}
	open={open}
	onClose={() => setOpen(false)}${placementAttr}${alignAttr}${matchAttr}
	style={menuChrome}
>
	<PopupRow onClick={openSettings}>Settings</PopupRow>
	<PopupRow onClick={remove}>Delete</PopupRow>
</AnchoredPopup>`;
};

/** The AnchoredPopup gallery entry. */
export const anchoredPopupEntry: IGalleryEntry = {
	id: 'anchored-popup',
	name: 'AnchoredPopup',
	group: 'content',
	blurb: 'The positioning container for any anchored popup or menu: portal-rendered at a fixed, measured position beside its anchor, flipped when out of room, clamped into the viewport, dismissed on outside mousedown or Escape.',
	doc: `AnchoredPopup renders its children into the host popup portal (\`#rr-popup-portal\`, falling back to \`document.body\`), so the popup escapes every \`overflow: hidden\` ancestor. It repositions on scroll and resize, and ignores mousedowns inside the ANCHOR so the trigger's own onClick toggle closes it without a close-then-reopen race.

It is purely positional — background, border, and shadow come from \`style\` and the children, so \`PopupRow\` bodies and bespoke menus compose unchanged. Under the hood it is \`useFixedPopupPosition\`'s measured mode packaged as a component.`,
	knobs: [
		{ id: 'placement', label: 'Placement', kind: 'select', options: ['below', 'above'], defaultValue: 'below' },
		{ id: 'align', label: 'Align', kind: 'select', options: ['start', 'end'], defaultValue: 'start' },
		{ id: 'matchAnchorWidth', label: 'Match anchor width', kind: 'boolean', defaultValue: false },
	],
	demo: AnchoredPopupDemo,
	code: buildCode,
	props: [
		{ name: 'anchorRef', type: 'RefObject<HTMLElement | null>', dir: 'in', required: true, note: 'The trigger element the popup positions against.' },
		{ name: 'open', type: 'boolean', dir: 'in', required: true, note: 'Whether the popup is open (closed renders nothing).' },
		{ name: 'placement', type: "'below' | 'above'", dir: 'in', note: "Preferred side of the anchor (default 'below'; flips when out of room)." },
		{ name: 'align', type: "'start' | 'end'", dir: 'in', note: "Horizontal alignment against the anchor (default 'start')." },
		{ name: 'gap', type: 'number', dir: 'in', note: 'Gap between anchor and popup in px (default 4).' },
		{ name: 'matchAnchorWidth', type: 'boolean', dir: 'in', note: "Match the popup's width to the anchor's (split buttons, comboboxes)." },
		{ name: 'style', type: 'CSSProperties', dir: 'in', note: 'Visual chrome for the popup box (merged over the positional base).' },
		{ name: 'children', type: 'ReactNode', dir: 'in', note: 'Popup body - PopupRows or any bespoke menu content.' },
		{ name: 'onClose', type: '() => void', dir: 'out', required: true, note: 'Dismissal callback (outside mousedown, Escape).' },
	],
};
