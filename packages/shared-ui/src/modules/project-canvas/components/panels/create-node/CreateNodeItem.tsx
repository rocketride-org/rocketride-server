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

import React, { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { grey } from '@mui/material/colors';
import { Button, Tooltip } from '@mui/material';
import { sanitizeAndParseHtmlToReact } from '../../../helpers';
import { debounce } from 'lodash';
import { brandOrange } from '../../../../../theme';
import { useTranslation } from 'react-i18next';
import { isInVSCode } from '../../../../../utils/vscode';

/**
 * Props for the CreateNodeItem component representing a single draggable/clickable
 * node entry in the "Add Node" panel.
 */
export interface IProps {
	/** Display name of the node type. */
	title: string;
	/** URL or data-URI of the node icon image. */
	icon: string;
	/** Optional HTML description displayed in a tooltip on hover. */
	description?: string;
	/** Optional URL to external documentation for this node type. */
	documentation?: string;
	/** Whether the item is fully disabled (no interaction). */
	disabled?: boolean;
	/** Whether the item is disabled due to an invalid subscription plan. */
	disabledInvalidPlan?: boolean;
	/** Callback invoked when the item is clicked to add it to the canvas. */
	onClick: () => void;
	/** Callback invoked when the user starts dragging the item onto the canvas. */
	onDragStart: (event: React.DragEvent) => void;
}

/**
 * Renders a single node type entry in the "Add Node" panel. The item
 * displays an icon and title, supports click-to-add and drag-to-add
 * interactions, and shows a description tooltip on hover. Items can be
 * disabled when the user's plan does not support the node type or when
 * actions are globally disabled.
 *
 * @param title - Node type display name.
 * @param icon - Node icon image URL.
 * @param description - HTML description for tooltip.
 * @param documentation - External documentation link.
 * @param disabled - Fully disables the item.
 * @param disabledInvalidPlan - Dims the item for plan-gated nodes.
 * @param onClick - Click handler to add the node.
 * @param onDragStart - Drag-start handler for drag-to-add.
 */
export default function CreateNodeItem({
	title,
	icon,
	description,
	documentation,
	disabled,
	disabledInvalidPlan,
	onClick,
	onDragStart,
}: IProps): ReactNode {
	const { t } = useTranslation();

	const _icon = <img src={icon} style={{ width: '100%', objectFit: 'cover', filter: icon?.includes('#td') ? 'var(--icon-filter)' : undefined }} />;

	const inVSCode = isInVSCode();

	/** Styles applied when the item is fully disabled (no pointer events). */
	const disabledSx = {
		pointerEvents: 'none',
		opacity: 0.4,
	};

	/** Styles applied when the item is disabled due to an invalid subscription plan. */
	const disabledInvalidPlanSx = {
		opacity: 0.4,
	};

	// Base row styles adapt padding and hover color for VS Code vs. web app environments
	let sx = {
		display: 'flex',
		alignItems: 'center',
		minHeight: inVSCode ? '22px' : undefined,
		p: inVSCode ? '0 8px' : '.75rem',
		cursor: 'pointer',
		borderRadius: '.5rem',
		'&:hover': {
			background: inVSCode
				? 'var(--vscode-list-hoverBackground, rgba(0,0,0,0.04))'
				: grey[100],
		},
	};

	// Merge in disabled styles based on the two independent disabled conditions
	sx = disabled ? { ...sx, ...disabledSx } : sx;
	sx = disabledInvalidPlan ? { ...sx, ...disabledInvalidPlanSx } : sx;

	/** Handles the click event, blocking interaction for plan-gated items. */
	const handleOnClick = () => {
		// Plan-gated items remain visible but clicks are silently blocked
		if (disabledInvalidPlan) return;
		else onClick();
	};

	/** Allows keyboard activation via the Enter key for accessibility. */
	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === 'Enter') handleOnClick();
	};

	/** Renders the core clickable/draggable item row with icon and title. */
	const component = () => (
		<Box
			sx={sx}
			onClick={debounce(() => handleOnClick(), 500)}
			onDragStart={onDragStart}
			draggable={!disabledInvalidPlan}
			tabIndex={0}
			role="button"
			onKeyDown={handleKeyDown}
		>
			<Box
				sx={{
					width: inVSCode ? '16px' : '1.5rem',
					height: inVSCode ? '16px' : '1.5rem',
					mr: inVSCode ? '8px' : '1rem',
					display: 'flex',
					justifyContent: 'center',
					alignItems: 'center',
				}}
			>
				{_icon}
			</Box>
			<Typography variant="body1" component="span">
				{title}
			</Typography>
		</Box>
	);

	// When a description is provided, wrap the item in a Tooltip showing
	// the sanitized HTML description and an optional documentation link
	if (description) {
		// Normal tooltip content: sanitized description + documentation link
		const _descriptionContent = (
			<>
				{sanitizeAndParseHtmlToReact(description)}
				{documentation && (
					<Button
						href={documentation}
						target="_blank"
						rel="noopener noreferrer"
						sx={{ textTransform: 'capitalize', mt: '1rem' }}
					>
						{t('flow.panels.createNode.documentation')} <br />
						{title}
					</Button>
				)}
			</>
		);
		// Alternate tooltip content for plan-gated items: upgrade prompt instead of description
		const _descriptionInvalidPlanContent = (
			<>
				<span>{t('flow.panels.createNode.planInvalid')}</span>
				{documentation && (
					<Button
						href={documentation}
						target="_blank"
						rel="noopener noreferrer"
						sx={{
							textTransform: 'capitalize',
							mt: '1rem',
							pointerEvents: 'none',
							opacity: 0.4,
						}}
					>
						{t('flow.panels.createNode.planUpgrade')}
					</Button>
				)}
			</>
		);
		// Styled tooltip container that adapts link styling for VS Code vs. web app
		const _description = (
			<Box
				sx={{
					px: '0.2rem',
					py: '0.5rem',
					fontWeight: inVSCode ? 400 : undefined,
					...(inVSCode && {
						fontFamily: 'var(--vscode-font-family)',
						fontSize: 'var(--vscode-font-size, 12px)',
					}),
					'& a': inVSCode
						? {
								color: 'var(--vscode-textLink-foreground)',
								textDecoration: 'underline',
							}
						: {
								textAlign: 'center',
								display: 'flex',
								flexDirection: 'column',
								background: brandOrange,
								borderRadius: '0.2rem',
								px: '0.5rem',
								py: '0.4rem',
								fontSize: '0.9rem',
							},
				}}
			>
				{!disabledInvalidPlan ? _descriptionContent : _descriptionInvalidPlanContent}
			</Box>
		);

		return (
			<Tooltip
				arrow
				title={_description}
				placement="left"
				slotProps={{
					tooltip: {
						sx: {
							fontSize: inVSCode ? 'var(--vscode-font-size, 12px)' : '1rem',
							fontWeight: 400,
							...(inVSCode && { fontFamily: 'var(--vscode-font-family)' }),
						},
					},
				}}
			>
				{component()}
			</Tooltip>
		);
	}

	// No description -- render the item without a tooltip wrapper
	return component();
}
