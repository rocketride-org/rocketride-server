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

import { useState, useEffect } from 'react';
import {
	Dialog,
	DialogTitle,
	DialogContent,
	DialogActions,
	TextField,
	Button,
	Box,
	IconButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useTranslation } from 'react-i18next';

import pxToRem from '../../utils/pxToRem';

/**
 * Props for the {@link SaveAsModal} component.
 * Controls the dialog's visibility, mode, pre-filled values, validation errors,
 * and the save/discard/close action callbacks.
 */
interface SaveAsModalProps {
	/** Whether the modal dialog is currently visible. */
	open: boolean;
	/** Human-readable type of the item being saved (e.g., "pipeline", "toolchain"), shown in labels. */
	itemType: string;
	/** Whether this is a direct save or a "save as" operation, affecting required fields and button labels. */
	mode: 'save' | 'saveAs';
	/** Optional custom dialog title, overriding the mode-based default. */
	title?: string;
	/** Pre-populated name value for the name text field. */
	name?: string;
	/** Pre-populated description value for the description text field. */
	description?: string;
	/** When true, the description field is hidden (e.g., for items that do not support descriptions). */
	hideDescription?: boolean;
	/** External validation error message displayed below the name field. */
	nameFieldError?: string;
	/** Callback invoked to close the modal without saving. */
	onClose: () => void;
	/** Async callback invoked with the name and description when the user confirms the save action. */
	handleSave: (name?: string, description?: string) => Promise<void>;
	/** Optional callback invoked when the user clicks the discard button. */
	onDiscard?: () => void;
	/** Whether to show the discard button alongside cancel and save. */
	showDiscard?: boolean;
}

/**
 * Renders a modal dialog for saving or "save-as" operations on named items.
 * Features a name field (required in saveAs mode), an optional description field
 * with a typewriter-effect placeholder, and action buttons for save, cancel, and
 * optionally discard. Supports Cmd/Ctrl+Enter keyboard shortcut for quick submission.
 * Used in the project canvas autosave flow and pipeline/toolchain save workflows.
 *
 * @param props - The component props conforming to {@link SaveAsModalProps}.
 * @returns An MUI Dialog with name/description fields and action buttons.
 */
export default function SaveAsModal({
	open,
	mode,
	itemType,
	title,
	name: _name = '',
	description: _description = '',
	nameFieldError = '',
	hideDescription = false,
	onClose,
	handleSave,
	onDiscard,
	showDiscard = false,
}: SaveAsModalProps) {
	const { t } = useTranslation();

	const [name, setName] = useState(_name);
	const [description, setDescription] = useState(_description);
	// Holds the progressively revealed placeholder string for the typewriter effect
	const [placeholderText, setPlaceholderText] = useState('');
	// Tracks async save in progress to disable form controls and prevent double-submit
	const [loading, setLoading] = useState(false);

	// Use the explicit title prop when provided; otherwise pick a mode-based default
	const modalTitle =
		title || (mode === 'save' ? t('dialog.save.title') : t('dialog.saveAs.title'));

	useEffect(() => {
		// When the modal closes, clear the placeholder so it restarts on next open
		if (!open) {
			setPlaceholderText('');
			return;
		}

		// Reset name field to the prop value each time the modal opens
		setName(_name);

		// Skip description-related logic when the description field is hidden
		if (hideDescription) return;

		setDescription(_description);

		// Retrieve the array of possible placeholder messages from i18n
		const PLACEHOLDER_MESSAGES = t('flow.autosave.saveAsModal.descriptionPlaceholders', {
			returnObjects: true,
		}) as string[];

		// Randomly select one message so the user sees variety across opens
		const randomMessage =
			PLACEHOLDER_MESSAGES[Math.floor(Math.random() * PLACEHOLDER_MESSAGES.length)];

		let index = 0;
		setPlaceholderText('');

		// Reveal the placeholder one character at a time at 15ms intervals
		const timer = setInterval(() => {
			if (index < randomMessage.length) {
				setPlaceholderText(randomMessage.slice(0, index++));
			} else {
				// All characters revealed -- stop the interval
				clearInterval(timer);
			}
		}, 15);

		// Cleanup: clear interval if the modal closes or deps change mid-animation
		return () => clearInterval(timer);
	}, [open, _name, _description, t, mode, hideDescription]);

	const handleCancel = () => {
		// Restore fields to their original prop values before closing
		setName(_name);
		if (!hideDescription) setDescription(_description);
		onClose();
	};

	const handleSubmit = async () => {
		// In saveAs mode the name is required; block submission if empty
		if (mode === 'saveAs' && !name.trim()) return;

		setLoading(true);

		try {
			await handleSave(name, description);
			// Close only on success so the user can retry on failure
			onClose();
		} catch (error) {
			// Re-enable form on failure so the user can correct and retry
			setLoading(false);
			throw error;
		}

		setLoading(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Cmd/Ctrl+Enter keyboard shortcut for quick submission without clicking
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			e.stopPropagation();
			handleSubmit();
		}
	};

	return (
		<Dialog
			open={open}
			onClose={handleCancel}
			onKeyDown={handleKeyDown}
			disableRestoreFocus
			maxWidth="sm"
			fullWidth
		>
			<DialogTitle
				sx={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
				}}
			>
				{modalTitle}
				<IconButton onClick={onClose} size="small">
					<CloseIcon />
				</IconButton>
			</DialogTitle>

			<DialogContent>
				<Box
					sx={{
						display: 'flex',
						flexDirection: 'column',
						gap: pxToRem(16),
						mt: pxToRem(8),
					}}
				>
					<Box>
						<Box
							sx={{
								fontWeight: 600,
								mb: pxToRem(8),
							}}
						>
							{t('dialog.save.nameTitle', { type: itemType })}
						</Box>
						<TextField
							fullWidth
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t('dialog.save.placeholder')}
							error={!!nameFieldError}
							helperText={nameFieldError}
							disabled={loading}
							autoFocus
						/>
					</Box>

					{!hideDescription && (
						<Box>
							<Box
								sx={{
									fontWeight: 600,
									mb: pxToRem(8),
								}}
							>
								{t('flow.autosave.saveAsModal.descriptionLabel')}
							</Box>
							<TextField
								fullWidth
								multiline
								rows={4}
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder={placeholderText}
								disabled={loading}
							/>
						</Box>
					)}
				</Box>
			</DialogContent>

			<DialogActions sx={{ p: pxToRem(16) }}>
				{/* Only show the discard button when explicitly opted in by the parent */}
				{showDiscard && onDiscard && (
					<Button onClick={onDiscard} variant="outlined" color="error" disabled={loading}>
						{t('dialog.save.discard')}
					</Button>
				)}
				<Button onClick={handleCancel} variant="outlined" disabled={loading}>
					{t('dialog.save.cancel')}
				</Button>
				{/* Disable submit when a save is in flight or when saveAs mode has no name */}
				<Button
					onClick={handleSubmit}
					variant="contained"
					disabled={(mode === 'saveAs' && !name.trim()) || loading}
					sx={{
						bgcolor: '#ff8c00',
						'&:hover': { bgcolor: '#e67e00' },
					}}
				>
					{mode === 'save'
						? t('dialog.save.accept')
						: t('flow.autosave.saveAsModal.accept')}
				</Button>
			</DialogActions>
		</Dialog>
	);
}
