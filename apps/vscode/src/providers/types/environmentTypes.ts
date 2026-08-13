// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Environment page webview message protocol types.
 *
 * Separated from `types.ts` so the extension host can import these without
 * pulling in `shared/modules/*` (which is only resolvable under the webview
 * tsconfig).
 */

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
			/** Which connection slot the error belongs to (if known). */
			slot?: 'development' | 'deployment';
			/** The scope level that failed (if known). */
			scope?: 'org' | 'team' | 'user';
			/** Optional scope identifier for the failed operation. */
			scopeId?: string;
	  }
	| {
			/** Pre-fill missing env var keys as empty entries in the user scope card. */
			type: 'env:prefill';
			/** Key names to add (with empty values) if not already present. */
			keys: string[];
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
