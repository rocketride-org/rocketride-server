// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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

// =============================================================================
// AGENT TOOL — the builtin agent tool's CONTROLLER (a DevToolProps component)
// =============================================================================
//
// Owns the MY SESSIONS state end to end: lists the .agents catalog on the
// realm's own connection, refreshes on the shell bus's fs-change notify,
// and expresses every action through generic host services (openPage /
// closePage / confirm). The host contributes no agent-specific wiring.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DevToolProps, ShellNotification } from 'shell';
import { showConfirmDialog } from 'shell';
import { ConnectionManager, useShellConnection, useWorkspace } from 'shell';
import { AgentSession, AGENTS_DIR } from '../../modules/agent/agent';
import type { AgentSessionMeta } from '../../modules/agent/agent';
import { useToolHost } from '../core/ToolContext';
import { AgentSidebarPanel } from './AgentSidebarPanel';
import type { AgentSidebar } from './types';
import type { IntroMode } from '../introCatalog';

/**
 * The agent tool's sidebar controller. Conversations are the tool's OWN
 * documents (tool:agent/<sessionId>), rendered by AgentConversationTool.
 */
export const AgentTool: React.FC<DevToolProps> = ({ documents }) => {
	const services = useToolHost();
	const { client, isConnected } = useShellConnection();

	// Session HISTORY is namespaced by the hosting app's id — the workspace
	// supplies it; AgentSession.configure stamps it for the storage layer.
	const { activeAppId: hostAppId } = useWorkspace();
	useEffect(() => {
		AgentSession.configure(hostAppId);
	}, [hostAppId]);

	const [sessions, setSessions] = useState<AgentSessionMeta[]>([]);
	// Ticket guard: only the newest listing lands (a slow list resolving
	// after a disconnect or a newer refresh must not apply stale rows).
	const reqRef = useRef(0);
	const refresh = useCallback(async () => {
		const req = ++reqRef.current;
		if (!client || !isConnected) {
			setSessions([]);
			return;
		}
		try {
			const listed = await AgentSession.getSessions();
			if (req === reqRef.current) setSessions(listed);
		} catch {
			if (req === reqRef.current) setSessions([]);
		}
	}, [client, isConnected]);
	useEffect(() => { void refresh(); }, [refresh]);

	// Agent history is a separate store tree (not a workspace mount), so the
	// shell bus's fs-change notify is its one change stream.
	useEffect(() => {
		return ConnectionManager.getInstance().on('shell:notify', (notification: ShellNotification) => {
			if (notification.kind !== 'onFsChange') return;
			if (notification.uri.startsWith(`${AGENTS_DIR}/${hostAppId}/`)) void refresh();
		});
	}, [refresh, hostAppId]);

	// Conversations are THIS TOOL's documents (tool:agent/<sessionId>) —
	// opened through DevToolProps.documents like any per-document tool.
	const agent: AgentSidebar = {
		sessions,
		...(services.activeDocKey?.startsWith('tool:agent/') ? { activeSessionId: services.activeDocKey.slice('tool:agent/'.length) } : {}),
		onNewSession: () => {
			// Mint the GUID now; nothing hits disk until the first send.
			const session = AgentSession.newSession();
			documents?.open(session.sessionId, session.title);
		},
		onOpenSession: (sessionId: string) => {
			const title = sessions.find((s) => s.sessionId === sessionId)?.title ?? 'Agent session';
			documents?.open(sessionId, title);
		},
		onDeleteSession: (sessionId: string) => {
			void (async () => {
				const title = sessions.find((s) => s.sessionId === sessionId)?.title ?? sessionId;
				// The shell's own dialog — realm UI, present in every host.
			const confirmed = await showConfirmDialog('Delete session', `Are you sure you want to delete "${title}"?`, 'Delete');
				if (!confirmed) return;
				await AgentSession.deleteSession(sessionId);
				// Force-close the conversation tab regardless of state.
				documents?.close(sessionId);
			})();
		},
	};

	return <AgentSidebarPanel agent={agent} onShowIntro={(mode: IntroMode) => services.openPage(`intro:${mode}`)} />;
};
