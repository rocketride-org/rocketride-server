// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DESKTOP ADAPTER — the built-in shell-runtime implementation
// =============================================================================
//
// INTERNAL (not exported from the shell barrel): DesktopView builds this
// lazily when the host passes no `adapter` prop. All server interactions the
// desktop performs live here — version rails, session overrides, desktop
// remove, unsubscribe, subscription status — against the shell's own
// ConnectionManager, so OSS and SaaS hosts run the identical calls without
// threading callbacks through props.

import { ConnectionManager } from '../../connection/connection';
import { getAppVersionOverride, applyAppVersionOverride } from '../../util/versionOverride';
import type { DesktopAdapter, DesktopVersionRow } from './types';

/** Rail rung audience types -> the display handles the drop list shows. */
const RUNG_LABEL: Record<string, string> = { user: '@me', team: '@team', public: '@public' };

// The org's developer id, shared by every card — keyed by ORG: the developer
// id is an org identity and the active org changes at runtime (org switch),
// so a document-wide singleton would keep answering for whichever org was
// active when the first card mounted. Failures are never cached — a transient
// disconnect must not disable the developer affordance for the session.
const developerIdCache = new Map<string, Promise<string>>();

/**
 * The caller org's developer id ('' when none is claimed), cached per org.
 *
 * @param client - Connected RocketRide client.
 * @param orgId - The ACTIVE organization id the answer belongs to.
 * @returns The developer id slug (failures uncached).
 */
function developerIdOf(client: { call: (command: string, args: Record<string, unknown>) => Promise<unknown> }, orgId: string): Promise<string> {
	const cached = developerIdCache.get(orgId);
	if (cached) return cached;
	const pending = client
		.call('rrext_deploy_app', { subcommand: 'developer_status' })
		.then((res) => String((res as { developerId?: string | null })?.developerId ?? ''))
		.catch(() => {
			developerIdCache.delete(orgId);
			return '';
		});
	developerIdCache.set(orgId, pending);
	return pending;
}

/**
 * Builds the default shell-runtime adapter.
 *
 * @returns A fully-populated {@link DesktopAdapter}.
 */
export function createShellDesktopAdapter(): DesktopAdapter {
	return {
		async listVersions(appId: string): Promise<DesktopVersionRow[]> {
			const client = ConnectionManager.getInstance().getClient();
			if (!client) return [];
			const rail = await client.listDeployments(appId);
			// Built versions only — an unbuilt row has no servable bytes.
			return rail
				.filter((r) => r.buildStatus === 'ok')
				.map((r) => ({
					registryVersion: r.registryVersion,
					appVersion: r.appVersion,
					handles: r.rungs?.length
						? [...new Set(r.rungs.map((rung) => RUNG_LABEL[rung] ?? rung))].concat(r.state === 'submit' ? ['in review'] : [])
						: [r.state === 'submit' ? 'in review' : 'unpublished'],
				}))
				.sort((a, b) => b.registryVersion - a.registryVersion);
		},

		getDeveloperId(): Promise<string> {
			const client = ConnectionManager.getInstance().getClient();
			const orgId: string = (client as { getAccountInfo?: () => { organization?: { id?: string } } | null } | null)?.getAccountInfo?.()?.organization?.id ?? '';
			if (!client || !orgId) return Promise.resolve('');
			return developerIdOf(client, orgId);
		},

		onDeveloperIdChanged(resolve: () => void): () => void {
			// Org switches and sign-in/out surface as account updates — the card
			// re-resolves so the developer affordance tracks the ACTIVE org, and
			// so a client that was not ready at mount recovers.
			const cm = ConnectionManager.getInstance();
			const offs = [cm.on('shell:accountUpdate', resolve), cm.on('shell:login', resolve), cm.on('shell:logout', resolve)];
			return () => {
				for (const off of offs) off?.();
			};
		},

		getVersionOverride: getAppVersionOverride,
		applyVersionOverride: applyAppVersionOverride,

		removeApp(appId: string): void {
			const client = ConnectionManager.getInstance().getClient();
			if (client) void client.call('rrext_app', { subcommand: 'desktop_remove', appId }).catch(() => {});
		},

		unsubscribeApp(appId: string): void {
			ConnectionManager.getInstance().emit('shell:unsubscribe', { appId });
		},
	};
}

/**
 * The default launch action: switch the shell to the app.
 *
 * @param appId - The app to switch to.
 */
export function defaultLaunch(appId: string): void {
	ConnectionManager.getInstance().emit('shell:switchApp', { appId });
}
