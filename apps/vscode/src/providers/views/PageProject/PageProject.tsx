// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageProject — Stateless message bridge for the VSCode webview.
 *
 * Forwards all incoming messages to ProjectView via ref.handleMessage().
 * Forwards all outgoing messages from ProjectView to the extension host
 * via useMessaging.sendMessage().
 */

import React, { useRef, useCallback } from 'react';
import { ProjectView } from 'shared';
import type { ProjectViewRef, ProjectViewIncoming, ProjectViewOutgoing } from 'shared';
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

	const handleMessage = useCallback((message: IncomingMessage) => {
		viewRef.current?.handleMessage(message);
	}, []);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: handleMessage,
	});

	const handleOutgoing = useCallback(
		(msg: ProjectViewOutgoing) => {
			sendMessage(msg);
		},
		[sendMessage]
	);

	return <ProjectView ref={viewRef} onMessage={handleOutgoing} />;
};
