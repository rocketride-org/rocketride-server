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
 * FlowContainer — Top-level wrapper that sets up ReactFlowProvider and
 * the new FlowProvider context hierarchy.
 *
 * This replaces the old ProjectCanvas container. It accepts the same
 * host-level props (project, services, callbacks) and distributes them
 * to the split context providers.
 *
 * Re-mounts when the project ID changes to ensure a clean state.
 */

import { ReactElement, ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';

import { IProject, IFlowFeatures, IValidateResponse, ITaskStatus } from '../types';

import { FlowProvider } from '../context/FlowProvider';

// =============================================================================
// Props
// =============================================================================

export interface IFlowContainerProps {
	/** The project to edit. */
	project: IProject;

	/** Root OAuth2 URL for authentication flows. */
	oauth2RootUrl: string;

	/** Feature flags controlling toolbar visibility. */
	features?: IFlowFeatures;

	/** Pipeline runtime status per node. */
	taskStatuses?: Record<string, ITaskStatus>;

	/** Per-component pipe counts for progress tracking. */
	componentPipeCounts?: Record<string, number>;

	/** Total number of pipes in the pipeline. */
	totalPipes?: number;

	/** The service catalog keyed by provider name. */
	servicesJson?: Record<string, unknown>;

	/** Error message if the service catalog failed to load. */
	servicesJsonError?: string;

	/** Connector inventory metadata. */
	inventory?: Record<string, unknown>;

	/** Map of connector provider to display title. */
	inventoryConnectorTitleMap?: Record<string, string>;

	/** Validates the pipeline. */
	handleValidatePipeline?: (pipeline: IProject) => Promise<IValidateResponse>;

	/** Called when pipeline content changes (dirty tracking). */
	onContentChanged?: (project: IProject) => void;

	/** Called when viewport changes (pan/zoom). */
	onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;

	/** Host-provided undo callback. */
	onUndo?: () => void;

	/** Host-provided redo callback. */
	onRedo?: () => void;

	/** Opens a URL in the host browser. */
	onOpenLink?: (url: string, displayName?: string) => void;

	/** Host-provided preference reader. */
	getPreference?: (key: string) => unknown;

	/** Host-provided preference writer. */
	setPreference?: (key: string, value: unknown) => void;

	/** Register panel actions with the host (e.g. for guided tour). */
	onRegisterPanelActions?: (actions: Record<string, unknown>) => void;

	/** Google Picker developer key. */
	googlePickerDeveloperKey?: string;

	/** Google Picker client ID. */
	googlePickerClientId?: string;

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

	/** Child components (typically the Canvas grid). */
	children?: ReactNode;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Sets up the ReactFlow and Flow context providers, then renders children.
 *
 * Uses `key` on the outer Box to force a clean re-mount when the project
 * ID changes, ensuring no stale graph state leaks between projects.
 */
export default function FlowContainer({ project, oauth2RootUrl, features, taskStatuses, componentPipeCounts, totalPipes, servicesJson, servicesJsonError, inventory, inventoryConnectorTitleMap, handleValidatePipeline, onContentChanged, onViewportChange, onUndo, onRedo, onOpenLink, getPreference, setPreference, googlePickerDeveloperKey, googlePickerClientId, onRunPipeline, onStopPipeline, onOpenStatus, serverHost, isConnected, children }: IFlowContainerProps): ReactElement {
	return (
		<ReactFlowProvider>
			{/* Re-key on project ID to force clean re-mount between projects */}
			<div style={{ position: 'relative', width: '100%', height: '100%' }} key={`${project.project_id ?? 'new'}-${project.name}`}>
				<FlowProvider project={project} projectId={project.project_id ?? ''} features={features} taskStatuses={taskStatuses} componentPipeCounts={componentPipeCounts} totalPipes={totalPipes} servicesJson={servicesJson} servicesJsonError={servicesJsonError} inventory={inventory} inventoryConnectorTitleMap={inventoryConnectorTitleMap} handleValidatePipeline={handleValidatePipeline} onContentChanged={onContentChanged} onViewportChange={onViewportChange} onUndo={onUndo} onRedo={onRedo} oauth2RootUrl={oauth2RootUrl} onOpenLink={onOpenLink} getPreference={getPreference} setPreference={setPreference} googlePickerDeveloperKey={googlePickerDeveloperKey} googlePickerClientId={googlePickerClientId} onRunPipeline={onRunPipeline} onStopPipeline={onStopPipeline} onOpenStatus={onOpenStatus} serverHost={serverHost} isConnected={isConnected}>
					{children}
				</FlowProvider>
			</div>
		</ReactFlowProvider>
	);
}
