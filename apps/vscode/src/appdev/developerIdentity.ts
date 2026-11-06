// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEVELOPER IDENTITY — which developer id new apps are created under
// =============================================================================
//
// vscode-free on purpose (unit-tested in src/test/developerIdentity.test.ts).
// The id comes from, in order: the account info captured at login, a claim
// made from the New App wizard this session (same org only), then a live
// developer_status lookup. Disconnected sessions and orgs without an id fall
// back to 'local'. A FAILED lookup is different: the id is unknown, not
// absent, so scaffolding refuses instead of silently creating local.<name>.
// =============================================================================

import type { NewAppIdentity } from 'shared/tools/appdev/types';

/** The developer id applied when the org has none or the session is offline. */
export const DEFAULT_DEVELOPER_ID = 'local';

/** What this module needs from the RocketRide client. */
export interface IDeveloperClient {
	getAccountInfo(): unknown;
	getOrgId(): string | undefined;
	developerStatus(): Promise<{ developerId: string | null }>;
	registerDeveloper(developerId: string): Promise<unknown>;
}

/** What this module needs from the connection manager. */
export interface IDeveloperConnection {
	getClient(): IDeveloperClient | undefined;
	isConnected(): boolean;
}

/** The resolved developer id and where it came from. */
export interface IResolvedDeveloperId {
	developerId: string;
	source: 'organization' | 'default';
	/** The org has no id yet and the server can claim one from the wizard. */
	canRegisterDeveloper: boolean;
	/** The live developer_status lookup failed: the id is unknown, not absent. */
	lookupFailed: boolean;
}

/** Shown when scaffolding cannot confirm the org's developer id. */
export const LOOKUP_FAILED_MESSAGE = "Could not confirm your organization's developer id with the server, so the app was not created. Check your connection and try again.";

/** Resolves and claims the org's developer id for one connection. */
export class DeveloperIdentity {
	/** A developer id registered from the wizard this session, keyed by org. The
	 *  login-time account info does not show it until a reconnect. */
	private sessionClaim: { orgId: string | undefined; developerId: string } | null = null;

	/**
	 * @param connection - The extension's connection manager.
	 */
	constructor(private readonly connection: IDeveloperConnection) {}

	/**
	 * Resolves the developer id for display and scaffolding.
	 *
	 * @returns The id, its source, and whether the wizard may claim one.
	 */
	public async resolve(): Promise<IResolvedDeveloperId> {
		const fallback: IResolvedDeveloperId = { developerId: DEFAULT_DEVELOPER_ID, source: 'default', canRegisterDeveloper: false, lookupFailed: false };
		const client = this.connection.getClient();
		if (!client || !this.connection.isConnected()) return fallback;

		const accountInfo = client.getAccountInfo() as { organization?: { developerId?: string } } | null | undefined;
		const fromLogin = accountInfo?.organization?.developerId;
		if (fromLogin) return { ...fallback, developerId: fromLogin, source: 'organization' };

		if (this.sessionClaim && this.sessionClaim.orgId === client.getOrgId()) {
			return { ...fallback, developerId: this.sessionClaim.developerId, source: 'organization' };
		}

		try {
			const status = await client.developerStatus();
			if (status?.developerId) return { ...fallback, developerId: status.developerId, source: 'organization' };
			return { ...fallback, canRegisterDeveloper: true };
		} catch {
			// OSS servers always carry an id at login, so this is a SaaS
			// lookup failure: hide the form, and let scaffolding refuse.
			return { ...fallback, lookupFailed: true };
		}
	}

	/**
	 * Resolves the id a new app is created under.
	 *
	 * @returns The developer id.
	 * @throws Error when the live lookup failed (never silently 'local').
	 */
	public async resolveForScaffold(): Promise<string> {
		const resolved = await this.resolve();
		if (resolved.lookupFailed) throw new Error(LOOKUP_FAILED_MESSAGE);
		return resolved.developerId;
	}

	/**
	 * Claims the org's developer id and remembers it for this session.
	 *
	 * @param developerId - The slug the user typed.
	 * @throws Error when not connected, the id is empty, or the server refuses.
	 */
	public async register(developerId: string): Promise<void> {
		const client = this.connection.getClient();
		if (!client || !this.connection.isConnected()) throw new Error('Not connected to server');
		const requested = developerId.trim();
		if (!requested) throw new Error('Enter a developer id');
		const res = (await client.registerDeveloper(requested)) as { developerId?: string } | undefined;
		this.sessionClaim = { orgId: client.getOrgId(), developerId: res?.developerId || requested };
	}
}

/** What the register handler needs from the host. */
export interface IRegisterHandlerDeps {
	identity: DeveloperIdentity;
	/** Builds the full wizard identity (developer id + workspace state). */
	buildIdentity: () => Promise<NewAppIdentity>;
	/** Fire-and-forget op to every attached realm. */
	broadcast: (op: string, params: unknown) => void;
}

/**
 * The host.appdev.registerDeveloper handler: claim the id, then push the
 * fresh identity to every open wizard and return it to the caller.
 *
 * @param deps - See {@link IRegisterHandlerDeps}.
 * @returns The op handler.
 */
export function makeRegisterDeveloperHandler(deps: IRegisterHandlerDeps): (params: { developerId: string }) => Promise<NewAppIdentity> {
	return async (params) => {
		await deps.identity.register(params.developerId);
		const identity = await deps.buildIdentity();
		deps.broadcast('host.appdev.identityChanged', identity);
		return identity;
	};
}
