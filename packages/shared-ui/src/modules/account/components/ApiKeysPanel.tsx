// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ApiKeysPanel — the API Keys tab within AccountView.
 *
 * Renders a card with a scrollable list of all API keys owned by the user.
 * Each row shows the key name, team tag, active/expired badge, permissions,
 * last-used timestamp, expiry date, and (for active keys) a Revoke button.
 * All server interactions are delegated to the host via callback props.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import type { ApiKeyRecord } from '../types';
import { S, Badge, relativeTime } from './shared';

// =============================================================================
// PROPS
// =============================================================================

/** Props accepted by the ApiKeysPanel component. */
export interface ApiKeysPanelProps {
	/** The list of API key records to display. */
	keys: ApiKeyRecord[];
	/** Opens the Create API Key modal. */
	onCreateKey: () => void;
	/** Opens the Revoke confirmation modal for the given key. */
	onRevokeKey: (k: ApiKeyRecord) => void;
}

// =============================================================================
// API KEYS PANEL
// =============================================================================

/**
 * The API Keys tab panel.
 *
 * Renders a card with a scrollable list of all API keys owned by the user.
 * Each row shows the key name, team tag, active/expired badge, permissions,
 * last-used timestamp, expiry date, and (for active keys) a Revoke button.
 */
export const ApiKeysPanel: React.FC<ApiKeysPanelProps> = ({ keys, onCreateKey, onRevokeKey }) => (
	<section>
		<div style={{ ...commonStyles.card, marginBottom: 14 }}>
			<div style={commonStyles.cardHeader}>
				<span style={commonStyles.labelUppercase}>
					API Keys — {keys.length} key{keys.length !== 1 ? 's' : ''}
				</span>
				<button style={{ ...commonStyles.buttonPrimary, ...commonStyles.cardHeaderButton } as CSSProperties} onClick={onCreateKey}>
					+ New Key
				</button>
			</div>
			<div style={S.rowList}>
				{keys.map((k, i) => (
					// Dim revoked / expired keys with reduced opacity.
					<div key={k.id} style={{ ...S.rowItem, opacity: k.active ? 1 : 0.5, borderBottom: i < keys.length - 1 ? '1px solid var(--rr-border)' : 'none' }}>
						<div style={S.rowInfo}>
							<div style={S.rowName}>{k.name}</div>
							<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
								<Badge variant={k.isSession ? 'member' : k.active ? 'active' : 'expired'}>{k.isSession ? 'Interactive login' : k.active ? 'Active' : 'Expired'}</Badge>
								{k.teamName && <Badge variant="pending">{k.teamName}</Badge>}
								{!k.teamId && !k.isSession && <Badge variant="member">All Teams</Badge>}
							</div>
						</div>
						<div style={{ fontSize: 10, color: 'var(--rr-text-disabled)', textAlign: 'right' as const, flexShrink: 0, lineHeight: 1.6 }}>
							{k.lastUsedAt ? `Used ${relativeTime(k.lastUsedAt)}` : 'Never used'}
							<br />
							{k.expiresAt ? `Exp. ${new Date(k.expiresAt).toLocaleDateString()}` : 'No expiry'}
						</div>
						{k.active && !k.isSession && (
							<div style={S.rowActions}>
								<button style={{ ...commonStyles.buttonSecondary, ...commonStyles.cardBodyButton } as CSSProperties} onClick={() => onRevokeKey(k)}>
									Revoke
								</button>
							</div>
						)}
					</div>
				))}
				{keys.length === 0 && <div style={{ padding: '20px 18px', color: 'var(--rr-text-disabled)', fontSize: 12 }}>No API keys yet.</div>}
			</div>
		</div>
	</section>
);
