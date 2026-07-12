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

	/** Host-provided preference reader. */
	getPreference?: (key: string) => unknown;

	/** Host-provided preference writer. */
	setPreference?: (key: string, value: unknown) => void;

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

	/** Whether the host is connected to the server. Controls run/stop button availability. */
	isConnected?: boolean;

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
	/** SaaS-only: export/download the current pipeline. Omitted hosts (VS Code) hide the button. */
	onExport?: () => void;

	/** When true, the canvas is fully read-only: no editing, no adding nodes, no run/stop. */
	isReadonly?: boolean;

	/** Available ROCKETRIDE_* environment variable key names for autocomplete in config fields. */
	envKeys?: string[];
}

// =============================================================================
// Component
// =============================================================================

export default function Flow({ oauth2RootUrl, oauthReturnUrl, onOpenExternal, pendingOAuthTokens, clearPendingOAuthTokens, project, servicesJson, taskStatuses, componentPipeCounts, totalPipes, handleValidatePipeline, onOpenLink, getPreference, setPreference, onContentChanged, onViewportChange, onUndo, onRedo, onRunPipeline, onStopPipeline, onOpenStatus, serverHost, isConnected, isSubscribed, initialViewport, isDirty, isNew, onSave, onExport, isReadonly = false, envKeys }: IFlowProps) {
	// --- Build inventory from service catalog --------------------------------
	const inventory = buildInventory(servicesJson);

	// --- MUI theme with live VS Code theme sync -----------------------------

	// Counter bumped whenever VS Code switches themes, triggering theme rebuild
	const [themeVersion, setThemeVersion] = useState(0);

	useEffect(() => {
		if (typeof document === 'undefined') return;

		// Watch for theme attribute changes:
		//   - VS Code webview switches kind via `data-vscode-theme-kind` /
		//     `data-vscode-theme-id` on `<body>`.
		//   - Non-VS Code apps flip light/dark via `data-theme` on `<html>`
		//     (see rocketride-default.css header).
		const bump = () => setThemeVersion((v) => v + 1);
		const bodyObserver = new MutationObserver(bump);
		bodyObserver.observe(document.body, {
			attributes: true,
			attributeFilter: ['class', 'data-vscode-theme-kind', 'data-vscode-theme-id'],
		});
		const rootObserver = new MutationObserver(bump);
		rootObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme'],
		});

		return () => {
			bodyObserver.disconnect();
			rootObserver.disconnect();
		};
	}, []);

	// Rebuild MUI theme from --rr-* CSS custom properties
	const currentTheme = useMemo(() => getMuiTheme(), [themeVersion]); // eslint-disable-line react-hooks/exhaustive-deps

	// NOTE: `--icon-color` is driven by the theme contract — see
	// rocketride-default.css (`:root` + `[data-theme="dark"]` for the standalone
	// case) and rocketride-vscode.css (`data-vscode-theme-kind` selectors for
	// the webview case). `buildMuiTheme.ts` bridges the `--rr-icon-color`
	// token to `--icon-color` via MuiCssBaseline. No runtime override is
	// needed (or wanted — it would break per-theme customization).

	// --- Render --------------------------------------------------------------

	return (
		<ThemeProvider theme={currentTheme}>
			<CssBaseline />
			<div
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
				}}
			>
				<FlowContainer oauth2RootUrl={oauth2RootUrl} oauthReturnUrl={oauthReturnUrl} onOpenExternal={onOpenExternal} pendingOAuthTokens={pendingOAuthTokens} clearPendingOAuthTokens={clearPendingOAuthTokens} project={project} servicesJson={servicesJson} inventory={inventory} taskStatuses={taskStatuses} componentPipeCounts={componentPipeCounts} totalPipes={totalPipes} handleValidatePipeline={handleValidatePipeline} onOpenLink={onOpenLink} getPreference={getPreference} setPreference={setPreference} onContentChanged={onContentChanged} onViewportChange={onViewportChange} onUndo={onUndo} onRedo={onRedo} onRunPipeline={onRunPipeline} onStopPipeline={onStopPipeline} onOpenStatus={onOpenStatus} serverHost={serverHost} isConnected={isConnected} isSubscribed={isSubscribed} initialViewport={initialViewport} isDirty={isDirty} isNew={isNew} onSave={onSave} onExport={onExport} isReadonly={isReadonly} envKeys={envKeys}>
					<FlowCanvas />
				</FlowContainer>
			</div>
		</ThemeProvider>
	);
}
