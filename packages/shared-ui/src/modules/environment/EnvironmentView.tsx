// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * EnvironmentView — host-agnostic environment variable management page.
 *
 * Pure component that receives all data as props and delegates server
 * mutations to async callback props. The host application is responsible
 * for fetching/saving env data via whatever transport it uses (direct
 * client calls in shell-ui, postMessage bridge in VS Code).
 *
 * Rendering modes:
 *   - Single slot: no tab bar, renders scope cards directly
 *   - Multiple slots: TabPanel with a pill per slot (e.g. Development / Deployment)
 *   - Per slot: OSS server → single "Server" card; SaaS → Org/Team/User cards
 *   - Disconnected slot → empty-state message
 */

import React, { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { TabPanel } from '../../components/tab-panel/TabPanel';
import type { ITabPanelTab, ITabPanelPanel } from '../../components/tab-panel/TabPanel';
import { commonStyles } from '../../themes/styles';
import { EnvScopeCard } from '../account/components/EnvironmentPanel';

// =============================================================================
// TYPES
// =============================================================================

/** Possible environment scope levels. */
export type EnvironmentScope = 'org' | 'team' | 'user';

/** Connection state and permissions for a single connection slot. */
export interface EnvironmentSlotConfig {
	/** Slot identifier (e.g. 'development', 'deployment', 'default'). */
	id: string;
	/** Display label for the tab (e.g. "Development", "Deployment"). */
	label: string;
	/** Whether this slot's server is connected. */
	isConnected: boolean;
	/** Whether the server is SaaS (true) or OSS (false). */
	isSaas: boolean;
	/** Whether the current user is an org admin on this slot. */
	isOrgAdmin: boolean;
	/** Whether the current user is a team admin on this slot. */
	isTeamAdmin: boolean;
	/** Organization ID (SaaS only). */
	orgId?: string;
	/** Team ID (SaaS only). */
	teamId?: string;
}

/** Props for the host-agnostic EnvironmentView component. */
export interface EnvironmentViewProps {
	/** Connection slots to display. Single slot = no tabs, multiple = tab panel. */
	slots: EnvironmentSlotConfig[];

	/**
	 * Loaded env dicts keyed by `slotId:scope:scopeId`.
	 * A key with `undefined` means loading; missing key means not yet requested.
	 */
	envs: Record<string, Record<string, string> | undefined>;

	/** Requests the host to load env data for a scope. */
	onLoadEnv: (slotId: string, scope: EnvironmentScope, scopeId?: string) => void;

	/** Saves env data for a scope. */
	onSaveEnv: (slotId: string, scope: EnvironmentScope, env: Record<string, string>, scopeId?: string) => Promise<void>;

	/** Keys that must have non-empty values before save is allowed (user scope only). */
	requiredKeys?: string[];

	/** Page-level error message. */
	error?: string | null;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Outer container — fills the available space with a column layout. */
	container: {
		...commonStyles.columnFill,
	} as CSSProperties,

	/** Content area when inside a TabPanel. */
	content: {
		...commonStyles.tabContent,
	} as CSSProperties,

	/** Content area in single-slot mode (no TabPanel / no pill bar). */
	contentSingle: {
		...commonStyles.tabContent,
		paddingTop: 30,
	} as CSSProperties,

	/** Empty-state message shown when a slot is not connected. */
	emptyState: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '60px 24px',
		color: 'var(--rr-text-disabled)',
		fontSize: 13,
		textAlign: 'center',
	} as CSSProperties,

	/** Page-level error banner. */
	errorBanner: {
		padding: '8px 16px',
		margin: '0 24px 12px',
		background: 'var(--rr-color-error-bg, rgba(244, 67, 54, 0.1))',
		color: 'var(--rr-color-error)',
		borderRadius: 4,
		fontSize: 12,
	} as CSSProperties,
};

// =============================================================================
// SLOT PANEL — renders env cards for a single connection slot
// =============================================================================

/**
 * Renders the env scope cards for a single connection slot.
 *
 * - Disconnected slot → empty-state message
 * - OSS server → single "Server" card (user scope on the server)
 * - SaaS server → up to three cards (Organization, Team, User)
 *   gated by the user's permissions
 */
const SlotPanel: React.FC<{
	/** Slot configuration. */
	slot: EnvironmentSlotConfig;
	/** Whether this is the only slot (no tab panel). */
	single: boolean;
	/** Loaded env dicts keyed by `slotId:scope:scopeId`. */
	envs: Record<string, Record<string, string> | undefined>;
	/** Requests env data load. */
	onLoadEnv: (slotId: string, scope: EnvironmentScope, scopeId?: string) => void;
	/** Saves env data. */
	onSaveEnv: (slotId: string, scope: EnvironmentScope, env: Record<string, string>, scopeId?: string) => Promise<void>;
	/** Required keys for user scope. */
	requiredKeys?: string[];
}> = ({ slot, single, envs, onLoadEnv, onSaveEnv, requiredKeys }) => {
	/** Builds a cache key for an env dict entry. */
	const envKey = useCallback(
		(scope: string, scopeId?: string) => `${slot.id}:${scope}:${scopeId ?? ''}`,
		[slot.id]
	);

	const contentStyle = single ? styles.contentSingle : styles.content;

	// ── Not connected — empty state ─────────────────────────────────────
	if (!slot.isConnected) {
		return (
			<div style={styles.emptyState}>
				{slot.label} server is not connected.
				<br />
				Connect in Settings to manage environment variables.
			</div>
		);
	}

	// ── OSS server — single flat card ───────────────────────────────────
	if (!slot.isSaas) {
		return (
			<div style={contentStyle}>
				<EnvScopeCard
					label="Server"
					env={envs[envKey('user')]}
					onRequestLoad={() => onLoadEnv(slot.id, 'user')}
					onSave={async (env) => { await onSaveEnv(slot.id, 'user', env); }}
					requiredKeys={requiredKeys}
				/>
			</div>
		);
	}

	// ── SaaS server — scoped cards gated by permissions ─────────────────
	return (
		<div style={contentStyle}>
			{/* Organization scope — only visible to org admins */}
			{slot.isOrgAdmin && slot.orgId && (
				<EnvScopeCard
					label="Organization"
					env={envs[envKey('org', slot.orgId)]}
					onRequestLoad={() => onLoadEnv(slot.id, 'org', slot.orgId)}
					onSave={async (env) => { await onSaveEnv(slot.id, 'org', env, slot.orgId); }}
				/>
			)}

			{/* Team scope — only visible to team admins */}
			{slot.isTeamAdmin && slot.teamId && (
				<EnvScopeCard
					label="Team"
					env={envs[envKey('team', slot.teamId)]}
					onRequestLoad={() => onLoadEnv(slot.id, 'team', slot.teamId)}
					onSave={async (env) => { await onSaveEnv(slot.id, 'team', env, slot.teamId); }}
				/>
			)}

			{/* User scope — always visible when connected to SaaS */}
			<EnvScopeCard
				label="User"
				env={envs[envKey('user')]}
				onRequestLoad={() => onLoadEnv(slot.id, 'user')}
				onSave={async (env) => { await onSaveEnv(slot.id, 'user', env); }}
				requiredKeys={requiredKeys}
			/>
		</div>
	);
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * EnvironmentView — host-agnostic environment variable management page.
 *
 * Renders env scope cards for one or more connection slots. When there
 * is a single slot, cards render directly. When there are multiple
 * slots, a TabPanel provides a pill bar to switch between them.
 *
 * @param props - Environment view configuration and callbacks.
 */
const EnvironmentView: React.FC<EnvironmentViewProps> = ({
	slots,
	envs,
	onLoadEnv,
	onSaveEnv,
	requiredKeys,
	error,
}) => {
	// ── Tab state (only used when multiple slots) ───────────────────────
	const [activeTab, setActiveTab] = useState(slots[0]?.id ?? '');

	const isSingle = slots.length <= 1;

	// ── Build tab definitions ──────────────────────────────────────────
	const tabs: ITabPanelTab[] = slots.map((s) => ({ id: s.id, label: s.label }));

	const panels: Record<string, ITabPanelPanel> = {};
	for (const slot of slots) {
		panels[slot.id] = {
			content: (
				<SlotPanel
					slot={slot}
					single={isSingle}
					envs={envs}
					onLoadEnv={onLoadEnv}
					onSaveEnv={onSaveEnv}
					requiredKeys={requiredKeys}
				/>
			),
		};
	}

	// ── Empty guard — nothing to render if no slots provided ──────────
	if (slots.length === 0) {
		return (
			<div style={styles.container}>
				{error && <div style={styles.errorBanner}>{error}</div>}
				<div style={{ padding: 16, color: 'var(--rr-text-secondary)', fontFamily: 'var(--rr-font-family)' }}>
					No connection slots available.
				</div>
			</div>
		);
	}

	return (
		<div style={styles.container}>
			{/* Page-level error banner */}
			{error && <div style={styles.errorBanner}>{error}</div>}

			{isSingle ? (
				// ── Single slot — no tab bar ────────────────────────────────
				<SlotPanel
					slot={slots[0]}
					single
					envs={envs}
					onLoadEnv={onLoadEnv}
					onSaveEnv={onSaveEnv}
					requiredKeys={requiredKeys}
				/>
			) : (
				// ── Multiple slots — tab bar ────────────────────────────────
				<TabPanel
					tabs={tabs}
					activeTab={activeTab}
					onTabChange={setActiveTab}
					panels={panels}
				/>
			)}
		</div>
	);
};

export default EnvironmentView;
