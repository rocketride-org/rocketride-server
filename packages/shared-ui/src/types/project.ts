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
 * Core project and service types shared across the entire application.
 *
 * These are NOT canvas-specific — they model the serialised project
 * structure, service catalog, validation responses, and pipeline
 * runtime status. Canvas-specific types (INode, INodeData, etc.)
 * live in modules/flow/types.ts.
 */

import type { PipelineComponent, PipelineConfig } from 'rocketride';

// Re-export SDK types under local aliases
export { TASK_STATE as ITaskState } from 'rocketride';
export type { PipelineInputConnection as IInputConnection } from 'rocketride';
export type { PipelineControlConnection as IControlConnection } from 'rocketride';
export type { TASK_STATUS as ITaskStatus } from 'rocketride';
export type { TASK_STATUS_FLOW as IFlowData } from 'rocketride';

// ============================================================================
// Form types (formerly in services/dynamic-forms/types.ts)
// ============================================================================

/**
 * Generic form data record type for dynamic form submissions.
 * Intentionally uses `any` to accommodate the wide variety of field types
 * produced by RJSF forms.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IFormData = Record<string, any>;

/**
 * A dictionary of dynamic form definitions keyed by service/connector name.
 * This is the shape returned by the services API and consumed by the canvas
 * to build the node inventory.
 */
export interface IForm {
	[key: string]: IService;
}

// ============================================================================
// Geometry
// ============================================================================

/** Position on the canvas in pixel coordinates. */
export interface IPosition {
	x: number;
	y: number;
}

/** Measured dimensions of a rendered element. */
export interface IDimensions {
	width: number;
	height: number;
}

// ============================================================================
// Service Catalog
// ============================================================================

/**
 * User-configured form data for a pipeline component.
 * Contains key/value pairs from the RJSF configuration form.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type INodeConfig = Record<string, any>;

/**
 * Bitmask capabilities supported by a service driver.
 * Each flag indicates a specific feature the driver supports.
 */
export enum IServiceCapabilities {
	Security = 1 << 0,
	Filesystem = 1 << 1,
	Substream = 1 << 2,
	Network = 1 << 3,
	Datanet = 1 << 4,
	Sync = 1 << 5,
	Internal = 1 << 6,
	Catalog = 1 << 7,
	NoMonitor = 1 << 8,
	NoInclude = 1 << 9,
	Invoke = 1 << 10,
	Remoting = 1 << 11,
	Gpu = 1 << 12,
	NoSaas = 1 << 13,
	Focus = 1 << 14,
	Deprecated = 1 << 15,
	Experimental = 1 << 16,
}

// ============================================================================
// Service Schema Types
// ============================================================================

/**
 * Pairs a JSON Schema with its corresponding RJSF UI schema for a single
 * form section (e.g. Pipe, Source, Target).
 *
 * The schema defines the data shape and validation rules. The ui schema
 * controls which widgets render each field and how they are laid out.
 */
export interface IServiceSchema {
	/** JSON Schema defining the data shape and validation rules. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	schema: Record<string, any>;
	/** RJSF UI schema controlling widget rendering and layout. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ui: Record<string, any>;
}

/**
 * Describes an invoke channel on a service — a control-flow dependency
 * that must be connected before the pipeline can run.
 *
 * For example, an agent node might require an `llm` invoke channel
 * (min 1, max 1) and optional `tool` channels (min 0).
 */
export interface IInvokeChannel {
	/** Human-readable description of what this channel provides. */
	description?: string;
	/** Minimum number of connections required (0 = optional). */
	min?: number;
	/** Maximum number of connections allowed (undefined = unlimited). */
	max?: number;
}

/**
 * A lane entry in the service definition — either a plain string
 * (lane name) or a structured object with metadata.
 */
export type IServiceLaneEntry =
	| string
	| {
			type: string;
			description?: string;
			min?: number;
			max?: number;
	  };

// ============================================================================
// Service Definition
// ============================================================================

/**
 * Service definition from the driver catalog (services.json).
 *
 * Describes a single pipeline service driver's metadata, configuration
 * schemas, capabilities, lane definitions, and invoke configuration.
 * This is the compiled form received by the UI — the engine resolves
 * `fields`, `shape`, and `preconfig` into `Pipe`/`Source`/`Target` schemas.
 */
export interface IService {
	/** Human-readable display title (e.g. "OpenAI", "PostgreSQL"). */
	title?: string;

	/** Tile display template strings shown on the node body (e.g. "Model: ${parameters.llm_openai.profile}"). */
	tile?: string[];

	/** Icon filename or URL for the node header (e.g. "openai.svg"). */
	icon?: string;

	/** Bitmask of actions this service supports. */
	actions?: number;

	/** Bitmask of capabilities (see {@link IServiceCapabilities}). */
	capabilities?: IServiceCapabilities;

	/** Class type tags determining which invoke channels accept this node (e.g. ["llm"], ["database", "tool"]). */
	classType?: string[];

	/**
	 * Lane definitions: maps input lane keys to arrays of output lane entries.
	 * Keys prefixed with `_` are hidden internal lanes.
	 *
	 * @example
	 * ```json
	 * { "questions": ["answers"], "_source": ["questions"] }
	 * ```
	 */
	lanes?: Record<string, IServiceLaneEntry[]>;

	/** Execution plan identifiers. */
	plans?: string[];

	/** Pipe configuration schema (compiled from fields/shape/preconfig by the engine). */
	Pipe?: IServiceSchema;

	/** Source configuration schema. */
	Source?: IServiceSchema;

	/**
	 * Invoke configuration: maps channel names to their connection requirements.
	 *
	 * @example
	 * ```json
	 * { "llm": { "min": 1, "max": 1 }, "tool": { "min": 0 } }
	 * ```
	 */
	invoke?: Record<string, IInvokeChannel>;

	/** Control-flow configuration. */
	control?: Record<string, unknown>;

	/** HTML description for tooltips. */
	description?: string;

	/** URL to external documentation. */
	documentation?: string;

	/** Service type identifier. */
	type?: string;

	/** Display content string. */
	content?: string;

	/** Whether this service should receive focus in the catalog. */
	focus?: boolean;
}

/** Dictionary of service definitions keyed by provider name. */
export interface IServiceCatalog {
	[key: string]: IService;
}

// ============================================================================
// Project Component
// ============================================================================

/**
 * Visual and layout properties for a component on the canvas.
 * Stored under `component.ui` in the serialised project file.
 */
export interface IComponentUI {
	[key: string]: unknown;
	position: IPosition;
	measured: IDimensions;
	nodeType: string;
	formDataValid?: boolean;
	parentId?: string;
}

/**
 * Serialised representation of a single pipeline component (node).
 * Extends the SDK's PipelineComponent with a strongly-typed `ui` object
 * and invoke (control-flow) connections.
 */
export interface IProjectComponent extends Omit<PipelineComponent, 'ui'> {
	ui: IComponentUI;
}

// ============================================================================
// Project
// ============================================================================

/**
 * Top-level project entity persisted to the .pipe file.
 * Extends the SDK's PipelineConfig.
 */
export interface IProject extends PipelineConfig {
	/** Editor document revision counter for change tracking (undo/redo, echo detection). Not a schema version. */
	docRevision?: number;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Response from the backend pipeline validation endpoint.
 */
export interface IValidateResponse {
	status: string;
	error?: {
		code?: number;
		message?: string;
	};
	data: {
		errors?: { code: number; message: string }[];
		warnings?: { code: number; message: string }[];
		component: IProjectComponent;
		pipeline: IProject;
	};
}

/**
 * Shape of the JSON file produced by the export-toolchain feature.
 */
export interface IToolchainExport {
	components: IProjectComponent[];
	id: string;
	servicesVersion?: number;
	appVersion?: string;
	engineVersion?: string;
}

// ============================================================================
// Toolchain State
// ============================================================================

/**
 * Transient UI state flags for the pipeline editor.
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

export const DEFAULT_TOOLCHAIN_STATE: IToolchainState = {
	isSaving: false,
	isSaved: true,
	isPending: false,
	isRunning: false,
	isUpdated: false,
	isDevMode: false,
	isDragging: false,
};
