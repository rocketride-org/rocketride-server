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
 * FlowProvider — Composite provider that nests all flow contexts in the
 * correct dependency order.
 *
 * Nesting order (outermost → innermost):
 *
 *   1. FlowPreferencesProvider — no dependencies
 *   2. FlowProjectProvider    — no dependencies on other flow contexts
 *   3. FlowGraphProvider      — reads from Preferences (isLocked) and Project (currentProject, servicesJson)
 *
 * This is the single provider that consuming code wraps around the canvas.
 * It accepts all the props needed by the individual sub-providers and
 * distributes them accordingly.
 *
 * Must be nested inside ReactFlow's `<ReactFlowProvider>` because
 * FlowGraphProvider uses `useReactFlow()`.
 */

import { ReactElement, ReactNode } from 'react';

import { IProject, IFlowFeatures, IValidateResponse, ITaskStatus } from '../types';

import { FlowPreferencesProvider } from './FlowPreferencesContext';
import { FlowProjectProvider } from './FlowProjectContext';
import { FlowGraphProvider } from './FlowGraphContext';

// =============================================================================
// Props — aggregates all sub-provider props
// =============================================================================

export interface IFlowProviderProps {
	children: ReactNode;

	// --- Project -----------------------------------------------------------
	/** The project to edit. */
	project: IProject;

	// --- Preferences -------------------------------------------------------
	/** The current project's ID, used to key per-project layout storage. */
	projectId: string;
	/** Host-provided preference reader. */
	getPreference?: (key: string) => unknown;
	/** Host-provided preference writer. */
	setPreference?: (key: string, value: unknown) => void;

	// --- Features ----------------------------------------------------------
	/** Controls which toolbar buttons are visible. */
	features?: IFlowFeatures;

	// --- Pipeline runtime data ---------------------------------------------
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
	onUndo?: () => void;
	onRedo?: () => void;
	oauth2RootUrl: string;
	onOpenLink?: (url: string, displayName?: string) => void;
	googlePickerDeveloperKey?: string;
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

	/** Whether the host is connected to the server. */
	isConnected?: boolean;
}

// =============================================================================
// Composite Provider
// =============================================================================

/**
 * Wraps the canvas with all flow contexts in the correct nesting order.
 *
 * @example
 * ```tsx
 * <ReactFlowProvider>
 *   <FlowProvider project={project} projectId={project.project_id} ...>
 *     <Canvas />
 *   </FlowProvider>
 * </ReactFlowProvider>
 * ```
 */
export function FlowProvider({ children, project, projectId, getPreference, setPreference, features, taskStatuses, componentPipeCounts, totalPipes, servicesJson, servicesJsonError, inventory, inventoryConnectorTitleMap, handleValidatePipeline, onContentChanged, onUndo, onRedo, oauth2RootUrl, onOpenLink, googlePickerDeveloperKey, googlePickerClientId, onRunPipeline, onStopPipeline, onOpenStatus, serverHost, isConnected }: IFlowProviderProps): ReactElement {
	return (
		<FlowPreferencesProvider projectId={projectId} getPreference={getPreference} setPreference={setPreference}>
			<FlowProjectProvider project={project} features={features} taskStatuses={taskStatuses} componentPipeCounts={componentPipeCounts} totalPipes={totalPipes} servicesJson={servicesJson} servicesJsonError={servicesJsonError} inventory={inventory} inventoryConnectorTitleMap={inventoryConnectorTitleMap} handleValidatePipeline={handleValidatePipeline} onContentChanged={onContentChanged} onUndo={onUndo} onRedo={onRedo} oauth2RootUrl={oauth2RootUrl} onOpenLink={onOpenLink} googlePickerDeveloperKey={googlePickerDeveloperKey} googlePickerClientId={googlePickerClientId} onRunPipeline={onRunPipeline} onStopPipeline={onStopPipeline} onOpenStatus={onOpenStatus} serverHost={serverHost} isConnected={isConnected}>
				<FlowGraphProvider>{children}</FlowGraphProvider>
			</FlowProjectProvider>
		</FlowPreferencesProvider>
	);
}
