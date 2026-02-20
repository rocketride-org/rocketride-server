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

import { isInVSCode } from '../../../../utils/vscode';
import { styles as nodeStyles } from '../nodes/node/index.style';

/** Whether the UI is running inside the VS Code webview, used to adapt lane styling. */
const inVSCode = isInVSCode();

/**
 * Style definitions for the Lanes component.
 *
 * Provides layout and theming for the lanes container, individual connection rows,
 * lane labels, and body text. Styles adapt for VS Code environments where padding,
 * background colors, and border treatments differ from the standalone web app.
 */
const styles = {
	lanes: {
		padding: inVSCode ? '0.25rem 0' : '0.45rem 0',
		position: 'relative',
		display: 'flex',
		...(inVSCode
			? {
					backgroundColor: 'background.default',
					borderRadius: '0.2rem',
				}
			: {}),
		...(!inVSCode
			? {
					'&:not(:first-of-type)': {
						borderTop: '1px solid #DCDCDC',
					},
				}
			: {}),
	},
	connections: {
		width: '100%',
		alignItems: 'center',
	},
	connectionBox: {
		flex: 1,
	},
	connectionType: {
		position: 'relative',
		textTransform: 'capitalize',
		display: 'flex',
	},
	body: {
		fontSize: '0.5rem',
		color: inVSCode ? 'text.disabled' : '#838383',
	},
	label: {
		...nodeStyles.label,
		width: 'fit-content',
		backgroundColor: 'background.default',
		padding: '0.3rem 0.4rem',
	},
};

export default styles;
