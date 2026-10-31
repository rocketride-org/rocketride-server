// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// PROJECT PAGE — this host's DOCUMENT SEAM around the shared pipeline editor
// =============================================================================
//
// The editor itself (canvas, sections, deploy page, record drawers, DVR,
// monitors, event folding) is the shared PipelineEditor
// (shared/tools/pipelines); what lives here is exactly what the cloud host
// owns and no other host does:
//
//   - the Documents-store document: save / save-as (SaveFileDialog over the
//     project VFS), dirty-run choreography, tab re-pointing after save-as;
//   - run settings resolution (the pipeline-builder settings) and the
//     client.use/terminate/restart verbs;
//   - the subscription prompt (shell:subscribe toward the shell's
//     CheckoutFlow) and the paywall gate;
//   - publish (client.deploy.add of the saved snapshot) and export.
// =============================================================================

import React, { useCallback, useMemo, useRef, useState, CSSProperties, useEffect } from 'react';
import { commonStyles } from 'shell';
import { getClient, useShellConnection, useWorkspace, useSubscriptions, ConnectionManager, ConfirmDialog, SaveFileDialog } from 'shell';
import { getDocs } from '../../docs';
import type { PipelineConfig } from 'shell';
// Project module is imported via subpath (not the 'shared' barrel) so the
// canvas bundles into THIS app, not the shell's eager shared chunk.
import { PipelineEditor } from 'shared/tools/pipelines/PipelineEditor';
import type { IPipelineEditorHost } from 'shared/tools/pipelines/PipelineEditor';
import type { TraceLevel, ViewState } from 'shared/tools/pipelines';
import { displayName as projectDisplayName } from '../workspace/projectStore';
import { createProjectVfs } from '../workspace/projectVfs';
import { downloadJson } from '../../utils/downloadFile';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		...commonStyles.columnFill,
		flex: 1,
		backgroundColor: 'var(--rr-bg-default)',
	} as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for PipelineProvider — received from RocketApp's editor content router.
 */
interface ProjectPageProps {
	/** Document URI / file path. */
	uri: string;
	/** Parsed PipelineConfig object. */
	pipeline: PipelineConfig;
	/** Whether the document has unsaved changes. */
	isDirty: boolean;
	/** Whether the document has never been saved to disk. */
	isNew: boolean;
	/** Whether the pipeline should be displayed in read-only mode (e.g. status views for unknown tasks). */
	isReadonly?: boolean;
	/**
	 * Per-editor saved view state (active tab, viewport, flow mode). Typed
	 * `unknown` because it is an untyped persisted blob from the Documents
	 * store; it was originally written from a ProjectView `ViewState`, so it
	 * is narrowed back to that shape where it is handed to the editor.
	 */
	initialViewState?: unknown;
	/** Called when the pipeline editor modifies the content. */
	onContentChanged: (updatedPipeline: any) => void;
	/** Called when view state changes (tab switch, viewport pan/zoom). */
	onViewStateChange?: (viewState: Record<string, unknown>) => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Pipeline editor view — the cloud host's seam around the shared editor.
 *
 * @param props - Project page configuration.
 */
const PipelineProvider: React.FC<ProjectPageProps> = ({ uri, pipeline, isDirty, isNew, isReadonly = false, initialViewState, onContentChanged, onViewStateChange: onViewStateChangeProp }) => {
	const { client, isConnected } = useShellConnection();
	const { settings } = useWorkspace();

	// --- Unified settings (effective values incl. manifest defaults) ----------

	// Default trace level for pipelines with no per-editor override
	const settingTraceLevel = (String(settings['rocketride.pipeBuilder.pipelineTraceLevel'] ?? '') || 'full') as TraceLevel;
	// Default idle-timeout in seconds; NaN when unset (then the engine default applies)
	const settingTtl = Number(settings['rocketride.pipeBuilder.pipelineTTL'] ?? NaN);
	// Extra command-line arguments for each task, kept as one raw string — the
	// engine splits it with shell parsing rules so quoted paths survive
	const settingTaskArguments = String(settings['rocketride.pipeBuilder.taskArguments'] ?? '').trim();
	// Full task debug output; adds --trace=debugOut to the task args when enabled
	const settingDebugOutput = settings['rocketride.pipeBuilder.pipelineDebugOutput'] === true;
	// Workspace-relative directory preselected when saving an untitled pipeline;
	// SaveFileDialog renders it even before it exists and mkdirs it on confirm
	const settingDefaultDir = String(settings['rocketride.pipeBuilder.defaultPipelinePath'] ?? '').replace(/^\/+|\/+$/g, '') || 'pipelines';

	// Rocket Builder is a paywalled app. Running requires an active sub —
	// gate the run controls (lock icon) and the run action on this. Reactive:
	// updates live when the subscription status changes.
	const { getStatus } = useSubscriptions();
	const isSubscribed = useMemo(() => {
		const s = getStatus('rocketride.pipeBuilder');
		return s === 'subscribed' || s === 'trialing';
	}, [getStatus]);

	const [saveDialogOpen, setSaveDialogOpen] = useState(false);
	const [pendingRun, setPendingRun] = useState<{ action: string; source?: string } | null>(null);
	// Ref preserves the run intent across save-as for new files (state is
	// cleared to dismiss the ConfirmDialog, but the ref survives)
	const deferredRunRef = useRef<{ action: string; source?: string } | null>(null);
	const [pipelineError, setPipelineError] = useState<string | null>(null);

	const projectId = pipeline?.project_id ?? '';
	const filename = uri;

	// Project-store VFS for the stock SaveFileDialog — the dialog loads its own
	// folder tree and drives its own overwrite confirm through this adapter.
	const projectVfs = useMemo(() => createProjectVfs(client), [client]);

	// --- Viewport restore on view activation ----------------------------------

	useEffect(() => {
		const unsub = ConnectionManager.getInstance().on('shell:viewActivated', () => {
			window.dispatchEvent(new CustomEvent('canvas:restoreViewport'));
		});
		return unsub;
	}, []);

	// --- Save logic -----------------------------------------------------------

	/**
	 * Saves the pipeline to disk and marks the document clean.
	 *
	 * @param saveFilename - The file path to save to.
	 * @param project      - The pipeline configuration to save.
	 * @param opts         - When `rethrow` is set, a save failure re-throws
	 *   after surfacing the error (the save-and-publish path awaits the save,
	 *   so a swallowed failure would publish an unsaved pipeline).
	 */
	const performSave = useCallback(
		async (saveFilename: string, project: PipelineConfig, opts?: { rethrow?: boolean }) => {
			if (!client || !isConnected) return;
			try {
				await projectVfs.write(saveFilename, project);
				// Mark clean in Documents model
				await getDocs()?.saveDocument(uri);
				window.dispatchEvent(new CustomEvent('project:saved', { detail: { projectId } }));
			} catch (err) {
				console.error('[PipelineProvider] Save failed:', err);
				// Surface the failure — a silent catch leaves the user believing
				// the document was saved.
				setPipelineError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
				if (opts?.rethrow) throw err;
			}
		},
		[client, isConnected, projectId, uri, projectVfs]
	);

	// --- Pipeline run/stop/restart -------------------------------------------

	/**
	 * Opens the subscription checkout (plan picker) for Rocket Builder.
	 * Uses the app entry from account info when present, else a minimal entry.
	 */
	const promptSubscribe = useCallback(() => {
		const info: any = getClient()?.getAccountInfo();
		const app = info?.apps?.find((a: any) => a.id === 'rocketride.pipeBuilder') ?? { id: 'rocketride.pipeBuilder', name: 'Rocket Builder', description: '' };
		ConnectionManager.getInstance().emit('shell:subscribe', { app });
	}, []);

	/**
	 * Executes a pipeline action (run, stop, restart) via the RocketRide client.
	 */
	const executePipelineAction = useCallback(
		(action: string, source?: string) => {
			if (!client || !isConnected || !pipeline) return;
			const pid = pipeline.project_id;
			if (!source || !pid) return;

			// Subscription gate (defense-in-depth; the primary gate is in
			// runAction below).
			if ((action === 'run' || action === 'restart') && !isSubscribed) {
				promptSubscribe();
				return;
			}

			if (action === 'run') {
				// Trace level, TTL, task arguments, and debug output all come from
				// the effective pipeline-builder settings. ttl:0 = no timeout;
				// omitting ttl lets the engine apply its own default.
				const traceLevel = settingTraceLevel;
				const ttl = Number.isFinite(settingTtl) ? settingTtl : undefined;
				const taskArgs: string[] = [];
				if (settingTaskArguments) taskArgs.push(settingTaskArguments);
				if (settingDebugOutput && !settingTaskArguments.includes('--trace=')) taskArgs.push('--trace=debugOut');
				client
					.use({
						pipeline,
						source,
						name: projectDisplayName(filename),
						pipelineTraceLevel: traceLevel,
						...(taskArgs.length > 0 ? { args: taskArgs } : {}),
						...(ttl !== undefined ? { ttl } : {}),
					})
					.catch((err: unknown) => setPipelineError(err instanceof Error ? err.message : String(err)));
			} else if (action === 'stop') {
				client
					.getTaskToken({ projectId: pid, source })
					.then((token: string | undefined) => (token ? client.terminate(token) : undefined))
					.catch((err: unknown) => setPipelineError(err instanceof Error ? err.message : String(err)));
			} else if (action === 'restart') {
				client
					.getTaskToken({ projectId: pid, source })
					// No token = no running task to restart; the server rejects a
					// tokenless restart outright, so skip it exactly as stop does.
					.then((token: string | undefined) => (token ? client.restart({ token, projectId: pid, source, pipeline: pipeline as unknown as Record<string, unknown> }) : undefined))
					.catch((err: unknown) => setPipelineError(err instanceof Error ? err.message : String(err)));
			}
		},
		[client, isConnected, pipeline, filename, isSubscribed, promptSubscribe, settingTraceLevel, settingTtl, settingTaskArguments, settingDebugOutput]
	);

	/** Initiates save — the save dialog for new documents, else direct. */
	const handleSave = useCallback(() => {
		if (!pipeline) return;
		if (isNew) {
			setSaveDialogOpen(true);
			return;
		}
		performSave(filename, pipeline);
	}, [isNew, filename, pipeline, performSave]);

	/** Exports the current pipeline as a downloaded .pipe file (SaaS-only). */
	const handleExport = useCallback(() => {
		if (!pipeline) return;
		const name = filename.split('/').pop() ?? 'pipeline.pipe';
		downloadJson(name, pipeline);
	}, [filename, pipeline]);

	/** Handles save-dialog confirmation with a new file path. */
	const handleSaveDialogConfirm = useCallback(
		async (fileRelPath: string) => {
			if (!pipeline || !client || !isConnected) return;
			setSaveDialogOpen(false);

			try {
				await projectVfs.write(fileRelPath, pipeline);
			} catch (err) {
				console.error('[PipelineProvider] Save-as failed:', err);
				setPipelineError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}

			// Close old tab and open the new file so the tab name updates
			const docs = getDocs();
			if (docs) {
				const st = docs.getState();
				const editorIds = Object.entries(st.editors)
					.filter(([, ed]) => ed.documentUri === uri)
					.map(([id]) => id);
				for (const eid of editorIds) docs.closeEditor(eid);
				await docs.openDocument(fileRelPath);
			}

			window.dispatchEvent(new CustomEvent('project:saved', { detail: { projectId } }));

			// If there was a deferred run (save-and-run flow), execute it now
			const deferredRun = deferredRunRef.current;
			deferredRunRef.current = null;
			if (deferredRun) {
				executePipelineAction(deferredRun.action, deferredRun.source);
			}
		},
		[pipeline, client, isConnected, uri, projectId, executePipelineAction, projectVfs]
	);

	/** Pipeline action with the dirty-save prompt choreography. */
	const runAction = useCallback(
		(action: 'run' | 'stop' | 'restart', source?: string) => {
			// Not subscribed → prompt checkout instead of running. Gate here,
			// before the dirty-save detour, so the lock always prompts checkout.
			if ((action === 'run' || action === 'restart') && !isSubscribed) {
				promptSubscribe();
				return;
			}
			if (action !== 'run') {
				executePipelineAction(action, source);
				return;
			}
			if (isDirty) {
				// exactOptionalPropertyTypes: omit `source` entirely when absent.
				setPendingRun(source !== undefined ? { action, source } : { action });
				return;
			}
			executePipelineAction(action, source);
		},
		[isDirty, executePipelineAction, isSubscribed, promptSubscribe]
	);

	/** Saves the pipeline then runs the pending action. */
	const handleSaveAndRun = useCallback(() => {
		if (!pendingRun || !pipeline) {
			setPendingRun(null);
			return;
		}
		if (isNew) {
			// Stash the run intent so handleSaveDialogConfirm can trigger it
			// after save-as. Clear state to dismiss the ConfirmDialog.
			deferredRunRef.current = pendingRun;
			setPendingRun(null);
			setSaveDialogOpen(true);
			return;
		}
		const run = pendingRun;
		setPendingRun(null);
		if (!client || !isConnected) return;
		projectVfs.write(filename, pipeline)
			.then(() => {
				getDocs()?.saveDocument(uri);
				executePipelineAction(run.action, run.source);
			})
			.catch((err) => setPipelineError(err instanceof Error ? err.message : String(err)));
	}, [pendingRun, isNew, filename, pipeline, client, isConnected, uri, executePipelineAction, projectVfs]);

	// --- Publish (client.deploy.add of the saved snapshot) --------------------

	const handlePublish = useCallback(
		async (comment: string, deployTo?: string): Promise<void> => {
			if (!client || !pipeline) throw new Error('Not connected');
			// Snapshot carries a display name: the registry's pipelineName is
			// what every deploy surface renders (names live in filenames here).
			const documentName = projectDisplayName(filename);
			const snapshot = { ...pipeline, name: pipeline.name || documentName };
			await client.deploy.add({
				pipeline: snapshot,
				...(comment ? { comment } : {}),
				...(deployTo ? { deployTo } : {}),
			});
		},
		[client, pipeline, filename]
	);

	// --- The host seam ---------------------------------------------------------

	const handleOpenLink = useCallback((url: string, displayName?: string) => {
		const docs = getDocs();
		if (!docs) return;
		docs.openStaticDocument(`webview:${url}`, displayName || 'Webview');
	}, []);

	const documentTitle = useMemo(() => {
		const docState = getDocs()?.getState();
		return (docState ? Object.values(docState.editors).find((editor) => editor.documentUri === uri)?.label : undefined) || projectDisplayName(filename);
	}, [uri, filename]);

	const editorHost = useMemo<IPipelineEditorHost>(
		() => ({
			documentTitle,
			isDirty,
			isNew,
			isReadonly,
			...(initialViewState ? { initialViewState: initialViewState as ViewState } : {}),
			onViewStateChange: (viewState: ViewState) => onViewStateChangeProp?.({ ...viewState }),
			onContentChanged,
			save: handleSave,
			// The publish flow awaits the save; a failed save MUST abort it.
			saveDocument: () => performSave(filename, pipeline, { rethrow: true }),
			publish: handlePublish,
			runAction,
			isSubscribed,
			promptSubscribe,
			openLink: handleOpenLink,
			exportDocument: handleExport,
		}),
		[documentTitle, isDirty, isNew, isReadonly, initialViewState, onViewStateChangeProp, onContentChanged, handleSave, performSave, filename, pipeline, handlePublish, runAction, isSubscribed, promptSubscribe, handleOpenLink, handleExport]
	);

	// --- Render --------------------------------------------------------------

	return (
		<div style={styles.container}>
			<PipelineEditor project={pipeline} host={editorHost} />
			{/* Preselect the document's own folder/name (an untitled doc has no
			    folder, so it opens at the workspace's default pipeline directory
			    with its "Untitled-N" placeholder). */}
			{saveDialogOpen && <SaveFileDialog title="Save Pipeline As" vfs={projectVfs} fileTypes={[{ label: 'RocketRide Pipeline', extension: '.pipe' }]} defaultDir={filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/')) : settingDefaultDir} initialName={projectDisplayName(filename)} onConfirm={handleSaveDialogConfirm} onCancel={() => setSaveDialogOpen(false)} />}
			{pendingRun && <ConfirmDialog title="Unsaved Changes" message="The pipeline has unsaved changes. Save before running?" confirmLabel="Save & Run" cancelLabel="Cancel" onConfirm={handleSaveAndRun} onCancel={() => setPendingRun(null)} />}
			{pipelineError && <ConfirmDialog title="Pipeline Error" message={pipelineError} confirmLabel="OK" onConfirm={() => setPipelineError(null)} onCancel={() => setPipelineError(null)} />}
		</div>
	);
};

export default PipelineProvider;
