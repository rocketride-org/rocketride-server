// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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
 * Wrapper canvas component used by the VS Code extension (and other lightweight hosts).
 * It provides MUI theming (auto-detecting VS Code theme changes), i18n initialisation,
 * and a snackbar provider, then delegates to the core project-canvas module.
 */
import { ThemeProvider, CssBaseline } from '@mui/material';
import { useMemo, useState, useEffect } from 'react';

import _Canvas from '../project-canvas';
import {
	IProject,
	IValidateResponse,
	TaskStatus,
} from '../project-canvas/types';
import { ActionsType } from '../project-canvas/constants';
import { createVSCodeTheme, theme } from '../../theme';
import { isInVSCode } from '../../utils/vscode';
import { buildInventory } from '../../services/dynamic-forms/utils';
import { SnackbarProvider } from '../../contexts/snackbar/SnackbarContext';
import { IDynamicForms } from '../../services/dynamic-forms/types';
import '../../services/i18n/i18n-service';

/**
 * Props accepted by the top-level Canvas wrapper component.
 * The host application (VS Code extension, Storybook, etc.) supplies project data,
 * service definitions, and callback handlers through these props.
 */
interface ICanvasProps {
	/** Root OAuth2 URL used as the refresh path (lambda) passed to the services OAuth2 endpoint. Required. */
	oauth2RootUrl: string;
	project: IProject;
	servicesJson: IDynamicForms;
	taskStatuses?: Record<string, TaskStatus>;
	componentPipeCounts?: Record<string, number>;
	totalPipes?: number;
	handleSaveProject: (project: IProject) => void;
	handleRunPipeline: (pipeline: IProject) => void;
	handleStopPipeline?: (componentId: string) => void;
	handleValidatePipeline: (pipeline: IProject) => Promise<IValidateResponse>;
	isAutosaveEnabled?: boolean;
	onAutosaveEnabledChange?: (enabled: boolean) => void;
	onOpenLink?: (url: string) => void;
	getPreference?: (key: string) => unknown;
	setPreference?: (key: string, value: unknown) => void;
	onRegisterPanelActions?: (actions: { toggleActionsPanel?: (type?: ActionsType) => void }) => void;
	/** Called when pipeline content changes (nodes, edges, etc.). Not called for viewport-only changes. */
	onContentChanged?: (project: IProject) => void;
}

/**
 * Top-level Canvas component for the VS Code extension host.
 *
 * Wraps the core `ProjectCanvas` with MUI theming (including live VS Code theme
 * synchronisation), a snackbar notification provider, and CSS baseline reset.
 * It translates host-level callbacks (save, run, stop, validate) into the shape
 * expected by the inner project-canvas module.
 *
 * @param props - {@link ICanvasProps}
 */
export default function Canvas({
	oauth2RootUrl,
	project,
	handleSaveProject,
	handleRunPipeline,
	handleStopPipeline,
	servicesJson,
	taskStatuses,
	componentPipeCounts,
	totalPipes,
	handleValidatePipeline,
	isAutosaveEnabled,
	onAutosaveEnabledChange,
	onOpenLink,
	getPreference,
	setPreference,
	onRegisterPanelActions,
	onContentChanged,
}: ICanvasProps) {
	/** Pre-computed inventory lookup built from the services JSON, passed to the inner canvas. */
	const inventory = buildInventory(servicesJson);

	// Counter used to force MUI theme re-creation whenever VS Code switches its colour theme
	const [themeVersion, setThemeVersion] = useState(0);

	// Observe VS Code theme mutations so the MUI theme stays in sync
	useEffect(() => {
		// Guard for SSR environments where document is unavailable
		if (typeof document === 'undefined') return;

		// MutationObserver fires whenever VS Code updates its theme-related attributes on <body>
		const observer = new MutationObserver(() => {
			// Bumping the version triggers useMemo below to rebuild the MUI theme
			setThemeVersion((v) => v + 1);
		});

		// Only watch the specific attributes VS Code modifies during theme transitions
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: ['class', 'data-vscode-theme-kind', 'data-vscode-theme-id'],
		});

		// Disconnect the observer on unmount to avoid memory leaks
		return () => observer.disconnect();
	}, []);

	// Derive the MUI theme from VS Code CSS variables (or fall back to the static theme)
	const currentTheme = useMemo(() => {
		const inVSCode = isInVSCode();
		// When inside VS Code, read CSS custom properties to build a matching MUI theme
		return inVSCode ? createVSCodeTheme() : theme;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [themeVersion]); // Re-create theme when themeVersion changes

	/** Passes the project to the host save handler. Project identity is pipeline.project_id only. */
	const saveProject = async (project: IProject) => {
		handleSaveProject(project);
	};

	/** Delegates pipeline execution to the host-provided run handler. */
	const runPipeline = async (pipeline: IProject) => {
		handleRunPipeline(pipeline);
	};

	/** Delegates pipeline cancellation to the host-provided stop handler, if available. */
	const stopPipeline = (projectId: string, source: string) => {
		// Only invoke if the host provided a stop callback; some hosts don't support cancellation
		if (handleStopPipeline) {
			handleStopPipeline(source);
		}
	};

	return (
		<ThemeProvider theme={currentTheme}>
			<SnackbarProvider>
				<CssBaseline />
				{/* Fixed-position container bypasses any body padding/margin the host injects */}
				<div
					style={{
						position: 'fixed',
						inset: 0,
						display: 'flex',
						flexDirection: 'column',
						overflow: 'hidden',
					}}
				>
					<_Canvas.Container
						oauth2RootUrl={oauth2RootUrl}
						project={project}
						saveProject={saveProject}
						runPipeline={runPipeline}
						stopPipeline={stopPipeline}
						handleValidatePipeline={handleValidatePipeline}
						isAutosaveEnabled={isAutosaveEnabled}
						onAutosaveEnabledChange={onAutosaveEnabledChange}
						onOpenLink={onOpenLink}
						getPreference={getPreference}
						setPreference={setPreference}
						onRegisterPanelActions={onRegisterPanelActions}
						onContentChanged={onContentChanged}
						servicesJson={servicesJson}
						taskStatuses={taskStatuses}
						componentPipeCounts={componentPipeCounts}
						totalPipes={totalPipes}
						inventory={inventory}
						features={{
							addNode: true,
							addAnnotation: true,
							fitView: true,
							zoomIn: true,
							zoomOut: true,
							lock: true,
							// Disable undo/redo inside VS Code because the host provides its own undo stack
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
						<_Canvas.Grid />
					</_Canvas.Container>
				</div>
			</SnackbarProvider>
		</ThemeProvider>
	);
}
