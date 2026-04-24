// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ProjectWebview — VS Code webview bridge for the pipeline editor.
 *
 * Receives messages from the extension host via useMessaging, manages local
 * state, and renders <ProjectView> with props. User actions from ProjectView
 * flow back as messages to the extension host.
 *
 * Architecture:
 *   ProjectHost (Node.js) ↔ postMessage ↔ ProjectWebview (browser) → ProjectView (pure UI)
 */

import React, { useState, useCallback, useRef } from 'react';

import { applyTheme } from 'shared/themes';
import { ProjectView, parseServerEvent } from 'shared';
import type { TaskStatus, TraceEvent, ViewState } from 'shared';
import { useMessaging } from '../hooks/useMessaging';
import type { ProjectHostToWebview, ProjectWebviewToHost } from '../types';

// =============================================================================
// COMPONENT
// =============================================================================

const ProjectWebview: React.FC = () => {
	// --- State (populated from host messages) ---------------------------------

	const [project, setProject] = useState<any>(null);
	const [projectId, setProjectId] = useState<string>('');
	const [servicesJson, setServicesJson] = useState<Record<string, any>>({});
	const [isConnected, setIsConnected] = useState(false);
	const [statusMap, setStatusMap] = useState<Record<string, TaskStatus>>({});
	const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
	const [viewState, setViewState] = useState<ViewState | undefined>(undefined);
	const [prefs, setPrefs] = useState<Record<string, unknown> | undefined>(undefined);
	const [serverHost, setServerHost] = useState<string>('');
	const [isDirty, setIsDirty] = useState(false);
	const [isNew, setIsNew] = useState(false);

	// --- Stable refs for message handler closures ----------------------------

	const projectIdRef = useRef(projectId);
	projectIdRef.current = projectId;

	// Pending validate requests (request-ID → Promise resolver)
	const pendingValidates = useRef<Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>>(new Map());
	const validateCounter = useRef(0);

	// --- Messaging ------------------------------------------------------------

	const sendMessageRef = useRef<(msg: ProjectWebviewToHost) => void>(() => {});
	const getStateRef = useRef<() => ViewState | null>(() => null);

	const handleMessage = useCallback((msg: ProjectHostToWebview) => {
		switch (msg.type) {
			case 'project:load': {
				// Restore saved webview state if available (survives tab switches)
				const saved = getStateRef.current();
				const vs = saved && Object.keys(saved).length > 0 ? saved : msg.viewState;

				setProject(msg.project);
				setProjectId(msg.project?.project_id ?? '');
				setServicesJson(msg.services);
				setIsConnected(msg.isConnected);
				setStatusMap(msg.statuses ?? {});
				setViewState({
					mode: vs?.mode ?? 'design',
					flowViewMode: vs?.flowViewMode ?? 'pipeline',
					viewport: vs?.viewport,
				});
				setPrefs(msg.prefs ?? {});
				setTraceEvents([]);
				if (msg.serverHost) setServerHost(msg.serverHost);
				break;
			}
			case 'shell:init':
				if (msg.theme) applyTheme(msg.theme as any);
				setIsConnected(msg.isConnected);
				sendMessageRef.current({ type: 'view:initialized' });
				break;
			case 'shell:themeChange':
				applyTheme(msg.tokens as any);
				break;
			case 'project:update':
				setProject(msg.project);
				break;
			case 'project:services':
				setServicesJson(msg.services);
				break;
			case 'project:validateResponse': {
				const pending = pendingValidates.current.get(msg.requestId);
				if (pending) {
					pendingValidates.current.delete(msg.requestId);
					if (msg.error) pending.reject(new Error(msg.error));
					else pending.resolve(msg.result);
				}
				break;
			}
			case 'server:event': {
				const pid = projectIdRef.current;
				const parsed = parseServerEvent(msg.event, pid);
				if (parsed.statusUpdate) {
					setStatusMap((prev) => ({ ...prev, [parsed.statusUpdate!.source]: parsed.statusUpdate!.status }));
				}
				if (parsed.traceEvent) {
					setTraceEvents((prev) => [...prev, parsed.traceEvent!]);
				}
				break;
			}
			case 'shell:connectionChange':
				if (msg.isConnected) {
					setStatusMap({});
					setTraceEvents([]);
				}
				setIsConnected(msg.isConnected);
				break;
			case 'shell:viewActivated':
				window.dispatchEvent(new CustomEvent('canvas:restoreViewport'));
				break;
			case 'project:initialState':
				setViewState({
					mode: msg.state?.mode ?? 'design',
					flowViewMode: msg.state?.flowViewMode ?? 'pipeline',
					viewport: msg.state?.viewport,
				});
				break;
			case 'project:initialPrefs':
				setPrefs(msg.prefs ?? {});
				break;
			case 'project:dirtyState':
				setIsDirty(msg.isDirty);
				setIsNew(msg.isNew);
				break;
		}
	}, []);

	const { sendMessage, getState, setState } = useMessaging<ProjectWebviewToHost, ProjectHostToWebview, ViewState>({
		onMessage: handleMessage,
	});
	sendMessageRef.current = sendMessage;
	getStateRef.current = getState;

	// --- ProjectView callbacks → outgoing messages ---------------------------

	const handleContentChanged = useCallback(
		(updatedProject: any) => {
			setProject(updatedProject);
			sendMessage({ type: 'project:contentChanged', project: updatedProject });
		},
		[sendMessage]
	);

	const handleValidate = useCallback(
		async (pipeline: any): Promise<any> => {
			return new Promise((resolve, reject) => {
				const requestId = ++validateCounter.current;
				pendingValidates.current.set(requestId, { resolve, reject });
				sendMessage({ type: 'project:validate', requestId, pipeline });
				// Timeout: resolve with empty result after 15s to avoid hanging
				setTimeout(() => {
					if (pendingValidates.current.has(requestId)) {
						pendingValidates.current.get(requestId)!.resolve({ errors: [], warnings: [] });
						pendingValidates.current.delete(requestId);
					}
				}, 15000);
			});
		},
		[sendMessage]
	);

	const handlePipelineAction = useCallback(
		(action: 'run' | 'stop' | 'restart', source?: string) => {
			sendMessage({ type: 'status:pipelineAction', action, source });
		},
		[sendMessage]
	);

	const handleViewStateChange = useCallback(
		(vs: ViewState) => {
			// Persist to VS Code webview state (survives tab switches)
			const current = getState() ?? ({} as ViewState);
			setState({ ...current, ...vs });
			sendMessage({ type: 'project:viewStateChange', viewState: vs });
		},
		[sendMessage, getState, setState]
	);

	const handlePrefsChange = useCallback(
		(updatedPrefs: Record<string, unknown>) => {
			sendMessage({ type: 'project:prefsChange', prefs: updatedPrefs });
		},
		[sendMessage]
	);

	const handleOpenLink = useCallback(
		(url: string, displayName?: string) => {
			sendMessage({ type: 'project:openLink', url, displayName });
		},
		[sendMessage]
	);

	const handleSave = useCallback(() => {
		sendMessage({ type: 'project:requestSave' });
	}, [sendMessage]);

	const handleTraceClear = useCallback(() => {
		setTraceEvents([]);
		sendMessage({ type: 'trace:clear' });
	}, [sendMessage]);

	// --- Wait for initial state from host before rendering -------------------

	if (!viewState || !prefs) return null;

	// --- Render --------------------------------------------------------------

	return <ProjectView project={project} servicesJson={servicesJson} isConnected={isConnected} statusMap={statusMap} serverHost={serverHost} isDirty={isDirty} isNew={isNew} initialViewState={viewState} initialPrefs={prefs} traceEvents={traceEvents} onContentChanged={handleContentChanged} onValidate={handleValidate} onPipelineAction={handlePipelineAction} onViewStateChange={handleViewStateChange} onPrefsChange={handlePrefsChange} onOpenLink={handleOpenLink} onSave={handleSave} onTraceClear={handleTraceClear} />;
};

export default ProjectWebview;
