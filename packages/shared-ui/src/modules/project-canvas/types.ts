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
 * Core domain types for the project canvas pipeline editor.
 * These interfaces model the serialised project structure (components, pipelines, edges)
 * and the runtime node data shape used by ReactFlow on the canvas.
 */
import { Edge } from '@xyflow/react';
import { NodeType } from './constants';
import { IDynamicForm, IFormData } from '../../services/dynamic-forms/types';

/**
 * Visual metadata stored on each project component's UI layer.
 * Captures the component's CSS class, display content, node type, and provider key
 * so the canvas can render the node without re-reading the full service definition.
 */
export interface IProjectComponentUIData {
	class: string;
	content: string;
	type: NodeType;
	provider: string;
	fgColor?: string;
	bgColor?: string;
}

/**
 * Describes an invoke (control) connection from one node to another.
 * Used to represent dependency edges where one node must execute before another.
 */
export interface IControl {
	classType: string;
	from: string;
}

/**
 * Describes a data-lane connection feeding into a node.
 * Each entry identifies the source node ID and the lane type (e.g. "text", "answers").
 */
export interface IInputLane {
	lane: string; // node provider name
	from: string; // node id
}

/**
 * Serialised representation of a single pipeline component (node).
 * Persisted to the project file and round-tripped between the canvas and the backend.
 * Contains the node ID, provider key, user-configured form data, visual position/size,
 * and its incoming data-lane and control connections.
 */
export interface IProjectComponent {
	id: string;
	provider: string; // We might change it to enum when we'll know all possible providers
	name?: string; // User-specified display name for this component instance
	description?: string; // User-specified description for this component instance
	config: Record<string, unknown>; // Object to store dynamic form values
	ui: {
		position: {
			x: number;
			y: number;
		};
		measured: {
			width: number;
			height: number;
		};
		data: IProjectComponentUIData;
		edges?: Edge[]; // Legacy property, no longer used
		parentId?: string;
		formDataValid?: boolean;
	};
	control?: IControl[];
	input?: IInputLane[];
}

/**
 * Top-level project entity persisted to the project file.
 * Contains components, metadata, and viewport state.
 * Project identity is project_id (no nested pipeline wrapper).
 */
export interface IProject {
	name?: string;
	description?: string;
	author?: string;
	viewport?: {
		x: number;
		y: number;
		zoom: number;
	};
	source?: string; // sourceId, sent to API but not stored in DB
	project_id?: string;
	components?: IProjectComponent[];
	chain?: string[]; // Returned by validation, never stored
	version?: number;
}

/**
 * Structured lane descriptor used in service definitions.
 * Unlike a plain string lane name, this carries optional cardinality constraints
 * (min/max) and a human-readable description.
 */
export interface LaneObject {
	type: string;
	description?: string;
	min?: number;
	max?: number;
}

/** Layout direction for arranging nodes on the canvas (currently unused, reserved for future layout engines). */
export type NodeLayout = 'horizontal' | 'vertical';

/**
 * Runtime shape of node.data on the canvas.
 * Extends the static driver definition (IDynamicForm) with runtime properties
 * added when building the ReactFlow graph (provider, class, formData, etc.).
 */
export interface INodeData extends IDynamicForm {
	provider?: string;
	class?: string;
	name?: string; // User-entered name (persisted as component.name)
	description?: string; // User-entered description (persisted as component.description)
	formData?: IFormData;
	formDataErrors?: unknown[];
	formDataValid?: boolean;
	input?: IInputLane[];
	controlConnections?: IControl[];
	isLocked?: boolean;
	[key: string]: unknown;
}

/**
 * Shape of the JSON file produced by the export-toolchain feature.
 * Contains the pipeline components plus version metadata so the file
 * can be re-imported into the same or a different project.
 */
export interface IToolchainExport {
	components: IProjectComponent[];
	id: string;
	servicesVersion?: number;
	appVersion?: string;
	engineVersion?: string;
}

/**
 * Response returned by the backend pipeline validation endpoint.
 * Contains any errors or warnings per component and the resolved
 * pipeline execution chain.
 */
export interface IValidateResponse {
	status: string;
	error?: {
		code?: number;
		message?: string;
	};
	data: {
		errors?: {
			code: number;
			message: string;
		}[];
		warnings?: {
			code: number;
			message: string;
		}[];
		component: IProjectComponent;
		pipeline: IProject;
	};
}

// ============================================================================
// Task Status Types (for real-time pipeline execution status)
// ============================================================================

/**
 * Task State Enumeration
 * Represents the lifecycle of a pipeline task from initialization to completion.
 */
export enum TASK_STATE {
	/** Initial state, no resources allocated yet */
	NONE = 0,
	/** Task is beginning startup sequence */
	STARTING = 1,
	/** Task is initializing resources and preparing to run */
	INITIALIZING = 2,
	/** Task is actively executing and processing data */
	RUNNING = 3,
	/** Task is gracefully shutting down and cleaning up */
	STOPPING = 4,
	/** Task has completed successfully and resources are cleaned up */
	COMPLETED = 5,
	/** Task was cancelled before completion */
	CANCELLED = 6,
}

/**
 * Represents flow data for pipeline execution tracking.
 */
export interface FlowData {
	totalPipes: number;
	byPipe: Record<number, string[]>;
}

/**
 * Endpoint configuration information for external services.
 */
export interface EndpointInfo {
	'button-text'?: string;
	'button-link'?: string;
	'url-text': string;
	'url-link': string;
	'auth-text': string;
	'auth-key': string;
}

/**
 * Comprehensive status information for a pipeline task execution.
 * This is sent from the backend via DAP events and used to update UI state.
 */
export interface TaskStatus {
	name: string;
	completed: boolean;
	state: TASK_STATE;
	status: string;
	debuggerAttached: boolean;
	startTime: number;
	endTime: number;
	warnings: string[];
	errors: string[];
	notes: Array<string | EndpointInfo>;
	currentObject: string;
	currentSize: number;
	totalSize: number;
	totalCount: number;
	completedSize: number;
	completedCount: number;
	failedSize: number;
	failedCount: number;
	wordsSize: number;
	wordsCount: number;
	rateSize: number;
	rateCount: number;
	serviceUp: boolean;
	exitCode: number;
	exitMsg: string;
	metrics?: Record<string, number>;
	pipeflow?: FlowData;
	host?: string;
}
