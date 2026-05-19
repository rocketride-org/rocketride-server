// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * VS Code webview message protocol types.
 *
 * Defines all messages exchanged between the extension host (Node.js) and the
 * webview (browser) for the project editor and server monitor views.
 */

import type { ViewState, TaskStatus } from 'shared/modules/project';
import type { DashboardResponse } from 'shared/modules/server';
import type { ConnectResult, ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, ProfileUpdate } from 'rocketride';

// =============================================================================
// PROJECT EDITOR PROTOCOL
// =============================================================================

/** All messages the extension host can send to the ProjectWebview. */
export type ProjectHostToWebview = { type: 'project:load'; project: any; viewState: ViewState; prefs: Record<string, unknown>; services: Record<string, any>; isConnected: boolean; isSubscribed?: boolean; statuses?: Record<string, TaskStatus>; serverHost?: string; isReadonly?: boolean; envKeys?: string[] } | { type: 'project:update'; project: any } | { type: 'project:services'; services: Record<string, any> } | { type: 'project:validateResponse'; requestId: number; result: any; error?: string } | { type: 'project:dirtyState'; isDirty: boolean; isNew: boolean } | { type: 'project:initialState'; state: ViewState } | { type: 'project:initialPrefs'; prefs: Record<string, unknown> } | { type: 'shell:init'; theme: Record<string, string>; isConnected: boolean } | { type: 'shell:themeChange'; tokens: Record<string, string> } | { type: 'shell:connectionChange'; isConnected: boolean } | { type: 'shell:viewActivated'; viewId: string } | { type: 'shell:event'; event: unknown };

/** All messages the ProjectWebview can send to the extension host. */
export type ProjectWebviewToHost = { type: 'view:ready' } | { type: 'view:initialized' } | { type: 'project:contentChanged'; project: any } | { type: 'project:validate'; requestId: number; pipeline: any } | { type: 'project:requestSave' } | { type: 'project:viewStateChange'; viewState: ViewState } | { type: 'project:prefsChange'; prefs: Record<string, unknown> } | { type: 'project:openLink'; url: string; displayName?: string } | { type: 'status:pipelineAction'; action: 'run' | 'stop' | 'restart'; source?: string } | { type: 'trace:clear' };

// =============================================================================
// SERVER MONITOR PROTOCOL
// =============================================================================

/** All messages the extension host can send to the MonitorWebview. */
export type MonitorHostToWebview = { type: 'shell:init'; theme: Record<string, string>; isConnected: boolean } | { type: 'shell:themeChange'; tokens: Record<string, string> } | { type: 'shell:connectionChange'; isConnected: boolean } | { type: 'shell:event'; event: unknown } | { type: 'monitor:dashboard'; data: DashboardResponse };

/** All messages the MonitorWebview can send to the extension host. */
export type MonitorWebviewToHost = { type: 'view:ready' } | { type: 'view:initialized' } | { type: 'monitor:refresh' };

// =============================================================================
// ACCOUNT PAGE PROTOCOL
// =============================================================================

/** All messages the extension host can send to the AccountWebview. */
export type AccountHostToWebview = { type: 'account:init'; isConnected: boolean; profile: ConnectResult | null; org: OrgDetail | null; members: MemberRecord[]; teams: TeamRecord[]; keys: ApiKeyRecord[] } | { type: 'shell:connectionChange'; isConnected: boolean } | { type: 'account:profile'; profile: ConnectResult | null } | { type: 'account:keys'; keys: ApiKeyRecord[] } | { type: 'account:org'; org: OrgDetail | null } | { type: 'account:members'; members: MemberRecord[] } | { type: 'account:teams'; teams: TeamRecord[] } | { type: 'account:teamDetail'; teamDetail: TeamDetail | null } | { type: 'account:keyCreated'; key: string } | { type: 'account:accountUpdate' } | { type: 'account:error'; error: string };

/** All messages the AccountWebview can send to the extension host. */
export type AccountWebviewToHost =
	| { type: 'view:ready' }
	| { type: 'account:saveProfile'; fields: ProfileUpdate }
	| { type: 'account:setDefaultTeam'; teamId: string }
	| { type: 'account:logout' }
	| { type: 'account:deleteAccount' }
	| { type: 'account:saveOrgName'; name: string }
	| { type: 'account:createKey'; params: { name: string; teamId: string; permissions: string[]; expiresAt?: string } }
	| { type: 'account:revokeKey'; keyId: string }
	| { type: 'account:inviteMember'; params: { email: string; givenName: string; familyName: string; role: string } }
	| { type: 'account:updateRole'; userId: string; role: string }
	| { type: 'account:removeMember'; userId: string }
	| { type: 'account:createTeam'; name: string }
	| { type: 'account:deleteTeam'; teamId: string }
	| { type: 'account:loadTeamDetail'; teamId: string }
	| { type: 'account:addTeamMember'; params: { teamId: string; userId: string; permissions: string[] } }
	| { type: 'account:editPerms'; params: { teamId: string; userId: string; permissions: string[] } }
	| { type: 'account:removeTeamMember'; params: { teamId: string; userId: string } }
	| { type: 'account:sectionChange'; section: string };

// =============================================================================
// ENVIRONMENT PAGE PROTOCOL
// =============================================================================

/**
 * Per-slot connection state sent from the extension host to the Environment
 * webview.  One of these is emitted for each connection slot (development /
 * deployment) so the webview knows what scopes to show and whether the
 * server is OSS or SaaS.
 */
export interface EnvironmentSlotState {
	/** Which connection slot this state describes. */
	slot: 'development' | 'deployment';
	/** Whether this slot currently has an active, authenticated connection. */
	isConnected: boolean;
	/**
	 * Whether the connected server is a SaaS instance (cloud auth with
	 * org/team/user hierarchy).  When false the server is OSS and only
	 * the org-level env scope is available.
	 */
	isSaas: boolean;
	/**
	 * The connection mode for this slot ('cloud', 'local', 'docker', etc.)
	 * or null when the deployment slot shares the development target.
	 */
	connectionMode: string | null;
	/** Whether the authenticated user has org-admin permissions. */
	isOrgAdmin: boolean;
	/** Whether the authenticated user has team-admin permissions. */
	isTeamAdmin: boolean;
	/** The organisation ID (if available from the connected server). */
	orgId?: string;
	/** The active team ID (if available from the connected server). */
	teamId?: string;
}

/** All messages the extension host can send to the EnvironmentWebview. */
export type EnvironmentHostToWebview =
	| {
			/** Sent once on view:ready with both slots' state. */
			type: 'env:init';
			/** True when deployment shares the development target (no pill bar). */
			shared: boolean;
			/** State for each connection slot (always two entries). */
			slots: EnvironmentSlotState[];
	  }
	| {
			/** Sent when a single slot's connection state changes. */
			type: 'env:slotUpdate';
			/** Updated state for the affected slot. */
			slot: EnvironmentSlotState;
	  }
	| {
			/** Response carrying loaded environment variables for one scope. */
			type: 'env:data';
			/** Which connection slot this data belongs to. */
			slot: 'development' | 'deployment';
			/** The scope level (org, team, or user). */
			scope: 'org' | 'team' | 'user';
			/** Optional scope identifier (orgId for org, teamId for team). */
			scopeId?: string;
			/** The key-value environment dict for this scope. */
			env: Record<string, string>;
	  }
	| {
			/** Sent when an env operation fails. */
			type: 'env:error';
			/** Human-readable error description. */
			error: string;
	  };

/** All messages the EnvironmentWebview can send to the extension host. */
export type EnvironmentWebviewToHost =
	| {
			/** Webview is mounted and ready to receive initial data. */
			type: 'view:ready';
	  }
	| {
			/** Request to load environment variables for one scope. */
			type: 'env:getEnv';
			/** Which connection slot to query. */
			slot: 'development' | 'deployment';
			/** The scope level to fetch. */
			scope: 'org' | 'team' | 'user';
			/** Optional scope identifier (orgId for org, teamId for team). */
			scopeId?: string;
	  }
	| {
			/** Request to save the full environment dict for one scope. */
			type: 'env:saveEnv';
			/** Which connection slot to target. */
			slot: 'development' | 'deployment';
			/** The scope level to write. */
			scope: 'org' | 'team' | 'user';
			/** The full key-value dict to persist (replaces existing). */
			env: Record<string, string>;
			/** Optional scope identifier (orgId for org, teamId for team). */
			scopeId?: string;
	  };
