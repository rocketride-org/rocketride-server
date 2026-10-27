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
// SQL-UI — GATED BUTTON (a button that says why it is off)
// =============================================================================
//
// The shell Button can only be natively disabled, which takes it out of the
// tab order, so a keyboard or screen-reader user never reaches it to hear why.
// While gated this renders one real button instead: focusable, aria-disabled,
// described by the visible reason element, and a no-op when activated. It is
// drawn like the shell button's disabled state.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { Button, commonStyles } from 'shell';
import type { IButtonProps } from 'shell';

/** Props for the {@link GatedButton} component. */
export interface GatedButtonProps extends IButtonProps {
	/** Why the button is unavailable (null/undefined = no gate, behaves as Button). */
	gateReason?: string | null;
	/** Id of the visible element that carries the reason, for aria-describedby. */
	reasonId?: string;
}

/** The look of a gated button: the shell button's shape, dimmed. */
const gatedStyle = (small: boolean | undefined): CSSProperties => ({
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: 7,
	height: small ? 26 : 34,
	padding: small ? '0 11px' : '0 16px',
	fontFamily: 'inherit',
	fontSize: small ? 11 : 13,
	fontWeight: 600,
	borderRadius: small ? 6 : 7,
	border: '1px solid var(--rr-border)',
	background: 'transparent',
	color: 'var(--rr-text-primary)',
	whiteSpace: 'nowrap',
	...commonStyles.buttonDisabled,
});

/**
 * A Button that is unavailable with a stated reason while `gateReason` is set.
 *
 * @param props - {@link GatedButtonProps}.
 * @returns The button.
 */
export const GatedButton: React.FC<GatedButtonProps> = ({ gateReason, reasonId, ...button }) => {
	if (!gateReason) return <Button {...button} />;
	return (
		<button
			type="button"
			style={gatedStyle(button.small)}
			aria-disabled="true"
			aria-describedby={reasonId}
			title={gateReason}
			onClick={() => undefined}
		>
			{button.children}
		</button>
	);
};

export default GatedButton;
