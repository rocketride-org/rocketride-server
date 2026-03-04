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

import { isInVSCode } from '../../../../../utils/vscode';

/** Whether the application is running inside VS Code; used to apply theme-aware styling. */
const inVSCode = isInVSCode();

/**
 * MUI `sx`-compatible style definitions for the redesigned AnnotationNode.
 * The annotation node now looks like a regular node with a hover-reveal header,
 * resizable dimensions, and rendered markdown content.
 */
export const styles = {
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
		// Reveal the header on hover
		'&:hover .annotation-header': {
			opacity: 1,
			pointerEvents: 'auto',
		},
	},
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
	contentArea: {
		flex: 1,
		overflowY: 'auto',
		padding: '0.5rem',
		fontSize: '0.75rem',
		lineHeight: 1.5,
		// Markdown element styles at canvas-appropriate scale
		'& h1': { fontSize: '1rem', fontWeight: 600, m: '0.25rem 0' },
		'& h2': { fontSize: '0.9rem', fontWeight: 600, m: '0.25rem 0' },
		'& h3': { fontSize: '0.8rem', fontWeight: 600, m: '0.2rem 0' },
		'& p': { m: '0.25rem 0', fontSize: '0.75rem' },
		'& ul, & ol': { pl: '1.25rem', m: '0.25rem 0', fontSize: '0.75rem' },
		'& li': { m: '0.1rem 0' },
		'& blockquote': {
			borderLeft: '3px solid',
			borderColor: 'text.disabled',
			pl: '0.5rem',
			m: '0.25rem 0',
			fontStyle: 'italic',
			color: 'text.secondary',
		},
		'& code': {
			fontSize: '0.7rem',
			fontFamily: '"Monaco", "Menlo", "Consolas", monospace',
			backgroundColor: 'rgba(0,0,0,0.06)',
			padding: '0.1rem 0.2rem',
			borderRadius: '3px',
		},
		'& pre': {
			m: '0.25rem 0',
			borderRadius: '4px',
			overflowX: 'auto',
			'& code': {
				backgroundColor: 'transparent',
				padding: 0,
			},
		},
		'& a': {
			color: inVSCode ? 'var(--vscode-textLink-foreground)' : '#1976d2',
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
			borderColor: 'divider',
		},
		'& th': {
			fontWeight: 600,
		},
		'& img': {
			maxWidth: '100%',
			height: 'auto',
		},
	},
	placeholder: {
		color: 'text.disabled',
		fontStyle: 'italic',
		fontSize: '0.7rem',
	},
};
