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

/**
 * Hook that manages transient canvas-level UI state: snap-to-grid settings
 * and the right-click context menu.  Preferences are persisted via the host
 * `getPreference`/`setPreference` callbacks when available, falling back to
 * `localStorage`.
 */
import { useState, useEffect, MouseEvent } from 'react';
import { STORAGE_KEY, DEFAULT_SNAP_GRID_SIZE } from '../constants';

/** Retrieves a stored preference value by key. */
type GetPreference = (key: string) => unknown;

/** Persists a preference value by key. */
type SetPreference = (key: string, value: unknown) => void;

/** Position of the right-click context menu on screen. */
interface ContextMenuState {
	x: number;
	y: number;
}

/** Return type of the {@link useCanvasState} hook, exposing state values and handler functions. */
interface UseCanvasStateReturn {
	snapToGrid: boolean;
	snapGridSize: [number, number];
	contextMenu: ContextMenuState | null;
	handleToggleSnapToGrid: () => void;
	handleChangeSnapGrid: (newGridSize: [number, number]) => void;
	onPaneContextMenu: (event: MouseEvent) => void;
	handleCloseContextMenu: () => void;
}

/**
 * Manages snap-to-grid state and the pane context menu for the canvas.
 *
 * On mount it reads the stored snap preference; toggling or changing the grid
 * size persists the new value.  The context menu is opened on right-click and
 * closed automatically when the user clicks elsewhere.
 *
 * @param getPreference - Optional host-provided preference getter.
 * @param setPreference - Optional host-provided preference setter.
 * @returns Snap state, context-menu state, and their handlers.
 */
export default function useCanvasState(
	getPreference?: GetPreference,
	setPreference?: SetPreference
): UseCanvasStateReturn {
	// Read the persisted snap-to-grid setting; prefer the host preference store over localStorage
	const storedSnapToGrid = getPreference
		? (getPreference(STORAGE_KEY.SNAP_TO_GRID) as string | null)
		: localStorage.getItem(STORAGE_KEY.SNAP_TO_GRID);

	// 'false' is stored as a literal string; anything else is treated as enabled
	const [snapToGrid, setSnapToGrid] = useState<boolean>(storedSnapToGrid !== 'false');
	// Parse the stored grid size if available, otherwise fall back to the default
	const [snapGridSize, setSnapGridSize] = useState<[number, number]>(
		storedSnapToGrid && storedSnapToGrid !== 'false'
			? JSON.parse(storedSnapToGrid)
			: DEFAULT_SNAP_GRID_SIZE
	);
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

	// Register a global click listener while the context menu is open so any click dismisses it
	useEffect(() => {
		const handleClickOutside = () => {
			handleCloseContextMenu();
		};

		if (contextMenu) {
			document.addEventListener('click', handleClickOutside);
			// Clean up on close or unmount to avoid stale listeners
			return () => {
				document.removeEventListener('click', handleClickOutside);
			};
		}
	}, [contextMenu]);

	/** Toggles snap-to-grid on/off and persists the new setting. */
	const handleToggleSnapToGrid = () => {
		const newValue = !snapToGrid;
		setSnapToGrid(newValue);
		// Store 'false' when disabled; store the default grid dimensions when enabled
		if (setPreference) {
			setPreference(STORAGE_KEY.SNAP_TO_GRID, newValue === false ? 'false' : JSON.stringify(DEFAULT_SNAP_GRID_SIZE));
		} else {
			if (newValue === false) {
				localStorage.setItem(STORAGE_KEY.SNAP_TO_GRID, 'false');
			} else {
				localStorage.setItem(STORAGE_KEY.SNAP_TO_GRID, JSON.stringify(DEFAULT_SNAP_GRID_SIZE));
			}
		}
	};

	/** Updates the snap grid cell size and persists the new value. */
	const handleChangeSnapGrid = (newGridSize: [number, number]) => {
		setSnapGridSize(newGridSize);
		if (setPreference) setPreference(STORAGE_KEY.SNAP_TO_GRID, JSON.stringify(newGridSize));
		else localStorage.setItem(STORAGE_KEY.SNAP_TO_GRID, JSON.stringify(newGridSize));
	};

	/** Opens the right-click context menu at the cursor position. */
	const onPaneContextMenu = (event: MouseEvent) => {
		event.preventDefault();
		setContextMenu({ x: event.clientX, y: event.clientY });
	};

	/** Closes the context menu (called on outside click or menu item selection). */
	const handleCloseContextMenu = () => {
		setContextMenu(null);
	};

	return {
		snapToGrid,
		snapGridSize,
		contextMenu,
		handleToggleSnapToGrid,
		handleChangeSnapGrid,
		onPaneContextMenu,
		handleCloseContextMenu,
	};
}
