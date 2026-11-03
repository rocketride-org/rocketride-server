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

/**
 * usePanelState — Manages which side panel is currently open on the canvas.
 *
 * This is a simple hook (not a context) because panel state is consumed
 * by very few components (the Canvas shell and the ActionsPanel wrapper).
 * If it grows in complexity, it can be promoted to a context later.
 */

import { useCallback, useState } from 'react';

// ============================================================================
// Panel types
// ============================================================================

/**
 * Identifies which side panel is currently open on the canvas.
 *
 * - `undefined` means no panel is open.
 */
export enum PanelType {
	/** The node configuration/edit panel. */
	Node = 'node',
	/** The create-node catalog panel. */
	CreateNode = 'createNode',
	/** The developer debug panel. */
	DevPanel = 'devPanel',
	/** The import/export panel. */
	ImportExport = 'importExport',
}

// ============================================================================
// Hook return type
// ============================================================================

export interface IPanelState {
	/** Which panel is currently open (undefined = none). */
	activePanelType: PanelType | undefined;

	/** Arbitrary data associated with the active panel (e.g. which node is being edited). */
	activePanelData: Record<string, unknown>;

	/** Whether the panel is blocked from closing (e.g. unsaved form changes). */
	isPanelBlocked: boolean;

	/**
	 * Opens a panel (or closes it by passing undefined).
	 *
	 * @param type - The panel to open, or undefined to close.
	 * @param data - Optional data to associate with the panel.
	 */
	togglePanel: (type?: PanelType, data?: Record<string, unknown>) => void;

	/** Blocks/unblocks the panel from closing. */
	setPanelBlocked: (blocked: boolean) => void;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Manages the currently open side panel on the canvas.
 *
 * @param initialPanel - Optional panel to open on mount.
 * @returns Panel state and control functions.
 */
export function usePanelState(initialPanel?: PanelType): IPanelState {
	const [activePanelType, setActivePanelType] = useState<PanelType | undefined>(initialPanel);
	const [activePanelData, setActivePanelData] = useState<Record<string, unknown>>({});
	const [isPanelBlocked, setPanelBlocked] = useState(false);

	const togglePanel = useCallback((type?: PanelType, data?: Record<string, unknown>) => {
		setActivePanelType(type);
		if (data) setActivePanelData(data);
	}, []);

	return {
		activePanelType,
		activePanelData,
		isPanelBlocked,
		togglePanel,
		setPanelBlocked,
	};
}
