// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Account host/webview protocol — the message contract between
 * AccountProvider (extension host) and the Account webview. Composes the
 * shell base (shellTypes.ts) and the shared checkout flow (checkoutTypes.ts);
 * the promo-code flow is Account-only and declared here.
 *
 * Pure types only — imported by both the extension host and the webview.
 */

import type { ConnectResult, ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, ProfileUpdate } from 'shell';
import type { PromoRedemption, PromoValidation } from 'shell';
import type { AppPrice, BillingDetail, CreditBalance, TransactionsResult, UsageRollup } from 'shell';
import type { ShellHostToWebview, ShellWebviewToHost } from './shellTypes';
import type { CheckoutResultHostToWebview, CheckoutRequestWebviewToHost } from './checkoutTypes';

/** All messages the extension host can send to the AccountWebview. */
export type AccountHostToWebview =
	| ShellHostToWebview
	| CheckoutResultHostToWebview
	| { type: 'account:init'; isConnected: boolean; profile: ConnectResult | null; org: OrgDetail | null; members: MemberRecord[]; teams: TeamRecord[]; keys: ApiKeyRecord[] }
	| { type: 'account:profile'; profile: ConnectResult | null }
	// The cached identity (client.getAccountInfo()) — posted beside
	// account:profile whenever the default team/org changes.
	| { type: 'account:authUser'; authUser: ConnectResult | null }
	| { type: 'account:keys'; keys: ApiKeyRecord[] }
	| { type: 'account:org'; org: OrgDetail | null }
	| { type: 'account:members'; members: MemberRecord[] }
	| { type: 'account:teams'; teams: TeamRecord[] }
	| { type: 'account:teamDetail'; teamDetail: TeamDetail | null }
	| { type: 'account:keyCreated'; key: string }
	| { type: 'account:accountUpdate' }
	| { type: 'account:error'; error: string }
	// Combined billing snapshot: loading/error envelope plus the parallel
	// SDK fetches (details, balance, plans, transactions, usage rollups).
	| { type: 'account:billing'; subscriptions: BillingDetail[]; creditBalance: CreditBalance | null; billingLoading: boolean; billingError: string | null; topupPlans?: AppPrice[]; allPlans?: AppPrice[]; transactions?: TransactionsResult | null; usageByUser?: UsageRollup[]; usageByTeam?: UsageRollup[] }
	// Top-up purchase reply — `result` on success ('requires_action' carries
	// the 3DS clientSecret), `error` on failure.
	| { type: 'billing:topupResult'; result?: { status: string; clientSecret?: string }; error?: string }
	| { type: 'billing:upgradeResult'; error?: string }
	| { type: 'checkout:validatePromoResult'; result: PromoValidation | null; error: string | null }
	| { type: 'checkout:redeemPromoResult'; result: PromoRedemption | null; error: string | null };

/** All messages the AccountWebview can send to the extension host. */
export type AccountWebviewToHost =
	| ShellWebviewToHost
	| CheckoutRequestWebviewToHost
	| { type: 'account:saveProfile'; fields: ProfileUpdate }
	| { type: 'account:setDefaultTeam'; teamId: string }
	| { type: 'account:setDefaultOrg'; orgId: string }
	| { type: 'account:logout' }
	| { type: 'account:deleteAccount' }
	| { type: 'account:saveOrgName'; name: string }
	// teamId omitted = a full PAT scoped to all teams (SDK CreateKeyParams).
	| { type: 'account:createKey'; params: { name: string; teamId?: string; permissions: string[]; expiresAt?: string } }
	| { type: 'account:revokeKey'; keyId: string }
	| { type: 'account:inviteMember'; params: { email: string; givenName: string; familyName: string; role: string; teamAssignments?: Array<{ teamId: string; permissions: string[] }> } }
	| { type: 'account:updateRole'; userId: string; role: string }
	| { type: 'account:removeMember'; userId: string }
	| { type: 'account:resendInvite'; userId: string }
	| { type: 'account:createTeam'; name: string }
	| { type: 'account:deleteTeam'; teamId: string }
	| { type: 'account:loadTeamDetail'; teamId: string }
	| { type: 'account:addTeamMember'; params: { teamId: string; userId: string; permissions: string[] } }
	| { type: 'account:editPerms'; params: { teamId: string; userId: string; permissions: string[] } }
	| { type: 'account:removeTeamMember'; params: { teamId: string; userId: string } }
	| { type: 'account:sectionChange'; section: string }
	// Billing dashboard actions (subscriptions, portal, top-ups).
	| { type: 'billing:cancel'; appId: string }
	| { type: 'billing:portal' }
	| { type: 'billing:purchaseTopup'; priceId: string }
	| { type: 'billing:upgrade'; appId: string; newPriceId: string }
	| { type: 'checkout:validatePromo'; code: string; priceId?: string }
	| { type: 'checkout:redeemPromo'; code: string };
