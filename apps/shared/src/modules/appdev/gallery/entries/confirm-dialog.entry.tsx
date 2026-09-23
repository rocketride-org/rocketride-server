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
// CONFIRM DIALOG — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock ConfirmDialog. */

import React, { useState } from 'react';
import { Button, ConfirmDialog } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a trigger button opening the real ConfirmDialog. */
const ConfirmDialogDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	// Local open state - the demo IS the confirm/cancel lifecycle
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button variant="secondary" onClick={() => setOpen(true)}>Delete pipeline...</Button>
			{open && (
				<ConfirmDialog
					title={String(knobs.title)}
					message="chat.pipe has unsaved changes that will be lost."
					confirmLabel={String(knobs.confirmLabel)}
					destructive={Boolean(knobs.destructive)}
					onConfirm={() => setOpen(false)}
					onCancel={() => setOpen(false)}
				/>
			)}
		</>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => `import { ConfirmDialog } from 'shell';

{confirming && (
	<ConfirmDialog
		title={${JSON.stringify(String(knobs.title))}}
		message="chat.pipe has unsaved changes that will be lost."
		confirmLabel={${JSON.stringify(String(knobs.confirmLabel))}}${knobs.destructive ? '\n\t\tdestructive' : ''}
		onConfirm={deletePipeline}
		onCancel={() => setConfirming(false)}
	/>
)}`;

/** The ConfirmDialog gallery entry. */
export const confirmDialogEntry: IGalleryEntry = {
	id: 'confirm-dialog',
	name: 'ConfirmDialog',
	group: 'content',
	blurb: 'The stock confirm/cancel dialog on Modal: titled message, Cancel + auto-focused primary confirm, optional third action, danger styling for irreversible actions.',
	doc: `The ONE way to confirm anything — dirty closes, deletes, plan changes. There is deliberately no ✕: Cancel is the dismiss control (Escape works too). Set \`destructive\` whenever the action cannot be undone, and \`confirmDisabled\` while a required input is missing.`,
	knobs: [
		{ id: 'title', label: 'Title', kind: 'text', defaultValue: 'Delete pipeline?' },
		{ id: 'confirmLabel', label: 'Confirm label', kind: 'text', defaultValue: 'Delete' },
		{ id: 'destructive', label: 'Destructive', kind: 'boolean', defaultValue: true },
	],
	demo: ConfirmDialogDemo,
	code: buildCode,
	props: [
		{ name: 'title', type: 'string', dir: 'in', required: true, note: 'Dialog title.' },
		{ name: 'message', type: 'ReactNode', dir: 'in', required: true, note: 'Body message - plain string or custom node.' },
		{ name: 'confirmLabel', type: 'string', dir: 'in', note: "Primary button label. Default 'Save'." },
		{ name: 'cancelLabel', type: 'string', dir: 'in', note: "Cancel button label. Default 'Cancel'." },
		{ name: 'secondaryLabel', type: 'string', dir: 'in', note: 'Optional third action button, rendered between Cancel and confirm.' },
		{ name: 'destructive', type: 'boolean', dir: 'in', note: 'Danger styling on the confirm button - use for irreversible actions.' },
		{ name: 'confirmDisabled', type: 'boolean', dir: 'in', note: 'Disable confirm (e.g. while a required field is empty).' },
		{ name: 'onConfirm', type: '() => void', dir: 'out', required: true, note: 'Primary action confirmed.' },
		{ name: 'onCancel', type: '() => void', dir: 'out', required: true, note: 'Dismissed via Cancel or Escape.' },
		{ name: 'onSecondary', type: '() => void', dir: 'out', note: 'Optional secondary action chosen.' },
	],
};
