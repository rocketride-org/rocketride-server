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

import { AccountView, CheckoutModal } from 'shared';
import type { ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, AccountSection, ProfileUpdate, CheckoutPlan, PromoRedemption, PromoValidation } from 'shared';
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
	const [transactions, setTransactions] = useState<any | null>(null);
	const [usageByUser, setUsageByUser] = useState<any[]>([]);
	const [usageByTeam, setUsageByTeam] = useState<any[]>([]);
	const [topupPlans, setTopupPlans] = useState<any[]>([]);
	const [allPlans, setAllPlans] = useState<any[]>([]);

	// Top-up purchase resolver (promise-based like key creation)
	const topupResolverRef = useRef<{ resolve: (v: any) => void; reject: (e: Error) => void } | null>(null);
	// Upgrade subscription resolver
	const upgradeResolverRef = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

	// Checkout modal state
	const [showCheckout, setShowCheckout] = useState(false);
	const checkoutResolvers = useRef<{
		plans?: { resolve: (v: CheckoutPlan[]) => void; reject: (e: Error) => void };
		session?: { resolve: (v: { clientSecret: string | null; subscriptionId: string; status?: string }) => void; reject: (e: Error) => void };
		confirm?: { resolve: () => void; reject: (e: Error) => void };
		validatePromo?: { resolve: (v: PromoValidation) => void; reject: (e: Error) => void };
		redeemPromo?: { resolve: (v: PromoRedemption) => void; reject: (e: Error) => void };
	}>({});

	// Section load error
	const [sectionError, setSectionError] = useState<string | null>(null);

	/**
	 * Pending promise resolver for `onCreateKey`. The provider posts
	 * `account:keyCreated` asynchronously; this ref holds the resolve
	 * function so the callback can return the key string to AccountView.
	 */
	const createKeyResolverRef = useRef<((result: { key: string }) => void) | null>(null);

	const sendMessageRef = useRef<(msg: AccountWebviewToHost) => void>(() => {});

	// Env resolvers and refreshSignal removed — env management moved to EnvironmentWebview.

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
					setTransactions((message as any).transactions ?? null);
				setUsageByUser((message as any).usageByUser ?? []);
				setUsageByTeam((message as any).usageByTeam ?? []);
				setTopupPlans((message as any).topupPlans ?? []);
				setAllPlans((message as any).allPlans ?? []);
				break;

			// Top-up purchase result
			case 'billing:topupResult':
				if (topupResolverRef.current) {
					if ((message as any).error) {
						topupResolverRef.current.reject(new Error((message as any).error));
					} else {
						topupResolverRef.current.resolve((message as any).result);
					}
					topupResolverRef.current = null;
				}
				break;

			// Upgrade subscription result
			case 'billing:upgradeResult':
				if (upgradeResolverRef.current) {
					if ((message as any).error) {
						upgradeResolverRef.current.reject(new Error((message as any).error));
					} else {
						upgradeResolverRef.current.resolve();
					}
					upgradeResolverRef.current = null;
				}
				break;

			// -- Checkout flow responses -------------------------------------------
			case 'checkout:plansResult': {
				const r = checkoutResolvers.current.plans;
				if (r) {
					checkoutResolvers.current.plans = undefined;
					if ((message as any).error) r.reject(new Error((message as any).error));
					else r.resolve((message as any).plans ?? []);
				}
				break;
			}
			case 'checkout:sessionResult': {
				const r = checkoutResolvers.current.session;
				if (r) {
					checkoutResolvers.current.session = undefined;
					if ((message as any).error) r.reject(new Error((message as any).error));
					else r.resolve({
						clientSecret: (message as any).clientSecret,
						subscriptionId: (message as any).subscriptionId,
						status: (message as any).status,
					});
				}
				break;
			}
			case 'checkout:confirmResult': {
				const r = checkoutResolvers.current.confirm;
				if (r) {
					checkoutResolvers.current.confirm = undefined;
					if ((message as any).error) r.reject(new Error((message as any).error));
					else r.resolve();
				}
				break;
			}
			case 'checkout:validatePromoResult': {
				const r = checkoutResolvers.current.validatePromo;
				if (r) {
					checkoutResolvers.current.validatePromo = undefined;
					if (message.error || !message.result) r.reject(new Error(message.error ?? 'Promo validation failed'));
					else r.resolve(message.result);
				}
				break;
			}
			case 'checkout:redeemPromoResult': {
				const r = checkoutResolvers.current.redeemPromo;
				if (r) {
					checkoutResolvers.current.redeemPromo = undefined;
					if (message.error || !message.result) r.reject(new Error(message.error ?? 'Promo redemption failed'));
					else r.resolve(message.result);
				}
				break;
			}

			// Env variables removed — now handled by EnvironmentWebview.

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

	/** Switches the user's active organization. */
	const handleSetDefaultOrg = useCallback(async (orgId: string): Promise<void> => {
		sendMessageRef.current({ type: 'account:setDefaultOrg', orgId });
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
	const handleInviteMember = useCallback(async (params: { email: string; givenName: string; familyName: string; role: string; teamAssignments?: Array<{ teamId: string; permissions: string[] }> }): Promise<void> => {
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

	/** Resends the initialization email for a pending member. */
	const handleResendInvite = useCallback(async (userId: string): Promise<void> => {
		sendMessageRef.current({ type: 'account:resendInvite', userId });
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

	// handleLoadEnv / handleSaveEnv removed — env management moved to EnvironmentWebview.

	/** Cancels a subscription by app ID. */
	const handleCancelSubscription = useCallback(async (appId: string): Promise<void> => {
		sendMessageRef.current({ type: 'billing:cancel', appId } as any);
	}, []);

	/** Opens the Stripe customer portal in the browser. */
	const handleOpenPortal = useCallback(async (): Promise<void> => {
		sendMessageRef.current({ type: 'billing:portal' } as any);
	}, []);


	/** Opens the inline checkout modal for Pipe Builder subscription. */
	const handleSubscribe = useCallback((): void => {
		setShowCheckout(true);
	}, []);

	// -- Checkout flow callbacks (bridge to host via postMessage) ----------

	/** Fetches available plans from the server via the host. */
	const handleFetchPlans = useCallback((): Promise<CheckoutPlan[]> => {
		return new Promise((resolve, reject) => {
			checkoutResolvers.current.plans = { resolve, reject };
			sendMessageRef.current({ type: 'checkout:fetchPlans' } as any);
		});
	}, []);

	/**
	 * Creates a Stripe checkout session via the host.
	 *
	 * `clientSecret` is null for a $0 first invoice (100%-off promo code) —
	 * the CheckoutModal skips the payment step in that case.
	 */
	const handleCreateCheckout = useCallback((priceId: string, promotionCode?: string): Promise<{ clientSecret: string | null; subscriptionId: string; status?: string }> => {
		return new Promise((resolve, reject) => {
			checkoutResolvers.current.session = { resolve, reject };
			sendMessageRef.current({ type: 'checkout:createSession', priceId, promotionCode } as any);
		});
	}, []);

	/** Resolves a promo code (read-only) via the host. */
	const handleValidatePromo = useCallback((code: string, priceId?: string): Promise<PromoValidation> => {
		return new Promise((resolve, reject) => {
			checkoutResolvers.current.validatePromo = { resolve, reject };
			sendMessageRef.current({ type: 'checkout:validatePromo', code, priceId });
		});
	}, []);

	/** Redeems a credit-grant (hackathon) code via the host. */
	const handleRedeemPromo = useCallback((code: string): Promise<PromoRedemption> => {
		return new Promise((resolve, reject) => {
			checkoutResolvers.current.redeemPromo = { resolve, reject };
			sendMessageRef.current({ type: 'checkout:redeemPromo', code });
		});
	}, []);

	/** Confirms pending payment via the host. */
	const handleConfirmPending = useCallback((subscriptionId: string, priceId: string): Promise<void> => {
		return new Promise((resolve, reject) => {
			checkoutResolvers.current.confirm = { resolve, reject };
			sendMessageRef.current({ type: 'checkout:confirmPending', subscriptionId, priceId } as any);
		});
	}, []);

	/** Closes the checkout modal and refreshes billing data on success. */
	const handleCheckoutSuccess = useCallback((): void => {
		setShowCheckout(false);
		// Trigger billing data re-fetch so subscriptions list updates
		sendMessageRef.current({ type: 'account:sectionChange', section: 'billing' });
	}, []);

	// =========================================================================
	// RENDER
	// =========================================================================

	// Don't render until the first account:init arrives — avoids a brief
	// "disconnected" flash while the provider fetches data.
	if (!ready) return null;

	const stripeKey = process.env.RR_STRIPE_PUBLISHABLE_KEY || '';

	return (
		<>
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
				apps={authUser?.apps ?? profile?.apps}
				onCancelSubscription={handleCancelSubscription}
				onOpenPortal={handleOpenPortal}
				onSubscribe={handleSubscribe}
				transactions={transactions}
				usageByUser={usageByUser}
				usageByTeam={usageByTeam}
				activeTasks={[]}
				dashboardLoading={billingLoading}
				onTransactionPage={() => {}}
				topupPlans={topupPlans}
				allPlans={allPlans}
				onPurchaseTopup={async (plan: any) => {
					return new Promise((resolve, reject) => {
						topupResolverRef.current = { resolve, reject };
						sendMessageRef.current({ type: 'billing:purchaseTopup', priceId: plan.stripePriceId } as any);
					});
				}}
				onUpgradeSubscription={async (appId: string, newPriceId: string) => {
					return new Promise<void>((resolve, reject) => {
						upgradeResolverRef.current = { resolve, reject };
						sendMessageRef.current({ type: 'billing:upgrade', appId, newPriceId } as any);
					});
				}}
				memberNames={Object.fromEntries(members.map((m: any) => [m.userId, m.displayName || m.email || m.userId]))}
				teamNames={Object.fromEntries(teams.map((t: any) => [t.id, t.name || t.id]))}
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
				onSetDefaultOrg={handleSetDefaultOrg}
				onLogout={handleLogout}
				onDeleteAccount={handleDeleteAccount}
				onSaveOrgName={handleSaveOrgName}
				onCreateKey={handleCreateKey}
				onRevokeKey={handleRevokeKey}
				onInviteMember={handleInviteMember}
				onUpdateMemberRole={handleUpdateMemberRole}
				onRemoveMember={handleRemoveMember}
				onResendInvite={handleResendInvite}
				onCreateTeam={handleCreateTeam}
				onDeleteTeam={handleDeleteTeam}
				onAddTeamMember={handleAddTeamMember}
				onEditTeamMemberPerms={handleEditTeamMemberPerms}
				onRemoveTeamMember={handleRemoveTeamMember}
				onLoadTeamDetail={handleLoadTeamDetail}
			/>
			{showCheckout && stripeKey && (
				<CheckoutModal
					appName="Pipe Builder"
					appDescription="Visual AI pipeline editor -- run and deploy pipelines on RocketRide Cloud."
					stripePublishableKey={stripeKey}
					onFetchPlans={handleFetchPlans}
					onCreateCheckout={handleCreateCheckout}
					onConfirmPending={handleConfirmPending}
					onValidatePromoCode={handleValidatePromo}
					onRedeemPromoCode={handleRedeemPromo}
					onSuccess={handleCheckoutSuccess}
					onClose={() => setShowCheckout(false)}
				/>
			)}
		</>
	);
};

export default AccountWebview;
