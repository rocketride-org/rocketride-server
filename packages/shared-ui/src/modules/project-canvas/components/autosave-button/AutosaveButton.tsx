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

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
	Button,
	Menu,
	MenuItem,
	Switch,
	Typography,
	ButtonGroup,
	ListItemText,
} from '@mui/material';
import { Sync } from '@mui/icons-material';
import SavedIcon from '../../../../assets/icons/SavedIcon';
import UnsavedIcon from '../../../../assets/icons/UnsavedIcon';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { IToolchainState } from '../../constants';
import styles from './index.style';
import { useFlow } from '../../FlowContext';
import { offBlack } from '../../../../theme';

/**
 * Props for the AutosaveButton component.
 * Configures the save behavior, autosave timing, and optional Save As action.
 */
interface AutosaveButtonProps {
	/** Debounce delay in milliseconds before autosave triggers after changes. */
	delay?: number;
	/** Callback to persist the current pipeline state. */
	saveChanges: () => void;
	/** Current toolchain state used to determine save/saving/saved/dragging status. */
	toolchainState: IToolchainState;
	/** Optional callback to open the Save As modal for renaming/duplicating the project. */
	onSaveAs?: () => void;
	/** When true, prevents the autosave toggle from being enabled. */
	disableAutosave?: boolean;
}

/**
 * Renders a split button with a primary save action and a dropdown menu for
 * toggling autosave and triggering Save As. When autosave is enabled, changes
 * are automatically persisted after the configured delay. The button displays
 * a spinning sync icon while saving and shows saved/unsaved status indicators.
 *
 * @param props - Save configuration, state, and callbacks.
 * @returns The rendered button group with dropdown menu, or null if autosave props are not provided by the host.
 */
export default function AutosaveButton({
	delay,
	saveChanges,
	toolchainState,
	onSaveAs,
	disableAutosave = false,
}: AutosaveButtonProps) {
	const { t } = useTranslation();
	// Read autosave state from the host via FlowContext; may be undefined if host does not support autosave
	const { isAutosaveEnabled: contextAutosave, onAutosaveEnabledChange: contextSetAutosave } =
		useFlow() as { isAutosaveEnabled?: boolean; onAutosaveEnabledChange?: (enabled: boolean) => void };

	// Anchor element for the dropdown menu positioning
	const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
	// Ref to the debounce timer so we can clear it on state changes or unmount
	const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	// Prevents retry loops: once a save fails, stop auto-saving until the next successful save
	const hasFailedRef = useRef(false);

	// When autosave is explicitly disabled by the host, force it off regardless of context state
	const isAutosaveEnabled = disableAutosave ? false : (contextAutosave ?? false);
	const setAutosaveEnabled = disableAutosave ? () => {} : contextSetAutosave;
	const open = Boolean(anchorEl);

	useEffect(() => {
		// Clear any pending autosave timer when dependencies change to avoid stale saves
		if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

		// Reset failure flag when save succeeds so autosave can resume
		if (toolchainState.isSaved) hasFailedRef.current = false;

		// Only schedule an autosave when: autosave is on, there are unsaved changes,
		// no save is already in progress, the user is not dragging nodes, and no prior failure
		if (
			isAutosaveEnabled &&
			!toolchainState.isSaved &&
			!toolchainState.isSaving &&
			!toolchainState.isDragging &&
			!hasFailedRef.current
		) {
			// Debounce the save call to avoid rapid-fire saves during quick edits
			saveTimeoutRef.current = setTimeout(async () => {
				try {
					await saveChanges();
				} catch {
					// Mark as failed to prevent infinite retry loops
					hasFailedRef.current = true;
				}
			}, delay);
		}

		// Cleanup: cancel the pending timer when the effect re-runs or the component unmounts
		return () => {
			if (saveTimeoutRef.current) {
				clearTimeout(saveTimeoutRef.current);
			}
		};
	}, [toolchainState.isSaved, toolchainState.isSaving, toolchainState.isDragging, isAutosaveEnabled, saveChanges, delay]);

	// When the host does not provide autosave props, the feature is unsupported; render nothing
	if (contextAutosave === undefined || contextSetAutosave === undefined) {
		return null;
	}

	/** Opens the dropdown menu anchored to the clicked button element. */
	const handleDropdownClick = (event: React.MouseEvent<HTMLButtonElement>) => {
		setAnchorEl(event.currentTarget);
	};

	/** Closes the dropdown menu. */
	const handleClose = () => {
		setAnchorEl(null);
	};

	/** Stops click propagation on menu items to prevent the menu from closing prematurely. */
	const handleMenuItemClick = (event: React.MouseEvent) => {
		event.stopPropagation();
	};

	/**
	 * Toggles the autosave feature on or off.
	 * When turning autosave off, any pending save timeout is cleared.
	 */
	const toggleAutosave = async (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
		// Prevent the click from bubbling up to the MenuItem and closing the menu
		event.stopPropagation();

		// Guard: the host may have disabled autosave toggling entirely
		if (disableAutosave) return;

		// Persist the new autosave preference to the host
		await setAutosaveEnabled?.(checked);

		// When disabling autosave, cancel any pending save timer immediately
		if (!checked) {
			if (saveTimeoutRef.current) {
				clearTimeout(saveTimeoutRef.current);
			}
		}
	};

	/** Closes the dropdown and triggers the Save As modal callback. */
	const handleSaveAs = () => {
		handleClose();
		if (onSaveAs) {
			onSaveAs();
		}
	};

	/** Returns the appropriate status icon based on the current save state (spinning, saved, or unsaved). */
	const getStatusIcon = () => {
		// Show a spinning icon during active save or when autosave is pending
		if (toolchainState.isSaving || (isAutosaveEnabled && !toolchainState.isSaved)) {
			return (
				<Sync
					sx={{
						animation: `${styles.spin} 1s linear infinite`,
					}}
				/>
			);
		}
		// Static icon: checkmark for saved state, warning for unsaved
		return toolchainState.isSaved ? <SavedIcon /> : <UnsavedIcon />;
	};

	/** Returns the localized button label text based on the current save state. */
	const getButtonText = () => {
		if (toolchainState.isSaving) return t('flow.autosave.saving');
		if (toolchainState.isSaved) return t('flow.autosave.saved');
		return t('flow.autosave.save');
	};

	// When autosave is active the button is always enabled (it shows status); otherwise disable only while save is in progress
	const disabled = isAutosaveEnabled ? false : toolchainState.isSaving;

	return (
		<>
			<ButtonGroup variant="text" sx={styles.buttonGroupStyles}>
				<Button
					startIcon={getStatusIcon()}
					onClick={isAutosaveEnabled ? undefined : saveChanges}
					disabled={isAutosaveEnabled || disabled}
					sx={{
						...styles.commonButtonStyles,
						...styles.mainButtonStyles,
					}}
				>
					<ListItemText
						sx={{
							color: offBlack,
							'& span': { fontWeight: 500 },
						}}
					>
						{getButtonText()}
					</ListItemText>
				</Button>
				<Button
					size="small"
					onClick={handleDropdownClick}
					disabled={disabled}
					sx={{
						...styles.commonButtonStyles,
						...styles.dropdownButtonStyles,
					}}
				>
					<ExpandMoreIcon />
				</Button>
			</ButtonGroup>

			<Menu
				anchorEl={anchorEl}
				open={open}
				onClose={handleClose}
				anchorOrigin={{
					vertical: 'bottom',
					horizontal: 'right',
				}}
				transformOrigin={{
					vertical: 'top',
					horizontal: 'right',
				}}
			>
				<MenuItem onClick={handleMenuItemClick}>
					<Typography variant="body2" sx={{ flex: 1 }}>
						{t('flow.autosave.autosave')}
					</Typography>
					<Switch
						checked={isAutosaveEnabled}
						onChange={toggleAutosave}
						onClick={(e) => e.stopPropagation()}
						size="small"
					/>
				</MenuItem>

				{onSaveAs && (
					<MenuItem onClick={handleSaveAs}>
						<Typography variant="body2">
							{t('flow.autosave.saveAsModal.title')}
						</Typography>
					</MenuItem>
				)}
			</Menu>
		</>
	);
}
