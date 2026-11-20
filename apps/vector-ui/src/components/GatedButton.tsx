// =============================================================================
// MIT License
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
// VECTOR-UI - GATED BUTTON (a small button that says why it is unavailable)
// =============================================================================
//
// The write controls of the Documents and Trash tabs and the pending bar.
// A control that is unavailable stays focusable (aria-disabled, its click
// does nothing) instead of `disabled`: a focused button that becomes
// disabled drops the focus to the page, and a write running elsewhere
// disables every write control while it runs. Its title carries the reason;
// the tab shows the same reason as text beside the controls.
// =============================================================================

import React from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { commonStyles } from 'shell';
import { CONSOLE_TEXT_TOKEN } from '../vector/colors';
import { FOCUS_RING } from '../styles';

/** The look of a gated button. */
export type GatedVariant = 'primary' | 'secondary' | 'danger';

/** The variants, small: the secondary one writes in the console's text token (the shell's secondary text fails in some themes). */
function variantStyle(variant: GatedVariant): CSSProperties {
	const base = variant === 'primary' ? commonStyles.buttonPrimary : variant === 'danger' ? commonStyles.buttonDanger : { ...commonStyles.buttonSecondary, color: `var(${CONSOLE_TEXT_TOKEN})` };
	return { ...base, ...commonStyles.buttonSmall, whiteSpace: 'nowrap' };
}

/** Props for the {@link GatedButton} component. */
export interface IGatedButtonProps {
	variant?: GatedVariant;
	/** Why it is unavailable, or null when it is available. */
	unavailable?: string | null;
	onClick(): void;
	children: ReactNode;
	/** The tooltip while available. */
	title?: string;
	/** Read with the button (an element's id). */
	describedBy?: string;
	/** For a toggle. */
	pressed?: boolean;
}

/**
 * A small button that stays focusable while unavailable.
 *
 * @param props - {@link IGatedButtonProps}.
 * @returns The button.
 */
export function GatedButton({ variant = 'secondary', unavailable = null, onClick, children, title, describedBy, pressed }: IGatedButtonProps): React.ReactElement {
	const off = unavailable !== null;
	return (
		<button
			type="button"
			aria-disabled={off || undefined}
			aria-pressed={pressed}
			aria-describedby={describedBy}
			title={off ? unavailable : title}
			style={{ ...variantStyle(variant), ...(off ? commonStyles.buttonDisabled : null) }}
			onClick={() => {
				if (!off) onClick();
			}}
			onFocus={(event) => (event.currentTarget.style.outline = FOCUS_RING)}
			onBlur={(event) => (event.currentTarget.style.outline = 'none')}
		>
			{children}
		</button>
	);
}

export default GatedButton;
