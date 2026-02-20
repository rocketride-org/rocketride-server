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

import { MouseEvent, ReactNode, useEffect, useRef, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Tooltip from '@mui/material/Tooltip';
import { Variant } from '@mui/material/styles/createTypography';
import { SxProps } from '@mui/material';
import { isInVSCode } from '../../../../../utils/vscode';

/**
 * Props for the CreateNodeGroup accordion component that groups
 * related node items (e.g. "Source", "LLM") in the add-node panel.
 */
export interface IProps {
	/** Section title displayed in the accordion header. */
	title: string;
	/** MUI Typography variant for the title. */
	titleVariant?: Variant;
	/** CSS font-weight for the title. */
	titleWeight?: string;
	/** Optional tooltip text shown on hover over the title. */
	tooltip?: string;
	children?: ReactNode;
	/** Optional MUI sx overrides applied to the root Accordion. */
	rootSx?: SxProps;
	/** Whether the accordion starts in the expanded state. */
	expanded?: boolean;
}

/**
 * Renders a collapsible accordion section in the "Add Node" panel.
 * Each group contains a category of pipeline nodes (e.g. Source, LLM,
 * Database). The accordion can be expanded/collapsed by clicking the
 * header, and an optional tooltip provides a description of the category.
 *
 * @param tooltip - Descriptive text shown on hover.
 * @param titleVariant - Typography variant; auto-selected based on host.
 * @param titleWeight - Font weight for the title text.
 * @param title - Group section title.
 * @param children - CreateNodeItem components rendered inside the section.
 * @param rootSx - Additional sx styles for the Accordion root.
 * @param expanded - Initial expanded state.
 */
export default function CreateNodeGroup({
	tooltip = '',
	titleVariant,
	titleWeight = 'bold',
	title,
	children,
	rootSx,
	expanded = true,
}: IProps): ReactNode {
	const inVSCode = isInVSCode();
	const variant = titleVariant || (inVSCode ? 'h5' : 'h2');
	const textTransform = inVSCode ? 'uppercase' : 'capitalize';
	const detailsRef = useRef<HTMLDivElement>(null);
	const [isExpanded, setIsExpanded] = useState(expanded);

	/**
	 * Builds the title element, optionally wrapping it in a Tooltip
	 * when tooltip text is provided.
	 */
	const buildTitle = () => {
		const titleNode = (
			<Typography
				variant={variant}
				component="span"
				fontWeight={titleWeight}
				textTransform={textTransform}
			>
				{title}
			</Typography>
		);

		if (tooltip) {
			return (
				<Tooltip
					arrow
					placement="left"
					title={tooltip}
					slotProps={{
						tooltip: {
							sx: {
								fontSize: '1rem', // Increase from default 0.75rem
							},
						},
					}}
				>
					{titleNode}
				</Tooltip>
			);
		}

		return titleNode;
	};

	useEffect(() => {
		setIsExpanded(expanded);
	}, [expanded]);

	return (
		<Accordion
			expanded={isExpanded}
			disableGutters
			elevation={0}
			onClick={(event: MouseEvent<HTMLDivElement>) => {
				if (detailsRef.current && detailsRef.current.contains(event.target as Node)) {
					return;
				}

				setIsExpanded(!isExpanded);
			}}
			sx={{
				boxShadow: 'none',
				border: 'none',
				'& .MuiCollapse-root': {
					transition: 'none !important',
				},
				'& .MuiAccordion-region': {
					transition: 'none !important',
				},
				'&:before': {
					display: 'none',
				},
				...rootSx,
			}}
		>
			<AccordionSummary
				expandIcon={
					<ExpandMoreIcon sx={inVSCode ? { fontSize: 18 } : undefined} />
				}
				sx={{
					p: 0,
					m: 0,
					minHeight: inVSCode ? '22px' : undefined,
					...(inVSCode && { py: '2px' }),
					border: 'none',
					'.MuiAccordionSummary-content': {
						p: 0,
						m: 0,
					},
				}}
			>
				{buildTitle()}
			</AccordionSummary>
			<AccordionDetails
				sx={{ p: 0, display: 'flex', flexDirection: 'column' }}
				ref={detailsRef}
			>
				{children}
			</AccordionDetails>
		</Accordion>
	);
}
