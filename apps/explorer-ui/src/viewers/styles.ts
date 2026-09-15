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
// VIEWER STYLES — shared CSS-in-JS styles for all file viewers
// =============================================================================

import type { CSSProperties } from 'react';

export const viewerStyles = {
	/** Centered loading / error / unsupported message. */
	message: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Centered media container (images). */
	mediaContainer: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		overflow: 'auto',
		padding: 16,
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,

	/** Scrollable prose container (markdown, JSON). */
	prose: {
		flex: 1,
		overflow: 'auto',
		padding: '12px 24px',
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,
};
