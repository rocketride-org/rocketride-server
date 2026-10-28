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
 * created: the workspace view (whose read-only .rocketride/ holds the
 * guides), the New App scaffold, the deploy packer, the open apps' dev
 * sessions, and the user's approval settings.
 */

import type { RocketRideClient } from 'shell';
import type { AgentDevSession, AgentHost, ApprovalControls, ApprovalPrefs, ApprovalSettings, Grant } from 'shared/modules/agent/host';
import type { FrameOptions } from 'shared/tools/appdev';
import { scaffoldApp } from '../surfaces/preview/session/appStore';
import { findDevSession, type WebDevSession } from '../surfaces/preview/session/devSession';
import { packAppSource } from '../surfaces/preview/session/pack';
import { getWorkspace, type Workspace } from '../surfaces/workspace/vfs/workspace';

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
// APPROVALS — the user's settings behind the agent's approvals
// =============================================================================

/** The settings behind the agent's approvals, as package.json declares them. Typed by Grant, so a new kind doesn't compile until it has a key. */
const APPROVAL_KEYS: Readonly<Record<'mode' | Grant, string>> = {
	mode: 'rocketride.pipeBuilder.agentApproval',
	schedules: 'rocketride.pipeBuilder.agentAllowScheduleChanges',
	deploymentToggles: 'rocketride.pipeBuilder.agentAllowDeploymentToggles',
};

/** Writes one setting: the workspace's updateSetting. */
type SettingWriter = (key: string, value: string | boolean) => void;

/**
 * The agent's approval settings in the effective settings. Anything but
 * 'auto' reads as Ask, and anything but true as no grant, so a missing or
 * garbled value fails safe.
 *
 * @param settings - The effective workspace settings.
 * @returns The mode and grants.
 */
function approvalPrefsOf(settings: Readonly<Record<string, unknown>>): ApprovalPrefs {
	return {
		mode: settings[APPROVAL_KEYS.mode] === 'auto' ? 'auto' : 'ask',
		grants: { schedules: settings[APPROVAL_KEYS.schedules] === true, deploymentToggles: settings[APPROVAL_KEYS.deploymentToggles] === true },
	};
}

/** Whether two sets of prefs say the same. */
function samePrefs(a: ApprovalPrefs, b: ApprovalPrefs): boolean {
	return a.mode === b.mode && a.grants.schedules === b.grants.schedules && a.grants.deploymentToggles === b.grants.deploymentToggles;
}

/**
 * The user's approval settings for every agent chat in the page. RocketApp
 * pushes the workspace settings in on every change, as it does autoCommit,
 * and a write goes out to the settings file and comes back through the next
 * push, so the settings file is the one source.
 */
class ApprovalFeed {
	private prefs: ApprovalPrefs = approvalPrefsOf({});
	private write: SettingWriter | null = null;
	private readonly listeners = new Set<() => void>();

	/** What a run gets: it reads, hears changes and grants, with no way to set the mode. */
	readonly run: ApprovalSettings = {
		read: () => this.prefs,
		subscribe: (listener) => {
			this.listeners.add(listener);
			return () => {
				this.listeners.delete(listener);
			};
		},
		grant: (kind) => this.write?.(APPROVAL_KEYS[kind], true),
	};

	/** What the chat's mode switch gets. */
	readonly controls: ApprovalControls = { ...this.run, setMode: (mode) => this.write?.(APPROVAL_KEYS.mode, mode) };

	/**
	 * Takes the settings as they now stand. Settings that say the same change
	 * nothing and tell no one, so RocketApp may push on every settings change.
	 *
	 * @param settings - The effective workspace settings.
	 * @param write - Writes one setting.
	 */
	push(settings: Readonly<Record<string, unknown>>, write: SettingWriter): void {
		this.write = write;
		const next = approvalPrefsOf(settings);
		if (samePrefs(next, this.prefs)) return;
		this.prefs = next;
		for (const listener of [...this.listeners]) listener();
	}
}

/** The page's one feed: every host built here hands out the same one. */
const approvalFeed = new ApprovalFeed();

/**
 * Pushes the workspace settings into the agent's approvals. RocketApp calls
 * it on every settings change.
 *
 * @param settings - The effective workspace settings.
 * @param write - Writes one setting (the workspace's updateSetting).
 */
export function feedApprovalSettings(settings: Readonly<Record<string, unknown>>, write: SettingWriter): void {
	approvalFeed.push(settings, write);
}

// =============================================================================
// THE HOST
// =============================================================================

/**
 * Builds the agent host over one of rocket-ui's workspaces. Call after
 * createWorkspace() settles. A run keeps the host it started with, so after a
 * team switch its reads, writes, scaffolds and deploys stay in its own team.
 *
 * @param client - The connected client; it supplies the publisher and packs deploys.
 * @param ws - The workspace the host is bound to: its view and its scope.
 * @returns The host to install with setAgentHost().
 */
export function createRocketAgentHost(client: RocketRideClient, ws: Workspace): AgentHost {
	// step: after a team switch, a run must not reach the new team's dev sessions, even where app ids match
	const current = (): boolean => {
		try {
			return getWorkspace().view === ws.view;
		} catch {
			return false;
		}
	};
	return {
		vfs: ws.view,
		scopeKey: ws.scopeKey,
		scopeName: (scopeKey) => (scopeKey.startsWith('team-') ? client.getAccountInfo()?.organization?.teams?.find((team) => team.id === scopeKey.slice('team-'.length))?.name : undefined),
		// step: the New App wizard's publisher and starting frame
		scaffoldApp: ({ appName, displayName, template }) =>
			scaffoldApp(
				{
					appName,
					displayName,
					publisher: client.getAccountInfo()?.organization?.developerId || 'local',
					frame: WIZARD_FRAME,
					template,
				},
				ws
			),
		packApp: (folder) => packAppSource(client, folder, ws),
		devSession: (appId) => {
			if (!current()) return null;
			const session = findDevSession(appId);
			return session ? agentDevSession(session) : null;
		},
		approvals: { run: approvalFeed.run, controls: approvalFeed.controls },
	};
}
