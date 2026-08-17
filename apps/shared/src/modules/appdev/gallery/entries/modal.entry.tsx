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
// MODAL — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock Modal dialog. */

import React, { useState } from 'react';
import { Button, Modal } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a trigger button opening the real Modal over the gallery. */
const ModalDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	// Local open state - the demo IS the open/close lifecycle
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button variant="secondary" onClick={() => setOpen(true)}>Open modal</Button>
			{open && (
				<Modal
					title={String(knobs.title)}
					width={Number(knobs.width)}
					onClose={() => setOpen(false)}
					footer={knobs.footer ? (
						<>
							<Button variant="secondary" small onClick={() => setOpen(false)}>Cancel</Button>
							<Button small onClick={() => setOpen(false)}>Save</Button>
						</>
					) : undefined}
				>
					<div>Multi-step flows and pickers live here. Escape closes; the backdrop is inert.</div>
				</Modal>
			)}
		</>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => `import { Modal, Button } from 'shell';

{open && (
	<Modal title={${JSON.stringify(String(knobs.title))}}${Number(knobs.width) !== 440 ? ` width={${Number(knobs.width)}}` : ''} onClose={() => setOpen(false)}${knobs.footer ? `
		footer={<>
			<Button variant="secondary" small onClick={() => setOpen(false)}>Cancel</Button>
			<Button small onClick={onSave}>Save</Button>
		</>}` : ''}>
		{/* body */}
	</Modal>
)}`;

/** The Modal gallery entry. */
export const modalEntry: IGalleryEntry = {
	id: 'modal',
	name: 'Modal',
	group: 'content',
	blurb: 'The stock dialog: a centered box over a dimmed INERT backdrop - outside-click never closes. Escape closes the topmost layer; focus is trapped and restored on close.',
	doc: `Modals are for **multi-step flows and pickers** — for confirmations use \`ConfirmDialog\`, and for inspecting/editing the app's own records use a \`DetailPanel\` record panel, not a dialog.

Behavior that comes for free: page-scroll lock, Tab focus trap, prior-focus restore, a layered overlay stack (Escape only closes the topmost), and the top-right ✕ that appears exactly when there is no footer (override with \`showClose\`).`,
	knobs: [
		{ id: 'title', label: 'Title', kind: 'text', defaultValue: 'Add source' },
		{ id: 'width', label: 'Width', kind: 'number', defaultValue: 440 },
		{ id: 'footer', label: 'Footer', kind: 'boolean', defaultValue: true },
	],
	demo: ModalDemo,
	code: buildCode,
	props: [
		{ name: 'title', type: 'ReactNode', dir: 'in', required: true, note: 'Header title - a plain string or a custom node (pair with ariaLabel).' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'Body content.' },
		{ name: 'footer', type: 'ReactNode', dir: 'in', note: 'Footer action row (Cancel / primary). Its presence hides the default ✕.' },
		{ name: 'showClose', type: 'boolean', dir: 'in', note: 'Force the top-right ✕ on or off; default is "only when there is no footer".' },
		{ name: 'closeOnEscape', type: 'boolean', dir: 'in', note: 'Whether Escape closes the dialog. Default true.' },
		{ name: 'width', type: 'number', dir: 'in', note: 'Box width in px. Default 440.' },
		{ name: 'noBodyPadding', type: 'boolean', dir: 'in', note: 'Drop body padding for content that fills the box (e.g. a DataGrid).' },
		{ name: 'ariaLabel', type: 'string', dir: 'in', note: 'Accessible label when title is not a plain string.' },
		{ name: 'onClose', type: '() => void', dir: 'out', required: true, note: 'Fired when the dialog is dismissed (✕ or Escape).' },
	],
	sections: [
		{
			label: 'Helpers',
			rows: [
				{ name: 'CLOSE_GLYPH', type: 'string', dir: 'in', note: 'The one canonical close glyph (U+2715) - use it for any custom close affordance.' },
			],
		},
	],
};
