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
 * Canvas-specific types for the flow pipeline editor.
 *
 * General project/service types (IProject, IService, IProjectComponent, etc.)
 * are defined in `src/types/project.ts` and re-exported here for convenience.
 *
 * This file defines types specific to the canvas rendering:
 *   - Node types and layout (INodeType, INode, INodeData)
 *   - Lane types (IServiceLane, ILaneObject, ILaneMap)
 *   - Canvas preferences (ICanvasPreferences, IProjectLayout)
 *   - Feature flags (IFlowFeatures)
 */

import type { PipelineInputConnection } from 'rocketride';

// Re-export all general types so flow consumers can import from one place
export type { IProject, IProjectComponent, IComponentUI, IControlConnection, IInputConnection, IPosition, IDimensions, IService, IServiceCatalog, INodeConfig, IValidateResponse, IServiceSchema, IToolchainExport, IToolchainState, IForm, IFormData, ITaskStatus, IFlowData } from '../../types/project';

export { IServiceCapabilities, ITaskState, DEFAULT_TOOLCHAIN_STATE } from '../../types/project';

// ============================================================================
// Node Type Discriminator
// ============================================================================

/**
 * Discriminated node types used in the ReactFlow nodeTypes registry.
 * Each value maps to a concrete React component.
 */
export enum INodeType {
	/** Standard pipeline component (LLM, Database, Filter, etc.). */
	Default = 'default',
	/** Free-form text annotation (no handles, no connections). */
	Annotation = 'annotation',
	/** Group boundary for nested child components. */
	Group = 'group',
}

// ============================================================================
// Node Layout & Lane Types
// ============================================================================

/** Direction in which lanes are arranged on a node. */
export type INodeLayout = 'horizontal' | 'vertical';

/**
 * Structured lane descriptor with optional cardinality constraints.
 * Used on the output side of lane mappings.
 */
export interface ILaneObject {
	type: string;
	description?: string;
	min?: number;
	max?: number;
}

/** A lane entry: plain string or structured object. */
export type ILaneEntry = string | ILaneObject;

/**
 * Map of input lane keys to output lane definitions.
 * Keys prefixed with `_` are hidden internal lanes.
 */
export type ILaneMap = Record<string, ILaneEntry[]>;

/** Array of lane entries as defined in service definitions. */
export type IServiceLane = (string | ILaneObject)[];

// ============================================================================
// Runtime Node Types
// ============================================================================

/**
 * Runtime data attached to each ReactFlow node.
 *
 * Thin reference to IProjectComponent fields — service metadata is
 * looked up at render time via the provider key, not stored here.
 */
export interface INodeData {
	[key: string]: unknown;

	/** Service provider key (e.g. "llm_openai"). */
	provider: string;

	/** User-entered display name. */
	name?: string;

	/** User-entered description. */
	description?: string;

	/** User-configured form values. */
	config: import('../../types/project').INodeConfig;

	/** Whether the current config passes validation. */
	formDataValid?: boolean;

	/** Validation errors from the config form. */
	formDataErrors?: unknown[];

	/** Incoming data-lane connections. */
	input?: PipelineInputConnection[];

	/** Incoming invoke (control-flow) connections. */
	control?: import('../../types/project').IControlConnection[];

	/** Whether the node is locked from editing. */
	isLocked?: boolean;
}

/**
 * Strongly-typed canvas node wrapping ReactFlow's Node with INodeData.
 *
 * Service metadata (icon, lanes, classType) is NOT stored on the node.
 * Look it up from the catalog: `servicesJson[node.data.provider]`
 */
export interface INode {
	id: string;
	type: string;
	position: import('../../types/project').IPosition;
	data: INodeData;
	parentId?: string;
	measured?: import('../../types/project').IDimensions;
	selected?: boolean;
	dragging?: boolean;
	deletable?: boolean;
	selectable?: boolean;
	extent?: string;
	style?: Record<string, unknown>;
}

// ============================================================================
// Canvas Layout & Preferences
// ============================================================================

/**
 * Per-project canvas layout state persisted in host preferences.
 */
export interface IProjectLayout {
	viewport?: { x: number; y: number; zoom: number };
	isLocked?: boolean;
	snapToGrid?: boolean;
	snapGridSize?: [number, number];
}

/**
 * All canvas UI preferences persisted in host storage.
 */
export interface ICanvasPreferences {
	navigationMode?: string;
	nodePanelWidth?: number;
	createPanelWidth?: number;
	projectLayouts?: Record<string, IProjectLayout>;
	toolbarPosition?: {
		anchorX: 'left' | 'right';
		offsetX: number;
		anchorY: 'top' | 'bottom';
		offsetY: number;
	};
}

// ============================================================================
// Feature Flags
// ============================================================================

/**
 * Controls which toolbar buttons and capabilities are visible.
 */
export interface IFlowFeatures {
	addNode?: boolean;
	addAnnotation?: boolean;
	fitView?: boolean;
	zoomIn?: boolean;
	zoomOut?: boolean;
	lock?: boolean;
	undo?: boolean;
	redo?: boolean;
	autoLayout?: boolean;
	keyboardShortcuts?: boolean;
	logs?: boolean;
	save?: boolean;
	saveAs?: boolean;
	importExport?: boolean;
	moreOptions?: boolean;
}

export const DEFAULT_FLOW_FEATURES: IFlowFeatures = {
	addNode: true,
	addAnnotation: true,
	fitView: true,
	zoomIn: true,
	zoomOut: true,
	lock: true,
	undo: true,
	redo: true,
	autoLayout: true,
	keyboardShortcuts: true,
	logs: true,
	save: true,
	saveAs: true,
	importExport: true,
	moreOptions: true,
};
