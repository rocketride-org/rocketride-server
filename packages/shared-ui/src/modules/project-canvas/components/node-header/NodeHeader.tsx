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

import { ReactElement } from 'react';
import { Box, IconButton, SxProps, Tooltip, Typography } from '@mui/material';
import { Settings } from '@mui/icons-material';
import { red } from '@mui/material/colors';

import styles from './index.style';
import { styles as nodeStyles } from '../nodes/node/index.style';
import { NodeType } from '../../../../constants';
import MoreMenu from '../more-menu/MoreMenu';
import { Option } from '../../../../types/ui';
import { sanitizeAndParseHtmlToReact } from '../../helpers';
import { isInVSCode } from '../../../../utils/vscode';

/**
 * Props for the NodeHeader component.
 *
 * Configures the visual appearance of the node header bar (icon, title, description),
 * the set of "more options" menu entries, and callbacks for click and edit interactions.
 */
interface IProps {
	/** Menu option definitions for the "more" overflow menu. */
	options: Option[];
	/** When true the settings/edit gear icon is hidden. */
	hideEdit?: boolean;
	/** The node type, available for conditional rendering but not currently used in this component. */
	nodeType?: NodeType;
	/** URL of the node icon image displayed to the left of the title. */
	icon?: string;
	/** Display name shown in the header; may be the node ID when dev-mode is active. */
	title?: string;
	/** HTML description shown in a tooltip when hovering over the title. */
	description?: string;
	/** When true the tooltip is suppressed (tooltips do not work well during drag). */
	isDragging?: boolean;
	/** When true the more-menu trigger button is disabled. */
	disableMoreMenu?: boolean;
	/** Optional MUI sx overrides applied to the root header container. */
	rootSx?: SxProps;
	/** When false the settings icon is tinted red to indicate invalid form data. */
	formDataValid?: boolean;
	/** Click handler for the entire header row (e.g. to select the node). */
	handleClick?: () => void;
	/** Click handler for the settings gear icon to open the node editor panel. */
	handleEdit?: () => void;
	/** Class type tags for the node (e.g. ["llm"]), shown as a subtitle below the title. */
	classType?: string[];
}

/**
 * Presentational header bar rendered at the top of every canvas node.
 *
 * Displays the node icon, title (with an optional rich-HTML tooltip showing
 * the description), a settings/edit gear button, and a "more options" overflow
 * menu. This is a pure display component -- business logic such as which options
 * to show and what happens on edit is controlled by the parent (typically
 * ProjectNodeHeader).
 *
 * @param props - Visual configuration, menu options, and interaction callbacks.
 * @returns The rendered node header bar element.
 */
export default function NodeHeader({
	options,
	hideEdit = false,
	icon,
	title,
	description,
	isDragging,
	disableMoreMenu,
	rootSx,
	formDataValid,
	handleClick,
	handleEdit,
	classType,
}: IProps): ReactElement {
	const inVSCode = isInVSCode();
	const subtitleText = classType?.length ? classType.join(' · ') : undefined;
	const titleElement = (
		<Box>
			<Typography
				sx={{
					...styles.title,
					...nodeStyles.label,
				}}
			>
				{title}
			</Typography>
			{subtitleText && (
				<Typography sx={styles.subtitle}>
					{subtitleText}
				</Typography>
			)}
		</Box>
	);

	return (
		<Box sx={{ ...styles.header, ...rootSx }} onClick={handleClick}>
			{icon && (
				<Box sx={styles.boxImage}>
					<img style={styles.nodeIcon} width="auto" src={icon} />
				</Box>
			)}
			<Box sx={styles.boxLabel}>
				{description && !isDragging ? (
					<Tooltip
						enterDelay={700}
						arrow
						placement="top"
						title={
							<Box
								sx={{
									fontSize: inVSCode ? 'var(--vscode-font-size, 12px)' : '0.75rem',
									fontFamily: inVSCode ? 'var(--vscode-font-family)' : undefined,
									fontWeight: 400,
									p: '0.25rem',
									'& a': {
										color: inVSCode
											? 'var(--vscode-textLink-foreground)'
											: undefined,
										textDecoration: 'underline',
									},
								}}
							>
								{sanitizeAndParseHtmlToReact(description)}
							</Box>
						}
						slotProps={{
							tooltip: {
								sx: {
									maxWidth: 300,
									fontWeight: 400,
									...(inVSCode && {
										fontFamily: 'var(--vscode-font-family)',
										fontSize: 'var(--vscode-font-size, 12px)',
									}),
								},
							},
						}}
					>
						{titleElement}
					</Tooltip>
				) : (
					titleElement
				)}
			</Box>
			<Box sx={styles.boxEdit}>
				{!hideEdit && (
					<IconButton
						aria-label="Edit node"
						sx={styles.editButton}
						onClick={handleEdit}
						disabled={disableMoreMenu}
					>
						<Settings
							fontSize="small"
							sx={{
								...styles.editIcon,
								fill: formDataValid === false ? red[500] : '',
							}}
						/>
					</IconButton>
				)}
				{options && (
					<MoreMenu buttonSx={{ padding: 0 }} options={options} isDisabled={false} />
				)}
			</Box>
		</Box>
	);
}
