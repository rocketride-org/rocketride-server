// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Project host/webview protocol — the message contract between
 * ProjectProvider (extension host) and the project editor webview. Composes
 * the shell base (shellTypes.ts), the shared checkout flow
 * (checkoutTypes.ts), and the deploy / run-log domain protocols
 * (deployTypes.ts, logTypes.ts); the subscription-gate pushes are
 * Project-only and declared here.
 *
 * Pure types only — imported by both the extension host and the webview
 * (ViewState/TaskStatus come from the pure `shared/modules/project/types`
 * leaf, never the tsx barrel).
 */

import type { ViewState, TaskStatus } from 'shared/modules/project/types';
import type { ShellHostToWebview, ShellWebviewToHost } from './shellTypes';
import type { CheckoutResultHostToWebview, CheckoutRequestWebviewToHost } from './checkoutTypes';
import type { DeployLifecycleHostToWebview, DeployLifecycleWebviewToHost, DeploymentHostToWebview, DeploymentWebviewToHost } from './deployTypes';
import type { LogSessionHostToWebview, LogSessionWebviewToHost } from './logTypes';

/** All messages the extension host can send to the ProjectWebview. */
export type ProjectHostToWebview =
	| ShellHostToWebview
	| { type: 'project:load'; project: any; viewState: ViewState; prefs: Record<string, unknown>; services: Record<string, any>; icons?: Record<string, string>; isConnected: boolean; isSubscribed?: boolean; statuses?: Record<string, TaskStatus>; serverHost?: string; oauthReturnUrl?: string; isReadonly?: boolean; envKeys?: string[] }
	| { type: 'project:oauthTokens'; tokens: string; state: string }
	| { type: 'project:update'; project: any }
	| { type: 'project:services'; services: Record<string, any>; icons?: Record<string, string> }
	| { type: 'project:validateResponse'; requestId: number; result: any; error?: string }
	| { type: 'project:nodeSchemaResponse'; requestId: number; service?: Record<string, any>; error?: string }
	| { type: 'project:dirtyState'; isDirty: boolean; isNew: boolean }
	| { type: 'project:initialState'; state: ViewState }
	| { type: 'project:initialPrefs'; prefs: Record<string, unknown> }
	| { type: 'project:envKeysUpdate'; envKeys: string[] }
	// Subscription gate + embedded checkout flow (the Subscribe overlay).
	| { type: 'checkout:required' }
	| { type: 'checkout:subscriptionUpdate'; isSubscribed: boolean }
	| CheckoutResultHostToWebview
	// Deploy lifecycle pushes for the DEPLOY page (see deployTypes.ts).
	| DeployLifecycleHostToWebview
	// Deployment record drawer pushes (the drawer lives in this webview).
	| DeploymentHostToWebview
	// Run-log session replies/pushes (the DVR bridge).
	| LogSessionHostToWebview;

/** All messages the ProjectWebview can send to the extension host. */
export type ProjectWebviewToHost =
	| ShellWebviewToHost
	| { type: 'project:contentChanged'; project: any }
	| { type: 'project:validate'; requestId: number; pipeline: any }
	| { type: 'project:getNodeSchema'; requestId: number; provider: string }
	| { type: 'project:requestSave' }
	| { type: 'project:viewStateChange'; viewState: ViewState }
	| { type: 'project:prefsChange'; prefs: Record<string, unknown> }
	| { type: 'project:openLink'; url: string; displayName?: string; browser?: boolean }
	| { type: 'project:openExternal'; url: string }
	| { type: 'status:pipelineAction'; action: 'run' | 'stop' | 'restart'; source?: string }
	| { type: 'status:missingEnvVars'; keys: string[] }
	| { type: 'trace:clear' }
	// Embedded checkout requests (the Subscribe overlay).
	| CheckoutRequestWebviewToHost
	// Deploy lifecycle requests from the DEPLOY page (see deployTypes.ts).
	| DeployLifecycleWebviewToHost
	// Deployment record drawer requests.
	| DeploymentWebviewToHost
	// Run-log session requests (the DVR bridge).
	| LogSessionWebviewToHost;
