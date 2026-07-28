// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DeploymentWebview — VS Code webview bridge for the file-less deployment tab.
 *
 * Receives the host-mapped deployment state (deployment:load) via
 * useMessaging, holds it as local state, and renders shared-ui's
 * DeploymentView. Every action flows back to the extension host as a
 * requestId-correlated message whose deployment:actionResult reply settles
 * the promise the component awaits — the host re-fetches and re-pushes
 * deployment:load after each mutation, so this bridge never guesses state.
 *
 * VS Code is live-only v1: openSession / fetchTimeline (the DVR/replay
 * adapters) are intentionally NOT passed, so the RUNS page renders its
 * sections without replay until the run-log transport is bridged.
 *
 * Architecture:
 *   DeploymentProvider (Node.js) ↔ postMessage ↔ DeploymentWebview (browser)
 *     → DeploymentView (pure UI)
 */

import React, { useCallback, useRef, useState, CSSProperties } from 'react';

import { DeploymentView } from 'shared/modules/deploy';
import { useMessaging } from '../hooks/useMessaging';
import type { DeploymentHostToWebview, DeploymentWebviewToHost, DeploymentLoadPayload, SchedulePreviewResultDTO } from '../types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Safety timeout for host round-trips so a lost reply never hangs the UI (ms). */
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// STYLES
// =============================================================================

const S = {
	message: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		height: '100vh',
		color: 'var(--rr-text-secondary)',
		fontSize: 13.5,
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** One pending host round-trip awaiting its reply message. */
interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	/** The timeout guard cleared when the reply arrives. */
	timer: ReturnType<typeof setTimeout>;
}

// =============================================================================
// COMPONENT
// =============================================================================

const DeploymentWebview: React.FC = () => {
	// --- State (populated from host messages) ---------------------------------

	const [data, setData] = useState<DeploymentLoadPayload | null>(null);
	const [loadError, setLoadError] = useState('');
	const [isConnected, setIsConnected] = useState(false);

	// Pending host round-trips keyed by requestId (actions, previews, validates).
	const pendingRequests = useRef<Map<number, PendingRequest>>(new Map());
	const requestCounter = useRef(0);

	// --- Messaging ------------------------------------------------------------

	/** Settles the pending request for a reply message, if one is armed. */
	const settleRequest = useCallback((requestId: number, error: string | undefined, value: unknown): void => {
		const pending = pendingRequests.current.get(requestId);
		if (!pending) return;
		pendingRequests.current.delete(requestId);
		clearTimeout(pending.timer);
		if (error) pending.reject(new Error(error));
		else pending.resolve(value);
	}, []);

	const handleMessage = useCallback(
		(msg: DeploymentHostToWebview) => {
			switch (msg.type) {
				case 'deployment:load': {
					// The full host-mapped snapshot replaces everything shown.
					const { type: _ignored, ...payload } = msg;
					setData(payload);
					setIsConnected(payload.isConnected);
					setLoadError('');
					break;
				}
				case 'deployment:error':
					setLoadError(msg.error);
					break;
				case 'deployment:actionResult':
					settleRequest(msg.requestId, msg.error, undefined);
					break;
				case 'deployment:previewResult':
					settleRequest(msg.requestId, msg.error, msg.result);
					break;
				case 'deployment:validateResult':
					settleRequest(msg.requestId, undefined, msg.result);
					break;
				case 'shell:connectionChange':
					setIsConnected(msg.isConnected);
					break;
			}
		},
		[settleRequest]
	);

	const { sendMessage } = useMessaging<DeploymentWebviewToHost, DeploymentHostToWebview>({ onMessage: handleMessage });

	// --- Request helper -------------------------------------------------------

	/**
	 * Sends one requestId-correlated message and returns a promise settled by
	 * the matching reply (deployment:actionResult / previewResult /
	 * validateResult), with a timeout guard so a lost reply never hangs.
	 */
	const request = useCallback(
		(build: (requestId: number) => DeploymentWebviewToHost): Promise<unknown> => {
			return new Promise<unknown>((resolve, reject) => {
				// Step 1: allocate the correlation id and arm the timeout guard.
				const requestId = ++requestCounter.current;
				const timer = setTimeout(() => {
					if (pendingRequests.current.has(requestId)) {
						pendingRequests.current.delete(requestId);
						reject(new Error('The server did not respond in time'));
					}
				}, REQUEST_TIMEOUT_MS);

				// Step 2: register the resolver and post the message.
				pendingRequests.current.set(requestId, { resolve, reject, timer });
				sendMessage(build(requestId));
			});
		},
		[sendMessage]
	);

	// --- DeploymentView callbacks → outgoing messages -------------------------

	const handleSetPaused = useCallback(
		async (paused: boolean): Promise<void> => {
			await request((requestId) => ({ type: 'deployment:setPaused', requestId, paused }));
		},
		[request]
	);

	const handleDeployVersion = useCallback(
		async (version: number): Promise<void> => {
			await request((requestId) => ({ type: 'deployment:deployVersion', requestId, version }));
		},
		[request]
	);

	const handleRemove = useCallback(async (): Promise<void> => {
		// The host closes this panel once the removal succeeds.
		await request((requestId) => ({ type: 'deployment:remove', requestId }));
	}, [request]);

	const handleRunSource = useCallback(
		async (sourceId: string): Promise<void> => {
			await request((requestId) => ({ type: 'deployment:runSource', requestId, sourceId }));
		},
		[request]
	);

	const handleStopSource = useCallback(
		async (sourceId: string): Promise<void> => {
			await request((requestId) => ({ type: 'deployment:stopSource', requestId, sourceId }));
		},
		[request]
	);

	const handleSetSchedule = useCallback(
		async (sourceId: string, cron: string | null, enabled: boolean, ttl: number | null): Promise<void> => {
			await request((requestId) => ({ type: 'deployment:setSchedule', requestId, sourceId, cron, enabled, ttl }));
		},
		[request]
	);

	const handlePreviewSchedule = useCallback(
		async (cron: string, count: number): Promise<SchedulePreviewResultDTO> => {
			return (await request((requestId) => ({ type: 'deployment:preview', requestId, cron, count }))) as SchedulePreviewResultDTO;
		},
		[request]
	);

	const handleValidate = useCallback(
		async (pipeline: unknown): Promise<{ errors: unknown[]; warnings: unknown[] }> => {
			// The host answers with an empty result on transport failure, so a
			// rejected validate only means the timeout fired — render clean then.
			try {
				return (await request((requestId) => ({ type: 'deployment:validate', requestId, pipeline }))) as { errors: unknown[]; warnings: unknown[] };
			} catch {
				return { errors: [], warnings: [] };
			}
		},
		[request]
	);

	// --- Render ---------------------------------------------------------------

	if (loadError) return <div style={S.message}>Failed to load deployment: {loadError}</div>;
	if (!data) return <div style={S.message}>Loading deployment&hellip;</div>;

	return (
		<DeploymentView
			teamName={data.teamName}
			deployment={data.deployment}
			pipeline={data.pipeline as never}
			servicesJson={data.servicesJson as never}
			handleValidatePipeline={handleValidate as never}
			schedules={data.schedules}
			history={data.history}
			versions={data.versions}
			{...(data.nextRun ? { nextRun: data.nextRun } : {})}
			runningSources={data.runningSources}
			canControl={data.canControl}
			isConnected={isConnected}
			// openSession / fetchTimeline deliberately absent: VS Code is
			// live-only v1 — the RUNS sections render without DVR replay.
			onSetPaused={handleSetPaused}
			onDeployVersion={handleDeployVersion}
			onRemove={data.canControl ? handleRemove : undefined}
			onRunSource={handleRunSource}
			onStopSource={handleStopSource}
			onSetSchedule={handleSetSchedule}
			previewSchedule={handlePreviewSchedule}
		/>
	);
};

export default DeploymentWebview;
