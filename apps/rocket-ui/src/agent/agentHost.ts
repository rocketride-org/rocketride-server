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
// AGENT HOST — what rocket-ui hands the agent at startup
// =============================================================================

/**
 * The agent lives in shared code and cannot import rocket-ui, so rocket-ui
 * builds its AgentHost here and installs it right after the workspace is
 * created: the workspace view, the bundled guides, the New App scaffold, the
 * deploy packer and the open apps' dev sessions.
 */

import type { RocketRideClient } from 'shell';
import type { AgentDevSession, AgentHost } from 'shared/modules/agent/host';
import type { FrameOptions } from 'shared/tools/appdev';
import { scaffoldApp } from '../surfaces/appdev/session/appStore';
import { findDevSession, type WebDevSession } from '../surfaces/appdev/session/devSession';
import { packAppSource } from '../surfaces/appdev/session/pack';
import { getWorkspaceVfs } from '../surfaces/workspace/vfs/workspace';
import { createRocketGuideSource } from './agentGuides';

// =============================================================================
// SCAFFOLD DEFAULTS
// =============================================================================

/** The frame the New App wizard starts with (NewAppForm's initial options): full screen. */
const WIZARD_FRAME: FrameOptions = { sidebar: false, statusFooter: false, docTabs: false };

// =============================================================================
// DEV SESSIONS
// =============================================================================

/**
 * Narrows a dev session to what the agent may use.
 *
 * @param session - The open session.
 * @returns The agent's view of it.
 */
function agentDevSession(session: WebDevSession): AgentDevSession {
	return {
		appId: session.appId,
		get previewAttached() {
			return session.previewAttached;
		},
		rebuild: () => session.rebuild(),
		subscribeConsole: (l) => session.subscribeConsole(l),
		subscribeErrors: (l) => session.subscribeErrors(l),
		subscribeWatch: (l) => session.subscribeWatch(l),
	};
}

// =============================================================================
// THE HOST
// =============================================================================

/**
 * Builds the agent host over rocket-ui's workspace. Call after
 * createWorkspace() settles, since the host captures the workspace view.
 *
 * @param client - The connected client; it supplies the publisher and packs deploys.
 * @returns The host to install with setAgentHost().
 */
export function createRocketAgentHost(client: RocketRideClient): AgentHost {
	return {
		vfs: getWorkspaceVfs(),
		guides: createRocketGuideSource(),
		// step: the New App wizard's publisher and starting frame
		scaffoldApp: ({ appName, displayName, template }) =>
			scaffoldApp({
				appName,
				displayName,
				publisher: client.getAccountInfo()?.organization?.developerId || 'local',
				frame: WIZARD_FRAME,
				template,
			}),
		packApp: (folder) => packAppSource(client, folder),
		devSession: (appId) => {
			const session = findDevSession(appId);
			return session ? agentDevSession(session) : null;
		},
	};
}
