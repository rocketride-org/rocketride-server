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
 * FlowProjectContext — Owns project identity, persistence, runtime status,
 * and all host-provided callbacks.
 *
 * This context is the bridge between the host application (VS Code extension
 * or web app) and the flow canvas. It holds:
 *
 *   - The current project definition (IProject)
 *   - Toolchain lifecycle state (saving, running, dirty, dev-mode)
 *   - Pipeline runtime data (task statuses, pipe counts)
 *   - Service catalog (servicesJson)
 *   - Host callbacks (save, validate, open link, open logs, etc.)
 *   - Feature flags controlling which toolbar buttons are visible
 *
 * This state changes infrequently compared to the graph context (node/edge
 * mutations), so separating it reduces unnecessary re-renders of node components.
 */

import { createContext, ReactElement, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { IProject, IToolchainState, IFlowFeatures, IValidateResponse, IServiceCatalog, ITaskStatus, ITaskState, DEFAULT_TOOLCHAIN_STATE, DEFAULT_FLOW_FEATURES } from '../types';

// =============================================================================
// Context shape
// =============================================================================

export interface IFlowProjectContext {
	// --- Project identity --------------------------------------------------

	/** The current project being edited. */
	currentProject: IProject;

	// --- Toolchain lifecycle state -----------------------------------------

	/** Transient UI flags (saving, running, dirty, dev-mode, etc.). */
	toolchainState: IToolchainState;

	/** Updates one or more toolchain state flags. */
	patchToolchainState: (patch: Partial<IToolchainState>) => void;

	/** Toggles developer mode on/off. */
	toggleDevMode: () => void;

	/** Whether any pipeline task is currently running (derived from taskStatuses). */
	isPipelineRunning: boolean;

	// --- Feature flags -----------------------------------------------------

	/** Controls which toolbar buttons and capabilities are visible. */
	features: IFlowFeatures;

	// --- Pipeline runtime data (from host) ---------------------------------

	/** Per-node task status, updated by the host during pipeline execution. */
	taskStatuses?: Record<string, ITaskStatus>;

	/** Per-component pipe counts for progress tracking during execution. */
	componentPipeCounts?: Record<string, number>;

	/** Total number of pipes in the pipeline. */
	totalPipes?: number;

	// --- Service catalog ---------------------------------------------------

	/** The service catalog keyed by provider name. */
	servicesJson: IServiceCatalog;

	/** Error message if the service catalog failed to load. */
	servicesJsonError?: string;

	// --- Inventory ---------------------------------------------------------

	/** Connector/inventory metadata from the host. */
	inventory?: Record<string, unknown>;

	/** Map of connector provider → display title. */
	inventoryConnectorTitleMap?: Record<string, string>;

	// --- Host callbacks ----------------------------------------------------

	/** Validates the pipeline and returns per-component errors/warnings. */
	handleValidatePipeline?: (pipeline: IProject) => Promise<IValidateResponse>;

	/** Notifies the host that the project content has changed (for dirty tracking). */
	onContentChanged?: (project: IProject) => void;

	/** Notifies the host that the viewport has changed (persisted per-view). */
	onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;

	/** Host-provided undo callback. */
	onUndo?: () => void;

	/** Host-provided redo callback. */
	onRedo?: () => void;

	/** OAuth2 root URL for authentication flows. */
	oauth2RootUrl: string;

	/** Opens an external URL in the host's default browser. */
	onOpenLink?: (url: string, displayName?: string) => void;

	/** Google Picker developer key (for Google Drive integration). */
	googlePickerDeveloperKey?: string;

	/** Google Picker client ID (for Google Drive integration). */
	googlePickerClientId?: string;

	// --- Pipeline execution callbacks --------------------------------------

	/** Runs a pipeline: host saves to disk then executes. */
	onRunPipeline?: (source: string, project: IProject) => void;

	/** Stops a running pipeline for the given source node. */
	onStopPipeline?: (source: string) => void;

	/** Opens the status page for a source node. */
	onOpenStatus?: (source: string) => void;

	/** Server host URL for replacing {host} placeholders in endpoint URLs. */
	serverHost?: string;

	/** Whether the host is connected to the server. Controls run/stop button availability. */
	isConnected?: boolean;
}

const FlowProjectContext = createContext<IFlowProjectContext | null>(null);

// =============================================================================
// Provider props
// =============================================================================

export interface IFlowProjectProviderProps {
	children: ReactNode;

	/** The project to edit. */
	project: IProject;

	/** Feature flags controlling toolbar visibility. */
	features?: IFlowFeatures;

	// --- Pipeline runtime data (updated by host during execution) -----------
	taskStatuses?: Record<string, ITaskStatus>;
	componentPipeCounts?: Record<string, number>;
	totalPipes?: number;

	// --- Service catalog ---------------------------------------------------
	servicesJson?: Record<string, unknown>;
	servicesJsonError?: string;

	// --- Inventory ---------------------------------------------------------
	inventory?: Record<string, unknown>;
	inventoryConnectorTitleMap?: Record<string, string>;

	// --- Host callbacks ----------------------------------------------------
	handleValidatePipeline?: (pipeline: IProject) => Promise<IValidateResponse>;
	onContentChanged?: (project: IProject) => void;
	onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
	onUndo?: () => void;
	onRedo?: () => void;
	oauth2RootUrl: string;
	onOpenLink?: (url: string, displayName?: string) => void;
	googlePickerDeveloperKey?: string;
	googlePickerClientId?: string;

	// --- Pipeline execution callbacks --------------------------------------
	onRunPipeline?: (source: string, project: IProject) => void;
	onStopPipeline?: (source: string) => void;
	onOpenStatus?: (source: string) => void;
	serverHost?: string;
	isConnected?: boolean;
}

// =============================================================================
// Provider
// =============================================================================

/**
 * Provides project identity, lifecycle state, runtime data, and host
 * callbacks to all descendants.
 *
 * The host application passes props that are tunneled through this context
 * so deeply nested components can access them without prop drilling.
 */
export function FlowProjectProvider({ children, project: currentProject, features = DEFAULT_FLOW_FEATURES, taskStatuses, componentPipeCounts, totalPipes, servicesJson: rawServicesJson, servicesJsonError, inventory, inventoryConnectorTitleMap, handleValidatePipeline, onContentChanged, onViewportChange, onUndo, onRedo, oauth2RootUrl, onOpenLink, googlePickerDeveloperKey, googlePickerClientId, onRunPipeline, onStopPipeline, onOpenStatus, serverHost, isConnected }: IFlowProjectProviderProps): ReactElement {
	// --- Toolchain state ---------------------------------------------------

	const [toolchainState, setToolchainState] = useState<IToolchainState>(DEFAULT_TOOLCHAIN_STATE);

	const patchToolchainState = useCallback((patch: Partial<IToolchainState>) => {
		setToolchainState((prev) => ({ ...prev, ...patch }));
	}, []);

	const toggleDevMode = useCallback(() => {
		setToolchainState((prev) => ({ ...prev, isDevMode: !prev.isDevMode }));
	}, []);

	// --- Derived state -----------------------------------------------------

	/** True if any task is neither completed nor cancelled. */
	const isPipelineRunning = useMemo(() => Object.values(taskStatuses ?? {}).some((status) => status.state !== ITaskState.COMPLETED && status.state !== ITaskState.CANCELLED), [taskStatuses]);

	// Type-narrow the raw servicesJson into our IServiceCatalog
	const servicesJson = useMemo(() => (rawServicesJson ?? {}) as IServiceCatalog, [rawServicesJson]);

	// --- Context value -----------------------------------------------------

	const value: IFlowProjectContext = {
		currentProject,
		toolchainState,
		patchToolchainState,
		toggleDevMode,
		isPipelineRunning,
		features,
		taskStatuses,
		componentPipeCounts,
		totalPipes,
		servicesJson,
		servicesJsonError,
		inventory,
		inventoryConnectorTitleMap,
		handleValidatePipeline,
		onContentChanged,
		onViewportChange,
		onUndo,
		onRedo,
		oauth2RootUrl,
		onOpenLink,
		googlePickerDeveloperKey,
		googlePickerClientId,
		onRunPipeline,
		onStopPipeline,
		onOpenStatus,
		serverHost,
		isConnected,
	};

	return <FlowProjectContext.Provider value={value}>{children}</FlowProjectContext.Provider>;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Returns the flow project context.
 *
 * @throws When called outside of a FlowProjectProvider.
 */
export function useFlowProject(): IFlowProjectContext {
	const ctx = useContext(FlowProjectContext);
	if (!ctx) {
		throw new Error('useFlowProject must be used within a FlowProjectProvider');
	}
	return ctx;
}
