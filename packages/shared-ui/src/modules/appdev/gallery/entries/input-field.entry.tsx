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
// INPUT FIELD — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock InputField text/select base. */

import React from 'react';
import { InputField } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: an uncontrolled InputField driven by the knob values. */
const InputFieldDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div style={{ maxWidth: 320 }}>
		<InputField
			// key remount clears the typed value when the type knob flips
			key={String(knobs.type)}
			type={String(knobs.type)}
			placeholder={String(knobs.placeholder)}
			disabled={Boolean(knobs.disabled)}
		/>
	</div>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const typeAttr = knobs.type !== 'text' ? ` type="${String(knobs.type)}"` : '';
	const disabledAttr = knobs.disabled ? ' disabled' : '';
	return `import { InputField } from 'shell';

<InputField${typeAttr} placeholder="${String(knobs.placeholder)}"${disabledAttr}
	value={name} onChange={(e) => setName(e.target.value)} />`;
};

/** The InputField gallery entry. */
export const inputFieldEntry: IGalleryEntry = {
	id: 'input-field',
	name: 'InputField',
	group: 'content',
	blurb: 'The stock text-input base - a styled native input carrying the full InputHTMLAttributes surface. Wraps commonStyles.inputField.',
	knobs: [
		{ id: 'type', label: 'Type', kind: 'select', options: ['text', 'password', 'number'], defaultValue: 'text' },
		{ id: 'placeholder', label: 'Placeholder', kind: 'text', defaultValue: 'Pipeline name' },
		{ id: 'disabled', label: 'Disabled', kind: 'boolean', defaultValue: false },
	],
	demo: InputFieldDemo,
	code: buildCode,
	props: [
		{ name: '...props', type: 'InputHTMLAttributes<HTMLInputElement>', dir: 'in', note: 'The entire native input attribute surface - value, placeholder, type, disabled, onChange, and the rest pass straight through.' },
	],
};
