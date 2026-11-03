// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// BUS-BACKED HOST HALF — the App Builder's pure-SDK members over client.* ops
// =============================================================================
//
// The SDK half of {@link IAppBuilderHost}, served from ANY bus realm through
// the realm's own RocketRideClient (`client.app.*` / `client.deploy.*`
// surface) — off-root its requests ride the bus; no socket, no authToken in
// the realm. Both hosts' App Builder surfaces spread this adapter and add
// only their genuinely host-specific members (file IO, pickers, dev-session
// feeds, preview plumbing).
//
// Realm-local derivations ride the mirrors: listTeams reads the retained
// shell:account snapshot; the build-status ticker and deploy-changed signal
// filter the realm-local shell:event re-emission (the deploy monitor is armed
// through the broker-refcounted client.addMonitor op).
// =============================================================================

import type { IAppBuilderHost, BuildStatusTick } from './types';
import { toVersionInfos, toRungPins, walkDeploymentHistory } from './wire';
import type { WireRailEntry, WirePin, WireHistoryRow } from './wire';

// =============================================================================
// THE BUS SEAM
// =============================================================================

/** One platform event as the realm-local shell:event re-emission carries it. */
interface ShellEventPayload {
	event?: { event?: string; body?: { appId?: string; projectId?: string; version?: number; status?: string } };
}

/**
 * What the adapter needs from its realm's ConnectionManager — STRUCTURAL, so
 * the shell class satisfies it without this module importing the class (a
 * nominal class in input position would flip the contract check
 * contravariant; see packages/shell/src/components/workspace/busPeer.ts).
 */
export interface IAppBuilderBus {
	/** The realm's client, or null before the first mirror delivery. Typed
	 *  `unknown` to stay structural — the adapter narrows to the members it
	 *  uses (a nominal class here would flip the check contravariant). */
	getClient(): unknown;
	/** Realm-local event stream (mirror.event → shell:event). */
	on(event: 'shell:event', listener: (payload: ShellEventPayload) => void): () => void;
	/** The mirrored account snapshot (retained shell:account topic). */
	getAccountInfo(): { organization?: { teams?: Array<{ id: string; name: string }> } | null } | undefined;
}

/** The client members this adapter reaches — the narrowing view over
 *  {@link IAppBuilderBus.getClient}'s `unknown`. */
interface IAppBuilderClient {
	addMonitor(key: { token: string }, types: string[]): Promise<void>;
	listDeployments(appId: string): Promise<unknown>;
	publishApp(appId: string, version: number, target: string): Promise<unknown>;
	removeAppPublish(appId: string, target: string): Promise<unknown>;
	whereApp(appId: string): Promise<unknown>;
	buildLog(appId: string, version: number): Promise<{ log?: string } | undefined>;
	submitApp(appId: string, version: number): Promise<unknown>;
	withdrawApp(appId: string, version: number): Promise<unknown>;
	replyApp(appId: string, message: string, version?: number): Promise<unknown>;
	call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	deploy: { history(projectId: string, options?: { page?: number; pageSize?: number }): Promise<unknown> };
}

/** Inputs fixed per mounted App Builder surface. */
export interface IBusAppBuilderHostOptions {
	/** The realm's ConnectionManager (or any structural equivalent). */
	bus: IAppBuilderBus;
	/** The app under construction. */
	appId: string;
	/** Whether the server runs the review ladder (gates submit/withdraw). */
	hasReviewLadder: boolean;
}

// =============================================================================
// THE ADAPTER
// =============================================================================

/**
 * Builds the SDK half of an {@link IAppBuilderHost} over the bus.
 *
 * Returns a PARTIAL host: exactly the members every host serves identically
 * through the brokered client ops. Callers spread it into their host object
 * and layer the host-specific members on top.
 *
 * @param o - See {@link IBusAppBuilderHostOptions}.
 * @returns The shared SDK-backed members.
 */
export function createBusAppBuilderHost(o: IBusAppBuilderHostOptions): Partial<IAppBuilderHost> {
	const { bus, appId, hasReviewLadder } = o;
	/** The realm's connected client, or throws the standard message. */
	const client = (): IAppBuilderClient => {
		const c = bus.getClient() as IAppBuilderClient | null;
		if (!c) throw new Error('Not connected to server');
		return c;
	};

	return {
		// ── Develop: server-fed tickers, derived realm-locally ────────────────
		subscribeBuildStatus: (listener: (tick: BuildStatusTick) => void) => {
			// DEPLOY-typed events only reach connections that monitored them —
			// arm the wildcard monitor; the realm client forwards it to the
			// broker (refcounted across realms at multi-realm roots).
			Promise.resolve().then(() => client().addMonitor({ token: '*' }, ['deploy'])).catch(() => {
				/* not connected yet — the reconnect path re-arms monitors */
			});
			return bus.on('shell:event', ({ event }) => {
				if (event?.event !== 'apaevt_build_status') return;
				const body = event.body;
				if (!body || body.appId !== appId) return;
				listener({ version: body.version, status: body.status ?? '' });
			});
		},
		subscribeDeployChanged: (listener: () => void) => {
			return bus.on('shell:event', ({ event }) => {
				if (event?.event !== 'apaevt_deploy') return;
				if (event.body?.projectId !== appId) return;
				listener();
			});
		},

		// ── Deploy (the publish ladder) ───────────────────────────────────────
		listVersions: async () => toVersionInfos((await client().listDeployments(appId)) as WireRailEntry[]),
		publish: async (version, target) => {
			await client().publishApp(appId, version, target);
		},
		removePublish: async (target) => {
			await client().removeAppPublish(appId, target);
		},
		listTeams: async () => (bus.getAccountInfo()?.organization?.teams ?? []).map((t) => ({ id: t.id, name: t.name })),
		getWhereLive: async () => toRungPins((await client().whereApp(appId)) as WirePin[], hasReviewLadder),
		loadBuildLog: async (version) => {
			const body = await client().buildLog(appId, version);
			return body?.log ?? '';
		},
		submitForReview: hasReviewLadder
			? async (version) => {
					await client().submitApp(appId, version);
				}
			: undefined,
		withdrawReview: hasReviewLadder
			? async (version) => {
					await client().withdrawApp(appId, version);
				}
			: undefined,
		getDeveloperId: async () => {
			const res = await client().call<{ developerId?: string | null } | undefined>('rrext_deploy_app', { subcommand: 'developer_status' });
			return res?.developerId ?? '';
		},
		registerDeveloper: async (developerId) => {
			const res = await client().call<{ developerId?: string } | undefined>('rrext_deploy_app', { subcommand: 'developer_register', developerId });
			return res?.developerId ?? developerId;
		},

		// ── Dashboard + review thread ─────────────────────────────────────────
		loadHistory: async () =>
			walkDeploymentHistory(async (page, pageSize) => (await client().deploy.history(appId, { page, pageSize })) as { rows?: WireHistoryRow[]; total?: number } | undefined),
		sendReply: async (message, version) => {
			await client().replyApp(appId, message, version);
		},
	};
}
