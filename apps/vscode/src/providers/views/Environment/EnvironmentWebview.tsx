// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * EnvironmentWebview — VS Code webview bridge for environment variable management.
 *
 * Receives `env:*` messages from EnvironmentProvider via useMessaging, manages
 * local state for both connection slots, and renders EnvScopeCard components
 * for each accessible scope.
 *
 * The page adapts to the connection state:
 *   - Shared mode (deploy shares dev target): no pill bar, single panel
 *   - Independent mode: TabPanel with Development / Deployment pills
 *   - Per slot: OSS → single "Environment" card; SaaS → Org/Team/User cards
 *   - Disconnected slot → empty state message
 *
 * Architecture:
 *   EnvironmentProvider (Node.js) ↔ postMessage ↔ EnvironmentWebview (browser)
 */

import React, { useState, useCallback, useRef, useEffect, type CSSProperties } from 'react';
import { EnvScopeCard } from 'shared/modules/account/components/EnvironmentPanel';
import { TabPanel } from 'shared/components/tab-panel/TabPanel';
import type { ITabPanelTab, ITabPanelPanel } from 'shared/components/tab-panel/TabPanel';
import { commonStyles } from 'shared/themes/styles';
import { useMessaging } from '../hooks/useMessaging';
import type { EnvironmentHostToWebview, EnvironmentWebviewToHost, EnvironmentSlotState } from '../types';

// =============================================================================
// STYLES
// =============================================================================

/** Styles specific to the Environment page layout. */
const styles = {
	/** Outer container — fills the available space with a column layout. */
	container: {
		...commonStyles.columnFill,
	} as CSSProperties,

	/**
	 * Content area when inside a TabPanel — identical to
	 * commonStyles.tabContent used by Settings, Account, Monitor, etc.
	 */
	content: {
		...commonStyles.tabContent,
	} as CSSProperties,

	/**
	 * Content area in shared mode (no TabPanel / no pill bar).
	 * Same layout as tabContent but 30px top since there's no
	 * overlay pill bar to clear.
	 */
	contentShared: {
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
 * Props for the EnvironmentSlotPanel sub-component.
 */
interface SlotPanelProps {
	/** Which connection slot this panel represents. */
	slot: 'development' | 'deployment';

	/** True when rendering without a TabPanel (shared mode). */
	shared?: boolean;

	/** Live connection state for this slot (undefined while init hasn't arrived). */
	state: EnvironmentSlotState | undefined;

	/** Loaded env dicts keyed by `slot:scope:scopeId`. */
	envs: Record<string, Record<string, string> | undefined>;

	/**
	 * Sends a message to the extension host.
	 * Stored in a ref so callbacks don't go stale.
	 */
	sendMessage: (msg: EnvironmentWebviewToHost) => void;

	/** Keys that must have non-empty values before save is allowed (user scope only). */
	requiredKeys?: string[];
}

/**
 * Renders the env scope cards for a single connection slot.
 *
 * - If the slot is not connected, shows an empty-state message.
 * - If the server is OSS (not SaaS), shows a single "Environment" card
 *   that maps to the org-level API call on the server.
 * - If the server is SaaS, shows up to three cards (Organization, Team, User)
 *   gated by the user's permissions.
 */
const EnvironmentSlotPanel: React.FC<SlotPanelProps> = ({ slot, shared: isShared, state, envs, sendMessage, requiredKeys }) => {
	/** Pick the right content padding based on whether we're inside a TabPanel. */
	const contentStyle = isShared ? styles.contentShared : styles.content;
	/**
	 * Builds a unique cache key for an env dict entry.
	 * Format: `development:org:abc123` or `deployment:user:`.
	 */
	const envKey = useCallback(
		(scope: string, scopeId?: string) => `${slot}:${scope}:${scopeId ?? ''}`,
		[slot]
	);

	// ── Not connected — empty state ─────────────────────────────────────
	if (!state || !state.isConnected) {
		const label = slot === 'development' ? 'Development' : 'Deployment';
		return (
			<div style={styles.emptyState}>
				{label} server is not connected.
				<br />
				Connect in Settings to manage environment variables.
			</div>
		);
	}

	// ── OSS server — single flat card ───────────────────────────────────
	// OSS has no org/team/user hierarchy; the entire .env file is
	// accessed via the 'user' scope (rrext_account_me) on the server.
	if (!state.isSaas) {
		return (
			<div style={contentStyle}>
				<EnvScopeCard
					label="Server"
					env={envs[envKey('user')]}
					onRequestLoad={() => sendMessage({ type: 'env:getEnv', slot, scope: 'user' })}
					onSave={async (env) => {
						sendMessage({ type: 'env:saveEnv', slot, scope: 'user', env });
					}}
					requiredKeys={requiredKeys}
				/>
			</div>
		);
	}

	// ── SaaS server — scoped cards gated by permissions ─────────────────
	return (
		<div style={contentStyle}>
			{/* Organization scope — only visible to org admins */}
			{state.isOrgAdmin && state.orgId && (
				<EnvScopeCard
					label="Organization"
					env={envs[envKey('org', state.orgId)]}
					onRequestLoad={() => sendMessage({ type: 'env:getEnv', slot, scope: 'org', scopeId: state.orgId })}
					onSave={async (env) => {
						sendMessage({ type: 'env:saveEnv', slot, scope: 'org', env, scopeId: state.orgId });
					}}
				/>
			)}

			{/* Team scope — only visible to team admins */}
			{state.isTeamAdmin && state.teamId && (
				<EnvScopeCard
					label="Team"
					env={envs[envKey('team', state.teamId)]}
					onRequestLoad={() => sendMessage({ type: 'env:getEnv', slot, scope: 'team', scopeId: state.teamId })}
					onSave={async (env) => {
						sendMessage({ type: 'env:saveEnv', slot, scope: 'team', env, scopeId: state.teamId });
					}}
				/>
			)}

			{/* User scope — always visible when connected to SaaS */}
			<EnvScopeCard
				label="User"
				env={envs[envKey('user')]}
				onRequestLoad={() => sendMessage({ type: 'env:getEnv', slot, scope: 'user' })}
				onSave={async (env) => {
					sendMessage({ type: 'env:saveEnv', slot, scope: 'user', env });
				}}
				requiredKeys={requiredKeys}
			/>
		</div>
	);
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/**
 * EnvironmentWebview is the top-level React component for the Environment page.
 *
 * It manages the messaging bridge to EnvironmentProvider, holds state for
 * both connection slots, and renders either a single panel (shared mode) or
 * a TabPanel with dev/deploy pills (independent mode).
 */
const EnvironmentWebview: React.FC = () => {
	// =========================================================================
	// STATE
	// =========================================================================

	/** Whether the init message has been received. */
	const [ready, setReady] = useState(false);

	/**
	 * Whether deployment shares the development target.
	 * When true, the pill bar is hidden and only the dev slot is shown.
	 */
	const [shared, setShared] = useState(false);

	/** Currently active pill in the dev/deploy TabPanel. */
	const [activeSlot, setActiveSlot] = useState<'development' | 'deployment'>('development');

	/**
	 * Per-slot connection state received from the extension host.
	 * Keyed by slot name ('development' | 'deployment').
	 */
	const [slots, setSlots] = useState<Record<string, EnvironmentSlotState>>({});

	/**
	 * Loaded env dicts keyed by `slot:scope:scopeId`.
	 * A key being present with `undefined` means the load hasn't completed;
	 * a missing key means no load has been requested yet.
	 */
	const [envs, setEnvs] = useState<Record<string, Record<string, string> | undefined>>({});

	/** Page-level error message (cleared on next successful operation). */
	const [error, setError] = useState<string | null>(null);

	/** Keys that must have non-empty values before save is allowed. */
	const [requiredKeys, setRequiredKeys] = useState<string[]>([]);
	const requiredKeysRef = useRef<string[]>([]);

	/** Ref to the latest sendMessage so callbacks don't go stale. */
	const sendMessageRef = useRef<(msg: EnvironmentWebviewToHost) => void>(() => {});

	// =========================================================================
	// INCOMING MESSAGES
	// =========================================================================

	/**
	 * Handles every message type the extension host can send to this webview.
	 * Updates the corresponding React state slices.
	 */
	const handleMessage = useCallback((message: EnvironmentHostToWebview) => {
		switch (message.type) {
			// -- Full initialisation (sent once on view:ready, and on reconnects) --
			case 'env:init':
				setShared(message.shared);
				// Build a slot-keyed map from the array
				setSlots(() => {
					const map: Record<string, EnvironmentSlotState> = {};
					for (const s of message.slots) {
						map[s.slot] = s;
					}
					return map;
				});
				// Clear cached env data — connection state may have changed
				setEnvs({});
				setError(null);
				setReady(true);
				break;

			// -- Single slot update (connection change, permission change) ---------
			case 'env:slotUpdate':
				setSlots((prev) => ({ ...prev, [message.slot.slot]: message.slot }));
				// If the slot disconnected, clear its cached env data
				if (!message.slot.isConnected) {
					setEnvs((prev) => {
						const next: Record<string, Record<string, string> | undefined> = {};
						for (const [key, val] of Object.entries(prev)) {
							// Only keep entries that don't belong to the disconnected slot
							if (!key.startsWith(`${message.slot.slot}:`)) {
								next[key] = val;
							}
						}
						return next;
					});
				}
				break;

			// -- Env data response (from getEnv or refreshed after saveEnv) --------
			case 'env:data': {
				const cacheKey = `${message.slot}:${message.scope}:${message.scopeId ?? ''}`;
				let env = message.env;
				// Only merge required keys into the development user scope
				if (message.slot === 'development' && message.scope === 'user' && requiredKeysRef.current.length > 0) {
					env = { ...env };
					for (const key of requiredKeysRef.current) {
						if (!(key in env)) {
							env[key] = '';
						}
					}
				}
				setEnvs((prev) => ({ ...prev, [cacheKey]: env }));
				setError(null);
				break;
			}

			// -- Error from the host ----------------------------------------------
			case 'env:error':
				setError(message.error);
				break;

			// -- Pre-fill missing env var keys into the user scope card ----------
			case 'env:prefill': {
				// Merge missing keys (with empty values) into the development user-scope env
				const userKey = 'development:user:';
				setEnvs((prev) => {
					const existing = prev[userKey] ?? {};
					const merged = { ...existing };
					for (const key of message.keys) {
						if (!(key in merged)) {
							merged[key] = '';
						}
					}
					return { ...prev, [userKey]: merged };
				});
				setRequiredKeys(message.keys);
				requiredKeysRef.current = message.keys;
				break;
			}
		}
	}, []);

	// =========================================================================
	// MESSAGING HOOK
	// =========================================================================

	const { sendMessage } = useMessaging<EnvironmentWebviewToHost, EnvironmentHostToWebview>({
		onMessage: handleMessage,
	});

	// Keep the ref in sync so callbacks created with useCallback don't go stale
	useEffect(() => {
		sendMessageRef.current = sendMessage;
	}, [sendMessage]);

	/** Stable reference for child components to send messages. */
	const stableSendMessage = useCallback(
		(msg: EnvironmentWebviewToHost) => sendMessageRef.current(msg),
		[]
	);

	// =========================================================================
	// TAB DEFINITIONS
	// =========================================================================

	/** Pills for the dev/deploy selector (only shown in independent mode). */
	const tabs: ITabPanelTab[] = [
		{ id: 'development', label: 'Development' },
		{ id: 'deployment', label: 'Deployment' },
	];

	/** Panel content for each tab — renders an EnvironmentSlotPanel. */
	const panels: Record<string, ITabPanelPanel> = {
		development: {
			content: (
				<EnvironmentSlotPanel
					slot="development"
					state={slots['development']}
					envs={envs}
					sendMessage={stableSendMessage}
					requiredKeys={requiredKeys}
				/>
			),
		},
		deployment: {
			content: (
				<EnvironmentSlotPanel
					slot="deployment"
					state={slots['deployment']}
					envs={envs}
					sendMessage={stableSendMessage}
				/>
			),
		},
	};

	// =========================================================================
	// RENDER
	// =========================================================================

	// Don't render until the first env:init arrives
	if (!ready) return null;

	return (
		<div style={styles.container}>
			{/* Page-level error banner */}
			{error && <div style={styles.errorBanner}>{error}</div>}

			{shared ? (
				// ── Shared mode — no pill bar, single dev panel ──────────────
				<EnvironmentSlotPanel
					slot="development"
					shared
					state={slots['development']}
					envs={envs}
					sendMessage={stableSendMessage}
					requiredKeys={requiredKeys}
				/>
			) : (
				// ── Independent mode — dev/deploy pill bar ───────────────────
				<TabPanel
					tabs={tabs}
					activeTab={activeSlot}
					onTabChange={(id) => setActiveSlot(id as 'development' | 'deployment')}
					panels={panels}
				/>
			)}
		</div>
	);
};

export default EnvironmentWebview;
