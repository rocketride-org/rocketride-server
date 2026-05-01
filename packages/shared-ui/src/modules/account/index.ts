// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Account module — public API for the account management component.
 *
 * The primary export is the `AccountView` component, which is the single
 * entry point for host applications.
 *
 * ```tsx
 * import AccountView from 'shared/modules/account';
 * <AccountView isConnected={true} profile={p} authUser={a} ... />
 * ```
 */

// =============================================================================
// VIEW
// =============================================================================

export { default } from './AccountView';
export type { IAccountViewProps } from './AccountView';

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

export { ProfilePanel } from './components/ProfilePanel';
export type { ProfilePanelProps } from './components/ProfilePanel';
export { ApiKeysPanel } from './components/ApiKeysPanel';
export type { ApiKeysPanelProps } from './components/ApiKeysPanel';
export { OrganizationPanel } from './components/OrganizationPanel';
export type { OrganizationPanelProps } from './components/OrganizationPanel';
export { TeamsPanel } from './components/TeamsPanel';
export type { TeamsPanelProps } from './components/TeamsPanel';
export { MembersPanel } from './components/MembersPanel';
export type { MembersPanelProps } from './components/MembersPanel';

// =============================================================================
// SHARED PRIMITIVES
// =============================================================================

export { Btn, Badge, PermPill, Avatar, RowIcon, Modal, PermGrid, ExpiryOpts } from './components/shared';
export { initials, avatarColor, relativeTime } from './components/shared';
export { S, PERMS, EXPIRY_OPTS } from './components/shared';

// =============================================================================
// TYPES
// =============================================================================

export type { ConnectResult, ApiKeyRecord, OrgDetail, MemberRecord, TeamRecord, TeamDetail, TeamMemberRecord, AccountSection, ProfileUpdate } from './types';
