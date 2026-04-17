// =============================================================================
// ProjectPage — Shared iframe/webview content for the pipeline editor
// =============================================================================
//
// Works in both VS Code webviews (via acquireVsCodeApi) and browser iframes
// (via window.parent.postMessage). Context is detected automatically by
// useMessaging.
//
// CSS is injected by the platform-specific entry point (page-project.tsx for
// browser, PageProject/index.tsx for VS Code). This file has no CSS imports.
// =============================================================================

import React, { useRef, useCallback } from 'react';
import ProjectView from './ProjectView';
import type { ProjectViewRef, ViewState, ProjectViewIncoming, ProjectViewOutgoing } from './types';
import { useMessaging } from '../../hooks/useMessaging';

// =============================================================================
// TYPES
// =============================================================================

type OutgoingMessage = ProjectViewOutgoing | { type: 'ready' };
type IncomingMessage = ProjectViewIncoming;

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * ProjectPage — renders ProjectView and bridges all postMessage communication.
 *
 * VS Code: uses acquireVsCodeApi().postMessage / getState / setState.
 * Browser: uses window.parent.postMessage. getState/setState are no-ops
 * (the shell workspace context handles view state persistence).
 */
export const ProjectPage: React.FC = () => {
	const viewRef = useRef<ProjectViewRef>(null);
	const getStateRef = useRef<() => ViewState | null>(() => null);

	const handleMessage = useCallback((message: IncomingMessage) => {
		// In VS Code: override viewState with saved webview state if available
		if (message.type === 'project:load') {
			const saved = getStateRef.current();
			if (saved && Object.keys(saved).length > 0) {
				viewRef.current?.handleMessage({ ...message, viewState: saved });
				return;
			}
		}
		viewRef.current?.handleMessage(message);
	}, []);

	const { sendMessage, getState, setState } = useMessaging<OutgoingMessage, IncomingMessage, ViewState>({
		onMessage: handleMessage,
	});
	getStateRef.current = getState;

	const handleOutgoing = useCallback(
		(msg: ProjectViewOutgoing) => {
			// Persist viewState changes to VS Code webview state (survives tab switches)
			if (msg.type === 'project:viewStateChange') {
				const current = getState() ?? ({} as ViewState);
				setState({ ...current, ...(msg as any).viewState });
			}
			sendMessage(msg);
		},
		[sendMessage, getState, setState]
	);

	return <ProjectView ref={viewRef} onMessage={handleOutgoing} />;
};
