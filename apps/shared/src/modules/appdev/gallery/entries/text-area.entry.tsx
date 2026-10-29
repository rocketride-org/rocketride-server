// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for TextArea, the multi-line text input. */

import React, { useState } from 'react';
import { Field, TextArea } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a prompt box inside a Field. */
const TextAreaDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [prompt, setPrompt] = useState('You are a helpful assistant.\nAnswer in one paragraph.');
	return (
		<div style={{ maxWidth: 420 }}>
			<Field label="System prompt">
				<TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} autoResize={Boolean(knobs.autoResize)} mono={Boolean(knobs.mono)} minRows={3} maxRows={8} />
			</Field>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let attrs = '';
	if (knobs.autoResize) attrs += ' autoResize maxRows={8}';
	if (knobs.mono) attrs += ' mono';
	return `import { Field, TextArea } from 'shell';

<Field label="System prompt">
	<TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)}${attrs} />
</Field>`;
}

/** The TextArea gallery entry. */
export const textAreaEntry: IGalleryEntry = {
	id: 'text-area',
	name: 'TextArea',
	group: 'content',
	blurb: 'Multi-line text input - prompts, JSON snippets, descriptions. Optionally grows with its content, then scrolls.',
	knobs: [
		{ id: 'autoResize', label: 'Auto-resize', kind: 'boolean', defaultValue: true },
		{ id: 'mono', label: 'Monospace', kind: 'boolean', defaultValue: false },
	],
	demo: TextAreaDemo,
	code: buildCode,
	props: [
		{ name: '...textarea props', type: 'TextareaHTMLAttributes', dir: 'in', note: 'Every native <textarea> prop passes through (value, onChange, placeholder, ...).' },
		{ name: 'autoResize', type: 'boolean', dir: 'in', note: 'Grow with the content between minRows and maxRows.' },
		{ name: 'minRows', type: 'number', dir: 'in', note: 'Minimum visible rows. Default 3.' },
		{ name: 'maxRows', type: 'number', dir: 'in', note: 'Rows before scrolling (autoResize). Default 12.' },
		{ name: 'mono', type: 'boolean', dir: 'in', note: 'Monospace text for code and JSON.' },
	],
};
