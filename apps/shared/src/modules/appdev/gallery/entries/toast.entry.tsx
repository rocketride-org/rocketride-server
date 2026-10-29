// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for the toast API (showToast / dismissToast / ToastViewport). */

import React from 'react';
import { Button, showToast } from 'shell';
import type { ToastVariant } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: fire a toast of the chosen variant. */
const ToastDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	/** Shows one toast built from the knobs. */
	function fire(): void {
		let action: { label: string; onClick: () => void } | undefined;
		if (knobs.withAction) action = { label: 'Undo', onClick: () => undefined };
		let title: string | undefined;
		if (knobs.title) title = 'Pipeline';
		showToast({ message: String(knobs.message), title, variant: knobs.variant as ToastVariant, action });
	}

	return (
		<Button variant="ghost" onClick={fire}>
			Show toast
		</Button>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let extra = '';
	if (knobs.title) extra += ", title: 'Pipeline'";
	if (knobs.withAction) extra += ", action: { label: 'Undo', onClick: undo }";
	return `import { showToast } from 'shell';

showToast({ message: '${String(knobs.message)}', variant: '${String(knobs.variant)}'${extra} });`;
}

/** The toast gallery entry. */
export const toastEntry: IGalleryEntry = {
	id: 'toast',
	name: 'showToast / dismissToast',
	group: 'content',
	blurb: 'Brief, non-blocking notification in the bottom-right stack. Call from anywhere - no provider. Auto-dismisses, pauses on hover/focus, errors announce assertively.',
	doc: 'The shell mounts the toast viewport, so apps just call `showToast()`. Outside the shell (VS Code webviews) the first call mounts a viewport itself; render `<ToastViewport />` to place it explicitly. At most 4 toasts show; the oldest drops first. Anything the user must act on belongs in a Modal or Banner.',
	knobs: [
		{ id: 'message', label: 'Message', kind: 'text', defaultValue: 'Pipeline saved' },
		{ id: 'variant', label: 'Variant', kind: 'select', options: ['info', 'success', 'warning', 'error'], defaultValue: 'success' },
		{ id: 'title', label: 'Title', kind: 'boolean', defaultValue: false },
		{ id: 'withAction', label: 'Action', kind: 'boolean', defaultValue: false },
	],
	demo: ToastDemo,
	code: buildCode,
	props: [
		{ name: 'message', type: 'string', dir: 'in', required: true, note: 'Main text, one line.' },
		{ name: 'title', type: 'string', dir: 'in', note: 'Optional bold first line.' },
		{ name: 'variant', type: "'info' | 'success' | 'warning' | 'error'", dir: 'in', note: "Default 'info'." },
		{ name: 'duration', type: 'number', dir: 'in', note: 'Auto-dismiss ms; 0 keeps it. Default 5000 (8000 for errors).' },
		{ name: 'action', type: '{ label; onClick }', dir: 'in', note: 'One action such as Undo or Retry; also dismisses.' },
	],
	propsLabel: 'showToast(options)',
	sections: [
		{
			label: 'Functions',
			rows: [
				{ name: 'showToast(options)', type: 'string', dir: 'out', note: 'Shows a toast; returns its id.' },
				{ name: 'dismissToast(id)', type: 'void', dir: 'in', note: 'Dismisses a toast early.' },
				{ name: '<ToastViewport />', type: 'ReactElement', dir: 'in', note: 'Places the stack yourself (the shell already mounts one).' },
			],
		},
	],
};
