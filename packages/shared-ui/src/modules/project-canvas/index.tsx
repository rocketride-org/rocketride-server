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
 * Project Canvas module entry point.
 *
 * Exports a compound-component API (`Canvas.Container`, `Canvas.Grid`, `Canvas.Header`)
 * that host applications compose to render the pipeline editor.  The Container wraps
 * ReactFlow, FlowContext, and MUI styling; the Grid renders the interactive ReactFlow
 * surface; and the Header provides project-level controls.
 */
import { ReactElement, ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { withStyles } from '@mui/styles';
import { Box } from '@mui/material';

import { FlowProvider } from './FlowContext';
import { FlowFeatures, DEFAULT_FLOW_FEATURES } from './types/features';
import { IProject, IValidateResponse, TaskStatus } from './types';
import { reactFlowStyles } from './components/ReactFlow.styles';

// Compound Components Export
import _Canvas from './components/Canvas';
import CanvasHeader from './components/CanvasHeader';

/**
 * Props for the ProjectCanvas container component.
 * Accepts project data, service definitions, feature flags, and all host-level callbacks
 * needed to save, run, and validate pipelines.
 */
interface IProps {
	/** Root OAuth2 URL for the refresh path (lambda) passed to the services OAuth2 endpoint. Required. */
	oauth2RootUrl: string;
	project: IProject;
	projects?: Record<string, IProject>[];
	taskStatuses?: Record<string, TaskStatus>;
	componentPipeCounts?: Record<string, number>;
	totalPipes?: number;
	panel?: string;
	node?: string;
	features?: FlowFeatures;
	inventory?: Record<string, unknown>;
	servicesJson?: Record<string, unknown>;
	servicesJsonError?: string;
	inventoryConnectorTitleMap?: Record<string, string>;
	handleValidatePipeline?: (pipeline: IProject) => Promise<IValidateResponse>;
	saveProject?: (project: IProject) => Promise<void>;
	runPipeline: (pipeline: IProject) => Promise<void>;
	stopPipeline: (projectId: string, source: string) => void;
	handleOpenTemplates?: () => void;
	onAddNodeSuccess?: (data: { nodeData: { provider: string } }) => void;
	children?: ReactNode;
	isAutosaveEnabled?: boolean;
	onAutosaveEnabledChange?: (enabled: boolean) => void;
	onOpenLink?: (url: string) => void;
	getPreference?: (key: string) => unknown;
	setPreference?: (key: string, value: unknown) => void;
	onRegisterPanelActions?: (actions: { toggleActionsPanel?: (type?: import('./constants').ActionsType) => void }) => void;
	onOpenLogHistory?: () => void;
	/** Google Picker API keys; host passes from env/config. Used by GoogleDrivePickerWidget via formContext. */
	googlePickerDeveloperKey?: string;
	googlePickerClientId?: string;
	/** Optional: called when pipeline content changes (nodes, edges, etc.) with current project. Not called for viewport-only changes. */
	onContentChanged?: (project: IProject) => void;
}

/**
 * Core project canvas container component.
 *
 * Sets up the ReactFlowProvider and FlowProvider context, applies ReactFlow
 * global styles, and renders its children (typically `Canvas.Grid`).
 * Re-mounts when the project ID or pipeline name changes to ensure a clean state.
 */
function ProjectCanvas({
	oauth2RootUrl,
	project,
	projects = [],
	taskStatuses,
	componentPipeCounts,
	totalPipes,
	saveProject,
	panel,
	node,
	features = DEFAULT_FLOW_FEATURES,
	runPipeline,
	stopPipeline,
	inventory,
	servicesJson,
	servicesJsonError,
	inventoryConnectorTitleMap,
	handleValidatePipeline,
	onAddNodeSuccess,
	children,
	isAutosaveEnabled,
	onAutosaveEnabledChange,
	onOpenLink,
	getPreference,
	setPreference,
	onRegisterPanelActions,
	onOpenLogHistory,
	googlePickerDeveloperKey,
	googlePickerClientId,
	onContentChanged,
}: IProps): ReactElement {
	return (
		<ReactFlowProvider>
			<Box
				sx={{
					position: 'relative',
					width: '100%',
					height: '100%',
				}}
				key={`${project.project_id ?? 'new'}-${project.name}`}
			>
				<FlowProvider
					oauth2RootUrl={oauth2RootUrl}
					project={project}
					projects={projects}
					saveProject={saveProject}
					panel={panel}
					activeNodeId={node}
					features={features}
					taskStatuses={taskStatuses}
					componentPipeCounts={componentPipeCounts}
					totalPipes={totalPipes}
					runPipeline={runPipeline}
					stopPipeline={stopPipeline}
					inventory={inventory}
					servicesJson={servicesJson}
					servicesJsonError={servicesJsonError}
					inventoryConnectorTitleMap={inventoryConnectorTitleMap}
					handleValidatePipeline={handleValidatePipeline}
					onAddNodeSuccess={onAddNodeSuccess}
					isAutosaveEnabled={isAutosaveEnabled}
					onAutosaveEnabledChange={onAutosaveEnabledChange}
					onOpenLink={onOpenLink}
					getPreference={getPreference}
					setPreference={setPreference}
					onRegisterPanelActions={onRegisterPanelActions}
					onOpenLogHistory={onOpenLogHistory}
					googlePickerDeveloperKey={googlePickerDeveloperKey}
					googlePickerClientId={googlePickerClientId}
					onContentChanged={onContentChanged}
				>
					{children}
				</FlowProvider>
			</Box>
		</ReactFlowProvider>
	);
}

/**
 * Compound component namespace for the project canvas module.
 *
 * - `Canvas.Container` -- Styled wrapper that initialises ReactFlow and FlowContext.
 * - `Canvas.Grid` -- The interactive ReactFlow graph surface.
 * - `Canvas.Header` -- Project-level toolbar (save, run, etc.).
 */
const Canvas = {
	Container: withStyles(reactFlowStyles)(ProjectCanvas),
	Grid: _Canvas,
	Header: CanvasHeader,
};

export default Canvas;
