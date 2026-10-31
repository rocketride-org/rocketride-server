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
// BUTTON — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock Button: live demo, knobs, snippet, props. */

import React from 'react';
import { Button } from 'shell';
import type { ButtonVariant } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: one Button driven entirely by the knob values. */
const ButtonDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<Button
		variant={knobs.variant as ButtonVariant}
		small={Boolean(knobs.small)}
		disabled={Boolean(knobs.disabled)}
		onClick={() => undefined}
	>
		{String(knobs.label)}
	</Button>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	// Only non-default props appear, so the copied code stays minimal
	const attrs = [
		knobs.variant !== 'primary' ? ` variant="${String(knobs.variant)}"` : '',
		knobs.small ? ' small' : '',
		knobs.disabled ? ' disabled' : '',
	].join('');
	return `import { Button } from 'shell';

<Button${attrs} onClick={handleClick}>${String(knobs.label)}</Button>`;
};

/** The Button gallery entry. */
export const buttonEntry: IGalleryEntry = {
	id: 'button',
	name: 'Button',
	group: 'content',
	blurb: 'The stock action button: primary / secondary / ghost / danger variants, with small (26px) and mini (16px, canvas chrome) sizes. Wraps the commonStyles button styles.',
	knobs: [
		{ id: 'variant', label: 'Variant', kind: 'select', options: ['primary', 'secondary', 'ghost', 'danger'], defaultValue: 'primary' },
		{ id: 'small', label: 'Small', kind: 'boolean', defaultValue: false },
		{ id: 'disabled', label: 'Disabled', kind: 'boolean', defaultValue: false },
		{ id: 'label', label: 'Label', kind: 'text', defaultValue: 'Run pipeline' },
	],
	demo: ButtonDemo,
	code: buildCode,
	props: [
		{ name: 'variant', type: "'primary' | 'secondary' | 'ghost' | 'danger'", dir: 'in', note: "Visual variant. Defaults to 'primary'." },
		{ name: 'small', type: 'boolean', dir: 'in', note: 'Render the compact (26px tall) size.' },
		{ name: 'mini', type: 'boolean', dir: 'in', note: 'Render the micro (16px tall) size - canvas-node chrome. Wins over small.' },
		{ name: 'disabled', type: 'boolean', dir: 'in', note: 'Disable the button - dimmed and non-interactive.' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'Button label / content.' },
		{ name: 'title', type: 'string', dir: 'in', note: 'Native tooltip text.' },
		{ name: 'pressed', type: 'boolean', dir: 'in', note: 'ARIA pressed state for toggle/segmented usage (rendered as aria-pressed).' },
		{ name: 'ariaExpanded', type: 'boolean', dir: 'in', note: "ARIA expanded state for dropdown-trigger usage (rendered as aria-expanded)." },
		{ name: 'onClick', type: '() => void', dir: 'out', note: 'Click handler.' },
	],
};
