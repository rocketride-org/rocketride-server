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

import { ReactNode } from 'react';
import { Box } from '@mui/material';
import { getHeaderHeight } from './BasePanelHeader';
import { SxProps } from '@mui/material';

/**
 * Props for the BasePanelContent component.
 * Allows custom styling overrides via the MUI `sx` prop.
 */
export interface IProps {
	/** Optional MUI sx overrides merged with the default scrollable container styles. */
	sx?: SxProps;
	children?: ReactNode;
}

/**
 * Scrollable content area for side panels on the project canvas.
 * Automatically subtracts the header height so the content fills the
 * remaining vertical space and scrolls independently. Used inside
 * every concrete panel alongside BasePanelHeader.
 *
 * @param sx - Optional MUI sx overrides.
 * @param children - Panel body content.
 */
export default function BasePanelContent({ sx, children }: IProps): ReactNode {
	return (
		<Box
			sx={{
				overflowY: 'auto',
				height: `calc(100% - ${getHeaderHeight()})`,
				...sx,
			}}
		>
			{children}
		</Box>
	);
}
