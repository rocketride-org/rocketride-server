// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Account module types — re-exported from the canonical source in
 * the RocketRide SDK so all consumers share a single type definition.
 */

import type { AccountSection as SDKAccountSection } from 'rocketride';

export type { ConnectResult, ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, TeamMemberRecord, ProfileUpdate, AgentKeyProvider, AgentKeyStatus } from 'rocketride';

/**
 * Union type for the navigable sections within AccountView.
 *
 * Widens the SDK's `AccountSection` with `'agent-keys'` — pure shell-side UI
 * navigation state that nothing in the SDK reads or returns, so it lives here
 * rather than forcing an SDK contract bump. Deliberately named `AccountViewSection`
 * (NOT `AccountSection`): a widened type also named `AccountSection` collides with —
 * and gets shadowed by — the SDK's `AccountSection` in the shell's public exports
 * (`export type * from 'rocketride'`), so consumers importing `AccountSection` from
 * 'shell' would silently get the narrow SDK type. Apps hosting AccountView import
 * THIS type to hold the active section (which may be `'agent-keys'`). See
 * client-typescript's `AccountSection` doc comment for the reverse pointer.
 */
export type AccountViewSection = SDKAccountSection | 'agent-keys';
