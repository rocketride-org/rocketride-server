// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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
 * Style definitions for the NodeHeader component.
 *
 * Provides layout, sizing, and theming for the header container, node icon,
 * title text, label/image/edit button boxes, and the settings gear icon.
 * These styles ensure the header renders consistently across all node types
 * on the project canvas.
 */
const styles = {
	header: {
		display: 'flex',
		alignItems: 'center',
		borderRadius: 0,
		justifyContent: 'space-between',
		padding: '0.15rem 0.25rem 0.4rem 0.6rem',
		width: '100%',
		backgroundColor: 'background.paper',
	},
	nodeIcon: {
		width: 'auto',
		height: '1rem',
		marginRight: '0.5rem',
		fill: 'text.secondary',
	},
	title: {
		fontWeight: 500,
		fontSize: '0.6rem',
	},
	boxImage: {
		display: 'flex',
		alignItems: 'center',
		minWidth: '1rem',
	},
	boxLabel: {
		overflow: 'hidden',
		flex: 4,
	},
	boxEdit: {
		display: 'flex',
	},
	editButton: {
		padding: 0,
	},
	editIcon: {
		height: '1rem',
		width: 'auto',
		fill: 'text.secondary',
	},
};

export default styles;
