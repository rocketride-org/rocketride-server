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

/** MUI sx styles for the SearchPanel root Paper container. Adds margin, padding, shadow, and horizontal flex layout. */
export const panelStyles = {
	margin: '15px',
	padding: '10px',
	backgroundColor: 'background.paper',
	boxShadow:
		'rgba(0, 0, 0, 0.2) 0px 3px 1px -2px, rgba(0, 0, 0, 0.14) 0px 2px 2px 0px, rgba(0, 0, 0, 0.12) 0px 1px 5px 0px',
	borderRadius: '4px',
	display: 'flex',
	alignItems: 'center',
	gap: '8px',
	height: '60px',
};

/** MUI sx styles for the search TextField. Removes the default underline decoration to create a clean inline input. */
export const textFieldStyles = {
	width: '180px',
	'& .MuiInput-underline:before': {
		borderBottom: 'none',
	},
	'& .MuiInput-underline:after': { borderBottom: 'none' },
	'& .MuiInput-underline:hover:not(.Mui-disabled):before': {
		borderBottom: 'none',
	},
};

/** MUI sx styles for the search result counter text. Ensures a minimum width so the layout does not shift. */
export const textStyles = { minWidth: '50px' };
