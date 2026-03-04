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
 * Style definitions for the NodeFooter component.
 *
 * Contains layout and theming for both source-node footers (completion/error
 * summary with expandable details) and non-source-node footers (pipe progress
 * bar with count label). Styles use MUI `sx` conventions with theme-aware tokens.
 */
export const styles = {
	footer: {
		borderTop: '1px solid',
		borderColor: 'divider',
		backgroundColor: 'background.paper',
		padding: '0.4rem 0.6rem',
		fontSize: '0.65rem',
		borderRadius: 0,
	},

	// Source node footer styles
	sourceFooterMain: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '0.5rem',
	},

	footerText: {
		fontSize: '0.65rem',
		color: 'text.secondary',
		fontWeight: 500,
	},

	expandButton: {
		padding: '0.2rem',
		transition: 'transform 0.2s',
		color: 'text.secondary',
	},

	expandedDetails: {
		paddingTop: '0.5rem',
		paddingLeft: '0.2rem',
		display: 'flex',
		flexDirection: 'column',
		gap: '0.3rem',
		borderTop: '1px solid',
		borderColor: 'divider',
		marginTop: '0.5rem',
	},

	detailRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '0.3rem',
		lineHeight: 1.4,
	},

	detailLabel: {
		fontSize: '0.45rem',
		color: 'text.secondary',
		fontWeight: 400,
		textAlign: 'left',
	},

	detailValue: {
		fontSize: '0.45rem',
		color: 'text.primary',
		fontWeight: 500,
		textAlign: 'left',
	},

	// Non-source node pipes progress styles
	pipesFooter: {
		display: 'flex',
		alignItems: 'center',
		gap: '0.5rem',
		width: '100%',
	},

	pipesLabel: {
		fontSize: '0.65rem',
		color: 'text.secondary',
		fontWeight: 400,
		minWidth: 'fit-content',
	},

	progressBarContainer: {
		flex: 1,
		minWidth: '60px',
	},

	progressBar: {
		height: '6px',
		borderRadius: '3px',
		backgroundColor: 'action.hover',
		'& .MuiLinearProgress-bar': {
			backgroundColor: 'success.main',
			borderRadius: '3px',
			transition: 'transform 0.1s ease-in-out !important',
		},
	},

	pipesCount: {
		fontSize: '0.65rem',
		color: 'text.primary',
		fontWeight: 500,
		minWidth: 'fit-content',
	},
};
