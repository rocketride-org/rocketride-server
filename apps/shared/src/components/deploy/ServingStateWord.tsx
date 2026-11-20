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
// SERVING STATE WORD — why a where-live row is not serving
// =============================================================================

/**
 * The state word of a where-live row, shared by both DEPLOY screens. A row
 * means serving (decided 2026-11-16): the serving state carries no word, so
 * only a reason the row is NOT serving is drawn ('disabled', 'errored',
 * 'in review', ...). The screen phrases the status with `pinStatusOf`; this
 * only colours it by tone. Never a process or engine state.
 */

import React from 'react';
import type { CSSProperties } from 'react';

// =============================================================================
// PROPS
// =============================================================================

/** A row's serving status (the shape `pinStatusOf` returns). */
export interface IServingStatus {
	/** The word ('serving', 'disabled', 'not serving: still building', ...). */
	word: string;
	/** How it reads at a glance; 'ok' draws nothing. */
	tone: 'ok' | 'warn' | 'error' | 'muted';
}

/** Props for {@link ServingStateWord}. */
export interface IServingStateWordProps {
	/** The row's status. */
	status: IServingStatus;
}

// =============================================================================
// STYLES
// =============================================================================

const word: CSSProperties = {
	fontSize: 11.5,
	fontWeight: 600,
	whiteSpace: 'nowrap',
};

const S: Record<Exclude<IServingStatus['tone'], 'ok'>, CSSProperties> = {
	warn: { ...word, color: 'var(--rr-color-warning)' },
	error: { ...word, color: 'var(--rr-color-error)' },
	muted: { ...word, color: 'var(--rr-text-disabled)' },
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders why a row does not serve; nothing while it serves.
 *
 * @param props - See {@link IServingStateWordProps}.
 */
export const ServingStateWord: React.FC<IServingStateWordProps> = ({ status }) => {
	if (status.tone === 'ok') return null;
	return <span style={S[status.tone]}>&#9679; {status.word}</span>;
};
