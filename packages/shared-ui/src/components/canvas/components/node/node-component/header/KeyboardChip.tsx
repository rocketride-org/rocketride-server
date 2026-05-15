// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Renders a single keyboard key as a styled chip.
 *
 * Used within keyboard shortcut displays in menus and the shortcuts panel.
 * Special characters '+' and ',' are rendered as plain text separators.
 */

import { ReactElement } from 'react';

// =============================================================================
// Types
// =============================================================================

interface IKeyboardChipProps {
	/** The keyboard key label to display (e.g., "Ctrl", "S", "+", ","). */
	text: string;
	/** Visual shape of the chip. 'round' uses default border-radius; 'square' removes it. */
	shape?: 'round' | 'square';
}

// =============================================================================
// Component
// =============================================================================

export default function KeyboardChip({ text, shape = 'round' }: IKeyboardChipProps): ReactElement {
	// Separator characters render as plain text, not chips
	if (text === '+') {
		return <span style={{ marginRight: '2px', fontSize: '0.75rem' }}>+</span>;
	}
	if (text === ',') {
		return <span style={{ marginRight: '2px', fontSize: '0.75rem' }}>,</span>;
	}

	return (
		<span
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				height: '20px',
				fontSize: '0.7rem',
				backgroundColor: 'var(--rr-bg-surface-alt)',
				color: 'var(--rr-text-primary)',
				marginRight: '2px',
				padding: '0 6px',
				borderRadius: shape === 'square' ? 0 : '16px',
			}}
		>
			{text}
		</span>
	);
}
