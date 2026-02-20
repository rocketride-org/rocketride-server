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

import { useEffect, useState, ChangeEvent, KeyboardEvent } from 'react';
import {
	Dialog,
	DialogTitle,
	DialogContent,
	DialogActions,
	Button,
	TextField,
} from '@mui/material';
import { useTranslation } from 'react-i18next';

/**
 * The operational mode of the RenameDialog, which determines the dialog's
 * title, placeholder text, and validation behaviour.
 */
type Mode = 'rename' | 'saveAs' | 'save';

/**
 * Props for the {@link RenameDialog} component.
 * Controls dialog visibility, mode, initial value, and save/close callbacks.
 */
interface IProps {
	/** Whether the dialog is currently visible. */
	isOpen: boolean;
	/** Dialog mode that determines labels and validation logic. Defaults to 'rename'. */
	mode?: Mode;
	/** Pre-populated value shown in the text field when the dialog opens. */
	initialValue?: string;
	/** Custom placeholder text for the text field, overriding mode-based defaults. */
	placeholder?: string;
	/** Callback invoked to close the dialog without saving. */
	handleClose: () => void;
	/** Callback invoked with the new name when the user confirms the save/rename action. */
	handleSave?: (name: string) => void;
}

/**
 * Renders a modal dialog for renaming or saving items.
 * Supports three modes: rename, saveAs, and save -- each with distinct labels
 * sourced from i18n translations. Validates that the entered name is non-empty
 * and differs from the original value. Supports Enter-key submission for
 * quick keyboard-driven workflows. Used for renaming toolchains, projects,
 * and other named entities.
 *
 * @param props - The component props conforming to {@link IProps}.
 * @returns An MUI Dialog containing a validated text input and cancel/save action buttons.
 */
const RenameDialog = ({
	isOpen = false,
	initialValue,
	placeholder,
	mode = 'rename',
	handleClose,
	handleSave,
}: IProps) => {
	const { t } = useTranslation();
	const [value, setValue] = useState(initialValue);
	const [errorMessage, setErrorMessage] = useState<string | undefined>();
	const [disabled, setDisabled] = useState(false);

	// Build mode-specific label sets so the same dialog component serves
	// rename, saveAs, and save workflows with appropriate i18n text
	const labels = {
		rename: {
			title: t('dialog.rename.title'),
			message: t('dialog.rename.placeholder'),
			placeholder: t('dialog.rename.placeholder'),
		},
		saveAs: {
			title: t('dialog.saveAs.title'),
			message: t('dialog.save.message'),
			placeholder: t('dialog.save.placeholder'),
		},
		save: {
			title: t('dialog.save.title'),
			message: t('dialog.save.placeholder'),
			placeholder: t('dialog.save.placeholder'),
		},
	};

	const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
		const _value = event?.target?.value;
		setValue(_value);

		// Reject empty names -- disable save and show a validation error
		if (!_value || _value.length === 0) {
			setDisabled(true);
			setErrorMessage(t('common.errorEmptyName'));
			return;
		}

		// Reject unchanged names to prevent no-op renames
		if (_value === initialValue) {
			setDisabled(true);
			setErrorMessage(t('common.errorExistingName'));
			return;
		}

		// Input is valid -- clear any previous error and enable save
		setDisabled(false);
		setErrorMessage('');
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		// Allow Enter key as a shortcut to submit, but only when the value is valid
		if (event.key === 'Enter' && !disabled) {
			event.preventDefault();
			handleOnSave();
		}
	};

	const handleOnSave = () => {
		// Guard: bail out if no save handler was provided or the form is invalid
		if (!handleSave || disabled) {
			return;
		}

		handleSave(value ?? '');
	};

	// Reset the text field value whenever the dialog opens or the initial value changes,
	// ensuring the user always starts from the latest name
	useEffect(() => {
		setValue(initialValue ?? '');
	}, [isOpen, initialValue]);

	return (
		<Dialog open={isOpen} onClose={handleClose} maxWidth="sm" fullWidth>
			<DialogTitle sx={{ textTransform: 'capitalize' }}>{labels[mode].title}</DialogTitle>
			<DialogContent>
				<TextField
					required
					autoComplete="off"
					autoFocus
					value={value}
					error={!!errorMessage}
					helperText={errorMessage}
					fullWidth
					onChange={(e) => handleChange(e)}
					onKeyDown={handleKeyDown}
					variant="standard"
					label={placeholder || labels[mode].placeholder}
				/>
			</DialogContent>
			<DialogActions>
				<Button
					color="error"
					onClick={() => {
						// Clear the input value before closing to reset state for next open
						setValue('');
						handleClose();
					}}
				>
					{t('dialog.save.cancel')}
				</Button>
				<Button color="info" onClick={handleOnSave} disabled={disabled}>
					{t('dialog.save.accept')}
				</Button>
			</DialogActions>
		</Dialog>
	);
};

export default RenameDialog;
