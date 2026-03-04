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

import { ReactElement, useEffect, useRef } from 'react';
import { Panel } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Paper, TextField, Typography, IconButton } from '@mui/material';
import { Close, KeyboardArrowUp, KeyboardArrowDown } from '@mui/icons-material';
import { useKeyDown } from '../../../hooks/useKeyDown';
import { panelStyles, textFieldStyles, textStyles } from './SearchPanel.style';
import { useNodeSearch } from './helpers/useNodeSearch';
import { SHORTCUTS } from '../constants';

/**
 * Renders a search panel overlay at the top-right of the ReactFlow canvas.
 * Provides a text input for searching nodes by name, displays match count,
 * and allows navigating between search results with arrow buttons or
 * Enter/Shift+Enter keyboard shortcuts. Toggled via the Ctrl/Cmd+F shortcut.
 *
 * @returns The search panel element when visible, or null when hidden.
 */
export default function SearchPanel(): ReactElement {
	const { t } = useTranslation();
	// Pull search state and navigation helpers from the custom node search hook
	const {
		isSearchVisible,
		toggleSearch,
		searchQuery,
		performSearch,
		searchResults,
		currentSearchResultIndex,
		goToNextSearchResult,
		goToPreviousSearchResult,
	} = useNodeSearch();

	// Bind Ctrl/Cmd+F to toggle the search panel open/closed
	useKeyDown(SHORTCUTS.SEARCH, toggleSearch);

	const inputRef = useRef<HTMLInputElement>(null);

	// Auto-focus the search input when the panel becomes visible (slight delay for mount animation)
	useEffect(() => {
		if (isSearchVisible) {
			setTimeout(() => inputRef.current?.focus(), 100);
		}
	}, [isSearchVisible]);

	// Do not render the panel when search is not active
	if (!isSearchVisible) {
		return null as unknown as ReactElement;
	}

	/**
	 * Handles keyboard events within the search input field.
	 * Allows Ctrl/Cmd+A for select-all within the input, and uses Enter/Shift+Enter
	 * to navigate forward/backward through search results.
	 */
	const handleKeyDown = (event: React.KeyboardEvent) => {
		// Allow Ctrl/Cmd+A to select all text within the input without triggering the canvas select-all shortcut
		if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
			event.stopPropagation();
			return;
		}

		if (searchResults.length > 0) {
			if (event.key === 'Enter') {
				event.preventDefault();
				// Shift+Enter navigates backward; plain Enter navigates forward through results
				if (event.shiftKey) {
					goToPreviousSearchResult();
				} else {
					goToNextSearchResult();
				}
			}
		}
	};

	return (
		<Panel position="top-right" style={{ right: 80, margin: 0 }}>
			<Paper sx={panelStyles} elevation={3}>
				<TextField
					inputRef={inputRef}
					variant="standard"
					placeholder={t('flow.shortcuts.searchPlaceholder')}
					value={searchQuery}
					onChange={(e) => performSearch(e.target.value)}
					onKeyDown={handleKeyDown}
					autoFocus
					sx={textFieldStyles}
				/>
				<Typography variant="body2" color="textSecondary" sx={textStyles}>
					{searchResults.length > 0
						? `${currentSearchResultIndex + 1} of ${searchResults.length}`
						: '0 of 0'}
				</Typography>
				<IconButton
					size="small"
					onClick={goToPreviousSearchResult}
					disabled={searchResults.length === 0}
				>
					<KeyboardArrowUp />
				</IconButton>
				<IconButton
					size="small"
					onClick={goToNextSearchResult}
					disabled={searchResults.length === 0}
				>
					<KeyboardArrowDown />
				</IconButton>
				<IconButton size="small" onClick={toggleSearch}>
					<Close />
				</IconButton>
			</Paper>
		</Panel>
	);
}
