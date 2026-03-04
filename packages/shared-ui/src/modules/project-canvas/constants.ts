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
 * Shared constants for the project canvas module.
 * Includes default node dimensions, visual enums, colour palettes for lanes,
 * keyboard shortcut definitions, and local-storage keys.
 */
import { SelectionMode } from '@xyflow/react';

/** Default rendered height (px) of a standard pipeline node. */
export const NODE_HEIGHT = 30;

/** Default rendered width (px) of a standard pipeline node. */
export const NODE_WIDTH = 160;

/** Vertical spacing (px) between auto-laid-out nodes (1.5x height). */
export const NODE_Y_SPACING = NODE_HEIGHT + NODE_HEIGHT / 2;

/** Horizontal spacing (px) between auto-laid-out nodes (1.5x width). */
export const NODE_X_SPACING = NODE_WIDTH + NODE_WIDTH / 2;

/** X/Y coordinate pair representing a node's position on the canvas. */
export interface NodePosition {
	x: number;
	y: number;
}

/** Measured width and height of a rendered node, used for hit-testing and layout. */
export interface NodeMeasured {
	width: number;
	height: number;
}

/** Generic key-value bag attached to a ReactFlow node's `data` property. */
export interface NodeData {
	[key: string]: unknown;
}

/**
 * Discriminator for the different visual node types rendered on the canvas.
 * Each value maps to a custom ReactFlow node component.
 */
export enum NodeType {
	Default = 'default',
	Annotation = 'annotation',
	RemoteGroup = 'remote-group',
	Group = 'group',
}

/**
 * Identifies which side-panel is currently open in the canvas UI.
 * Used by `toggleActionsPanel` to switch between create-node, node-edit,
 * dev, and import/export panels.
 */
export enum ActionsType {
	CreateNode = 'createNode',
	Node = 'node',
	DevPanel = 'devPanel',
	ImportExportPanel = 'importExportPanel',
}

/** Default properties applied to every new ReactFlow edge (selectable and deletable). */
export const defaultEdge = {
	selectable: true,
	deletable: true,
};

/**
 * Ordered colour palette used to visually distinguish data lanes on the canvas.
 * Each lane type is assigned the next colour in sequence so users can easily
 * trace data flow between nodes.
 */
export const lanesColorPalette = [
	'#3F51B5', // Royal Blue
	'#9E1B32', // Cranberry
	'#26C6DA', // Aqua
	'#F1A93B', // Golden Amber
	'#D85B00', // Deep Orange
	'#FFEB3B', // Lemon Yellow
	'#FF4081', // Hot Pink
	'#FF9A8B', // Peach
	'#FF7F11', // Soft Orange
	'#9B4DCA', // Violet
	'#D32F2F', // Bright Red
	'#00BCD4', // Turquoise
	'#673AB7', // Deep Purple
	'#4CAF50', // Lime Green
	'#FF80AB', // Pastel Pink
	'#FBBF4B', // Bright Yellow
	'#607D8B', // Slate Grey
	'#CFD8DC', // Light Blue Grey
	'#8D6E63', // Earthy Brown
	'#263238', // Charcoal Blue
	'#F5F5F5', // Very Light Grey
	'#9C27B0', // Medium Purple
	'#8BC34A', // Fresh Green
	'#455A64', // Deep Slate Blue
	'#8E24AA', // Purple Orchid
	'#F48FB1', // Pale Pink
	'#FBBF4B', // Bright Yellow
	'#607D8B', // Dusty Grey Blue
	'#BB86FC', // Light Lavender
	'#7986CB', // Soft Lavender Blue
	'#8BC34A', // Fresh Green
	'#FF5722', // Fiery Red-Orange
	'#BDBDBD', // Medium Grey
	'#0069C0', // Dark Sky Blue
	'#3F51B5', // Indigo
	'#7986CB', // Soft Lavender Blue
	'#00FF7F', // Spring Green
	'#03A9F4', // Sky Blue
	'#B3B3B3', // Light Grey
	'#B3E5FC', // Pale Blue
];

/**
 * Transient UI state flags for the pipeline editor.
 * Tracks whether the project is saving, running, pending, etc.
 * so the UI can disable/enable controls accordingly.
 */
export interface IToolchainState {
	isSaving: boolean;
	isSaved: boolean;
	isPending: boolean;
	isRunning: boolean;
	isUpdated: boolean;
	isDevMode: boolean;
	isDragging: boolean;
}

/** Initial (idle) toolchain state used when the canvas first loads. */
export const defaultToolchainState = {
	isSaving: false,
	isSaved: true,
	isPending: false,
	isRunning: false,
	isUpdated: false,
	isDevMode: false,
	isDragging: false,
};

/**
 * Canvas interaction mode controlling how mouse drag behaves.
 * DRAG pans the viewport; SELECT draws a selection rectangle.
 */
export enum NavigationMode {
	DRAG = 'drag',
	SELECT = 'select',
}

/** Default zoom level applied when no saved viewport is available. */
export const DEFAULT_ZOOM = 1;

/**
 * Builds the default ReactFlow canvas configuration props based on the current
 * navigation mode and user-controlled canvas lock. When not locked, the canvas
 * is fully editable; when locked, node/edge edits are disabled.
 *
 * @param navigationMode - Current interaction mode (DRAG or SELECT).
 * @param isLocked - When true, nodes and edges are not draggable/connectable/selectable.
 * @returns A ReactFlow props object.
 */
export const getDefaultCanvasProps = (
	navigationMode: NavigationMode,
	isLocked: boolean
) => {
	const editable = !isLocked;
	return {
		selectionMode: SelectionMode.Partial,
		panOnScroll: navigationMode === NavigationMode.SELECT,
		panOnDrag: navigationMode === NavigationMode.DRAG,
		selectionOnDrag: navigationMode === NavigationMode.SELECT,
		defaultViewport: { x: 0, y: 0, zoom: DEFAULT_ZOOM },
		proOptions: { hideAttribution: true },
		nodesDraggable: editable,
		nodesConnectable: editable,
		nodesFocusable: editable,
		edgesFocusable: editable,
		elementsSelectable: editable,
	};
};

/** Default snap grid cell size (width, height) in pixels when snap-to-grid is enabled. */
export const DEFAULT_SNAP_GRID_SIZE = [20, 20] as const;

/**
 * Keys used for persisting user preferences in localStorage or the host settings store.
 * Each key maps to a specific canvas preference (e.g. navigation mode, snap-to-grid).
 */
export const STORAGE_KEY = {
	PIPELINE_NODE_ID: 'PIPELINE_NODE_ID',
	SNAP_TO_GRID: 'SNAP_TO_GRID',
	NAVIGATION_MODE: 'NAVIGATION_MODE',
	NODE_PANEL_SHOW_UNSAVED_PROMPT: 'NODE_PANEL_SHOW_UNSAVED_PROMPT',
};

/**
 * Keyboard shortcut definitions using the `is-hotkey` format.
 * `mod` maps to Cmd on macOS and Ctrl on Windows/Linux.
 */
export const SHORTCUTS = {
	GROUP: 'mod+g',
	UNGROUP: 'mod+shift+g',
	DEV_MODE: 'mod+d',
	SELECT_ALL: 'mod+a',
	SAVE: 'mod+s',
	DELETE: 'mod+backspace',
	ARROW_NAVIGATION: 'shift+arrow',
	RUN_PIPELINE: 'mod+enter',
	SEARCH: 'mod+f',
	COPY: 'mod+c',
	PASTE: 'mod+v',
	UNDO: 'mod+z',
	REDO: 'mod+shift+z',
};
