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
 * MUI sx-compatible style definitions for NodeAnnotation.
 *
 * The annotation node renders as a sticky-note with a hover-reveal header,
 * resizable dimensions, and rendered markdown content. Markdown styles are
 * scaled to fit the canvas zoom level (~0.7rem base).
 */

export const styles = {
	/** Root container — fills the ReactFlow node wrapper, hides overflow, reveals header on hover. */
	root: {
		position: 'relative',
		width: '100%',
		height: '100%',
		borderRadius: '5px',
		border: 'none',
		outline: 'none',
		boxShadow: 'none',
		overflow: 'hidden',
		display: 'flex',
		flexDirection: 'column',
		'&:hover .annotation-header': {
			opacity: 1,
			pointerEvents: 'auto',
		},
	},

	/** Header bar — absolutely positioned, invisible until parent hover. */
	header: {
		position: 'absolute',
		top: 0,
		left: 0,
		right: 0,
		zIndex: 1,
		opacity: 0,
		pointerEvents: 'none',
		transition: 'opacity 0.2s ease',
		borderRadius: '5px 5px 0 0',
	},

	/** Scrollable content area with canvas-scaled markdown styles. */
	contentArea: {
		flex: 1,
		overflowY: 'auto',
		padding: '0.5rem',
		fontSize: '0.75rem',
		lineHeight: 1.5,
		'& h1': { fontSize: '1rem', fontWeight: 600, m: '0.25rem 0' },
		'& h2': { fontSize: '0.9rem', fontWeight: 600, m: '0.25rem 0' },
		'& h3': { fontSize: '0.8rem', fontWeight: 600, m: '0.2rem 0' },
		'& p': { m: '0.25rem 0', fontSize: '0.75rem' },
		'& ul, & ol': { pl: '1.25rem', m: '0.25rem 0', fontSize: '0.75rem' },
		'& li': { m: '0.1rem 0' },
		'& blockquote': {
			borderLeft: '3px solid',
			borderColor: 'var(--rr-text-disabled)',
			pl: '0.5rem',
			m: '0.25rem 0',
			fontStyle: 'italic',
			color: 'var(--rr-text-secondary)',
		},
		'& code': {
			fontSize: '0.7rem',
			fontFamily: '"Monaco", "Menlo", "Consolas", monospace',
			backgroundColor: 'var(--rr-bg-surface-alt)',
			padding: '0.1rem 0.2rem',
			borderRadius: '3px',
		},
		'& pre': {
			m: '0.25rem 0',
			borderRadius: '4px',
			overflowX: 'auto',
			'& code': { backgroundColor: 'transparent', padding: 0 },
		},
		'& a': {
			color: 'var(--rr-text-link)',
			textDecoration: 'none',
			'&:hover': { textDecoration: 'underline' },
		},
		'& table': {
			width: '100%',
			borderCollapse: 'collapse',
			fontSize: '0.7rem',
			m: '0.25rem 0',
		},
		'& th, & td': {
			padding: '0.2rem 0.4rem',
			textAlign: 'left',
			borderBottom: '1px solid',
			borderColor: 'var(--rr-border)',
		},
		'& th': { fontWeight: 600 },
		'& img': { maxWidth: '100%', height: 'auto' },
	},

	/** Placeholder text shown when the annotation has no content. */
	placeholder: {
		color: 'var(--rr-text-disabled)',
		fontStyle: 'italic',
		fontSize: '0.7rem',
	},
};
