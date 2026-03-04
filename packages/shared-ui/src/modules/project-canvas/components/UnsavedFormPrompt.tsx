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

import { ChangeEvent, useState } from 'react';
import {
	Dialog,
	DialogContent,
	DialogContentText,
	DialogActions,
	Button,
	Box,
	FormControlLabel,
	Checkbox,
	Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';

/**
 * Props for the UnsavedFormPrompt component.
 * Controls the dialog visibility and provides callbacks for user actions.
 */
interface IProps {
	/** Whether the unsaved-changes dialog is currently open. */
	isOpen: boolean;
	/** Callback to close the dialog without accepting changes. */
	onClose: () => void;
	/** Callback invoked when the user opts to not show this prompt again. */
	onCheck: () => void;
	/** Callback invoked when the user accepts leaving with unsaved changes. */
	onAccept: () => void;
}

/**
 * Renders a confirmation dialog warning the user about unsaved form changes.
 * Includes a "don't show again" checkbox so the user can suppress future prompts.
 * Used when navigating away from a form (e.g., node configuration) that has
 * pending unsaved modifications.
 *
 * @param props - Dialog state and action callbacks.
 * @returns The rendered confirmation dialog.
 */
const UnsavedFormPrompt = ({ isOpen = false, onClose, onCheck, onAccept }: IProps) => {
	const { t } = useTranslation();

	// Track the "don't show again" checkbox state locally within the dialog lifecycle
	const [isChecked, setIsChecked] = useState(false);

	/**
	 * Handles the user accepting the unsaved changes prompt.
	 * If the "don't show again" checkbox is checked, invokes the onCheck callback
	 * to persist that preference. Then fires onAccept and closes the dialog.
	 */
	const handleAccept = () => {
		// Persist the "don't show again" preference before accepting
		if (isChecked) {
			onCheck();
		}

		// Fire the accept callback to proceed with the navigation, then close the dialog
		onAccept();
		onClose();
	};

	return (
		<Dialog open={isOpen} onClose={onClose} maxWidth="sm">
			<DialogContent>
				<DialogContentText>{t('dialog.leave.message')}</DialogContentText>
			</DialogContent>
			<DialogActions sx={{ flexDirection: 'column', alignItems: 'unset' }}>
				<Box sx={{ margin: 0 }}>
					<FormControlLabel
						sx={{ mb: 0, mx: 0 }}
						control={
							<Checkbox
								className="MuiDialogContentText-root"
								checked={isChecked}
								onChange={(event: ChangeEvent<HTMLInputElement>) =>
									setIsChecked(event.target.checked)
								}
							/>
						}
						label={
							<Typography variant="body1" color="text.secondary">
								{t('dialog.leave.dontShowAgain')}
							</Typography>
						}
					/>
				</Box>
				<Box
					sx={{
						display: 'flex',
						justifyContent: 'flex-end',
					}}
				>
					<Button color="error" onClick={onClose}>
						{t('dialog.leave.cancelText')}
					</Button>
					<Button color="info" onClick={handleAccept}>
						{t('dialog.leave.acceptText')}
					</Button>
				</Box>
			</DialogActions>
		</Dialog>
	);
};

export default UnsavedFormPrompt;
