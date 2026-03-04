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

import { ReactNode } from 'react';
import { Box, Divider, IconButton, Typography, Tooltip } from '@mui/material';
import { Close, InfoOutlined, MenuBook } from '@mui/icons-material';
import pxToRem from '../../../../utils/pxToRem';
import { isInVSCode, getVSCodeColor } from '../../../../utils/vscode';
import { sanitizeAndParseHtmlToReact } from '../../helpers';


/** Static header height value expressed in rem, used for layout calculations. */
export const headerHeight = `${pxToRem(90)}rem`;

/**
 * Returns the header height string appropriate for the current host environment.
 * Inside VS Code the header is compact (36px); in the web app it uses the
 * standard rem-based height.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const getHeaderHeight = (): string =>
	isInVSCode() ? '36px' : `${pxToRem(90)}rem`;

/**
 * Props for the BasePanelHeader component that renders the top bar
 * of every side panel.
 */
export interface IProps {
	/** Panel title displayed prominently in the header. */
	title?: string;
	/** Optional icon rendered to the left of the title. */
	icon?: ReactNode;
	/** Callback invoked when the close button is clicked. */
	onClose?: () => void;
	/** Optional HTML description shown in an info tooltip. */
	description?: string;
	/** Optional URL to external documentation, opened in a new tab. */
	documentation?: string;
}

/**
 * Renders the header bar for side panels on the project canvas.
 * Displays a title with an optional icon, an info tooltip (when a
 * description is provided), a documentation link button, and a close
 * button. Adapts sizing and background color for VS Code embedding.
 *
 * @param title - Panel title text.
 * @param icon - Optional icon element rendered before the title.
 * @param onClose - Close button click handler.
 * @param description - HTML description displayed in an info tooltip.
 * @param documentation - External documentation URL.
 */
export default function BasePanelHeader({
	title,
	icon,
	onClose,
	description,
	documentation,
}: IProps): ReactNode {
	const inVSCode = isInVSCode();
	// Adapt the header background color to match the host environment's theme
	const headerBg = inVSCode
		? getVSCodeColor('--vscode-sideBarSectionHeader-background', '#00000015')
		: '#f2f2f7';

	return (
		<Box
			sx={{
				display: 'flex',
				backgroundColor: headerBg,
				p: inVSCode ? '0.5rem 0.75rem' : '1.5rem',
				height: getHeaderHeight(),
				justifyContent: 'space-between',
			}}
		>
			<Box sx={{ display: 'flex', alignItems: 'center', flex: 1 }}>
				{icon}
				<Typography variant="h5">{title}</Typography>
			</Box>
			<Box sx={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
				{description && (
					<Tooltip
						arrow
						placement="bottom"
						title={
							<Box sx={{ fontSize: '0.875rem', p: '0.25rem' }}>
								{sanitizeAndParseHtmlToReact(description)}
							</Box>
						}
					>
						<IconButton size={inVSCode ? 'small' : 'medium'}>
							<InfoOutlined />
						</IconButton>
					</Tooltip>
				)}
				{documentation && (
					<Tooltip arrow placement="bottom" title="View documentation">
						<IconButton
							size={inVSCode ? 'small' : 'medium'}
							href={documentation}
							target="_blank"
							rel="noopener noreferrer"
							component="a"
						>
							<MenuBook />
						</IconButton>
					</Tooltip>
				)}
				{(description || documentation) && (
					<Divider orientation="vertical" flexItem sx={{ mx: '0.25rem' }} />
				)}
				<IconButton size={inVSCode ? 'small' : 'medium'} onClick={onClose}>
					<Close />
				</IconButton>
			</Box>
		</Box>
	);
}
