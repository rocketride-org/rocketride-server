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

import { useEffect, useState } from 'react';
import {
	Typography,
	Stack,
	IconButton,
	Divider,
	List,
	ListItem,
	ListItemIcon,
	ListItemText,
	SxProps,
	Theme,
	Tooltip,
} from '@mui/material';
import { useFlow } from '../FlowContext';
import { Edit, Circle } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import AutosaveButton from './autosave-button/AutosaveButton';
import theme, { offBlack } from '../../../theme';
import { Option } from '../../../types/ui';
import { useRocketRideMediaQuery } from '../../../hooks/useRocketRideMediaQuery';
import SaveAsModal from '../../../components/saveas-form/SaveAsModal';
import { ShortcutsDropdown } from './KeyboardShortcutsDisplay';

/** Default header height for standard screen sizes. */
export const HEADER_HEIGHT = '3.7rem';

/** Taller header height used on extra-large screens for better spacing. */
export const XL_HEADER_HEIGHT = '4.8rem';

/**
 * Props for the CanvasHeader component.
 * Configures the header bar displayed above the pipeline canvas, including
 * the project name, connection status, autosave controls, and action options.
 */
export interface CanvasHeaderProps {
	/** The type of item being edited (e.g., "pipeline"), used in the Save As modal. */
	itemType: string;
	/** When true, disables the autosave toggle and functionality. */
	disableAutosave?: boolean;
	/** When true, hides the description field in the Save As modal. */
	hideDescription?: boolean;
	/** Validation error message to display on the name field in the Save As modal. */
	nameFieldError?: string;
	/** Additional MUI sx styles applied to the root header Stack. */
	rootStyles?: SxProps<Theme>;
	/** Callback to open the templates browser. */
	handleOpenTemplates?: () => void;
	/** Whether the engine/client is currently connected. Shows a status indicator dot. */
	isConnected?: boolean;
	/** Callback invoked when the user discards a new unsaved project. */
	onDiscard?: () => void;
	/** Controls initial visibility of the Save As modal. */
	showSaveAsModal: boolean;
	/** Additional action options rendered as clickable list items in the header. */
	options?: Option[];
}

/**
 * Renders the header bar above the project canvas containing the project name,
 * connection status indicator, keyboard shortcuts dropdown, custom action options,
 * and the autosave/save button group. Also manages the Save As modal for renaming
 * or duplicating the current project.
 *
 * @param props - Configuration for the header display and actions.
 * @returns The rendered canvas header with save controls and optional modals.
 */
const CanvasHeader = ({
	itemType,
	disableAutosave = false,
	hideDescription = false,
	nameFieldError,
	rootStyles,
	isConnected,
	onDiscard,
	showSaveAsModal,
	options = [],
}: CanvasHeaderProps) => {
	// Responsive breakpoints to adapt header spacing and layout
	const { screenIsBelowXLarge, screenIsAboveMedium } = useRocketRideMediaQuery();
	const { t } = useTranslation();
	// Local state mirrors the prop to allow opening the modal from internal actions (e.g., edit icon)
	const [_showSaveAsModal, setShowSaveAsModal] = useState(showSaveAsModal);

	const { saveChanges, currentProject, toolchainState } = useFlow();

	// Fall back to empty strings if pipeline metadata is not yet available
	const name = currentProject?.name ?? '';
	const description = currentProject?.description ?? '';

	// Sync the external prop to local state whenever the parent changes it
	useEffect(() => setShowSaveAsModal(showSaveAsModal), [showSaveAsModal]);

	return (
		<>
			<Stack
				direction="row"
				justifyContent="space-between"
				alignItems="center"
				px={'2rem'}
				sx={{
					backgroundColor: 'white',
					height: screenIsBelowXLarge ? XL_HEADER_HEIGHT : HEADER_HEIGHT,
					borderBottom: '1px solid rgba(0, 0, 0, 0.12)',
					...rootStyles,
				}}
			>
				<Stack direction="row" alignItems="center" gap="0.5rem">
					{isConnected !== undefined && (
						<Tooltip
							title={
								isConnected
									? t('common.rocketrideClient.connected')
									: t('common.rocketrideClient.disconnected')
							}
						>
							<Circle
								sx={{
									fontSize: '0.75rem',
									color: isConnected ? '#4caf50' : '#f44336',
								}}
							/>
						</Tooltip>
					)}
					<Typography
						sx={{
							cursor: 'initial',
							color: '#000',
							fontWeight: 600,
						}}
						variant="h5"
					>
						{name}
					</Typography>
					<IconButton onClick={() => setShowSaveAsModal(true)}>
						<Edit sx={{ fill: offBlack }} />
					</IconButton>
				</Stack>

				<Stack
					direction="row"
					alignItems="center"
					gap="1rem"
					divider={<Divider orientation="vertical" flexItem />}
				>
					<List
						sx={{
							display: 'flex',
							flex: 1,
							flexDirection: 'row',
							gap: screenIsAboveMedium ? '2rem' : '1rem',
						}}
					>
						<ShortcutsDropdown />
						{options.map((option) => (
							<ListItem
								disablePadding
								key={option.label}
								onClick={option.handleClick}
								sx={{
									cursor: 'pointer',
									'&:hover span': {
										color: theme.palette.primary.dark,
									},
									'&:hover svg': {
										fill: theme.palette.primary.dark,
										transition: 'none',
									},
								}}
							>
								<ListItemIcon
									sx={{
										display: 'inline-block',
										minWidth: 'unset',
										mr: '0.5rem',
										'& svg': { fill: offBlack },
										...(option.compact && {
											ml: '-0.7rem',
											mr: '0.3rem',
										}),
									}}
								>
									{option.icon}
								</ListItemIcon>
								<ListItemText
									primary={option.label}
									sx={{
										whiteSpace: 'nowrap',
										display: 'inline-block',
										color: offBlack,
										'& span': { fontWeight: 500 },
									}}
								/>
							</ListItem>
						))}
					</List>
					<AutosaveButton
						delay={500}
						saveChanges={saveChanges}
						toolchainState={toolchainState}
						disableAutosave={disableAutosave}
						onSaveAs={() => setShowSaveAsModal(true)}
					/>
				</Stack>
			</Stack>
			<SaveAsModal
				open={_showSaveAsModal}
				itemType={itemType}
				onClose={() => setShowSaveAsModal(false)}
				name={name}
				description={description || ''}
				nameFieldError={nameFieldError}
				mode="saveAs"
				hideDescription={hideDescription}
				handleSave={async (name, description) => { await saveChanges({ name, description }); }}
				onDiscard={onDiscard}
				showDiscard={!currentProject.project_id}
			/>
		</>
	);
};

export default CanvasHeader;
