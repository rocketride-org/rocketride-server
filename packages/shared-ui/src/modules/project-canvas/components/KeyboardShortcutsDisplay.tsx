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

import { useState, useRef, ReactElement } from 'react';
import {
	Box,
	Typography,
	Paper,
	List,
	ListItem,
	ListItemIcon,
	ListItemText,
	Popper,
	Fade,
} from '@mui/material';
import { Keyboard } from '@mui/icons-material';
import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { isMacOs } from 'react-device-detect';
import KeyboardChip from './KeyboardChip';
import theme, { offBlack } from '../../../theme';

/**
 * Returns the platform-appropriate modifier key label.
 * On macOS this is the Command symbol; on other platforms it is "Ctrl".
 *
 * @param isMacOs - Whether the current platform is macOS.
 * @returns The modifier key label string.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const cmdOrCtrl = (isMacOs: boolean) => (isMacOs ? '⌘' : 'Ctrl');

/**
 * Builds a record of keyboard shortcut key sequences for display purposes.
 * Each entry is an array of key labels (including '+' separators) that can
 * be rendered as individual KeyboardChip components.
 *
 * @param t - The i18next translation function, used to localize key labels.
 * @returns A record mapping shortcut names to their key sequence arrays.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const shortcutKeys = (t: TFunction<'translation', undefined>): Record<string, string[]> => ({
	navigate: ['Shift', '+', t('flow.shortcuts.arrowKeys')],
	save: [cmdOrCtrl(isMacOs), '+', 'S'],
	selectAll: [cmdOrCtrl(isMacOs), '+', 'A'],
	delete: ['Del/Backspace'],
	group: [cmdOrCtrl(isMacOs), '+', 'G'],
	ungroup: [cmdOrCtrl(isMacOs), '+', 'Shift', '+', 'G'],
	toggleDevMode: [isMacOs ? '⌘' : 'Ctrl', '+', 'D'],
	runPipeline: [isMacOs ? '⌘' : 'Ctrl', '+', 'Enter'],
});

/**
 * Custom hook that returns a list of keyboard shortcut definitions with
 * localized names and their corresponding key sequences. Used by the
 * ShortcutsDropdown component to render the shortcuts reference panel.
 *
 * @returns An array of objects each containing a shortcut `name` and `keys` array.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useShortcuts() {
	const { t } = useTranslation();
	// Generate platform-aware key sequences using the translation function
	const keys = shortcutKeys(t);

	// Return an ordered list pairing each shortcut's display name with its key combo
	return [
		{ name: t('flow.shortcuts.navigate'), keys: keys.navigate },
		{ name: t('flow.shortcuts.save'), keys: keys.save },
		{ name: t('flow.shortcuts.selectAll'), keys: keys.selectAll },
		{ name: t('flow.shortcuts.delete'), keys: keys.delete },
		{ name: t('flow.shortcuts.group'), keys: keys.group },
		{ name: t('flow.shortcuts.ungroup'), keys: keys.ungroup },
		{ name: t('flow.shortcuts.toggleDevMode'), keys: keys.toggleDevMode },
		{ name: t('flow.shortcuts.runPipeline'), keys: keys.runPipeline },
	];
}

/**
 * Renders a hoverable/clickable dropdown in the canvas header that displays
 * all available keyboard shortcuts in a floating popover. Used to give users
 * a quick reference for canvas keyboard shortcuts without leaving the editor.
 *
 * @returns The shortcuts dropdown list item and its associated popover panel.
 */
export function ShortcutsDropdown(): ReactElement {
	const { t } = useTranslation();
	// Toggle state controls the Popper visibility on hover and click
	const [open, setOpen] = useState(false);
	// Anchor element ref for positioning the Popper relative to the list item
	const anchorRef = useRef<HTMLLIElement>(null);
	const shortcuts = useShortcuts();

	return (
		<>
			<ListItem
				ref={anchorRef}
				disablePadding
				onMouseEnter={() => setOpen(true)}
				onMouseLeave={() => setOpen(false)}
				onClick={() => setOpen((prev) => !prev)}
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
						minWidth: 'unset',
						mr: '0.5rem',
						'& svg': { fill: offBlack },
					}}
				>
					<Keyboard />
				</ListItemIcon>
				<ListItemText
					primary="Shortcuts"
					sx={{
						color: offBlack,
						'& span': { fontWeight: 500 },
					}}
				/>
			</ListItem>
			<Popper
				open={open}
				anchorEl={anchorRef.current}
				placement="bottom-start"
				transition
				sx={{ zIndex: 1300 }}
				onMouseEnter={() => setOpen(true)}
				onMouseLeave={() => setOpen(false)}
			>
				{({ TransitionProps }) => (
					<Fade {...TransitionProps} timeout={200}>
						<Paper
							sx={{
								mt: '0.5rem',
								p: 1,
								minWidth: '16rem',
								boxShadow: 3,
							}}
						>
							<Typography
								variant="subtitle2"
								sx={{
									fontWeight: 'bold',
									px: 1,
									pb: 0.5,
								}}
							>
								{t('flow.shortcuts.title')}
							</Typography>
							<List dense disablePadding>
								{shortcuts.map((shortcut) => (
									<ListItem
										key={shortcut.name}
										sx={{
											py: 0.25,
											px: 1,
											display: 'flex',
											justifyContent: 'space-between',
										}}
									>
										<ListItemText
											primary={shortcut.name}
											primaryTypographyProps={{
												variant: 'caption',
											}}
											sx={{
												m: 0,
												flexGrow: 2,
												flexBasis: '60%',
											}}
										/>
										<Box
											sx={{
												display: 'flex',
												alignItems: 'center',
												flexShrink: 0,
												flexBasis: '40%',
												justifyContent: 'flex-end',
											}}
										>
											{shortcut.keys.map((value: string, index: number) => (
												<KeyboardChip key={index} text={value} />
											))}
										</Box>
									</ListItem>
								))}
							</List>
						</Paper>
					</Fade>
				)}
			</Popper>
		</>
	);
}
