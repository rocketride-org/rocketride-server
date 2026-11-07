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
// The lookup is time-limited (STATUS_TIMEOUT_MS, far under the bus's 120 s
// request timeout) through the SDK's developerStatus({ timeout }): a silent
// server counts as a failed lookup, the client drops the pending request, and
// a reply after the limit cannot let a scaffold go through. A failed lookup
// keeps its error (logged, and the cause of the scaffold error) and is shown
// in the wizard up front: toWizardIdentity() feeds the form from the same
// resolution resolveForScaffold() acts on, so what it shows is what Create does.
// =============================================================================

import type { NewAppIdentity } from 'shared/tools/appdev/types';

/** The developer id applied when the org has none or the session is offline. */
export const DEFAULT_DEVELOPER_ID = 'local';

/** What this module needs from the RocketRide client. */
export interface IDeveloperClient {
	getAccountInfo(): unknown;
	getOrgId(): string | undefined;
	developerStatus(options?: { timeout?: number }): Promise<{ developerId: string | null } | undefined>;
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
	/** Why the lookup failed (timeout, auth, server error), when it did. */
	lookupError?: unknown;
}

/** Longest wait for the developer_status lookup before it counts as failed. */
export const STATUS_TIMEOUT_MS = 10_000;

/** Shown when scaffolding cannot confirm the org's developer id. */
export const LOOKUP_FAILED_MESSAGE = "Could not confirm your organization's developer id with the server, so the app was not created. Check your connection and try again.";

/** Resolves and claims the org's developer id for one connection. */
export class DeveloperIdentity {
	/** A developer id registered from the wizard this session, keyed by org. The
	 *  login-time account info does not show it until a reconnect. Only kept
	 *  when the org is known, so a session without an org never reuses it. */
	private sessionClaim: { orgId: string; developerId: string } | null = null;

	/**
	 * @param connection - The extension's connection manager.
	 * @param statusTimeoutMs - Limit for the live lookup (tests pass a small one).
	 * @param log - Receives a line when the lookup fails (the host passes its logger).
	 */
	constructor(
		private readonly connection: IDeveloperConnection,
		private readonly statusTimeoutMs: number = STATUS_TIMEOUT_MS,
		private readonly log?: (message: string) => void
	) {}

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
			// Same typed request the Deploy tab makes (busHost getDeveloperId), bounded.
			const status = await client.developerStatus({ timeout: this.statusTimeoutMs });
			if (status?.developerId) return { ...fallback, developerId: status.developerId, source: 'organization' };
			return { ...fallback, canRegisterDeveloper: true };
		} catch (err) {
			// OSS servers always carry an id at login, so this is a SaaS lookup
			// failure or timeout: keep why, show it up front, and let scaffolding refuse.
			this.log?.(`developer_status lookup failed: ${err instanceof Error ? err.message : String(err)}`);
			return { ...fallback, lookupFailed: true, lookupError: err };
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
		if (resolved.lookupFailed) throw new Error(LOOKUP_FAILED_MESSAGE, { cause: resolved.lookupError });
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
		// Read the org BEFORE the request: a disconnect while it is in flight
		// would blank it, and a blank org must never key a remembered claim.
		const orgId = client.getOrgId();
		const res = (await client.registerDeveloper(requested)) as { developerId?: string } | undefined;
		if (orgId) {
			this.sessionClaim = { orgId, developerId: res?.developerId || requested };
		}
	}
}

/** The workspace half of the wizard identity (the host knows its folders). */
export interface IWizardWorkspace {
	workspaceOpen: boolean;
	existingFolders: string[];
}

/**
 * The identity the wizard shows, built from the same resolution scaffolding
 * acts on (so what the form shows is what Create does).
 *
 * @param resolved - From {@link DeveloperIdentity.resolve}.
 * @param workspace - The host's scaffold target.
 * @returns The wizard identity.
 */
export function toWizardIdentity(resolved: IResolvedDeveloperId, workspace: IWizardWorkspace): NewAppIdentity {
	return {
		developerId: resolved.developerId,
		source: resolved.source,
		workspaceOpen: workspace.workspaceOpen,
		existingFolders: workspace.existingFolders,
		canRegisterDeveloper: resolved.canRegisterDeveloper,
		lookupFailed: resolved.lookupFailed,
	};
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
