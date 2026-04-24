// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageProject — Message bridge for the VSCode webview.
 *
 * Forwards all incoming messages to ProjectView via ref.handleMessage().
 * Forwards all outgoing messages from ProjectView to the extension host.
 *
 * Uses vscode.getState()/setState() for per-document view state persistence
 * (viewport, mode, flowViewMode) — survives tab switches and restarts.
 */

import React, { useRef, useCallback } from 'react';
import { ProjectView } from 'shared';
import type { ProjectViewRef, ViewState, ProjectViewIncoming, ProjectViewOutgoing } from 'shared';
import { useMessaging } from '../../../shared/util/useMessaging';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

// =============================================================================
// MESSAGE TYPES
// =============================================================================

type OutgoingMessage = ProjectViewOutgoing | { type: 'ready' };
type IncomingMessage = ProjectViewIncoming;

// =============================================================================
// COMPONENT
// =============================================================================

export const PageProject: React.FC = () => {
	const viewRef = useRef<ProjectViewRef>(null);
	const getStateRef = useRef<() => ViewState | null>(() => null);

	const handleMessage = useCallback((message: IncomingMessage) => {
		// For project:load, override viewState with saved webview state if available
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
			// Persist viewState changes to webview state (survives restarts)
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
