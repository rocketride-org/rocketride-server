// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * StatusWebview — VS Code webview bridge for the status-only task viewer.
 *
 * Receives a synthesized project and server events from the extension host,
 * renders <ProjectView statusOnly> from shared-ui.
 *
 * Architecture:
 *   PageStatusProvider (Node.js) ↔ postMessage ↔ StatusWebview (browser) → ProjectView (shared-ui)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';

import { ProjectView, parseServerEvent } from 'shared';
import type { TaskStatus, TraceEvent, ViewState } from 'shared';
import { useMessaging } from '../hooks/useMessaging';

// =============================================================================
// TYPES
// =============================================================================

type OutgoingMessage = { type: 'view:ready' } | { type: 'status:pipelineAction'; action: string; source?: string };

type IncomingMessage = { type: 'status:init'; project: any; isConnected: boolean; serverHost?: string } | { type: 'server:event'; event: any } | { type: 'shell:connectionChange'; isConnected: boolean };

// =============================================================================
// COMPONENT
// =============================================================================

const StatusWebview: React.FC = () => {
	const [project, setProject] = useState<any>(null);
	const [projectId, setProjectId] = useState('');
	const [isConnected, setIsConnected] = useState(false);
	const [statusMap, setStatusMap] = useState<Record<string, TaskStatus>>({});
	const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
	const [serverHost, setServerHost] = useState('');

	const projectIdRef = useRef(projectId);
	useEffect(() => {
		projectIdRef.current = projectId;
	}, [projectId]);

	// ── Messaging ───────────────────────────────────────────────────────

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (msg) => {
			switch (msg.type) {
				case 'status:init':
					setProject(msg.project);
					setProjectId(msg.project?.project_id ?? '');
					setIsConnected(msg.isConnected);
					if (msg.serverHost) setServerHost(msg.serverHost);
					setStatusMap({});
					setTraceEvents([]);
					break;

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
			}
		},
	});

	// ── Callbacks ────────────────────────────────────────────────────────

	const handlePipelineAction = useCallback(
		(action: 'run' | 'stop' | 'restart', source?: string) => {
			sendMessage({ type: 'status:pipelineAction', action, source });
		},
		[sendMessage]
	);

	const handleTraceClear = useCallback(() => {
		setTraceEvents([]);
	}, []);

	// ── Render ───────────────────────────────────────────────────────────

	if (!project) return null;

	return <ProjectView project={project} servicesJson={{}} isConnected={isConnected} statusMap={statusMap} serverHost={serverHost} traceEvents={traceEvents} onPipelineAction={handlePipelineAction} onTraceClear={handleTraceClear} statusOnly />;
};

export default StatusWebview;
