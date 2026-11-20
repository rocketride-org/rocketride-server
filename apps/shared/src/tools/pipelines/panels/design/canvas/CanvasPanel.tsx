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
 * CanvasPanel — Top-level entry point for the pipeline canvas.
 *
 * This is the single component that host applications (VS Code, web app)
 * render. It sets up:
 *   - Full-viewport container (theming is the --rr-* token contract of the
 *     host's stylesheet; nothing is bridged at runtime)
 *   - FlowContainer (context providers) + Canvas (ReactFlow surface)
 *
 * The host only needs to pass project data, service definitions, and
 * callback handlers. Everything else is self-contained.
 */

import FlowContainer from './components/FlowContainer';
import FlowCanvas from './components/FlowCanvas';
import { IProject, IValidatePipelinePayload, IValidateResponse, ITaskStatus } from './types';
import { buildInventory } from './util/helpers';
import { IServiceCatalog } from './types';
import type { EndpointKeyMinter } from 'shared/tools/pipelines/components/pipeline-actions/endpointKey';
import type { OpenToolHandler } from 'shared/tools/pipelines/components/pipeline-actions/PipelineActions';

// =============================================================================
// Props
// =============================================================================

/**
 * Props accepted by the CanvasPanel component.
 * The host supplies project data, service definitions, and callbacks.
 */
export interface ICanvasPanelProps {
	/** Root OAuth2 URL for authentication refresh endpoints. */
	oauth2RootUrl: string;

	/** The project to edit. */
	project: IProject;

	/** Service catalog (keyed by provider name). */
	servicesJson: IServiceCatalog;

	/** Host function returning the FULL service definition for one provider (see FlowProjectProvider). */
	getNodeSchema?: (provider: string) => Promise<Record<string, unknown> | undefined>;

	/** Pipeline runtime status per node. */
	taskStatuses?: Record<string, ITaskStatus>;

	/** Per-component pipe counts for progress tracking. */
	componentPipeCounts?: Record<string, number>;

	/** Total number of pipes in the pipeline. */
	totalPipes?: number;

	/** Validates a full pipeline or a single component server-side. */
	handleValidatePipeline: (pipeline: IValidatePipelinePayload) => Promise<IValidateResponse>;

	/** OAuth broker return URL for hosts that intercept a deep link (e.g. VS Code). */
	oauthReturnUrl?: string;

	/** Opens an external URL in the host's system browser to start an OAuth login. */
	onOpenExternal?: (url: string) => void;

	/** OAuth tokens delivered out-of-band by the host (e.g. VS Code deep-link callback). */
	pendingOAuthTokens?: { tokens: string; state: string };

	/** Clears `pendingOAuthTokens` once a config panel has consumed them. */
	clearPendingOAuthTokens?: () => void;

	/** Opens a URL in the host browser. */
	onOpenLink?: (url: string, displayName?: string) => void;

	/** Called when pipeline content changes (dirty tracking). */
	onContentChanged?: (project: IProject) => void;

	/** Called when viewport changes (pan/zoom) — persisted per-view, not in document. */
	onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;

	/** Host-provided undo callback. */
	onUndo?: () => void;

	/** Host-provided redo callback. */
	onRedo?: () => void;

	/** Runs a pipeline: host saves to disk then executes. */
	onRunPipeline?: (source: string, project: IProject) => void;

	/** Stops a running pipeline for the given source node. */
	onStopPipeline?: (source: string) => void;

	/** Opens the status page for a source node. */
	onOpenStatus?: (source: string) => void;

	/** Server host URL for replacing {host} placeholders in endpoint URLs. */
	serverHost?: string;
	/** Mints the owner's scoped key for one endpoint address (the endpoint modal's Create API key; plan 2.4). */
	onCreateEndpointKey?: EndpointKeyMinter;
	/** Opens a node's front end for its `open-tool` note (plan 3.6). */
	onOpenTool?: OpenToolHandler;

	/** Whether the host is connected to the server. Controls run/stop button availability. */
	isConnected?: boolean;

	/** Whether either connection slot is configured to use RocketRide Cloud. */
	cloudConnectionConfigured?: boolean;

	/** Whether the user has an active subscription. When false, run buttons show a lock icon. */
	isSubscribed?: boolean;

	/** Saved viewport to restore on load — passed separately, not in the project. */
	initialViewport?: { x: number; y: number; zoom: number };

	/** Whether the document has unsaved changes — shows Save/Save As button in toolbar. */
	isDirty?: boolean;

	/** Whether the document is new (not yet saved) — shows Save As instead of Save. */
	isNew?: boolean;

	/** Called when the user triggers save from the canvas toolbar. */
	onSave?: () => void;

	/** Opens the host's RocketRide Cloud setup flow. */
	onOpenCloudSetup?: () => void;
	/** Whether the Cloud prompt was dismissed for this canvas activation. */
	cloudPromptDismissed?: boolean;
	/** Dismisses the Cloud prompt for this canvas activation. */
	onDismissCloudPrompt?: () => void;
	/** Permanently dismisses the Cloud prompt. */
	onDismissCloudPromptForever?: () => void;
	/** SaaS-only: export/download the current pipeline. Omitted hosts (VS Code) hide the button. */
	onExport?: () => void;

	/** When true, the canvas is fully read-only: no editing, no adding nodes, no run/stop. */
	isReadonly?: boolean;

	/** Available ROCKETRIDE_* environment variable key names for autocomplete in config fields. */
	envKeys?: string[];

	/** Nodes with keys their schema does not declare changed (see FlowProjectProvider). */
	onUnknownConfigKeys?: (nodeIds: string[]) => void;

	/** The red gear's hover text per node id (see FlowProjectProvider). */
	configMessages?: Record<string, string>;
}

// =============================================================================
// Component
// =============================================================================

export default function CanvasPanel({ oauth2RootUrl, oauthReturnUrl, onOpenExternal, pendingOAuthTokens, clearPendingOAuthTokens, project, servicesJson, getNodeSchema, taskStatuses, componentPipeCounts, totalPipes, handleValidatePipeline, onOpenLink, onContentChanged, onViewportChange, onUndo, onRedo, onRunPipeline, onStopPipeline, onOpenStatus, serverHost, onCreateEndpointKey, onOpenTool, isConnected, cloudConnectionConfigured, isSubscribed, initialViewport, isDirty, isNew, onSave, onOpenCloudSetup, cloudPromptDismissed, onDismissCloudPrompt, onDismissCloudPromptForever, onExport, isReadonly = false, envKeys, onUnknownConfigKeys, configMessages }: ICanvasPanelProps) {
	// --- Build inventory from service catalog --------------------------------
	const inventory = buildInventory(servicesJson);

	// NOTE: `--icon-color` is driven by the theme contract — see
	// rocketride-default.css (`:root` + `[data-theme="dark"]` for the standalone
	// case) and rocketride-vscode.css (`data-vscode-theme-kind` selectors for
	// the webview case). No runtime override is needed (or wanted — it would
	// break per-theme customization).

	// --- Render --------------------------------------------------------------

	return (
		<>
			<div
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
				}}
			>
				<FlowContainer oauth2RootUrl={oauth2RootUrl} oauthReturnUrl={oauthReturnUrl} onOpenExternal={onOpenExternal} pendingOAuthTokens={pendingOAuthTokens} clearPendingOAuthTokens={clearPendingOAuthTokens} project={project} servicesJson={servicesJson} getNodeSchema={getNodeSchema} inventory={inventory} taskStatuses={taskStatuses} componentPipeCounts={componentPipeCounts} totalPipes={totalPipes} handleValidatePipeline={handleValidatePipeline} onOpenLink={onOpenLink} onContentChanged={onContentChanged} onViewportChange={onViewportChange} onUndo={onUndo} onRedo={onRedo} onRunPipeline={onRunPipeline} onStopPipeline={onStopPipeline} onOpenStatus={onOpenStatus} serverHost={serverHost} onCreateEndpointKey={onCreateEndpointKey} onOpenTool={onOpenTool} isConnected={isConnected} cloudConnectionConfigured={cloudConnectionConfigured} isSubscribed={isSubscribed} initialViewport={initialViewport} isDirty={isDirty} isNew={isNew} onSave={onSave} onOpenCloudSetup={onOpenCloudSetup} onExport={onExport} isReadonly={isReadonly} envKeys={envKeys} onUnknownConfigKeys={onUnknownConfigKeys} configMessages={configMessages}>
					<FlowCanvas cloudPromptDismissed={cloudPromptDismissed} onDismissCloudPrompt={onDismissCloudPrompt} onDismissCloudPromptForever={onDismissCloudPromptForever} />
				</FlowContainer>
			</div>
		</>
	);
}
