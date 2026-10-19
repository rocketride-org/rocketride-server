// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// FOOTER MENU — the sidebar footer's popup items, built from connection facts
// =============================================================================
//
// Pure derivation: connection/auth facts in, SidebarFooterMenuItem[] out.
// Development and Deployment appear as status headers; clicking opens the
// Settings page (dev or deploy section). Account, Subscribe, Variables,
// Settings, Log out follow per the auth state:
//   - Anonymous (no cloud identity): Development + Settings only
//   - Cloud signed in: + Account/Billing CTA/Log out
// =============================================================================

import { BxUser, BxCog, BxExport, BxLock, BxRocket } from 'shell';
import type { SidebarFooterMenuItem } from 'shell';

/** A mode display label like "Local" or "Cloud". */
function modeLabel(mode: string | null): string {
	if (!mode) return 'Not configured';
	const labels: Record<string, string> = { local: 'Local', cloud: 'Cloud', docker: 'Docker', service: 'Service', onprem: 'Direct' };
	return labels[mode] ?? mode;
}

/** A connection status string from state, mode, and optional progress. */
function connectionStatusText(state: string, mode: string | null, progressMessage?: string): string {
	// Progress message takes priority (e.g. "Downloading 1.2.0: 45%")
	if (progressMessage) return progressMessage;
	const modeStr = modeLabel(mode);
	switch (state) {
		case 'connected':
			return `Connected (${modeStr})`;
		case 'connecting':
			return 'Connecting...';
		case 'downloading-engine':
			return 'Downloading engine...';
		case 'starting-engine':
			return 'Starting engine...';
		case 'stopping-engine':
			return 'Stopping engine...';
		case 'auth-failed':
			return 'Sign-in required';
		default:
			return 'Disconnected';
	}
}

/** The connection/auth facts the menu derives from. */
export interface FooterMenuFacts {
	// Dev connection
	connectionState: string;
	developmentMode: string;
	devProgressMessage?: string | undefined;
	devProgressLog: string[];
	// Deploy connection
	deployConnectionState: string;
	deployTargetMode: string | null;
	deployProgressMessage?: string | undefined;
	deployProgressLog: string[];
	// Auth
	cloudConnected: boolean;
	subscribed: boolean;
}

/** A status dot state from a connection state string. */
const dotState = (state: string) => (state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected') as 'connected' | 'connecting' | 'disconnected';

/**
 * Builds the footer popup's items.
 *
 * @param facts - The connection/auth facts.
 * @param runCommand - Executes one VS Code command in the extension host.
 * @returns The menu items, in display order.
 */
export function buildFooterMenuItems(facts: FooterMenuFacts, runCommand: (command: string, args?: unknown[]) => void): SidebarFooterMenuItem[] {
	const items: SidebarFooterMenuItem[] = [];
	const anyConnected = facts.connectionState === 'connected' || facts.deployConnectionState === 'connected';

	// ── Development section ─────────────────────────────────────────────────
	const devStatus = connectionStatusText(facts.connectionState, facts.developmentMode, facts.devProgressMessage);
	items.push({
		id: 'dev-header',
		label: 'Development',
		header: true,
		statusText: [devStatus, ...facts.devProgressLog].join('\n'),
		statusState: dotState(facts.connectionState),
		onClick: () => runCommand('rocketride.page.settings.open', ['development']),
	});

	// ── Deployment section ──────────────────────────────────────────────────
	if (facts.deployTargetMode) {
		const deployStatus = connectionStatusText(facts.deployConnectionState, facts.deployTargetMode, facts.deployProgressMessage);
		items.push({
			id: 'deploy-header',
			label: 'Deployment',
			header: true,
			statusText: [deployStatus, ...facts.deployProgressLog].join('\n'),
			statusState: dotState(facts.deployConnectionState),
			onClick: () => runCommand('rocketride.page.settings.open', ['deployment']),
		});
	}

	// ── Account / Subscribe / Variables / Settings / Log out ────────────────
	if (facts.cloudConnected) {
		items.push({ id: 'account', label: 'Account', icon: BxUser, dividerBefore: true, onClick: () => runCommand('rocketride.page.account.open') });
	}

	// Subscribe CTA — only when cloud-signed-in but not subscribed
	if (facts.cloudConnected && !facts.subscribed) {
		items.push({ id: 'subscribe', label: 'Subscribe', icon: BxRocket, onClick: () => runCommand('rocketride.page.account.open', ['billing']) });
	}

	// Variables is visible whenever at least one connection is active,
	// regardless of whether the server is OSS or SaaS.
	if (anyConnected) {
		items.push({ id: 'environment', label: 'Variables', icon: BxLock, dividerBefore: !facts.cloudConnected, onClick: () => runCommand('rocketride.page.environment.open') });
	}

	// Settings is always shown. Divider only when neither Account nor
	// Variables was shown above (i.e. not connected and not cloud).
	items.push({ id: 'settings', label: 'Settings', icon: BxCog, dividerBefore: !facts.cloudConnected && !anyConnected, onClick: () => runCommand('rocketride.page.settings.open') });

	if (facts.cloudConnected) {
		items.push({ id: 'logout', label: 'Log out', icon: BxExport, dividerBefore: true, onClick: () => runCommand('rocketride.cloud.logout') });
	}

	return items;
}
