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
export type ProjectHostToWebview = { type: 'project:load'; project: any; viewState: ViewState; prefs: Record<string, unknown>; services: Record<string, any>; isConnected: boolean; statuses?: Record<string, TaskStatus>; serverHost?: string } | { type: 'project:update'; project: any } | { type: 'project:services'; services: Record<string, any> } | { type: 'project:validateResponse'; requestId: number; result: any; error?: string } | { type: 'project:dirtyState'; isDirty: boolean; isNew: boolean } | { type: 'project:initialState'; state: ViewState } | { type: 'project:initialPrefs'; prefs: Record<string, unknown> } | { type: 'shell:init'; theme: Record<string, string>; isConnected: boolean } | { type: 'shell:themeChange'; tokens: Record<string, string> } | { type: 'shell:connectionChange'; isConnected: boolean } | { type: 'shell:viewActivated'; viewId: string } | { type: 'server:event'; event: unknown };

/** All messages the ProjectWebview can send to the extension host. */
export type ProjectWebviewToHost = { type: 'view:ready' } | { type: 'view:initialized' } | { type: 'project:contentChanged'; project: any } | { type: 'project:validate'; requestId: number; pipeline: any } | { type: 'project:requestSave' } | { type: 'project:viewStateChange'; viewState: ViewState } | { type: 'project:prefsChange'; prefs: Record<string, unknown> } | { type: 'project:openLink'; url: string; displayName?: string } | { type: 'status:pipelineAction'; action: 'run' | 'stop' | 'restart'; source?: string } | { type: 'trace:clear' };

// =============================================================================
// SERVER MONITOR PROTOCOL
// =============================================================================

/** All messages the extension host can send to the MonitorWebview. */
export type MonitorHostToWebview = { type: 'shell:init'; theme: Record<string, string>; isConnected: boolean } | { type: 'shell:themeChange'; tokens: Record<string, string> } | { type: 'shell:connectionChange'; isConnected: boolean } | { type: 'server:event'; event: unknown } | { type: 'monitor:dashboard'; data: DashboardResponse };

/** All messages the MonitorWebview can send to the extension host. */
export type MonitorWebviewToHost = { type: 'view:ready' } | { type: 'view:initialized' } | { type: 'monitor:refresh' };

// =============================================================================
// ACCOUNT PAGE PROTOCOL
// =============================================================================

/** All messages the extension host can send to the AccountWebview. */
export type AccountHostToWebview = { type: 'account:init'; isConnected: boolean; profile: ConnectResult | null; org: OrgDetail | null; members: MemberRecord[]; teams: TeamRecord[]; keys: ApiKeyRecord[] } | { type: 'shell:connectionChange'; isConnected: boolean } | { type: 'account:profile'; profile: ConnectResult | null } | { type: 'account:keys'; keys: ApiKeyRecord[] } | { type: 'account:org'; org: OrgDetail | null } | { type: 'account:members'; members: MemberRecord[] } | { type: 'account:teams'; teams: TeamRecord[] } | { type: 'account:teamDetail'; teamDetail: TeamDetail | null } | { type: 'account:keyCreated'; key: string } | { type: 'account:error'; error: string };

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
