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
// the brokered `client.app.*` / `client.deploy.*` ops — no socket, no client,
// no authToken in the realm. Both hosts' App Builder surfaces spread this
// adapter and add only their genuinely host-specific members (file IO,
// pickers, dev-session feeds, preview plumbing).
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
	/** Brokered op request (client.* rides this to the framework root). */
	request(op: string, params: unknown): Promise<unknown>;
	/** Realm-local event stream (mirror.event → shell:event). */
	on(event: 'shell:event', listener: (payload: ShellEventPayload) => void): () => void;
	/** The mirrored account snapshot (retained shell:account topic). */
	getAccountInfo(): { organization?: { teams?: Array<{ id: string; name: string }> } | null } | undefined;
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

	return {
		// ── Develop: server-fed tickers, derived realm-locally ────────────────
		subscribeBuildStatus: (listener: (tick: BuildStatusTick) => void) => {
			// DEPLOY-typed events only reach connections that monitored them —
			// arm the wildcard monitor through the broker (refcounted across
			// realms at multi-realm roots).
			bus.request('client.addMonitor', { key: { token: '*' }, types: ['deploy'] }).catch(() => {
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
		listVersions: async () => toVersionInfos((await bus.request('client.app.listDeployments', { appId })) as WireRailEntry[]),
		publish: async (version, target) => {
			await bus.request('client.app.publish', { appId, version, target });
		},
		removePublish: async (target) => {
			await bus.request('client.app.removePublish', { appId, target });
		},
		listTeams: async () => (bus.getAccountInfo()?.organization?.teams ?? []).map((t) => ({ id: t.id, name: t.name })),
		getWhereLive: async () => toRungPins((await bus.request('client.app.where', { appId })) as WirePin[], hasReviewLadder),
		loadBuildLog: async (version) => {
			const body = (await bus.request('client.app.buildLog', { appId, version })) as { log?: string } | undefined;
			return body?.log ?? '';
		},
		submitForReview: hasReviewLadder
			? async (version) => {
					await bus.request('client.app.submit', { appId, version });
				}
			: undefined,
		withdrawReview: hasReviewLadder
			? async (version) => {
					await bus.request('client.app.withdraw', { appId, version });
				}
			: undefined,
		getDeveloperId: async () => {
			const res = (await bus.request('client.app.developerStatus', {})) as { developerId?: string | null } | undefined;
			return res?.developerId ?? '';
		},
		registerDeveloper: async (developerId) => {
			const res = (await bus.request('client.app.developerRegister', { developerId })) as { developerId?: string } | undefined;
			return res?.developerId ?? developerId;
		},

		// ── Dashboard + review thread ─────────────────────────────────────────
		loadHistory: async () =>
			walkDeploymentHistory(async (page, pageSize) => (await bus.request('client.deploy.history', { projectId: appId, page, pageSize })) as { rows?: WireHistoryRow[]; total?: number } | undefined),
		sendReply: async (message, version) => {
			await bus.request('client.app.reply', { appId, message, version });
		},
	};
}
