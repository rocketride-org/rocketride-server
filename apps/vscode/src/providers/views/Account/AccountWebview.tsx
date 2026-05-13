// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AccountWebview — VS Code webview bridge for account management.
 *
 * Receives messages from the extension host via useMessaging, manages local
 * state, and renders <AccountView> with props. User actions flow back as
 * messages to the extension host.
 *
 * Architecture:
 *   AccountProvider (Node.js) ↔ postMessage ↔ AccountWebview (browser) → AccountView (pure UI)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

import { AccountView } from 'shared';
import type { ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, AccountSection, ProfileUpdate } from 'shared';
import type { ConnectResult } from 'rocketride';
import { useMessaging } from '../hooks/useMessaging';
import type { AccountHostToWebview, AccountWebviewToHost } from '../types';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * AccountWebview is the bridge between the VS Code extension host and the pure
 * AccountView component. It translates postMessage traffic into React state and
 * maps AccountView callbacks back to outgoing messages.
 */
const AccountWebview: React.FC = () => {
	// =========================================================================
	// STATE
	// =========================================================================

	const [ready, setReady] = useState(false);
	const [isConnected, setIsConnected] = useState(false);
	const [profile, setProfile] = useState<ConnectResult | null>(null);
	const [authUser, setAuthUser] = useState<ConnectResult | null>(null);
	const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
	const [org, setOrg] = useState<OrgDetail | null>(null);
	const [members, setMembers] = useState<MemberRecord[]>([]);
	const [teams, setTeams] = useState<TeamRecord[]>([]);
	const [teamDetail, setTeamDetail] = useState<TeamDetail | null>(null);
	const [section, setSection] = useState<AccountSection>('profile');
	const [activeTeamId, setActiveTeamId] = useState<string | null>(null);

	// Billing state
	const [subscriptions, setSubscriptions] = useState<any[]>([]);
	const [billingLoading, setBillingLoading] = useState(false);
	const [billingError, setBillingError] = useState<string | null>(null);
	const [creditBalance, setCreditBalance] = useState<any | null>(null);
	const [creditPacks, setCreditPacks] = useState<any[]>([]);

	// Section load error
	const [sectionError, setSectionError] = useState<string | null>(null);

	/**
	 * Pending promise resolver for `onCreateKey`. The provider posts
	 * `account:keyCreated` asynchronously; this ref holds the resolve
	 * function so the callback can return the key string to AccountView.
	 */
	const createKeyResolverRef = useRef<((result: { key: string }) => void) | null>(null);

	const sendMessageRef = useRef<(msg: AccountWebviewToHost) => void>(() => {});

	/**
	 * Pending promise resolvers for `onLoadEnv`. The provider posts
	 * `account:env` asynchronously; this map holds resolve functions
	 * keyed by `scope:scopeId` so each response fulfils the correct caller.
	 */
	const envResolverRef = useRef<Map<string, (env: Record<string, string>) => void>>(new Map());

	/** Bumped when an `account:accountUpdate` event arrives to trigger re-fetches. */
	const [refreshSignal, setRefreshSignal] = useState(0);

	// =========================================================================
	// INCOMING MESSAGES
	// =========================================================================

	/**
	 * Handles every message type the extension host can send to this webview.
	 * Updates the corresponding React state slices so AccountView re-renders.
	 */
	const handleMessage = useCallback((message: AccountHostToWebview) => {
		switch (message.type) {
			// -- Lifecycle --------------------------------------------------------
			case 'account:init':
				setIsConnected(message.isConnected);
				setProfile(message.profile);
				setAuthUser((message as any).authUser ?? message.profile);
				setOrg(message.org);
				setMembers(message.members);
				setTeams(message.teams);
				setKeys(message.keys);
				setReady(true);
				break;

			// -- Connection -------------------------------------------------------
			case 'shell:connectionChange':
				setIsConnected(message.isConnected);
				break;

			// -- Granular updates -------------------------------------------------
			case 'account:profile':
				setProfile(message.profile);
				break;
			case 'account:authUser':
				setAuthUser((message as any).authUser);
				break;
			case 'account:keys':
				setKeys(message.keys);
				break;
			case 'account:org':
				setOrg(message.org);
				break;
			case 'account:members':
				setMembers(message.members);
				break;
			case 'account:teams':
				setTeams(message.teams);
				break;
			case 'account:teamDetail':
				setTeamDetail(message.teamDetail);
				break;

			// -- Create key result ------------------------------------------------
			case 'account:keyCreated':
				if (createKeyResolverRef.current) {
					createKeyResolverRef.current({ key: message.key });
					createKeyResolverRef.current = null;
				}
				break;

			// -- Billing ----------------------------------------------------------
			case 'account:billing':
				setSubscriptions((message as any).subscriptions ?? []);
				setBillingLoading((message as any).billingLoading ?? false);
				setBillingError((message as any).billingError ?? null);
				setCreditBalance((message as any).creditBalance ?? null);
				setCreditPacks((message as any).creditPacks ?? []);
				break;

			// -- Env variables ----------------------------------------------------
			case 'account:env': {
				// Resolve the pending promise for the matching scope+scopeId key
				const key = `${message.scope}:${message.scopeId ?? ''}`;
				const resolver = envResolverRef.current.get(key);
				if (resolver) {
					resolver(message.env);
					envResolverRef.current.delete(key);
				}
				break;
			}
			case 'account:accountUpdate': {
				// Bump signal so downstream components re-fetch env data
				setRefreshSignal((n) => n + 1);
				break;
			}

			// -- Error ------------------------------------------------------------
			case 'account:error':
				setSectionError(message.error);
				break;
		}
	}, []);

	const { sendMessage } = useMessaging<AccountWebviewToHost, AccountHostToWebview>({
		onMessage: handleMessage,
	});
	useEffect(() => {
		sendMessageRef.current = sendMessage;
	}, [sendMessage]);

	// =========================================================================
	// OUTGOING CALLBACKS
	// =========================================================================

	/** Persists profile edits by sending the updated fields to the host. */
	const handleSaveProfile = useCallback(async (fields: ProfileUpdate): Promise<void> => {
		sendMessageRef.current({ type: 'account:saveProfile', fields });
	}, []);

	/** Sets the user's preferred default team. */
	const handleSetDefaultTeam = useCallback(async (teamId: string): Promise<void> => {
		sendMessageRef.current({ type: 'account:setDefaultTeam', teamId });
	}, []);

	/** Triggers the logout flow on the host side. */
	const handleLogout = useCallback(() => {
		sendMessageRef.current({ type: 'account:logout' });
	}, []);

	/** Permanently deletes the user account. */
	const handleDeleteAccount = useCallback(async (): Promise<void> => {
		sendMessageRef.current({ type: 'account:deleteAccount' });
	}, []);

	/** Saves an updated organization name. */
	const handleSaveOrgName = useCallback(async (name: string): Promise<void> => {
		sendMessageRef.current({ type: 'account:saveOrgName', name });
	}, []);

	/**
	 * Creates a new API key. Returns a promise that resolves when the host
	 * posts `account:keyCreated` with the raw key string.
	 */
	const handleCreateKey = useCallback(async (params: { name: string; teamId: string; permissions: string[]; expiresAt?: string }): Promise<{ key: string }> => {
		return new Promise<{ key: string }>((resolve) => {
			// Step 1: stash the resolver so the message handler can fulfil it.
			createKeyResolverRef.current = resolve;
			// Step 2: send the request to the host.
			sendMessageRef.current({ type: 'account:createKey', params });
		});
	}, []);

	/** Revokes an API key by its ID. */
	const handleRevokeKey = useCallback(async (keyId: string): Promise<void> => {
		sendMessageRef.current({ type: 'account:revokeKey', keyId });
	}, []);

	/** Sends an invitation to a new organization member. */
	const handleInviteMember = useCallback(async (params: { email: string; givenName: string; familyName: string; role: string }): Promise<void> => {
		sendMessageRef.current({ type: 'account:inviteMember', params });
	}, []);

	/** Updates an organization member's role. */
	const handleUpdateMemberRole = useCallback(async (userId: string, role: string): Promise<void> => {
		sendMessageRef.current({ type: 'account:updateRole', userId, role });
	}, []);

	/** Removes an organization member. */
	const handleRemoveMember = useCallback(async (userId: string): Promise<void> => {
		sendMessageRef.current({ type: 'account:removeMember', userId });
	}, []);

	/** Creates a new team. */
	const handleCreateTeam = useCallback(async (name: string): Promise<void> => {
		sendMessageRef.current({ type: 'account:createTeam', name });
	}, []);

	/** Deletes a team. */
	const handleDeleteTeam = useCallback(async (teamId: string): Promise<void> => {
		sendMessageRef.current({ type: 'account:deleteTeam', teamId });
	}, []);

	/** Adds a member to a team with specified permissions. */
	const handleAddTeamMember = useCallback(async (params: { teamId: string; userId: string; permissions: string[] }): Promise<void> => {
		sendMessageRef.current({ type: 'account:addTeamMember', params });
	}, []);

	/** Updates a team member's permissions. */
	const handleEditTeamMemberPerms = useCallback(async (params: { teamId: string; userId: string; permissions: string[] }): Promise<void> => {
		sendMessageRef.current({ type: 'account:editPerms', params });
	}, []);

	/** Removes a member from a team. */
	const handleRemoveTeamMember = useCallback(async (params: { teamId: string; userId: string }): Promise<void> => {
		sendMessageRef.current({ type: 'account:removeTeamMember', params });
	}, []);

	/** Requests the host to load full detail for a specific team. */
	const handleLoadTeamDetail = useCallback((teamId: string): void => {
		sendMessageRef.current({ type: 'account:loadTeamDetail', teamId });
	}, []);

	/** Requests env data from the extension host via postMessage and waits for the response. */
	const handleLoadEnv = useCallback(async (scope: 'org' | 'team' | 'user', scopeId?: string): Promise<Record<string, string>> => {
		return new Promise<Record<string, string>>((resolve) => {
			const key = `${scope}:${scopeId ?? ''}`;
			// Step 1: stash the resolver so the incoming message handler can fulfil it.
			envResolverRef.current.set(key, resolve);
			// Step 2: send the request to the host.
			sendMessageRef.current({ type: 'account:getEnv', scope, scopeId });
			// Step 3: timeout fallback — resolve with empty if host doesn't respond.
			setTimeout(() => {
				if (envResolverRef.current.delete(key)) resolve({});
			}, 10000);
		});
	}, []);

	/** Sends an env save request to the extension host. */
	const handleSaveEnv = useCallback(async (scope: 'org' | 'team' | 'user', env: Record<string, string>, scopeId?: string): Promise<void> => {
		sendMessageRef.current({ type: 'account:saveEnv', scope, env, scopeId });
	}, []);

	/** Cancels a subscription by app ID. */
	const handleCancelSubscription = useCallback(async (appId: string): Promise<void> => {
		sendMessageRef.current({ type: 'billing:cancel', appId } as any);
	}, []);

	/** Opens the Stripe customer portal in the browser. */
	const handleOpenPortal = useCallback(async (): Promise<void> => {
		sendMessageRef.current({ type: 'billing:portal' } as any);
	}, []);

	/** Opens a Stripe checkout session for a credit pack. */
	const handleBuyCredits = useCallback(async (pack: any): Promise<void> => {
		sendMessageRef.current({ type: 'billing:buyCredits', packId: pack.id } as any);
	}, []);

	// =========================================================================
	// RENDER
	// =========================================================================

	// Don't render until the first account:init arrives — avoids a brief
	// "disconnected" flash while the provider fetches data.
	if (!ready) return null;

	return (
		<AccountView
			isConnected={isConnected}
			sectionError={sectionError}
			profile={profile}
			authUser={authUser}
			keys={keys}
			org={org}
			members={members}
			teams={teams}
			teamDetail={teamDetail}
			subscriptions={subscriptions}
			billingLoading={billingLoading}
			billingError={billingError}
			creditBalance={creditBalance}
			creditPacks={creditPacks}
			apps={authUser?.apps ?? profile?.apps}
			onCancelSubscription={handleCancelSubscription}
			onOpenPortal={handleOpenPortal}
			onBuyCredits={handleBuyCredits}
			section={section}
			onSectionChange={(s) => {
				setSection(s);
				setSectionError(null);
				sendMessageRef.current({ type: 'account:sectionChange', section: s });
			}}
			activeTeamId={activeTeamId}
			onActiveTeamIdChange={setActiveTeamId}
			onSaveProfile={handleSaveProfile}
			onSetDefaultTeam={handleSetDefaultTeam}
			onLogout={handleLogout}
			onDeleteAccount={handleDeleteAccount}
			onSaveOrgName={handleSaveOrgName}
			onCreateKey={handleCreateKey}
			onRevokeKey={handleRevokeKey}
			onInviteMember={handleInviteMember}
			onUpdateMemberRole={handleUpdateMemberRole}
			onRemoveMember={handleRemoveMember}
			onCreateTeam={handleCreateTeam}
			onDeleteTeam={handleDeleteTeam}
			onAddTeamMember={handleAddTeamMember}
			onEditTeamMemberPerms={handleEditTeamMemberPerms}
			onRemoveTeamMember={handleRemoveTeamMember}
			onLoadTeamDetail={handleLoadTeamDetail}
			onLoadEnv={handleLoadEnv}
			onSaveEnv={handleSaveEnv}
			refreshSignal={refreshSignal}
		/>
	);
};

export default AccountWebview;
