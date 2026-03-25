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
 * Flow — Top-level entry point for the pipeline canvas.
 *
 * This is the single component that host applications (VS Code, web app)
 * render. It sets up:
 *   - MUI ThemeProvider with live VS Code theme synchronisation
 *   - CssBaseline reset
 *   - Full-viewport container
 *   - FlowContainer (context providers) + Canvas (ReactFlow surface)
 *
 * The host only needs to pass project data, service definitions, and
 * callback handlers. Everything else is self-contained.
 */

import { ThemeProvider, CssBaseline } from '@mui/material';
import { useMemo, useState, useEffect } from 'react';

import FlowContainer from './components/FlowContainer';
import FlowCanvas from './components/FlowCanvas';
import { IProject, IValidateResponse, ITaskStatus } from './types';
import { getMuiTheme } from '../../themes/getMuiTheme';
import { isInVSCode } from '../../themes/vscode';
import { buildInventory } from './util/helpers';
import { IServiceCatalog } from './types';

// =============================================================================
// Props
// =============================================================================

/**
 * Props accepted by the Flow component.
 * The host supplies project data, service definitions, and callbacks.
 */
export interface IFlowProps {
	/** Root OAuth2 URL for authentication refresh endpoints. */
	oauth2RootUrl: string;

	/** The project to edit. */
	project: IProject;

	/** Service catalog (keyed by provider name). */
	servicesJson: IServiceCatalog;

	/** Pipeline runtime status per node. */
	taskStatuses?: Record<string, ITaskStatus>;

	/** Per-component pipe counts for progress tracking. */
	componentPipeCounts?: Record<string, number>;

	/** Total number of pipes in the pipeline. */
	totalPipes?: number;

	/** Validates the pipeline server-side. */
	handleValidatePipeline: (pipeline: IProject) => Promise<IValidateResponse>;

	/** Opens a URL in the host browser. */
	onOpenLink?: (url: string, displayName?: string) => void;

	/** Host-provided preference reader. */
	getPreference?: (key: string) => unknown;

	/** Host-provided preference writer. */
	setPreference?: (key: string, value: unknown) => void;

	/** Called when pipeline content changes (dirty tracking). */
	onContentChanged?: (project: IProject) => void;

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
}

// =============================================================================
// Component
// =============================================================================

export default function Flow({ oauth2RootUrl, project, servicesJson, taskStatuses, componentPipeCounts, totalPipes, handleValidatePipeline, onOpenLink, getPreference, setPreference, onContentChanged, onUndo, onRedo, onRunPipeline, onStopPipeline, onOpenStatus, serverHost }: IFlowProps) {
	// --- Build inventory from service catalog --------------------------------
	const inventory = buildInventory(servicesJson);

	// --- MUI theme with live VS Code theme sync -----------------------------

	// Counter bumped whenever VS Code switches themes, triggering theme rebuild
	const [themeVersion, setThemeVersion] = useState(0);

	useEffect(() => {
		if (typeof document === 'undefined') return;

		// Watch for VS Code theme attribute changes on <body>
		const observer = new MutationObserver(() => setThemeVersion((v) => v + 1));
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: ['class', 'data-vscode-theme-kind', 'data-vscode-theme-id'],
		});

		return () => observer.disconnect();
	}, []);

	// Rebuild MUI theme from --rr-* CSS custom properties
	const currentTheme = useMemo(() => getMuiTheme(), [themeVersion]); // eslint-disable-line react-hooks/exhaustive-deps

	// --- Render --------------------------------------------------------------

	return (
		<ThemeProvider theme={currentTheme}>
			<CssBaseline />
			{/* Fixed-position container fills the entire viewport */}
			<div
				style={{
					position: 'fixed',
					inset: 0,
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
				}}
			>
				<FlowContainer
					oauth2RootUrl={oauth2RootUrl}
					project={project}
					servicesJson={servicesJson}
					inventory={inventory}
					taskStatuses={taskStatuses}
					componentPipeCounts={componentPipeCounts}
					totalPipes={totalPipes}
					handleValidatePipeline={handleValidatePipeline}
					onOpenLink={onOpenLink}
					getPreference={getPreference}
					setPreference={setPreference}
					onContentChanged={onContentChanged}
					onUndo={onUndo}
					onRedo={onRedo}
					onRunPipeline={onRunPipeline}
					onStopPipeline={onStopPipeline}
					onOpenStatus={onOpenStatus}
					serverHost={serverHost}
					features={{
						addNode: true,
						addAnnotation: true,
						fitView: true,
						zoomIn: true,
						zoomOut: true,
						lock: true,
						undo: !isInVSCode(),
						redo: !isInVSCode(),
						keyboardShortcuts: true,
						logs: false,
						save: true,
						saveAs: true,
						importExport: false,
						moreOptions: false,
					}}
				>
					<FlowCanvas />
				</FlowContainer>
			</div>
		</ThemeProvider>
	);
}
